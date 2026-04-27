# Memory Indexing & Metadata Layer — Design Spec

**Date:** 2026-04-27
**Sub-Project:** 1 of 4 (Memory Management Improvement)
**Scope:** Add a lightweight indexing and metadata layer on top of Robin's existing markdown memory files
**Config version:** 2.0.0 → 2.1.0

## Context

Robin's memory system uses 8 core markdown files with file-based locking and a daily Dream protocol for maintenance. As the system grows, four problems emerge:

1. **Retrieval quality** — Robin loads entire files rather than pulling relevant fragments
2. **Scalability** — files grow unbounded with no archiving or summarization
3. **Accuracy/freshness** — stale facts persist; daily Dream cycle isn't always enough
4. **Cross-file relationships** — facts are siloed with no way to connect related information across files

This spec addresses the foundation: an indexing layer that enables the other three improvements (Smart Retrieval, Tiered Storage, Freshness Engine) to be built as subsequent sub-projects.

**Build order for the full initiative:**
1. **Memory Indexing & Metadata Layer** (this spec)
2. **Smart Retrieval** — query indexes to load only relevant entries
3. **Tiered Storage & Archiving** — aging rules, archive layer, summary pointers
4. **Freshness & Accuracy Engine** — confidence scores, contradiction detection, composable maintenance jobs

Each sub-project depends on the previous one.

## Design Constraints

- Markdown files remain human-readable — indexes are additive, not replacements
- Indexes are derived artifacts — if lost, they can be rebuilt from source files
- Source files are always authoritative over indexes
- The metadata schema should be representable as database tables (forward-compatible with robin-assistant-app)
- Portability preserved — no dependencies beyond file read/write

---

## 1. Entry ID Scheme

Every discrete fact or entry gets a stable, location-independent ID assigned at creation time.

**Format:**

```
<YYYYMMDD>-<HHMM>-<session-short><seq>
```

**Components:**
- `YYYYMMDD-HHMM` — timestamp of creation (UTC)
- `session-short` — platform abbreviation + daily sequence number
- `seq` — single-character suffix (`a`-`z`) for multiple entries in the same minute

**Platform abbreviations:** `cc` (Claude Code), `cu` (Cursor), `gm` (Gemini CLI), `ws` (Windsurf), `cx` (Codex), `ag` (Antigravity)

**Examples:**
- `20260415-1030-cc1a` — first entry at 10:30 in the first Claude Code session of the day
- `20260415-1030-cc1b` — second entry in the same minute
- `20260418-1400-gm1a` — first entry at 14:00 in a Gemini CLI session

**Session short derivation:** At session registration, Robin reads `state/sessions.md` and counts existing sessions for the same platform on the current date. First Claude Code session = `cc1`, second = `cc2`.

**Migration IDs:** `<YYYYMMDD>-0000-mig<NN>` where date comes from the entry if parseable or the file's last-modified date, and `NN` is zero-padded numeric (01-99).

**Rules:**
- IDs are write-once: assigned at creation, never changed, never reused
- IDs survive promotion (correction → pattern), routing (inbox → profile), and archiving (active → archive)
- Location is never encoded in the ID — the index tracks where entries live
- Robin only assigns IDs to entries it writes; pre-existing ID-less entries are handled by Dream's integrity check

## 2. Entry Format in Source Files

IDs are embedded in source files as HTML comments, invisible in rendered markdown.

**List items (profile, knowledge, tasks):** ID inline after the bullet marker.

```markdown
## People

- **Dr. Smith** — Cardiologist at City Medical <!-- id:20260415-1030-cc1a -->
  - Annual checkup in October
  - Referred by Dr. Jones

- **Alex Chen** — Colleague on the platform team <!-- id:20260418-0900-cc2a -->
```

**Block entries (journal, decisions, inbox, self-improvement append-only sections):** ID as an HTML comment on its own line before the entry.

```markdown
<!-- APPEND-ONLY below this line -->

<!-- id:20260415-1030-cc1a -->
**2026-04-15** — Had coffee with Alex. He mentioned switching teams...

<!-- id:20260418-1400-gm1a -->
**2026-04-18** — Launched v2 today. Retrospective notes: deployment was smooth...
```

**Tasks:**

```markdown
## Work

<!-- id:20260420-0830-cc1a -->
- [ ] Ship the v2.1 patch by Friday
<!-- id:20260421-1100-cc1a -->
- [x] Review PR #42 for auth changes
```

**Self-improvement structured entries (Learning Queue, Calibration):**

```markdown
## Learning Queue

<!-- id:20260101-0000-init -->
- question: What does a typical week look like?
  why: Establishes baseline for scheduling and prioritization
  domain: personal
  added: 2026-01-01
  status: open
```

**Entry boundary conventions:**
- **Append-only files:** blank-line-separated blocks, each starting with a date pattern or bullet
- **Reference files:** each top-level bullet and its indented children = one fact
- **Tasks:** each checkbox line and its indented children = one entry

## 3. Per-File Sidecar Indexes

Each core file gets a companion index at `core/index/<file>.idx.md`. Trips get `core/index/trips.idx.md`.

```
core/index/profile.idx.md
core/index/knowledge.idx.md
core/index/tasks.idx.md
core/index/journal.idx.md
core/index/decisions.idx.md
core/index/self-improvement.idx.md
core/index/inbox.idx.md
core/index/trips.idx.md
```

### Domain Vocabulary (Controlled)

`work`, `personal`, `finance`, `health`, `learning`, `home`, `shopping`, `travel`

These represent life areas, not storage locations. Entries can have multiple domains.

### Tag Normalization Rules

- Lowercase, hyphen-separated
- People: `firstname-lastname`
- Places: `city-name` or `place-name`
- Dream deduplicates and normalizes during index maintenance

### Index Format — Fact-Level (profile, knowledge)

```markdown
# Index: Profile

## People

- id: 20260415-1030-cc1a
  entity: dr-smith
  domains: [health]
  related: [20260415-1030-cc1a, PRF>People>dr-smith]
  enriched: true

- id: 20260418-0900-cc2a
  entity: alex-chen
  domains: [work, personal]
  related: [20260418-1400-gm1a]
  enriched: true
```

Each fact (a bullet or small group of bullets about one entity) gets an index entry with: ID, entity name, domains, related entries.

### Index Format — Entry-Level (journal, decisions, tasks, self-improvement, inbox)

```markdown
# Index: Journal

- id: 20260415-1030-cc1a
  domains: [health, personal]
  tags: [appointment, dr-smith]
  related: [20260410-0900-cc1a, PRF>People>dr-smith]
  summary: Cardiology follow-up, all clear
  enriched: true

- id: 20260418-1400-gm1a
  domains: [work]
  tags: [project-launch, deadline]
  related: [TSK>Work]
  summary: Launched v2, retrospective notes
  enriched: true
```

### Cross-Reference Syntax

| Reference type | Syntax | Example |
|---|---|---|
| Entry (any file) | Bare ID | `20260415-1030-cc1a` |
| Section | `<FILE>><Section>` | `KNW>Medical` |
| Entity in section | `<FILE>><Section>><entity>` | `PRF>People>dr-smith` |

Entry references use bare IDs (no file suffix). The index tracks which file an entry lives in — the retrieval layer resolves IDs to locations at query time. This ensures references remain valid when entries move between files.

### `enriched` Flag

Every index entry has an `enriched` field:
- `true` — domains, tags, summary, and related fields are populated
- `false` — structural skeleton only (ID and section location known, metadata empty)

Unenriched entries are usable (findable by ID) but invisible to domain/tag queries until enriched.

### Concurrency Rules

- **Appending** new index entries: no lock required
- **Modifying** existing entries (Dream updating summaries, normalizing tags, removing archived entries): requires lock at `core/state/locks/<filename>.idx.lock`

## 4. Root Manifest

A single file at `core/manifest.md` providing a bird's-eye view of the memory system. The retrieval layer reads this first to decide which index files to consult.

```markdown
# Memory Manifest

Generated by Dream. Do not edit manually.
Last updated: 2026-04-27T08:30:00Z

## Files

- file: profile
  path: core/profile.md
  index: core/index/profile.idx.md
  type: reference
  entries: 34
  domains: [personal, work, health, finance]
  last_modified: 2026-04-25
  sections: [Identity, Personality, Preferences, Goals, People, Routines, Work, Interests]

- file: knowledge
  path: core/knowledge.md
  index: core/index/knowledge.idx.md
  type: reference
  entries: 22
  domains: [health, finance, home, personal]
  last_modified: 2026-04-23
  sections: [Vendors, Medical, Locations, Subscriptions, References]

- file: journal
  path: core/journal.md
  index: core/index/journal.idx.md
  type: append-only
  entries: 87
  domains: [work, personal, health, finance, learning]
  last_modified: 2026-04-27
  oldest_entry: 2026-01-15
  newest_entry: 2026-04-27

- file: tasks
  path: core/tasks.md
  index: core/index/tasks.idx.md
  type: mixed
  entries: 19
  domains: [work, personal, finance, health, learning, home, shopping]
  last_modified: 2026-04-26
  active: 14
  completed: 5

- file: decisions
  path: core/decisions.md
  index: core/index/decisions.idx.md
  type: append-only
  entries: 12
  domains: [finance, work, health, personal]
  last_modified: 2026-04-20
  oldest_entry: 2026-02-01
  newest_entry: 2026-04-20

- file: self-improvement
  path: core/self-improvement.md
  index: core/index/self-improvement.idx.md
  type: mixed
  entries: 41
  last_modified: 2026-04-27
  subsections:
    corrections: 8
    patterns: 3
    preferences: 12
    session_reflections: 7
    learning_queue: 6
    calibration: 5

- file: inbox
  path: core/inbox.md
  index: core/index/inbox.idx.md
  type: append-only
  entries: 3
  last_modified: 2026-04-26

- file: trips
  path: trips/
  index: core/index/trips.idx.md
  type: reference
  entries: 0
  domains: [travel]
  last_modified: null
```

**Per-file metadata:**
- Path and index path (nothing hardcoded elsewhere)
- File type (`reference`, `append-only`, `mixed`) — informs locking rules
- Entry count — quick integrity signal
- Domains covered — retrieval uses this to decide which indexes to open
- Last modified date — retrieval skips files unchanged since last session
- File-specific metadata: date ranges, active/completed counts, subsection breakdowns

**Maintenance:** Dream regenerates the manifest from index files at the end of every run. It is a derived artifact — if lost, Dream rebuilds it on next cycle. Robin does not update the manifest during normal capture.

## 5. Migration Strategy

### Phase A: Structural (Node.js script — `scripts/migrate-index.js`)

Deterministic, no AI required. Can run offline.

1. **Backup** — copy `core/` to `archive/pre-index-<date>/`. Skip if backup already exists from a prior attempt.

2. **Parse entries** from source files using boundary rules (Section 2).

3. **Assign IDs** — `<YYYYMMDD>-0000-mig<NN>` format. Date from entry if parseable, file last-modified otherwise. Skip entries that already have IDs (re-run safety).

4. **Inject IDs** into source files per placement rules (Section 2).

5. **Generate skeleton index files** — entry ID and section location populated; `domains: []`, `tags: []`, `related: []`, `summary: ~`, `enriched: false`. Entity names extracted mechanically (bold text at start of bullet).

6. **Generate root manifest** — entry counts and sections from structural parsing. Domain fields empty.

7. **Update config:**
   ```json
   {
     "version": "2.1.0",
     "indexing": {
       "status": "structural",
       "migrated_at": "2026-04-27T08:30:00Z"
     }
   }
   ```

8. **Validate** — compare entry counts between source and indexes. Report mismatches. On failure, point to backup.

**Idempotency:** ID injection skips entries with IDs. Index generation always rebuilds from scratch. Safe to re-run after partial failure.

### Phase B: Semantic (AI-assisted, first post-migration session)

Triggered at session startup when `indexing.status === "structural"`. Runs in the background — Robin is usable immediately.

Startup announces: "Index migration in progress — I'm enriching your memory in the background. Everything works, search will improve as this completes."

1. For each `enriched: false` index entry, Robin reads the source content and fills in: domains, tags, summary, entity (verified/corrected). Sets `enriched: true`.

2. **Relationship discovery** — populate `related` fields using three heuristics:
   - **Entity match:** two entries mention the same entity name → related
   - **Temporal proximity:** entries within 48 hours sharing a domain → candidates, Robin confirms
   - **Explicit reference:** entry text references another entry's content → linked

3. **Manifest enrichment** — regenerate with domain coverage populated.

4. **Update config:**
   ```json
   {
     "indexing": {
       "status": "complete",
       "migrated_at": "2026-04-27T08:30:00Z",
       "semantic_at": "2026-04-27T09:15:00Z"
     }
   }
   ```

**Resumability:** For large workspaces, Phase B tracks progress via a cursor in config (`"semantic_cursor": "<last-processed-id>"`). If the session ends before completion, the next session resumes from the cursor. Processes newest entries first.

### Rollback

Restore from `archive/pre-index-<date>/` and revert `robin.config.json` to version `2.0.0`.

## 6. Changes to Existing Systems

### Capture Rules (`capture-rules.md`)

After writing an entry to a source file, Robin also:
1. Appends an index entry to `core/index/<file>.idx.md` with ID, domains, tags, summary (for append-only entries), entity (for reference facts), `enriched: true`
2. Populates `related` if obvious connections exist; otherwise leaves empty for Dream
3. Applies tag normalization at capture time
4. For trip auto-creation: also appends to `core/index/trips.idx.md`

**Failure handling:** If the index write fails, the source entry still stands. Source is always authoritative. Dream's integrity check reconciles on next run.

### Startup Sequence (`startup.md`)

Updated sequence: Register session → Check siblings → **Phase B check** → Dream check → Read context → Respond.

Phase B check:
- Read `robin.config.json`
- If `indexing.status === "structural"`, start Phase B enrichment in background
- If `indexing.status === "complete"` or field absent, skip

Context loading: startup reads `core/manifest.md` for an overview, then loads profile.md and self-improvement sections as before. Full index-driven selective loading is deferred to Sub-Project 2 (Smart Retrieval).

### Dream Protocol (`protocols/dream.md`)

Updated phases: **Phase 0** → Phase 1 → Phase 2 → Phase 3 → **Phase 4**.

**Phase 0: Index Integrity** (new, runs first)
- Count entries with IDs in each source file
- Compare against corresponding index
- Missing from index → generate skeleton entry (`enriched: false`)
- In index but missing from source → mark deleted in index
- Log reconciliation results

**Phase 2 addition:** When an entry is moved between source files (inbox routing, fact promotion), also move its index entry from the origin sidecar to the destination sidecar. If the entry was unenriched, enrich it during the move. Origin index modification requires lock; destination append does not.

**Phase 4: Index Maintenance** (new, runs last)
- Normalize tags across all indexes
- Discover cross-references on entries created/modified/moved since last Dream (delta only, not full scan)
- Update summaries for changed entries
- Enrich any `enriched: false` entries
- Regenerate `core/manifest.md`

**Boundary rule update:** Dream can read/write `core/index/*.idx.md` and `core/manifest.md`. Lock required when modifying existing index entries (Phase 4); not required for appends (Phase 0 skeleton entries).

### Scripts

**`validate.js`** gains:
- Check `core/index/` exists with expected sidecar files
- Entry count match between source files and indexes
- Manifest exists with consistent file-level metadata
- Config version is `2.1.0` with indexing status field

**`update.js`** gains:
- Preserve `core/index/` and `core/manifest.md` when updating system files
- If updating from pre-2.1.0, prompt user to run `robin migrate-index`

---

## Summary of New Files

| File | Purpose | Created by |
|---|---|---|
| `core/index/profile.idx.md` | Fact-level index for profile | Migration / Robin capture |
| `core/index/knowledge.idx.md` | Fact-level index for knowledge | Migration / Robin capture |
| `core/index/tasks.idx.md` | Entry-level index for tasks | Migration / Robin capture |
| `core/index/journal.idx.md` | Entry-level index for journal | Migration / Robin capture |
| `core/index/decisions.idx.md` | Entry-level index for decisions | Migration / Robin capture |
| `core/index/self-improvement.idx.md` | Entry-level index for self-improvement | Migration / Robin capture |
| `core/index/inbox.idx.md` | Entry-level index for inbox | Migration / Robin capture |
| `core/index/trips.idx.md` | Entry-level index for trips | Migration / Robin capture |
| `core/manifest.md` | Root manifest — file-level metadata | Migration / Dream |
| `scripts/migrate-index.js` | Phase A migration script | Developer |

## Summary of Modified Files

| File | Change |
|---|---|
| `core/capture-rules.md` | Add index write step, trip indexing |
| `core/startup.md` | Add Phase B check step |
| `core/protocols/dream.md` | Add Phase 0 and Phase 4, entry movement indexing in Phase 2 |
| `scripts/validate.js` | Add index integrity checks |
| `scripts/update.js` | Preserve indexes, prompt migration for pre-2.1.0 |
| `robin.config.json` (template) | Add indexing status field, bump to 2.1.0 |

## Next Sub-Projects

This spec is Sub-Project 1. The subsequent sub-projects build on this foundation:

- **Sub-Project 2: Smart Retrieval** — query indexes to load only relevant entries by domain, tags, recency, and relationships
- **Sub-Project 3: Tiered Storage & Archiving** — entries age from active to archive with summary pointers; index tracks location
- **Sub-Project 4: Freshness & Accuracy Engine** — confidence scores on facts, contradiction detection, composable maintenance jobs (Dream refactor)

Each will get its own design spec following the same brainstorming process.
