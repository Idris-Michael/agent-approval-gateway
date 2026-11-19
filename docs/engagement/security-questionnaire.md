# Security questionnaire answers

The questions a customer's information security team typically sends before a pilot, answered for
this system as built. Where something is not built, the answer says so.

## Architecture and data flow

**What does the system do?**
It sits between an AI agent and the systems the agent acts on. Every tool call the agent wants to
make is checked against a policy. Read-only calls are allowed; unlisted calls are refused; sensitive
calls are sent to a named person for approval and, if approved, run by the gateway itself.

**Where does data go?**
1. Agent → gateway (HTTP, local network): tool name, arguments, a short reason.
2. Gateway → Telegram (HTTPS, outbound): the approval card, which contains the tool name and the
   arguments, for example an amount and a customer id.
3. Telegram → gateway (HTTPS, outbound long polling): the approver's button tap.
4. Gateway → payments system (in the pilot, an in-memory stub): the approved arguments.

**Does any data leave our environment?**
Yes: card contents pass through Telegram's servers. For a regulated deployment, replace the
Telegram transport with one inside the customer's tenancy (Teams, Slack Enterprise Grid, or an
internal web page with SSO). The transport is a two-method interface for that reason (ADR 6).
In the pilot the model runs locally on Ollama, so prompts and customer data do not go to a model
provider.

**What is stored, where, and for how long?**
| Store | Contents | Retention |
|---|---|---|
| `approvals.db` (SQLite) | Cards: tool, arguments, status, approver id, outcome | Not pruned; set a policy |
| `queue.db` (SQLite) | Approved tasks and their results | Not pruned; set a policy |
| `audit.jsonl` | Every request and decision, hash-chained | Keep for the regulatory period; never edit |
| Agent checkpoints (SQLite) | The agent's conversation state per thread | Not pruned; set a policy |

**Is data encrypted at rest?**
Not by the application. Run it on an encrypted volume (BitLocker, LUKS, cloud disk encryption).
In transit, Telegram traffic is HTTPS; agent-to-gateway is plain HTTP on localhost in the pilot and
must be TLS (or a private network with mTLS) if the two run on different hosts.

## Identity and access

**How are callers authenticated?**
API keys of at least 24 characters, compared in constant time on their SHA-256 hashes. Two scopes:
`agent` keys can raise tool calls and read their own approvals; `viewer` keys can read the queue
and the audit status. Each key is rate-limited per minute.

**How are approvers authenticated?**
By their Telegram user id, checked against the approver group for that tool in the policy. Button
data is signed with HMAC-SHA256 over the card id and the decision, so a button can't be forged,
reused on another card, or switched from reject to approve. The weak point is the approver's
Telegram account itself; require 2-step verification, or move to an SSO-backed transport.

**Can one person approve their own request?**
The agent raises requests, not people, so self-approval in the usual sense doesn't arise. Two-person
approval for large amounts is not built (see handover).

**Where are secrets kept?**
Environment variables, loaded from a file outside the repository in the pilot. The service refuses
to start if any is missing or too short. In Azure or AWS they belong in Key Vault or Secrets
Manager (the Terraform in `infra/` does this). The bot token is scrubbed from every error message.

## Logging and monitoring

**What is logged?**
One JSON line per HTTP request: time, request id, method, path, status, duration, and the API key's
*name* (never the key). Errors go to stderr as JSON. Internal error details are logged, not
returned to callers.

**Can the audit trail be tampered with?**
Editing, inserting, deleting or reordering a line is detected and located (`/v1/audit`, and tests
in `test/audit.test.ts`). Removing lines from the end is not detected without an external copy of
the latest hash; anchoring it in WORM storage is recommended and not built.

## AI-specific risks (OWASP Top 10 for LLM Applications, 2025)

| Risk | How this system responds |
|---|---|
| LLM01 Prompt injection | Injected instructions can make the agent *ask* for anything, but unlisted tools are refused, arguments must fit a schema with limits, and sensitive actions need a person who sees the real arguments. |
| LLM02 Sensitive information disclosure | Card contents go to the approver channel only. Keep arguments to what an approver needs; the Telegram residency point above applies. |
| LLM05 Improper output handling | Model output never reaches an executor directly: it is schema-checked, shown to a person, and passed as data, not code. Cards are plain text. |
| LLM06 Excessive agency | The core of the design: default-deny policy, per-tool approvers, limits as policy, and credentials held by the gateway, not the agent (ADR 1). |
| LLM09 Misinformation | The agent is told the actual outcome after each decision ("Rejected... Nothing was run"), so it reports results instead of guessing. In the live run its answer matched the gateway's record. |
| LLM10 Unbounded consumption | Per-key rate limits and request size limits on the gateway. Model token budgets are not enforced here. |

LLM03, LLM04, LLM07 and LLM08 concern model supply chain, training data, system prompts and
vector stores, which this component does not touch.

## Supply chain
The gateway has no runtime dependencies (ADR 5). The Python agent depends on LangGraph,
LangChain Core, langchain-ollama and httpx, pinned in `python/uv.lock`.

## Known gaps (stated, not hidden)
- Card contents leave the environment through Telegram.
- No encryption at rest inside the application.
- Single host (SQLite); see ADR 3 for the multi-instance path.
- Audit tail truncation is not detected without external anchoring.
- No two-person approval for high-value actions.
- Not deployed; Terraform is validated offline only.
