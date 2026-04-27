# Capture Rules

Capture significant facts, preferences, decisions, and learnings into the right file as they surface in conversation **or as you derive them from analysis**. Silent. Same turn as your response. No announcements.

## Capture bar

Would a good human assistant remember this for next time? If yes, write it down.
- Only persist facts useful in a future session
- Don't capture what's already in context and won't matter next time
- Wait for recurrence or significance before storing vendors/contacts
- Never announce captures — silent competence
- Capture positive signals too — not just mistakes. "Yes exactly", accepting a non-obvious approach without pushback, explicit style feedback ("just do it", "more detail") are preference data

## Routing

| Signal | Destination |
|--------|------------|
| Fact about the user (identity, preferences, goals, routines, people) | `profile.md` (appropriate section) |
| Task or commitment (action items, deadlines, reminders) | `tasks.md` |
| Reference knowledge (vendors, medical, locations, financial facts) | `knowledge.md` (appropriate section) |
| Decision made (choice + reasoning) | `decisions.md` |
| Correction to the assistant (what you did wrong, what to do instead) | `self-improvement.md` -> `## Corrections` |
| Positive signal about Robin's approach (style, format, level of detail) | `self-improvement.md` -> `## Preferences` |
| Reflective observation or daily note | `journal.md` |
| Trip details (dates, flights, lodging, itinerary, packing) | `trips/<slug>.md` |
| Everything else (unclear classification, fleeting thought) | `inbox.md` |

When unsure, use `inbox.md`. Dream and System Maintenance will sort it later.

When Dream routes an entry from one file to another, the entry's ID stays the same — only the index entry moves between sidecar files.

## Derived-analysis auto-capture

When you produce a multi-step derivation — a user profile, gap analysis, pattern detection, recurring-spot inventory, location map, trip log built from data, etc. — extract the durable insights and capture them in the same turn that you surface the analysis. Don't wait for the user to ask "save that."

Same rule as Trip auto-creation, applied to derivations: if the result is worth surfacing in the response, the durable parts are worth persisting.

Extract and route:

| Type of finding | Destination |
|---|---|
| Identity / profile facts about the user | `profile.md` |
| Recurring patterns and preferences | `profile.md`, or `self-improvement.md` → `## Preferences` |
| Reference inventories (paths, accounts, recurring locations, app usage) | `knowledge.md` |
| Project state with goals or gaps | `tasks.md` (active work) or a dedicated section in `profile.md` (ongoing initiative) |
| Long-form artifact (the full analysis, raw data, exports) | `artifacts/<YYYY-MM-DD-topic>/` — and surface the path inline so the user can find it |

Two constraints:
- Capture files hold the **durable distillation**, not the full analysis. They point to the artifact path for the long form.
- If a finding overlaps with an existing entry, update in place. Don't create near-duplicates.

This is the same silent-competence default as Trip auto-creation: the structure should already exist when the user asks "did you save that?"

## Trip auto-creation

When the user mentions an upcoming trip with at least a destination AND a rough date window — even casually, even as part of another question — create `trips/<slug>.md` immediately, same turn, silently. Slug format: `<destination>-<month>-<year>` (e.g., `cali-may-2026`, `tokyo-oct-2026`).

Seed the file with sections: Overview, Logistics (Flights / Lodging / Ground transport), Itinerary table covering the full date range, Photography (if relevant to the user), Open questions / TODO, Notes. Populate with whatever is known; leave the rest as `_Not yet booked_` or `_Add as trip details surface._`.

Also keep the one-line trip pointer in `profile.md` under the relevant Travel section so it surfaces in briefings.

Don't wait for the user to ask for a trip file. The point is silent competence — the structure should already exist when they need it.

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

## Index maintenance

After writing an entry to any data file, also append an index entry to the corresponding sidecar file at `index/<file>.idx.md`:

1. Generate an entry ID in `YYYYMMDD-HHMM-<session><seq>` format and embed it in the source file (inline `<!-- id:... -->` for list items, comment line before block entries)
2. Append to the sidecar index with: `id`, `domains` (from controlled vocabulary: work, personal, finance, health, learning, home, shopping, travel), `tags` (lowercase, hyphen-separated, `firstname-lastname` for people), `related` (obvious connections only — Dream discovers subtler ones), `summary` (one line for append-only entries), `enriched: true`
3. For trip auto-creation, also append to `index/trips.idx.md`

If the index write fails, the source entry still stands — source files are always authoritative. Dream's integrity check reconciles on next run.
