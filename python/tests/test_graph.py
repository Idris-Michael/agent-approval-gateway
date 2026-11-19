"""Agent graph tests. WHY each one exists:
- the agent can't run a denied tool, and the model is told plainly that it was refused
- a sensitive tool pauses the run; nothing happens until a person decides
- resuming re-runs the node, and the idempotency key stops a second card being sent
- the model is told the true outcome (approved and ran / rejected / failed), so it can't
  claim a refund happened when it didn't
- a paused run survives the agent process exiting (SQLite checkpoints)
- if the gateway is down, nothing runs and the model is told so"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.checkpoint.sqlite import SqliteSaver
from langgraph.types import Command

from approval_agent.gateway import GatewayClient
from approval_agent.graph import build_graph, describe_outcome
from approval_agent.tools import LOCAL_TOOLS
from tests.conftest import FakeGateway, ScriptedModel, tool_call

REFUND = {
    "customer_id": "C-1042",
    "amount_gbp": 40,
    "reason_code": "duplicate_charge",
    "reason": "charged twice",
}
CONFIG = {"configurable": {"thread_id": "t-1"}}


def tool_messages(result: dict[str, Any]) -> list[ToolMessage]:
    return [m for m in result["messages"] if isinstance(m, ToolMessage)]


def test_a_denied_tool_never_runs_and_the_model_is_told(client: GatewayClient) -> None:
    model = ScriptedModel([tool_call("wire_money", {"amount_gbp": 250000}), AIMessage("I can't do that.")])
    graph = build_graph(model, client, LOCAL_TOOLS, InMemorySaver())
    result = graph.invoke({"messages": [HumanMessage("wire it")]}, CONFIG)
    assert "__interrupt__" not in result
    assert "Refused by policy" in tool_messages(result)[0].content


def test_an_allowed_read_only_tool_runs_locally(client: GatewayClient) -> None:
    model = ScriptedModel([tool_call("lookup_customer", {"customer_id": "C-1042"}), AIMessage("Found them.")])
    graph = build_graph(model, client, LOCAL_TOOLS, InMemorySaver())
    result = graph.invoke({"messages": [HumanMessage("look up C-1042")]}, CONFIG)
    assert "OCT-INSTALMENT" in tool_messages(result)[0].content


def test_a_sensitive_tool_pauses_the_run_until_a_person_decides(
    client: GatewayClient, fake_gateway: FakeGateway
) -> None:
    model = ScriptedModel([tool_call("issue_refund", REFUND)])
    graph = build_graph(model, client, LOCAL_TOOLS, InMemorySaver())
    result = graph.invoke({"messages": [HumanMessage("refund them")]}, CONFIG)
    paused = result["__interrupt__"][0].value
    assert paused["tool"] == "issue_refund"
    assert paused["args"] == {"customer_id": "C-1042", "amount_gbp": 40, "reason_code": "duplicate_charge"}
    assert fake_gateway.posts[0]["reason"] == "charged twice"  # reason goes to the card, not into the args
    assert fake_gateway.approvals[paused["approval_id"]]["status"] == "pending"
    assert len(model.seen) == 1  # the model is not called again while paused


def test_resuming_reruns_the_node_but_the_idempotency_key_prevents_a_second_card(
    client: GatewayClient, fake_gateway: FakeGateway
) -> None:
    model = ScriptedModel([tool_call("issue_refund", REFUND), AIMessage("Refunded.")])
    graph = build_graph(model, client, LOCAL_TOOLS, InMemorySaver())
    paused = graph.invoke({"messages": [HumanMessage("refund")]}, CONFIG)["__interrupt__"][0].value
    fake_gateway.decide(paused["approval_id"], "done", {"status": "done", "result": "Refund RF-1 issued"})
    graph.invoke(Command(resume=fake_gateway.approvals[paused["approval_id"]]), CONFIG)
    assert len(fake_gateway.posts) == 2  # LangGraph re-ran the node and asked again...
    assert fake_gateway.posts[0]["key"] == fake_gateway.posts[1]["key"] == "t-1:call-1"
    assert fake_gateway.cards_sent == 1  # ...but the approver got one card


def test_the_model_hears_the_real_outcome_after_approval(
    client: GatewayClient, fake_gateway: FakeGateway
) -> None:
    model = ScriptedModel([tool_call("issue_refund", REFUND), AIMessage("Done.")])
    graph = build_graph(model, client, LOCAL_TOOLS, InMemorySaver())
    paused = graph.invoke({"messages": [HumanMessage("refund")]}, CONFIG)["__interrupt__"][0].value
    fake_gateway.decide(
        paused["approval_id"], "done", {"status": "done", "result": "Refund RF-84047 issued: £40"}
    )
    result = graph.invoke(Command(resume=fake_gateway.approvals[paused["approval_id"]]), CONFIG)
    told = tool_messages(result)[0].content
    assert "Approved by 1001" in told
    assert "RF-84047" in told
    assert result["messages"][-1].content == "Done."


def test_a_rejection_tells_the_model_nothing_was_run(
    client: GatewayClient, fake_gateway: FakeGateway
) -> None:
    model = ScriptedModel([tool_call("issue_refund", REFUND), AIMessage("Not approved.")])
    graph = build_graph(model, client, LOCAL_TOOLS, InMemorySaver())
    paused = graph.invoke({"messages": [HumanMessage("refund")]}, CONFIG)["__interrupt__"][0].value
    fake_gateway.decide(paused["approval_id"], "rejected")
    result = graph.invoke(Command(resume=fake_gateway.approvals[paused["approval_id"]]), CONFIG)
    assert "Nothing was run" in tool_messages(result)[0].content


def test_a_paused_run_survives_the_agent_process_exiting(
    client: GatewayClient, fake_gateway: FakeGateway, tmp_path: Path
) -> None:
    db = str(tmp_path / "checkpoints.db")
    with SqliteSaver.from_conn_string(db) as saver:
        graph = build_graph(ScriptedModel([tool_call("issue_refund", REFUND)]), client, LOCAL_TOOLS, saver)
        paused = graph.invoke({"messages": [HumanMessage("refund")]}, CONFIG)["__interrupt__"][0].value
    # new process: new model object, new graph, same database and thread id
    fake_gateway.decide(paused["approval_id"], "done", {"status": "done", "result": "Refund RF-2 issued"})
    with SqliteSaver.from_conn_string(db) as saver:
        graph = build_graph(ScriptedModel([AIMessage("Refunded.")]), client, LOCAL_TOOLS, saver)
        assert graph.get_state(CONFIG).interrupts[0].value["approval_id"] == paused["approval_id"]
        result = graph.invoke(Command(resume=fake_gateway.approvals[paused["approval_id"]]), CONFIG)
    assert result["messages"][-1].content == "Refunded."
    assert fake_gateway.cards_sent == 1


def test_if_the_gateway_is_down_nothing_runs_and_the_model_is_told(
    client: GatewayClient, fake_gateway: FakeGateway
) -> None:
    fake_gateway.down = True
    model = ScriptedModel([tool_call("issue_refund", REFUND), AIMessage("Try later.")])
    graph = build_graph(model, client, LOCAL_TOOLS, InMemorySaver())
    result = graph.invoke({"messages": [HumanMessage("refund")]}, CONFIG)
    assert "could not be reached" in tool_messages(result)[0].content
    assert "__interrupt__" not in result


def test_outcome_wording_covers_every_terminal_state() -> None:
    assert "running it failed" in describe_outcome(
        {"status": "done", "execution": {"status": "error", "result": "timeout"}}
    )
    assert "expired" in describe_outcome({"status": "expired"})
    assert "Nothing was run" in describe_outcome({"status": "failed", "outcome": "card not delivered"})
