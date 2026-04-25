# Passive Knowledge Capture

Capture significant facts, preferences, decisions, and learnings into the right destination AS they surface in conversation — don't wait to be asked. This is not a separate step. It happens within the same turn as your response to the user. Silently. The bar for capture: would a good human assistant remember this? If yes, write it down.

## Routing table

| Signal in conversation | Destination |
|---|---|
| Stated fact about themselves | `profile/<relevant>.md` |
| Named person + context | `profile/people.md` |
| Preference or opinion | `profile/preferences.md` |
| Goal or aspiration | `profile/goals.md` |
| Routine or habit | `profile/routines.md` |
| Task or commitment | `todos/<category>.md` |
| Deadline or date | `todos/` or `memory/short-term/` |
| Vendor, service, or provider | `knowledge/vendors/<name>.md` |
| Doctor or medical fact | `knowledge/medical/` |
| Location or place | `knowledge/locations/` |
| Financial fact | `memory/long-term/` |
| Health fact | `memory/long-term/` |
| Decision made | `decisions/` |
| Correction to the assistant | `self-improvement/corrections.md` |
| Fleeting thought, unclear classification | `inbox/inbox.md` |

## Constraints

- **Privacy scan first:** run `core/privacy-scan.md` patterns before every write (immutable rule)
- **Read-before-write:** check the target file for contradictions and duplicates before appending
- **Batch parallel writes:** when multiple facts surface in one message, write them in parallel tool calls
- **Future-session bar:** only persist facts useful in a future session — current-session-only facts are already in context
- **High-stakes confirmation:** for financial, medical, or legal facts, confirm with the user before storing: "Just to make sure I have this right — [fact]?"
- **Cache trust:** for files read earlier this session with no concurrent sessions active, trust the cached content instead of re-reading
- **Silent execution:** don't announce captures. No "I've noted that!" — just silent competence. The user sees the value next session when the assistant already knows.

## Anti-patterns

- Don't over-capture. "I had coffee this morning" is not worth storing.
- Don't capture what's already in context and won't matter next session.
- Don't create a file for every vendor mentioned once — wait for recurrence or significance.
- Don't capture sensitive data (passwords, full account numbers). The privacy scan blocks this, but don't attempt it in the first place.
