# Capture Rules

The 5-line capture checkpoint lives in `AGENTS.md` so it's always loaded. This
file is the full vocabulary, routing table, and sweep protocol — fetch on
demand for non-routine cases.

## Capture checkpoint (always-on, repeated here for reference)

After every response, scan for capturable signals.

- **Direct-write to file** for: corrections to assistant behavior, user-stated
  "remember this", updates that supersede a fact already in your context.
- **Inbox-write** with `[tag]` for everything else. Dream routes within 24h.
- **Tags:** `[fact|preference|decision|correction|task|update|derived|journal|?]`.

If AGENTS.md and this file disagree, AGENTS.md wins.

## Signal patterns

### Always-capture

- Name + relationship ("my dentist is Dr. Park")
- Date or deadline ("we leave June 3rd")
- Explicit preference ("I prefer X over Y")
- Decision with reasoning ("Vanguard, because...")
- Correction ("no, that's wrong")
- Explicit "remember this"
- New recurring commitment ("PT every Tuesday")
- Contradicts/supersedes known information
- Robin-produced analysis with durable insights

### Conditional-capture

Capture if it would change Robin's behavior or knowledge in a future session:

- Facts mentioned in passing ("...since I moved to Jersey City...")
- Lasting opinions ("that restaurant was terrible")
- Health/financial/legal details mentioned casually
- Work context changes ("I just got promoted")
- Repeated behavioral patterns

### Never-capture

- Ephemeral task context ("use port 3000 here")
- Code-specific decisions that live in code
- Already-captured items (dedup against in-context files; don't read solely to dedup)
- Conversation mechanics ("yes", "go ahead") unless confirming non-obvious preferences

## Inbox format

    - [tag] Content <!-- id:YYYYMMDD-HHMM-SSss -->

Examples:

    - [fact] Dentist is Dr. Park, downtown JC <!-- id:20260427-1430-cc01 -->
    - [preference] Prefers single bundled PRs for refactors <!-- id:20260427-1430-cc02 -->
    - [decision] Vanguard target-date for 401k — expense ratio decided <!-- id:20260427-1431-cc01 -->
    - [update] Cancelled Orange Theory (supersedes: gym routine in profile) <!-- id:20260427-1432-cc01 -->

## Tag → destination

| Tag | Routes to |
|-----|-----------|
| `[fact]` | `profile/<topic>.md` or `knowledge/<topic>.md` |
| `[preference]` | `self-improvement/preferences.md` |
| `[decision]` | `decisions.md` |
| `[correction]` | `self-improvement/corrections.md` |
| `[task]` | `tasks.md` |
| `[update]` | `profile/<topic>.md` or `knowledge/<topic>.md` (supersedes existing) |
| `[derived]` | Dream classifies from content |
| `[journal]` | `journal.md` |
| `[?]` | Unclassified — Dream classifies from content |

Tags are routing hints; Dream verifies against the table.

### Multi-faceted moments

Split into separate atomic entries. Each routes independently.

### Supersedes hint

`[update]` entries can include `(supersedes: <hint>)` to speed Dream's resolution.

## Direct-write exceptions

These skip inbox:

- **Corrections** → `self-improvement/corrections.md` (must take effect this session)
- **Explicit "remember this"** → confident destination + confirm
- **Updates contradicting loaded context** → in-place update now
- **Derived analysis** → see Derived-analysis section below
- **Ingest** → multi-file structural; see `system/jobs/ingest.md`

## Confirmation behavior

| Type | User sees |
|------|-----------|
| Routine `[fact|preference|journal]` | Nothing (silent) |
| `[decision|correction|update]` | Brief inline parenthetical |
| High-stakes (medical/financial/legal) | Verify before writing |
| Explicit "remember this" | Confirm what + where |

## Capture sweep (safety net)

**Trigger 1 — context compaction imminent.** Mini-sweep of the about-to-be-lost
window. Most important trigger.

**Trigger 2 — graceful session end.** Full sweep.

**Process:** Scan available context → cross-reference inbox.md (dedup) → draft
tagged entries → batch-append to inbox → write one-line note to
`self-improvement/session-handoff.md` ("Captured N items: X facts, Y prefs...")
→ append session summary to `hot.md`.

**Scope:** 30 seconds of effort, not 5 minutes. Ambiguous items get `[?]`.

## Hot cache

At session end or compaction, append a session summary to `hot.md`:

```markdown
## Session — YYYY-MM-DD HH:MM TZ

**Focus:** <topic>
**Key decisions:** <if any>
**Open threads:** <pending>
**Files touched:** <if any>
```

Append-only. Cap 25 lines per entry. Dream Phase 4 trims to last 2-3 entries.
Loaded at startup.

## Derived-analysis auto-capture

When you produce a multi-step derivation (profile, gap analysis, pattern
detection, inventory, location map), extract durable insights and capture in
the same turn — don't wait for the user to say "save that."

| Finding type | Destination |
|---|---|
| Identity / profile facts | `profile/<topic>.md` |
| Recurring patterns / preferences | `profile/` or `self-improvement/preferences.md` |
| Reference inventories | `knowledge/<topic>.md` |
| Project state with goals/gaps | `tasks.md` (active) or `profile/<topic>.md` (initiative) |
| Long-form artifact | `artifacts/output/<YYYY-MM-DD-topic>/` (surface path inline) |

Capture files hold the durable distillation, pointing to the artifact for the
full analysis. Update in place if a finding overlaps an existing entry.

## Privacy (immutable)

Block writes containing: full government IDs (SSN/SIN/passport), full payment
or bank account numbers (last-4 ok), credentials (passwords/API keys/tokens/
private keys), URLs with embedded credentials. On match: block, warn, offer
to redact. Cannot be overridden.

## High-stakes confirmation

For financial / medical / legal facts, confirm before storing:
"Just to make sure I have this right — [fact]?"

## Read-before-write

Always read a file before writing. **Exception:** if you read it earlier this
turn AND no `Bash`/`Write`/`Edit`/`NotebookEdit` ran since then, you may write
without re-reading. Other tools (Read, Grep) don't invalidate.

## Index maintenance

Each topic file under `user-data/memory/` carries frontmatter:

```yaml
---
description: One-line summary for INDEX.md
type: topic
---
```

Required fields: `description`, `type` (`topic|entity|snapshot|event|source|
analysis|conversation|reference`). Optional: `tags`, `related`, `created`,
`last_verified`, `ingested`, `origin`.

`INDEX.md` is generated from `description` fields. Sub-trees with their own
`INDEX.md` show as one row in the parent. Direct writes to existing topic
files require no INDEX update.

Mid-session direct-writes do NOT create new topic files for routing-driven
captures whose home doesn't already exist — those go to `inbox.md` and Dream
creates the destination on the next cycle. Exception: user-authored documents
(events/trips, derived analyses worth their own file) are created mid-session
with `description:` frontmatter.

Pointer IDs (`<!-- id:... -->`) apply only to `inbox.md`.
