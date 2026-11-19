# 4. Hash-chained JSON Lines audit log

Status: accepted

## Context
Compliance needs to show who approved what, and that the record has not been altered since.

## Decision
Every gate event (requested, refused, claimed, done, rejected, failed, expired) is appended to a
JSON Lines file. Each entry holds the SHA-256 of the previous entry and a hash of its own content,
including a hash of the approved arguments. `verifyAudit` walks the chain and names the first broken
line. The service refuses to start appending to a log that fails verification.

## Consequences
- Editing, inserting, deleting or reordering any line is detected, even if the editor recomputes
  that line's own hash.
- Cutting lines off the end leaves a valid shorter chain. The head hash should be copied somewhere
  the gateway can't rewrite (WORM storage such as S3 Object Lock or Azure immutable blobs, or a
  daily message to a separate channel). Not built here.
- One writer per file. Several instances would each need their own chain or a central log service.
