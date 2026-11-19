"""CLI tests. WHY: wrong usage fails with a clear message; config comes from an env file without
overriding what is already set; resuming a thread that isn't paused says so instead of hanging."""

from __future__ import annotations

import os
from pathlib import Path

import httpx
import pytest
from langchain_core.messages import AIMessage, HumanMessage
from langgraph.checkpoint.memory import InMemorySaver

from approval_agent.gateway import GatewayClient, GatewayError
from approval_agent.graph import build_graph
from approval_agent.run import _load_env_file, main
from tests.conftest import FakeGateway, ScriptedModel, tool_call


def test_usage_errors_exit_with_a_message(capsys: pytest.CaptureFixture[str]) -> None:
    with pytest.raises(SystemExit):
        main([])
    assert "give a message" in capsys.readouterr().err
    with pytest.raises(SystemExit):
        main(["--resume"])
    assert "--resume needs --thread" in capsys.readouterr().err


def test_env_file_fills_gaps_but_never_overrides(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    env = tmp_path / ".env"
    env.write_text("# comment\nAA_GATEWAY_TEST=from-file\nAA_ALREADY_SET=from-file\n\n", encoding="utf-8")
    monkeypatch.setenv("AA_ALREADY_SET", "from-shell")
    monkeypatch.delenv("AA_GATEWAY_TEST", raising=False)
    _load_env_file(str(env))
    assert os.environ["AA_GATEWAY_TEST"] == "from-file"
    assert os.environ["AA_ALREADY_SET"] == "from-shell"
    monkeypatch.delenv("AA_GATEWAY_TEST")


def test_resuming_a_thread_that_is_not_paused_says_so(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.delenv("ENV_FILE", raising=False)
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    monkeypatch.setenv("AGENT_API_KEY", "agent-key")
    assert main(["--resume", "--thread", "never-started"]) == 1
    assert "Nothing is paused" in capsys.readouterr().out


def test_an_allowed_tool_without_a_local_implementation_is_reported(
    fake_gateway: FakeGateway, client: GatewayClient
) -> None:
    fake_gateway.policy["lookup_transactions"] = "allow"
    model = ScriptedModel([tool_call("lookup_transactions", {}), AIMessage("ok")])
    result = build_graph(model, client, {}, InMemorySaver()).invoke(
        {"messages": [HumanMessage("x")]}, {"configurable": {"thread_id": "t"}}
    )
    assert "no implementation" in result["messages"][-2].content


def test_network_errors_and_non_json_bodies_become_gateway_errors() -> None:
    def broken(_r: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused")

    c = GatewayClient(
        "http://g", "k", client=httpx.Client(base_url="http://g", transport=httpx.MockTransport(broken))
    )
    with pytest.raises(GatewayError, match="refused"):
        c.get_approval("0" * 16)
    html = httpx.MockTransport(lambda _r: httpx.Response(502, text="<html>bad gateway</html>"))
    c2 = GatewayClient("http://g", "k", client=httpx.Client(base_url="http://g", transport=html))
    with pytest.raises(GatewayError, match="502"):
        c2.request_tool_call("issue_refund", {}, reason=None, idempotency_key="k")
