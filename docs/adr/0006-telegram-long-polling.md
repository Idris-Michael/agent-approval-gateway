# 6. Telegram over long polling, behind a transport interface

Status: accepted for the demo; Teams or Slack expected in a real deployment

## Context
Approvers need a card on their phone. A webhook needs a public HTTPS endpoint into the gateway,
which widens its exposure.

## Decision
The Telegram transport long-polls `getUpdates` for button taps, so the gateway makes only outbound
connections. Cards are sent as plain text (no markup parsing), buttons are removed when a card
closes, each tap is answered once, and the bot token is scrubbed from every error message.
Transports implement a two-method interface (`send`, `edit`), so Teams, Slack or email links can
replace Telegram without touching the gate.

## Consequences
- No inbound port is needed for approvals.
- Card text, including customer ids and amounts, passes through Telegram's servers. That is a data
  residency question for a regulated customer, and the main reason to swap in an SSO-backed tool.
- Approver identity is the Telegram account id, so the approver's account security (2-step
  verification) matters. An SSO-backed transport would tie approval to corporate identity.
