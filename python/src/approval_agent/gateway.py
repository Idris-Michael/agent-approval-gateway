"""HTTP client for the approval gateway. The agent asks before every tool call; it never holds
the credentials for sensitive actions, so the gateway is the only path to running them."""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any, Literal

import httpx

Action = Literal["allow", "deny", "pending_approval"]
TERMINAL = {"done", "rejected", "failed", "expired"}


class GatewayError(Exception):
    """The gateway refused the request or could not be reached. Nothing was run."""

    def __init__(self, status: int | None, message: str) -> None:
        super().__init__(f"gateway error{f' {status}' if status else ''}: {message}")
        self.status = status


@dataclass(frozen=True)
class Decision:
    action: Action
    reason: str | None = None
    approval: dict[str, Any] | None = None


class GatewayClient:
    def __init__(
        self,
        base_url: str,
        api_key: str,
        *,
        client: httpx.Client | None = None,
        timeout_s: float = 10.0,
        sleep: Any = time.sleep,
    ) -> None:
        if not api_key:
            raise ValueError("AGENT_API_KEY is not set")
        self._http = client or httpx.Client(base_url=base_url, timeout=timeout_s)
        self._headers = {"authorization": f"Bearer {api_key}"}
        self._sleep = sleep

    def request_tool_call(
        self, tool: str, args: dict[str, Any], *, reason: str | None, idempotency_key: str
    ) -> Decision:
        """Asks whether `tool` may run. The idempotency key makes a repeated ask (for example when
        LangGraph re-runs a node after resuming) return the same approval instead of a new card."""
        body: dict[str, Any] = {"tool": tool, "args": args}
        if reason:
            body["reason"] = reason
        try:
            res = self._http.post(
                "/v1/tool-calls",
                json=body,
                headers={**self._headers, "idempotency-key": idempotency_key},
            )
        except httpx.HTTPError as e:
            raise GatewayError(None, str(e)) from e
        data = _json(res)
        if res.status_code == 200:
            return Decision("allow")
        if res.status_code == 403 and data.get("decision") == "deny":
            return Decision("deny", reason=str(data.get("reason")))
        if res.status_code == 202:
            return Decision("pending_approval", approval=data["approval"])
        raise GatewayError(res.status_code, str(data.get("error", res.text)))

    def get_approval(self, approval_id: str) -> dict[str, Any]:
        try:
            res = self._http.get(f"/v1/approvals/{approval_id}", headers=self._headers)
        except httpx.HTTPError as e:
            raise GatewayError(None, str(e)) from e
        data = _json(res)
        if res.status_code != 200:
            raise GatewayError(res.status_code, str(data.get("error", res.text)))
        return data

    def wait_for_outcome(
        self, approval_id: str, *, poll_s: float = 2.0, timeout_s: float | None = None
    ) -> dict[str, Any]:
        """Polls until a person has decided and, if approved, the gateway has finished running it."""
        waited = 0.0
        while True:
            view = self.get_approval(approval_id)
            execution = view.get("execution")
            decided = view["status"] in TERMINAL
            ran = view["status"] != "done" or (
                execution is not None and execution["status"] in ("done", "error")
            )
            if decided and ran:
                return view
            if timeout_s is not None and waited >= timeout_s:
                raise TimeoutError(f"approval {approval_id} still {view['status']} after {timeout_s}s")
            self._sleep(poll_s)
            waited += poll_s


def _json(res: httpx.Response) -> dict[str, Any]:
    try:
        data = res.json()
    except ValueError:
        return {}
    return data if isinstance(data, dict) else {}
