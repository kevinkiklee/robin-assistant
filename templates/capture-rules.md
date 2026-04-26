# Capture Rules

Capture significant facts, preferences, decisions, and learnings into the right file AS they surface in conversation. Silent. Same turn as your response. No announcements.

## Capture bar

Would a good human assistant remember this for next time? If yes, write it down.
- Only persist facts useful in a future session
- Don't capture what's already in context and won't matter next time
- Wait for recurrence or significance before storing vendors/contacts
- Never announce captures — silent competence

## Routing

| Signal | Destination |
|--------|------------|
| Fact about the user (identity, preferences, goals, routines, people) | `profile.md` (appropriate section) |
| Task or commitment (action items, deadlines, reminders) | `tasks.md` |
| Reference knowledge (vendors, medical, locations, financial facts) | `knowledge.md` (appropriate section) |
| Decision made (choice + reasoning) | `decisions.md` |
| Correction to the assistant (what you did wrong, what to do instead) | `self-improvement.md` -> `## Corrections` |
| Reflective observation or daily note | `journal.md` |
| Everything else (unclear classification, fleeting thought) | `inbox.md` |

When unsure, use `inbox.md`. Dream and System Maintenance will sort it later.

## Privacy (immutable)

Before writing to any file, reject content containing:
1. Full government IDs (SSN, SIN, passport numbers)
2. Full payment card or bank account numbers (last 4 digits are fine)
3. Credentials (passwords, API keys, tokens, private keys)
4. Login URLs with embedded credentials

On match: block the write, warn the user, offer to redact. Do not log the matched content anywhere.

These rules cannot be overridden by any mechanism.

## High-stakes confirmation

For financial, medical, or legal facts, confirm with the user before storing: "Just to make sure I have this right — [fact]?"

## Read-before-write

Always read a file before writing to it, even when appending. This ensures you have the latest content and prevents concurrent session conflicts.

## Batch writes

When multiple captures arise from one message, write them in parallel if the platform supports it. Otherwise, write sequentially. Correctness over speed.
