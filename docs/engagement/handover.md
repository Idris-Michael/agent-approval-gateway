# Handover

## What was delivered
- **Gateway** (TypeScript, Node 22.13+, no runtime dependencies): policy, signed approval cards,
  exactly-once execution, durable queue, hash-chained audit log, HTTP API, read-only console,
  Telegram transport.
- **Agent integration** (Python, LangGraph): a support agent that checks every tool call with the
  gateway and pauses for approval with `interrupt()`, with SQLite checkpoints so a paused run
  survives restarts.
- **Example policy and stub executors** for the fictional lender.
- **Documentation:** this folder, six decision records in `docs/adr/`, and the README.

## How to add a sensitive tool
1. Add it to the policy with `requiresApproval: true`, an approver group, an expiry and an `args`
   schema with limits.
2. Register an executor for it in the gateway (see `examples/lender-demo.ts`). It receives the
   approved arguments and an idempotency key; pass the key to the downstream API.
3. Give the agent a schema-only tool with the same name and argument names (see
   `python/src/approval_agent/tools.py`). The gateway refuses to start if a tool that needs approval
   has no executor.

## How to add a read-only tool
Add it to the policy with `requiresApproval: false` (and an `args` schema), then implement it in
the agent's `LOCAL_TOOLS`.

## Recommended next steps, in order
1. **Move approvals inside the tenancy:** a Teams or Slack transport tied to corporate SSO, so card
   contents stay in the customer's environment and approval is tied to a managed identity.
2. **Two-person approval** for amounts above a threshold, as a policy setting.
3. **Anchor the audit head hash** daily in WORM storage.
4. **Replace stubs** with the real payments and customer APIs, passing the idempotency key through.
5. **Retention rules** for the three SQLite stores and the agent checkpoints.
6. **Postgres** if more than one gateway instance is needed (ADR 3).

## Open risks
See "Known gaps" in the [security questionnaire](security-questionnaire.md#known-gaps-stated-not-hidden).
