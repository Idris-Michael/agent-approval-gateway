## What and why

<!-- One or two sentences. Link the issue or decision record if there is one. -->

## Risk checklist

- [ ] Does this change what an agent can do without approval? (policy, `requiresApproval`, argument limits)
- [ ] Does it touch signing, the claim, expiry or the audit chain? If so, which test proves the guarantee still holds?
- [ ] Could it put a secret, bot token or approver id into logs, errors, the repo or Terraform state?
- [ ] New runtime dependency in the gateway? (ADR 5 says none; explain if so)
- [ ] Docs updated: README results, runbook, security questionnaire, ADRs

## How it was tested

<!-- Commands run and what they showed. Live runs: say what was real and what was a stub. -->
