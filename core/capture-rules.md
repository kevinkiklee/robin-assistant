# Capture Rules

## Capture checkpoint (ALWAYS READ)

After every response, scan the user's message and your response for capturable signals listed below. Write captures to `user-data/inbox.md` with tags (see Inbox-first pipeline). Direct-write corrections and explicit saves. This is what separates Robin from a stateless chatbot — don't skip it.

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

Most captures go to `user-data/inbox.md` as lightweight tagged entries. Dream routes them to the right destination within 24 hours. This keeps per-capture cost low — append one tagged line + index entry instead of navigating file structure.

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
| `[fact]` | `user-data/profile.md` or `user-data/knowledge.md` (Dream decides based on content) |
| `[preference]` | `user-data/self-improvement.md` → `## Preferences` |
| `[decision]` | `user-data/decisions.md` |
| `[correction]` | `user-data/self-improvement.md` → `## Corrections` |
| `[task]` | `user-data/tasks.md` |
| `[update]` | `user-data/profile.md` or `user-data/knowledge.md` (supersedes existing entry) |
| `[derived]` | Depends on content (Dream classifies) |
| `[trip]` | `user-data/trips/` |
| `[journal]` | `user-data/journal.md` |
| `[?]` | Unclassified — Dream treats as untagged, classifies from content |

Tags are routing hints, not binding. Dream uses the tag as a first-pass signal but verifies against the routing table. A bad tag doesn't misroute permanently.

### Multi-faceted moments

When a single moment contains multiple distinct facts, split into separate entries. Each entry is atomic — Dream routes each independently.

    - [update] Dr. Park is no longer my dentist — office moved (supersedes: dentist in user-data/profile.md) <!-- id:... -->
    - [fact] New dentist is Dr. Chen, office on Main St <!-- id:... -->
    - [decision] Switched dentists because Dr. Park's office moved too far — proximity was the factor <!-- id:... -->

### `[update]` entries and supersedes hints

Update entries should include an optional `(supersedes: <hint>)` describing what they replace. Dream uses this hint to locate the original entry. Not required — Dream can search — but it speeds up resolution.

### Direct-write exceptions

These skip inbox and go to the destination file immediately:

- **Corrections** — `user-data/self-improvement.md` → `## Corrections`. The assistant needs to learn from them this session, not next Dream cycle.
- **Trip auto-creation** — already has its own protocol below, goes direct to `user-data/trips/`.
- **Explicit "remember this"** — user asked directly, so route to the confident destination and confirm.
- **Updates that contradict loaded context** — if the assistant knows the old fact is in a file it already read (e.g., `user-data/profile.md` loaded at startup), update it in place now. Don't wait for Dream.
- **Derived-analysis findings** — the assistant just performed the analysis and knows exactly where findings belong. Follow the derived-analysis auto-capture rules below.

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

**Primary — context compaction imminent.** When you receive a signal that context is about to compact (platform-specific — e.g., Claude Code shows a compaction warning), run a mini-sweep of the conversation window that's about to be lost. This is the most important trigger — once context compacts, the detail is gone. The mini-sweep is fast: scan for obvious signal hits, tag and append to `user-data/inbox.md`.

**Bonus — graceful session end.** When the user says goodbye or explicitly ends the session, run a full sweep of available context.

### Process

1. **Scan** — review available conversation context against signal patterns
2. **Cross-reference** — read `user-data/inbox.md` before each sweep to dedup against prior captures (prevents duplicates across multiple compaction events)
3. **Extract** — draft tagged inbox entries for anything missed
4. **Write** — batch-append all captures to `user-data/inbox.md`
5. **Handoff** — write a brief note to `user-data/self-improvement.md` → `## Session Handoff`: "Captured N items to inbox (breakdown by tag)."

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
| Fact about the user (identity, preferences, goals, routines, people) | `user-data/profile.md` (appropriate section) |
| Task or commitment (action items, deadlines, reminders) | `user-data/tasks.md` |
| Reference knowledge (vendors, medical, locations, financial facts) | `user-data/knowledge.md` (appropriate section) |
| Decision made (choice + reasoning) | `user-data/decisions.md` |
| Correction to the assistant (what you did wrong, what to do instead) | `user-data/self-improvement.md` -> `## Corrections` |
| Positive signal about Robin's approach (style, format, level of detail) | `user-data/self-improvement.md` -> `## Preferences` |
| Reflective observation or daily note | `user-data/journal.md` |
| Trip details (dates, flights, lodging, itinerary, packing) | `user-data/trips/<slug>.md` |
| Everything else (unclear classification, fleeting thought) | `user-data/inbox.md` |

When Dream routes an entry from one file to another, the entry's ID stays the same — only the index entry moves between sidecar files.

## Derived-analysis auto-capture

When you produce a multi-step derivation — a user profile, gap analysis, pattern detection, recurring-spot inventory, location map, trip log built from data, etc. — extract the durable insights and capture them in the same turn that you surface the analysis. Don't wait for the user to ask "save that."

Same rule as Trip auto-creation, applied to derivations: if the result is worth surfacing in the response, the durable parts are worth persisting.

Extract and route:

| Type of finding | Destination |
|---|---|
| Identity / profile facts about the user | `user-data/profile.md` |
| Recurring patterns and preferences | `user-data/profile.md`, or `user-data/self-improvement.md` → `## Preferences` |
| Reference inventories (paths, accounts, recurring locations, app usage) | `user-data/knowledge.md` |
| Project state with goals or gaps | `user-data/tasks.md` (active work) or a dedicated section in `user-data/profile.md` (ongoing initiative) |
| Long-form artifact (the full analysis, raw data, exports) | `artifacts/output/<YYYY-MM-DD-topic>/` — and surface the path inline so the user can find it |

Two constraints:
- Capture files hold the **durable distillation**, not the full analysis. They point to the artifact path for the long form.
- If a finding overlaps with an existing entry, update in place. Don't create near-duplicates.

This is the same silent-competence default as Trip auto-creation: the structure should already exist when the user asks "did you save that?"

## Trip auto-creation

When the user mentions an upcoming trip with at least a destination AND a rough date window — even casually, even as part of another question — create `user-data/trips/<slug>.md` immediately, same turn, silently. Slug format: `<destination>-<month>-<year>` (e.g., `cali-may-2026`, `tokyo-oct-2026`).

Seed the file with sections: Overview, Logistics (Flights / Lodging / Ground transport), Itinerary table covering the full date range, Photography (if relevant to the user), Open questions / TODO, Notes. Populate with whatever is known; leave the rest as `_Not yet booked_` or `_Add as trip details surface._`.

Also keep the one-line trip pointer in `user-data/profile.md` under the relevant Travel section so it surfaces in briefings.

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

After writing an entry to any data file, also append an index entry to the corresponding sidecar file at `user-data/index/<file>.idx.md`:

1. Generate an entry ID in `YYYYMMDD-HHMM-<session><seq>` format and embed it in the source file (inline `<!-- id:... -->` for list items, comment line before block entries)
2. Append to the sidecar index with: `id`, `domains` (from controlled vocabulary: work, personal, finance, health, learning, home, shopping, travel), `tags` (lowercase, hyphen-separated, `firstname-lastname` for people), `related` (obvious connections only — Dream discovers subtler ones), `summary` (one line for append-only entries), `enriched: true`
3. For trip auto-creation, also append to `user-data/index/trips.idx.md`

If the index write fails, the source entry still stands — source files are always authoritative. Dream's integrity check reconciles on next run.
