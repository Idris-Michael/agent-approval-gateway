# Runbook

## Configuration
All settings are environment variables. The gateway checks them all at start-up and lists every
missing one before exiting.

| Variable | Purpose |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Bot that sends cards (from @BotFather) |
| `APPROVER_CHAT_ID` | Chat the cards go to |
| `FINANCE_APPROVER_ID`, `OPS_APPROVER_ID` | Approver user ids, referenced from the policy as `env:...` |
| `APPROVAL_HMAC_SECRET` | Signs card buttons; at least 32 characters (`openssl rand -hex 32`) |
| `AGENT_API_KEY`, `VIEWER_API_KEY` | API keys, at least 24 characters |
| `POLICY_PATH` | Policy file (default `examples/policy.json`) |
| `DATA_DIR` | Where the databases and audit log live (default `data`) |
| `PORT`, `HOST` | Listen address (default `127.0.0.1:8787`) |

## Start and stop
```bash
ENV_FILE=/secure/path/gateway.env npm run demo      # gateway with the stub executors
```
Stop with Ctrl+C (SIGINT) or SIGTERM; the worker and poller stop and the databases close. On
Windows, if the gateway was started from a wrapper that was killed, check nothing still holds the
port before restarting: `netstat -ano | findstr :8787`.

## Health
- `GET /healthz` returns `{"ok":true}`.
- `GET /v1/audit` (viewer key) returns the audit chain status. Alert if `ok` is ever `false`.
- The console at `/` shows pending, all and failed approvals and the audit status.

## Common situations

**An approver says they never got a card.**
The agent received a 502 `delivery_failed` and the card is stored as `failed` with the reason.
Check the Telegram token and chat id, then let the agent raise the request again.

**A card expired.**
Expiry is per tool in the policy (refunds: 24 hours). Expired cards are closed on the next tap and
nothing runs. The agent's thread is told it expired.

**An approved action failed.**
The task is retried up to 3 times for ordinary errors. For outages (provider down) it waits and
retries every 5 minutes without using up attempts, for up to 24 hours. The approver gets one
"waiting" message and one final "failed" message, not one per retry. A failed approval is never
retried from the card, because a timed-out payment may still have gone through: check the payments
system first, then raise a new request if needed.

**The gateway crashed mid-action.**
On restart, tasks caught in progress are re-queued and run again (at-least-once), with the same
idempotency key passed to the payments API. A task that crashes the process 3 times is stopped.

**The audit check fails.**
The service will not start appending to a broken log. Do not edit the file to "fix" it. Preserve
it, report it as a security incident, start a new log in a new `DATA_DIR`, and compare the broken
chain with any external copy of the head hash.

## Rotating secrets
- **API keys:** add the new key, move callers over, remove the old one, restart.
- **HMAC secret:** every pending card's buttons stop working (they were signed with the old
  secret). Rotate when the queue is empty, or accept that pending requests must be raised again.
- **Bot token:** revoke in @BotFather (`/revoke`), set the new one, restart.
