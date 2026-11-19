# Engagement brief

> **The customer is fictional.** "Northgate Lending" is an invented UK consumer lender used to frame
> the work the way a forward-deployed engagement would be framed. The code, tests and results are real.

## The problem
Northgate's support team wants an AI agent to handle routine customer requests: look up an account,
explain a payment, and put mistakes right. Putting mistakes right means moving money (refunds) or
billing customers (invoices). Compliance will not allow an AI system to do either on its own.

They need the agent to be useful without being trusted with money.

## Stakeholders
| Role | Cares about |
|---|---|
| Head of Customer Operations (sponsor) | Faster resolution of routine cases without adding headcount |
| Finance lead (approver) | Deciding quickly, from a phone, with the real figures in front of them |
| Compliance | A named person approves every movement of money, and the record can't be altered |
| Information security | The agent can't reach payment credentials; nothing new is exposed to the internet |
| Platform engineering | Something small they can run, monitor and hand over |

## Success criteria (agreed up front)
1. No refund or invoice runs without a named approver deciding on that exact request.
2. What the approver sees is exactly what runs: same tool, same arguments.
3. A request the payments system can't execute as shown is refused before anyone is asked.
4. Each approved action runs once, even with double taps, retries, restarts or two processes.
5. Every request and decision is in an audit record that shows any later edit.
6. Tools the policy doesn't list are refused, whatever the agent asks for.

## Constraints
- Approvers decide on their phones; most refunds are small and time-sensitive.
- The agent framework is LangGraph (Python). The platform team prefers small services with few
  dependencies.
- No inbound internet exposure for the approval path.
- This phase is a working pilot on stub payment and customer systems, not production.

## Outcome (pilot)
All six criteria are met and covered by automated tests (84 TypeScript, 21 Python). In a live run
on a phone, a local model found a duplicate £40 charge, asked to refund it, paused until the finance
lead approved, and the gateway issued it once. See the [README](../../README.md#results) for the
evidence and [what broke](../../README.md#what-broke) on the way.

## Out of scope for the pilot
Production deployment, real payment and customer APIs, Teams or Slack approval, two-person approval
for large amounts, external anchoring of the audit log. Each is listed in the [handover](handover.md).
