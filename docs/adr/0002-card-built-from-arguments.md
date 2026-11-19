# 2. Cards are built from the arguments, and arguments are checked against a schema

Status: accepted (schema added after a live-run bug, see below)

## Context
In the system this was ported from, the agent wrote the approval card's text. An agent could
describe a £4,000 refund as "a small goodwill refund" and the approver would see only the words.

## Decision
The card is rendered from the tool name and the structured arguments, with the agent's own
explanation shown last and labelled "Agent's reason". Values too long to show in full are
refused, not cut. Each tool in the policy can declare an argument schema (types, required fields,
min/max, allowed values, no unknown fields). The API rejects a non-matching call with 422 and a
list of every problem before any card is sent; the gate checks again for direct library callers.

## What prompted the schema
In the first live run the agent sent `amount_gbp` and `customer_id` while the demo executor read
`amountGbp` and `customerId`. The card was correct, the approver approved it, and the stub
reported a refund of "£undefined to customer undefined". Approving the exact arguments is not
enough if nothing checks that the arguments fit the executor. `test/argSchema.test.ts` replays it.

## Consequences
- An approver can only ever be asked about a call that can run exactly as shown.
- Limits such as "refunds above £500 are refused" are policy data that compliance can review.
- Executors should still validate their own input (the demo ones do), as a second line of defence.
