# Capture Rules

## Capture checkpoint (ALWAYS READ)

After every response, scan the user's message and your response for capturable signals listed below. Write captures to `user-data/memory/inbox.md` with tags (see Inbox-first pipeline). Direct-write corrections and explicit saves. This is what separates Robin from a stateless chatbot — don't skip it.

During multi-step tool-heavy work (implementing a feature, debugging across files), buffer captures mentally and batch-write them at the next natural break — after completing the immediate task, before moving to the next topic. The checkpoint runs as part of the same turn: compose your text response, then execute capture writes as tool calls.

## Signal patterns

### Always-capture

Write immediately, no judgment needed:

- User states a name + relationship ("my dentist is Dr. Park")
- User states a date or deadline ("we leave for Tokyo on June 3rd")
- User states a preference explicitly ("I prefer X over Y", "I don't like Z")
- User makes a decision with reasoning ("I'm going with Vanguard because...")
- User gives a correction ("no, that's wrong — it's actually...")
- User says "remember this" or equivalent explicit save request
- User shares a new recurring commitment ("I have PT every Tuesday")
- User states something that contradicts or supersedes known information ("I stopped going to that gym", "my new dentist is Dr. Chen")
- Robin produces analysis with durable insights (profile observations, pattern detection, inventories, gap analyses)

### Conditional-capture

Capture if the fact would change Robin's behavior or knowledge in a future session:

- Facts mentioned in passing that aren't the topic ("...since I moved to Jersey City...")
- Opinions and reactions with lasting relevance ("that restaurant was terrible")
- Health, financial, or legal details mentioned casually
- Work context changes ("I just got promoted", "we switched to Slack")
- User exhibits a repeated behavioral pattern across interactions (consistently prefers short responses, always chooses the detailed option, etc.)

### Never-capture

- Ephemeral task context ("let's use port 3000 for this")
- Code-specific decisions that live in the code itself
- Anything already captured — dedup against files currently in context; don't read files solely to check for duplicates
- Conversation mechanics ("yes", "go ahead", "sounds good") unless confirming a non-obvious preference or approach

## Inbox-first pipeline

Most captures go to `user-data/memory/inbox.md` as lightweight tagged entries. Dream routes them to the right destination within 24 hours. This keeps per-capture cost low — append one tagged line + index entry instead of navigating file structure.

### Format

    - [tag] Content of the capture <!-- id:YYYYMMDD-HHMM-SSss -->

Examples:

    - [fact] Dentist is Dr. Park, office in downtown JC <!-- id:20260427-1430-cc01 -->
    - [preference] Prefers single bundled PRs over many small ones for refactors <!-- id:20260427-1430-cc02 -->
    - [decision] Going with Vanguard target-date fund for 401k — expense ratio was the deciding factor <!-- id:20260427-1431-cc01 -->
    - [correction] Don't summarize at the end of responses — user reads the diff <!-- id:20260427-1431-cc02 -->
    - [update] Cancelled Orange Theory membership (supersedes: gym routine in profile) <!-- id:20260427-1432-cc01 -->
    - [derived] Photography leans editorial — 60% of portfolio is environmental portraits <!-- id:20260427-1432-cc02 -->

### Tag vocabulary

| Tag | Dream routes to |
|-----|----------------|
| `[fact]` | `user-data/memory/profile.md` or `user-data/memory/knowledge.md` (Dream decides based on content) |
| `[preference]` | `user-data/memory/self-improvement.md` → `## Preferences` |
| `[decision]` | `user-data/memory/decisions.md` |
| `[correction]` | `user-data/memory/self-improvement.md` → `## Corrections` |
| `[task]` | `user-data/memory/tasks.md` |
| `[update]` | `user-data/memory/profile.md` or `user-data/memory/knowledge.md` (supersedes existing entry) |
| `[derived]` | Depends on content (Dream classifies) |
| `[journal]` | `user-data/memory/journal.md` |
| `[?]` | Unclassified — Dream treats as untagged, classifies from content |

Tags are routing hints, not binding. Dream uses the tag as a first-pass signal but verifies against the routing table. A bad tag doesn't misroute permanently.

### Multi-faceted moments

When a single moment contains multiple distinct facts, split into separate entries. Each entry is atomic — Dream routes each independently.

    - [update] Dr. Park is no longer my dentist — office moved (supersedes: dentist in user-data/memory/profile.md) <!-- id:... -->
    - [fact] New dentist is Dr. Chen, office on Main St <!-- id:... -->
    - [decision] Switched dentists because Dr. Park's office moved too far — proximity was the factor <!-- id:... -->

### `[update]` entries and supersedes hints

Update entries should include an optional `(supersedes: <hint>)` describing what they replace. Dream uses this hint to locate the original entry. Not required — Dream can search — but it speeds up resolution.

### Direct-write exceptions

These skip inbox and go to the destination file immediately:

- **Corrections** — `user-data/memory/self-improvement.md` → `## Corrections`. The assistant needs to learn from them this session, not next Dream cycle.
- **Explicit "remember this"** — user asked directly, so route to the confident destination and confirm.
- **Updates that contradict loaded context** — if the assistant knows the old fact is in a file it already read (e.g., `user-data/memory/profile.md` loaded at startup), update it in place now. Don't wait for Dream.
- **Derived-analysis findings** — the assistant just performed the analysis and knows exactly where findings belong. Follow the derived-analysis auto-capture rules below.
- **Ingest operations** — ingest is user-supervised, multi-file, and too structural for inbox-first routing. Ingest writes directly to knowledge files, creates source pages, and updates cross-references. See `system/jobs/ingest.md`.

### Confirmation behavior

| Capture type | User sees |
|-------------|-----------|
| Routine `[fact]`, `[preference]`, `[journal]` | Nothing (silent) |
| `[decision]`, `[correction]`, `[update]` | Brief inline parenthetical at end of response: *(noted — updated your dentist to Dr. Chen)* |
| High-stakes (medical, financial, legal) | Explicit verification before writing: "Just to make sure I have this right — [fact]?" |
| Explicit "remember this" | Confirmation of what was saved and where |

## Capture sweep

Safety net for missed captures. The inline checkpoint degrades over long sessions as context compacts — the sweep catches what was missed.

### Triggers

**Primary — context compaction imminent.** When you receive a signal that context is about to compact (platform-specific — e.g., Claude Code shows a compaction warning), run a mini-sweep of the conversation window that's about to be lost. This is the most important trigger — once context compacts, the detail is gone. The mini-sweep is fast: scan for obvious signal hits, tag and append to `user-data/memory/inbox.md`.

**Bonus — graceful session end.** When the user says goodbye or explicitly ends the session, run a full sweep of available context.

### Process

1. **Scan** — review available conversation context against signal patterns
2. **Cross-reference** — read `user-data/memory/inbox.md` before each sweep to dedup against prior captures (prevents duplicates across multiple compaction events)
3. **Extract** — draft tagged inbox entries for anything missed
4. **Write** — batch-append all captures to `user-data/memory/inbox.md`
5. **Handoff** — write a one-line note to `user-data/memory/self-improvement.md` → `## Session Handoff`: "Captured N items to inbox (breakdown by tag)."
6. **Hot cache** — append a session summary to `user-data/memory/hot.md` (see Hot cache section below)

## Hot cache

At session end (graceful) or context compaction, append a session summary to `user-data/memory/hot.md`. This provides seamless continuation across sessions.

### Format

```markdown
## Session — YYYY-MM-DD HH:MM TZ

**Focus:** <what the session was about>
**Key decisions:** <decisions made, if any>
**Open threads:** <what's still pending>
**Files touched:** <files created or modified, if any>
```

### Rules

- **Append-only** — each session appends its summary. No locking needed (append-only per multi-session coordination).
- **Rolling window** — Dream Phase 4 trims to the last 3 entries. Between Dream cycles, hot.md may temporarily have 4-5 entries.
- **Cap per entry** — 25 lines max. Summarize ruthlessly. hot.md is a bridge, not a transcript.
- **Loaded at startup** — hot.md is read after INDEX.md and before identity/personality for session orientation.

### What the user sees

A single brief line, only if captures were made:

> *Captured 4 items to inbox before closing (2 facts, 1 preference, 1 update). Dream will route them next cycle.*

If nothing was captured, nothing is said.

### Scope limit

The sweep should take 30 seconds of assistant effort, not 5 minutes. Scan for signal pattern hits, write them, move on. If something is ambiguous, inbox it with a `[?]` tag and let Dream figure it out. The sweep operates on available context only — after compaction, conversation detail is gone.

## Routing table (Dream reference)

Dream uses this table to route tagged inbox entries to their destination. The tag provides a first-pass signal; Dream verifies against this table.

| Signal | Destination |
|--------|------------|
| Fact about the user (identity, preferences, goals, routines, people) | `user-data/memory/profile/<topic>.md` (Dream picks topic via INDEX.md) |
| Task or commitment (action items, deadlines, reminders) | `user-data/memory/tasks.md` |
| Reference knowledge (vendors, medical, locations, financial facts) | `user-data/memory/knowledge/<topic>.md` (Dream picks topic via INDEX.md) |
| Decision made (choice + reasoning) | `user-data/memory/decisions.md` |
| Correction to the assistant (what you did wrong, what to do instead) | `user-data/memory/self-improvement.md` -> `## Corrections` |
| Positive signal about Robin's approach (style, format, level of detail) | `user-data/memory/self-improvement.md` -> `## Preferences` |
| Reflective observation or daily note | `user-data/memory/journal.md` |
| Dated event (trip, conference, attended event) | `user-data/memory/knowledge/events/<slug>.md` |
| Everything else (unclear classification, fleeting thought) | `user-data/memory/inbox.md` |

When Dream routes an entry from inbox into a topic file, it consults `user-data/memory/INDEX.md` to find the matching topic. If no topic file fits, Dream creates one with `description:` frontmatter and the next index regen picks it up.

## Derived-analysis auto-capture

When you produce a multi-step derivation — a user profile, gap analysis, pattern detection, recurring-spot inventory, location map, etc. — extract the durable insights and capture them in the same turn that you surface the analysis. Don't wait for the user to ask "save that."

If the result is worth surfacing in the response, the durable parts are worth persisting.

Extract and route:

| Type of finding | Destination |
|---|---|
| Identity / profile facts about the user | `user-data/memory/profile.md` |
| Recurring patterns and preferences | `user-data/memory/profile.md`, or `user-data/memory/self-improvement.md` → `## Preferences` |
| Reference inventories (paths, accounts, recurring locations, app usage) | `user-data/memory/knowledge.md` |
| Project state with goals or gaps | `user-data/memory/tasks.md` (active work) or a dedicated section in `user-data/memory/profile.md` (ongoing initiative) |
| Long-form artifact (the full analysis, raw data, exports) | `artifacts/output/<YYYY-MM-DD-topic>/` — and surface the path inline so the user can find it |

Two constraints:
- Capture files hold the **durable distillation**, not the full analysis. They point to the artifact path for the long form.
- If a finding overlaps with an existing entry, update in place. Don't create near-duplicates.

The point is silent competence — the structure should already exist when the user asks "did you save that?"

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

Each topic file under `user-data/memory/` carries YAML frontmatter:

```yaml
---
description: Doctors, providers, medications, screenings, conditions
type: topic
---
```

### Frontmatter fields

| Field | Required | Values | Purpose |
|-------|----------|--------|---------|
| `description` | Yes | One-line string | INDEX.md generation, file discovery |
| `type` | Yes | See type vocabulary below | Categorizes the file for operations |
| `tags` | No | Inline array `[medical, labs]` | Search, lint scoping, filtering |
| `related` | No | Inline array of relative paths | Semantic connections not captured by inline links |
| `created` | No | YYYY-MM-DD | When the file was created |
| `last_verified` | No | YYYY-MM-DD | Last time a human confirmed the content is current |
| `ingested` | No | YYYY-MM-DD | When the source was ingested (source pages only) |
| `origin` | No | Path or URL | Where the source came from (source pages only) |

### Type vocabulary

| Type | Meaning | Examples |
|------|---------|---------|
| `topic` | General knowledge or profile file (default) | identity.md, recipes.md, photography.md |
| `entity` | A specific person, place, organization, or thing | hemonc-lee.md, home.md, parents-house.md |
| `snapshot` | Point-in-time data that goes stale | health-snapshot.md, financial-snapshot.md |
| `event` | A dated event | cali-may-2026.md, winter-photo-2025-12.md |
| `source` | Source summary created by ingest | lab-report-2026-03.md |
| `analysis` | Filed analysis from a query | q1-spending-analysis.md |
| `conversation` | Filed conversation summary | wiki-design-session.md |
| `reference` | Stable reference data (inventories, lists) | photo-gear-inventory.md, vendors.md |

Types are set by migration 0004 (default `topic`) and refined by the user or Robin during conversation. Ingest and save-conversation set types automatically for their output files. Robin may suggest type changes during lint ("hemonc-lee.md looks like an entity, not a topic — want me to update?").

### Type assignment guidance

When creating new knowledge files mid-session:
- Medical/legal/financial providers → `type: entity`
- Specific places → `type: entity`
- Inventories, lists, templates → `type: reference`
- Point-in-time summaries → `type: snapshot`
- Everything else → `type: topic`

`user-data/memory/INDEX.md` is generated from `description` fields by `system/scripts/regenerate-memory-index.js`. Dream regenerates INDEX.md at the end of every cycle.

**Direct writes to existing topic files** require no INDEX update — only the file's content changes.

**New invariant for inbox-routed content:** mid-session direct-writes do not create new topic files for facts and updates whose home doesn't already exist. Such observations go to `inbox.md` and Dream creates the destination file on the next cycle. This eliminates the stale-INDEX window for routing-driven file creation.

**User-authored documents are exempt:** when the user (or Robin acting on the user's explicit request) authors a coherent new document — most commonly an event/trip file under `events/`, occasionally a derived analysis worth its own file — the file is created mid-session with `description:` frontmatter. The brief stale-INDEX window for these is acceptable because the user named the file explicitly.

**Pointer IDs (`<!-- id:... -->`)** apply only to `inbox.md` for dedup and supersedes resolution. Other memory files do not carry inline pointer comments.
