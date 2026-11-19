"""Command line: run the support agent against a local Ollama model and the approval gateway.

    uv run approval-agent "Customer C-1042 says they were charged twice in October. Sort it out."
    uv run approval-agent --resume --thread <id>     # pick up a paused run after a restart

Checkpoints live in SQLite, so a run paused for approval survives the agent process exiting."""

from __future__ import annotations

import argparse
import os
import sys
import uuid
from collections.abc import Callable
from pathlib import Path
from typing import Any

from langchain_core.messages import HumanMessage, SystemMessage
from langgraph.types import Command

from approval_agent.gateway import GatewayClient
from approval_agent.graph import build_graph
from approval_agent.tools import ALL_TOOLS, LOCAL_TOOLS

SYSTEM_PROMPT = (
    "You are a customer support agent for Northgate Lending, a fictional UK lender. "
    "Look up the customer before acting. Only refund money you can see was taken in error. "
    "Refunds and invoices need a person's approval: request them with the tool and the "
    "approval gateway handles the rest. Report outcomes exactly as the tools state them. "
    "Never claim something was done unless a tool result says so."
)


def drive(
    graph: Any,
    gateway: GatewayClient,
    config: dict[str, Any],
    first_input: Any,
    say: Callable[[str], None],
    poll_s: float = 2.0,
) -> str:
    """Runs until the graph finishes, waiting on the gateway each time it pauses for approval."""
    result = graph.invoke(first_input, config)
    while result.get("__interrupt__"):
        paused = result["__interrupt__"][0].value
        say(
            f"Paused: {paused['tool']} needs approval (approval {paused['approval_id']}). "
            "Waiting for a person..."
        )
        outcome = gateway.wait_for_outcome(paused["approval_id"], poll_s=poll_s)
        say(f"Decision: {outcome['status']} by {outcome.get('decidedBy') or 'nobody'}")
        result = graph.invoke(Command(resume=outcome), config)
    return str(result["messages"][-1].content)


def _load_env_file(path: str) -> None:
    for line in Path(path).read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            os.environ.setdefault(key.strip(), value.strip())


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="approval-agent")
    parser.add_argument("message", nargs="?", help="what the customer or colleague asked for")
    parser.add_argument("--thread", default=None, help="thread id (default: a new one)")
    parser.add_argument(
        "--resume", action="store_true", help="resume a paused thread instead of starting one"
    )
    parser.add_argument("--model", default=os.environ.get("AGENT_MODEL", "qwen2.5:7b"))
    args = parser.parse_args(argv)
    if os.environ.get("ENV_FILE"):
        _load_env_file(os.environ["ENV_FILE"])
    if not args.resume and not args.message:
        parser.error("give a message, or --resume --thread <id>")
    if args.resume and not args.thread:
        parser.error("--resume needs --thread")

    from langchain_ollama import ChatOllama
    from langgraph.checkpoint.sqlite import SqliteSaver

    gateway = GatewayClient(
        os.environ.get("GATEWAY_URL", f"http://127.0.0.1:{os.environ.get('PORT', '8787')}"),
        os.environ.get("AGENT_API_KEY", ""),
    )
    model = ChatOllama(model=args.model, temperature=0).bind_tools(ALL_TOOLS)
    data_dir = Path(os.environ.get("DATA_DIR", "data"))
    data_dir.mkdir(parents=True, exist_ok=True)
    thread_id = args.thread or f"thread-{uuid.uuid4().hex[:12]}"
    config = {"configurable": {"thread_id": thread_id}}
    say = print

    with SqliteSaver.from_conn_string(str(data_dir / "agent-checkpoints.db")) as checkpointer:
        graph = build_graph(model, gateway, LOCAL_TOOLS, checkpointer)
        say(f"Thread {thread_id}")
        if args.resume:
            state = graph.get_state(config)
            if not state.interrupts:
                say("Nothing is paused on that thread.")
                return 1
            # Re-enter the loop at the existing pause, once the person has decided
            outcome = gateway.wait_for_outcome(state.interrupts[0].value["approval_id"])
            first: Any = Command(resume=outcome)
        else:
            first = {"messages": [SystemMessage(SYSTEM_PROMPT), HumanMessage(args.message)]}
        answer = drive(graph, gateway, config, first, say)
    say(f"\nAgent: {answer}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
