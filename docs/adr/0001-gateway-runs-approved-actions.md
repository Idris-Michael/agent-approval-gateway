# 1. The gateway runs approved actions, not the agent

Status: accepted

## Context
An agent that asks for approval and then runs the action itself still holds the credentials for
that action. A prompt injection, a bug, or a model that skips the approval step could then move
money with no person involved.

## Decision
Sensitive tools exist in the agent only as schemas. Their executors (the code that calls the
payments API) live in the gateway. On approval the gateway puts the approved arguments on its own
queue and runs them with its own credentials. The agent waits and is told the outcome.

## Consequences
- The agent process can be fully compromised and still cannot issue a refund without a person.
- The gateway becomes the component to protect, deploy carefully and audit. It is small on purpose.
- Adding a sensitive tool means two changes: a policy entry and an executor in the gateway.
