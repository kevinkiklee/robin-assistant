---
name: memory-curation
description: How to decide what is worth remembering and where to store it (event, belief, or knowledge note) so recall stays useful. Use when capturing something durable or writing a knowledge entry.
metadata:
  version: "1.0"
---

# Memory curation

Robin's value is its memory. Noise degrades recall as much as missing facts do. This skill is how to decide **whether** to store something, **where**, and **how to shape it**.

## What is worth remembering

Store something only if it is **durable** and **not trivially re-derivable**:

- **Yes:** stable preferences, decisions and their rationale, commitments and deadlines, relationships between people/projects/tools, corrections, hard-won facts that were expensive to discover.
- **No:** things already in the code, git history, or a file Robin can re-read; one-off chatter; anything that will be stale in a day; secrets/credentials.

Test: *"If I recall this in three months, will it still be true and still save real work?"* If not, don't store it. If you're storing something obvious, ask what was actually non-obvious about it and store that instead.

## Where it goes

Robin has distinct memory surfaces — pick the narrowest one that fits:

- **Event** (`remember`) — an observation or fact at a point in time. Append-only log; feeds recall + the entity graph. Default for "this happened / this is true."
- **Belief** (`believe` / `recall_belief`) — a topic-keyed claim that **changes over time** and where you want *current truth*, not history. Use a dotted topic key (e.g. `project.x.status`); new beliefs supersede old ones. Use this instead of an event when the thing has a single evolving answer.
- **Knowledge note** — a durable, editable document at `user-data/content/knowledge/<topic>.md` with frontmatter `node_type: memory`. Use for things that need structure and curation over time: profiles, project follow-ups, reference material. Prefer updating an existing note over creating a near-duplicate.

When unsure between event and belief: if you'd ask "what's the latest…?", use a belief; if you'd ask "what happened / what did we learn?", use an event.

## How to shape an entry

- **Self-contained:** a recall hit is read without its original context. Spell out who/what/when; resolve relative dates to absolute ones.
- **One fact per unit.** Don't bundle unrelated claims — they can't be superseded or recalled independently.
- **Lead with the fact**, then (for guidance/decisions) *why* it's true and *how to apply* it.
- **Link related memory** by name/topic so the graph connects.
- **Capture the why, not just the what** — a decision without its rationale gets re-litigated.

## Maintenance

- Before adding, check for an existing entry that already covers it — update rather than duplicate.
- When something is corrected, record the correction (`record_correction`) and supersede/fix the stale memory; don't leave both.
- Delete memory that turns out to be wrong. Wrong memory is worse than none.
