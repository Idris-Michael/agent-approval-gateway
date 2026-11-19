# 3. SQLite with single-statement state changes

Status: accepted

## Context
Exactly-once execution depends on two taps (or two processes) never both winning the claim on a
card or a queued task. The original used a JSON file and relied on running in one process.

## Decision
Use Node's built-in `node:sqlite` (no native dependency). Every state change is one conditional
statement: `UPDATE approvals SET status='executing' WHERE id=? AND status='pending' AND expires_at>=?`
for cards, and `UPDATE ... WHERE id=(SELECT ... LIMIT 1) RETURNING *` for queue claims. WAL mode
and a busy timeout let the API read while the worker writes. A card's row is written before the
card is sent, so a tap can never arrive for a card the store doesn't know.

## Consequences
- Exactly-once holds across processes on one host (tested with two connections racing the claim).
- One host only. For several gateway instances, move to Postgres and claim with
  `SELECT ... FOR UPDATE SKIP LOCKED`; the store and queue are behind small interfaces for that.
- Delivery from the queue is at-least-once (a crash mid-run re-runs the task), so executors receive
  an idempotency key and must pass it to the downstream API.
