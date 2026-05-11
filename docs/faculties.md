# Faculties

Robin's behavior is organized into named faculties. Two categories:

- **Process faculties** (verbs — what Robin *does*): intuition, biographer, heartbeat, discretion, dream, reflection, introspection, reinforcement.
- **Substrate lenses** (nouns — what Robin *knows*): attention, chronicle, knowledge, habits, persona, narrative, foresight.

The two-name convention: **modules are named for cognitive function; memo kinds are named for data shape**. `habits.js` writes `kind='habit'` memos; `foresight.js` writes `kind='prediction'` memos; `narrative.js` writes `kind='thread'` memos. Code does, data is.

## Substrate lenses (`src/memory/*.js`)

All lenses read/write through `store.js` — the only writer to events/memos/edges/embeddings. Each lens is a thin file (~30–80 LOC) baking in `kind` and exposing legacy function names alongside the new ones during the migration.

### attention
**What Robin is currently attending to.** Active episodes + recent events + entities mentioned across them.
- File: `src/memory/attention.js`
- API: `getAttention(db, { source?, windowMinutes? })` → `{ episodes, recent_events, entities }`
- Replaces v1's `hot.js` (which hardcoded `entities: []`).

### chronicle
**Chronological list of significant biographed events.**
- File: `src/memory/chronicle.js`
- API: `listChronicleEntries(db, { since?, until?, limit?, minContentLen? })`
- Replaces v1's `journal.js`.

### knowledge
**Distilled facts about the world** (memos kind='knowledge').
- File: `src/memory/knowledge.js`
- API: `createKnowledge(db, embedder, input)` / `searchKnowledge(db, embedder, q)` / `listKnowledge(db, opts)` / `getKnowledgeByContentHash(db, content)`
- Subject linkage moved from `subject_id` scalar to `about` edges; lineage moved from `source_events` arrays to `derived_from` edges.

### habits
**Recurring observations** (memos kind='habit'). Dedup by `meta.name`; re-observations increment `signal_count`.
- File: `src/memory/habits.js`
- API: `upsert(db, embedder, { name, description, lineage?, strength? })` / `list(db, opts)`
- Replaces v1's `patterns.js`.

### persona
**The singleton model of Robin's user.** Stored as a `persona:singleton` row.
- File: `src/memory/persona.js`
- API: `getPersona(db)` / `updatePersonaFields(db, fields)` / `updateCommStyle(db, fields)` / `updateCalibration(db, fields)`
- Replaces v1's `profile.js` (table renamed from `profile` to `persona`).

### narrative
**Multi-episode arcs** (memos kind='thread').
- File: `src/memory/narrative.js`
- API: `add(db, embedder, { title?, summary?, episode_ids?, entity_ids? })` / `list(db, opts)`
- Replaces v1's `threads.js`.

### foresight
**Predictions and calibration** (memos kind='prediction').
- File: `src/memory/foresight.js`
- API: `predict(db, embedder, { statement, statement_kind, confidence, expected_resolution_at? })` / `resolve(db, id, { correct, actual_outcome? })` / `listOpen(db, opts)` / `computeCalibration(db)`
- New consolidation of prediction logic previously scattered.

## Process faculties

### intuition
**The UserPromptSubmit hook that injects relevant memory into the next turn.**
- Trigger: Claude Code or Gemini CLI fires `UserPromptSubmit` with `{prompt, transcript_path, session_id}`.
- Files: `src/hooks/handlers/intuition.js` (hook entry), `src/recall/intuition.js` (daemon endpoint), `src/recall/rank.js`.
- Behavior: Composes events + memos[kind=knowledge] recall via `store.searchEvents` + `store.searchMemos`. Ranks via `rank.score` (cosine × freshness × contradiction × trust × scope). MMR-lite diversity pass. Writes `intuition_telemetry` + `recall_log{outcome:pending}` rows. Returns a `<!-- relevant memory -->` block under a 1500-token budget.
- Inspect: `SELECT * FROM intuition_telemetry ORDER BY ts DESC LIMIT 20`.

### biographer
**Per-turn consolidation: turns raw events into structured entities, edges, and (rarely) memos.**
- Files: `src/capture/biographer.js`, `src/capture/biographer-prompt.js`, `src/capture/biographer-output.js`, `src/graph/`.
- Writes: `entities` (upserted via 3-stage cascade), `edges` (mentions/about/works_on/participates_in/occurs_with/before via `store.relateAll`), `events.biographed_at = time::now()`.

### heartbeat
**The 60-second scheduler tick.**
- Dispatches integration syncs, biographer queue, stale-session sweep, quiet-window cursor advance, internal jobs (notably `reinforce-recall`).

### discretion
**Refuses inappropriate writes (inbound), commands (bash), and outbound payloads.** Unchanged from v1 — three sub-mechanisms sharing the `refusals` table.

### dream
**Nightly multi-step consolidation into long-term memory.**
- Pipeline: step-knowledge → step-habits (from edges[kind='occurs_with']) → step-narrative (from edges[kind='mentions']) → step-persona → step-reflection → step-scope-cleanup. Plus comm-style and calibration sub-steps.
- step-knowledge emits `supersedes` edges when promoting contradicting facts (old memo preserved; `fn::freshness` returns 0).
- step-scope-cleanup promotes referenced ephemerals to global; prunes the rest (session: 7d, temp: 24h).

### reflection
**Correction-to-rule + reinforcement-to-rule learning loop.** Runs as a step inside dream; clusters correction *and* positive-reinforcement events into `rule_candidates`.

### reinforcement (NEW)
**The recall feedback loop — the keystone effectiveness fix.**
- Files: `src/recall/reinforcement.js`, `src/jobs/internal/reinforce-recall.js`, `src/jobs/builtin/reinforce-recall.md`.
- Behavior: every 5 minutes, walks `recall_log` rows whose `outcome='pending'` and `ts < now - 5min`. For each: looks for `meta.kind='correction'` events in the same session within the 5-min window. If a correction landed → mark `outcome='corrected'`. Else for each hit memo → `signal_count += 1`, `decay_anchor = time::now()`; mark `outcome='reinforced'`. Useful memos sharpen with use.
- Inspect: `SELECT outcome, count() FROM recall_log GROUP BY outcome`.

### introspection
**Daemon-boot integrity check against the install-time manifest baseline.** Unchanged from v1.

## See also

- [`architecture.md`](architecture.md) — how faculties fit into the request lifecycle
- [`development.md`](development.md) — adding a new memo kind, edge kind, or integration
- `docs/superpowers/specs/2026-05-11-robin-v2-database-and-memory-redesign-design.md` — design rationale
