"""Test doubles: a scripted chat model and an in-memory gateway behind httpx.MockTransport.
The fake gateway mirrors the real API's contract (status codes, idempotency, approval view)."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any

import httpx
import pytest
from langchain_core.messages import AIMessage, BaseMessage

from approval_agent.gateway import GatewayClient


class ScriptedModel:
    """Returns the given replies in order and records what it was shown."""

    def __init__(self, replies: list[AIMessage]) -> None:
        self.replies = list(replies)
        self.seen: list[list[BaseMessage]] = []

    def invoke(self, messages: list[BaseMessage]) -> BaseMessage:
        self.seen.append(list(messages))
        if not self.replies:
            raise AssertionError("model called more times than scripted")
        return self.replies.pop(0)


def tool_call(name: str, args: dict[str, Any], call_id: str = "call-1") -> AIMessage:
    return AIMessage(
        content="", tool_calls=[{"name": name, "args": args, "id": call_id, "type": "tool_call"}]
    )


@dataclass
class FakeGateway:
    policy: dict[str, str] = field(
        default_factory=lambda: {
            "lookup_customer": "allow",
            "issue_refund": "approval",
            "send_invoice": "approval",
        }
    )
    approvals: dict[str, dict[str, Any]] = field(default_factory=dict)
    by_key: dict[str, str] = field(default_factory=dict)
    posts: list[dict[str, Any]] = field(default_factory=list)
    gets: int = 0
    down: bool = False

    def handler(self, request: httpx.Request) -> httpx.Response:
        if self.down:
            raise httpx.ConnectError("connection refused")
        if request.method == "POST" and request.url.path == "/v1/tool-calls":
            body = json.loads(request.content)
            key = request.headers.get("idempotency-key")
            self.posts.append({"key": key, **body})
            rule = self.policy.get(body["tool"])
            if rule is None:
                return httpx.Response(
                    403, json={"decision": "deny", "reason": f'tool "{body["tool"]}" is not in the policy'}
                )
            if rule == "allow":
                return httpx.Response(200, json={"decision": "allow"})
            if key in self.by_key:  # same key: same approval, no new card
                return httpx.Response(
                    202, json={"decision": "pending_approval", "approval": self.approvals[self.by_key[key]]}
                )
            approval_id = f"{len(self.approvals) + 1:016x}"
            self.approvals[approval_id] = {
                "id": approval_id,
                "tool": body["tool"],
                "args": body["args"],
                "card": f"Approval needed: {body['tool']}",
                "status": "pending",
                "outcome": None,
                "decidedBy": None,
                "execution": None,
            }
            if key:
                self.by_key[key] = approval_id
            return httpx.Response(
                202, json={"decision": "pending_approval", "approval": self.approvals[approval_id]}
            )
        if request.method == "GET" and request.url.path.startswith("/v1/approvals/"):
            self.gets += 1
            approval = self.approvals.get(request.url.path.rsplit("/", 1)[1])
            return (
                httpx.Response(200, json=approval)
                if approval
                else httpx.Response(404, json={"error": "approval not found"})
            )
        return httpx.Response(404, json={"error": "not found"})

    def decide(self, approval_id: str, status: str, execution: dict[str, Any] | None = None) -> None:
        self.approvals[approval_id].update(
            status=status, decidedBy="1001", outcome="decided", execution=execution
        )

    @property
    def cards_sent(self) -> int:
        return len(self.approvals)


@pytest.fixture
def fake_gateway() -> FakeGateway:
    return FakeGateway()


@pytest.fixture
def client(fake_gateway: FakeGateway) -> GatewayClient:
    http = httpx.Client(base_url="http://gateway", transport=httpx.MockTransport(fake_gateway.handler))
    return GatewayClient("http://gateway", "agent-key", client=http, sleep=lambda _s: None)
