---
description: Explicit per-action-class policy. AUTO acts silently; ASK asks once; NEVER blocks. Hard-rule precheck (privacy / >$1k / health/legal) always runs first and cannot be bypassed.
type: reference
---

<!-- BEGIN compact-summary (Dream-maintained — DO NOT EDIT BY HAND) -->
AUTO: spotify-queue, spotify-skip, gmail-archive, github-mark-read
NEVER: gmail-send-new-thread, calendar-delete-event-with-attendees, shell-rm-recursive
<!-- END compact-summary -->

# Policies

User-editable. Comments allowed (anything after `#`). First match wins per class. Hard rules cannot be bypassed.

Action class slug derivation: `system/scripts/lib/actions/classify.js`. Earned trust evidence: `user-data/memory/self-improvement/action-trust.md`.

## AUTO

- spotify-queue          # queue songs without confirming
- spotify-skip
- gmail-archive          # archive only — never delete
- github-mark-read

## ASK

- gmail-reply-to-known-sender   # earned-trust may promote; default cautious
- calendar-create-event

## NEVER

- gmail-send-new-thread             # explicit user override
- calendar-delete-event-with-attendees
- shell-rm-recursive
