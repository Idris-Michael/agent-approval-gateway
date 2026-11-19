"""The agent graph: model → gated tools → model, with a pause for human approval.

Every tool call goes to the gateway first. Allowed calls run here; denied calls go back to the
model as an error; sensitive calls pause the graph with `interrupt()` until a person decides.
On resume, LangGraph re-runs the whole tools node, so the gateway is asked again. The
idempotency key (thread id + tool call id) makes that second ask return the same approval
instead of sending the approver a duplicate card."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any, Protocol

from langchain_core.messages import AIMessage, BaseMessage, ToolMessage
from langchain_core.runnables import RunnableConfig
from langchain_core.tools import BaseTool
from langgraph.graph import END, START, MessagesState, StateGraph
from langgraph.types import interrupt

from approval_agent.gateway import GatewayClient, GatewayError


class ChatModel(Protocol):
    def invoke(self, input: Sequence[BaseMessage], /) -> BaseMessage: ...


def describe_outcome(view: Mapping[str, Any]) -> str:
    """What the model is told after a person decides. Plain facts, so it reports them honestly."""
    status = view.get("status")
    execution = view.get("execution") or {}
    who = view.get("decidedBy") or "an approver"
    if status == "done" and execution.get("status") == "done":
        return f"Approved by {who}. The gateway ran it: {execution.get('result')}"
    if status == "done":
        failure = execution.get("result")
        return f"Approved by {who}, but running it failed: {failure}. Do not retry; tell the user."
    if status == "rejected":
        return f"Rejected by {who}. Nothing was run. Tell the user it was not approved."
    if status == "expired":
        return "Nobody approved it before it expired. Nothing was run."
    return f"The approval ended as {status}: {view.get('outcome')}. Nothing was run."


def build_graph(
    model: ChatModel,
    gateway: GatewayClient,
    local_tools: Mapping[str, BaseTool],
    checkpointer: Any,
) -> Any:
    def agent(state: MessagesState) -> dict[str, list[BaseMessage]]:
        return {"messages": [model.invoke(state["messages"])]}

    def gated_tools(state: MessagesState, config: RunnableConfig) -> dict[str, list[BaseMessage]]:
        thread_id = config["configurable"]["thread_id"]
        last = state["messages"][-1]
        assert isinstance(last, AIMessage)
        results: list[BaseMessage] = []
        for call in last.tool_calls:
            name, call_id = call["name"], call["id"] or ""
            args = dict(call["args"])
            reason = args.pop("reason", None)
            results.append(
                ToolMessage(_run_one(name, call_id, args, reason, thread_id), tool_call_id=call_id, name=name)
            )
        return {"messages": results}

    def _run_one(name: str, call_id: str, args: dict[str, Any], reason: Any, thread_id: str) -> str:
        try:
            decision = gateway.request_tool_call(
                name, args, reason=str(reason) if reason else None, idempotency_key=f"{thread_id}:{call_id}"
            )
        except GatewayError as e:
            return f"The approval gateway could not be reached ({e}). Nothing was run."
        if decision.action == "deny":
            return f"Refused by policy: {decision.reason}. Do not try this tool again."
        if decision.action == "allow":
            local = local_tools.get(name)
            if local is None:
                return f"Policy allows {name}, but this agent has no implementation of it."
            return str(local.invoke(args))
        approval = decision.approval or {}
        # Pauses here. The value passed to Command(resume=...) comes back as `outcome`.
        outcome = interrupt(
            {
                "approval_id": approval.get("id"),
                "tool": name,
                "args": args,
                "card": approval.get("card"),
            }
        )
        return describe_outcome(outcome)

    def route(state: MessagesState) -> str:
        last = state["messages"][-1]
        return "tools" if isinstance(last, AIMessage) and last.tool_calls else END

    graph = StateGraph(MessagesState)
    graph.add_node("agent", agent)
    graph.add_node("tools", gated_tools)
    graph.add_edge(START, "agent")
    graph.add_conditional_edges("agent", route, ["tools", END])
    graph.add_edge("tools", "agent")
    return graph.compile(checkpointer=checkpointer)
