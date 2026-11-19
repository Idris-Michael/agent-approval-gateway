# 5. No runtime dependencies in the gateway

Status: accepted

## Context
The gateway is the component that holds payment credentials. Every runtime dependency is supply
chain surface that a security review has to clear.

## Decision
Use Node's standard library only: `node:http` for the API, `node:sqlite` for storage, `node:crypto`
for HMAC and hashing, `fetch` for Telegram. The policy is JSON (not YAML) so no parser is needed.
Validation is hand-written and small (`src/argSchema.ts`, `src/policy.ts`).

## Consequences
- `npm ls --omit=dev` is empty. TypeScript, tsx and @types/node are build and test tools only.
- More code to own (routing, validation) than with a framework. It is kept to a few hundred lines
  and covered by tests, which is the trade this component should make.
- The Python agent is a separate package with its own dependencies (LangGraph, httpx); it holds no
  credentials for sensitive actions.
