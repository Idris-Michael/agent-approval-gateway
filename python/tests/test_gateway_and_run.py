"""Gateway client and run-loop tests. WHY:
- the client maps the gateway's status codes to decisions and fails loudly on anything else
- waiting returns only once a person decided AND the approved action finished running
- the run loop drives a paused graph through to the final answer without a second card"""

from __future__ import annotations

import httpx
import pytest
from langchain_core.messages import AIMessage, HumanMessage
from langgraph.checkpoint.memory import InMemorySaver

from approval_agent.gateway import GatewayClient, GatewayError
from approval_agent.graph import build_graph
from approval_agent.run import drive
from approval_agent.tools import LOCAL_TOOLS, issue_refund, lookup_customer
from tests.conftest import FakeGateway, ScriptedModel, tool_call


def test_status_codes_map_to_decisions(client: GatewayClient) -> None:
    assert (
        client.request_tool_call("lookup_customer", {}, reason=None, idempotency_key="k1").action == "allow"
    )
    deny = client.request_tool_call("wire_money", {}, reason=None, idempotency_key="k2")
    assert deny.action == "deny" and "not in the policy" in (deny.reason or "")
    pending = client.request_tool_call("issue_refund", {"amount_gbp": 1}, reason="r", idempotency_key="k3")
    assert pending.action == "pending_approval" and pending.approval is not None


def test_unexpected_responses_raise_rather_than_guess() -> None:
    http = httpx.Client(
        base_url="http://g",
        transport=httpx.MockTransport(lambda _r: httpx.Response(422, json={"error": "too long"})),
    )
    c = GatewayClient("http://g", "k", client=http)
    with pytest.raises(GatewayError, match="422: too long"):
        c.request_tool_call("issue_refund", {}, reason=None, idempotency_key="k")
    with pytest.raises(GatewayError, match="422"):
        c.get_approval("0" * 16)


def test_a_missing_api_key_fails_at_start_up() -> None:
    with pytest.raises(ValueError, match="AGENT_API_KEY"):
        GatewayClient("http://g", "")


def test_waiting_ends_only_after_the_approved_action_has_run(
    client: GatewayClient, fake_gateway: FakeGateway
) -> None:
    approval = client.request_tool_call("issue_refund", {}, reason=None, idempotency_key="k").approval
    assert approval is not None
    polls = {"n": 0}

    def progress(_s: float) -> None:
        polls["n"] += 1
        if polls["n"] == 1:
            fake_gateway.decide(
                approval["id"], "done", {"status": "queued", "result": None}
            )  # approved, not yet run
        if polls["n"] == 2:
            fake_gateway.decide(approval["id"], "done", {"status": "done", "result": "Refund RF-9 issued"})

    client._sleep = progress
    view = client.wait_for_outcome(approval["id"], poll_s=0)
    assert view["execution"]["result"] == "Refund RF-9 issued"
    assert polls["n"] == 2


def test_waiting_gives_up_after_the_timeout(client: GatewayClient) -> None:
    approval = client.request_tool_call("issue_refund", {}, reason=None, idempotency_key="k").approval
    assert approval is not None
    with pytest.raises(TimeoutError, match="still pending"):
        client.wait_for_outcome(approval["id"], poll_s=1, timeout_s=3)


def test_the_run_loop_waits_for_approval_and_finishes(
    client: GatewayClient, fake_gateway: FakeGateway
) -> None:
    model = ScriptedModel(
        [
            tool_call(
                "issue_refund",
                {
                    "customer_id": "C-1042",
                    "amount_gbp": 40,
                    "reason_code": "duplicate_charge",
                    "reason": "twice",
                },
            ),
            AIMessage("I've refunded £40."),
        ]
    )
    graph = build_graph(model, client, LOCAL_TOOLS, InMemorySaver())
    said: list[str] = []

    def approve_on_first_poll(_s: float) -> None:
        approval_id = next(iter(fake_gateway.approvals))
        fake_gateway.decide(approval_id, "done", {"status": "done", "result": "Refund RF-3 issued"})

    client._sleep = approve_on_first_poll
    answer = drive(
        graph,
        client,
        {"configurable": {"thread_id": "t"}},
        {"messages": [HumanMessage("refund")]},
        said.append,
        poll_s=0,
    )
    assert answer == "I've refunded £40."
    assert any("Paused: issue_refund needs approval" in s for s in said)
    assert fake_gateway.cards_sent == 1


def test_sensitive_tools_cannot_run_inside_the_agent() -> None:
    with pytest.raises(RuntimeError, match="runs in the approval gateway"):
        issue_refund.func(customer_id="C-1", amount_gbp=1.0, reason_code="goodwill", reason="x")  # type: ignore[misc]
    assert "No customer" in lookup_customer.invoke({"customer_id": "C-0000"})
