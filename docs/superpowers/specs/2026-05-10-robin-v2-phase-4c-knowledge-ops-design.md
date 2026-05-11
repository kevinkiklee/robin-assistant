# Robin v2 Phase 4c — Knowledge Ops MCP Tools

**Status:** Design (pre-implementation)
**Date:** 2026-05-10
**Phase:** 4c (Phase 4 envelope from `2026-05-10-robin-v2-phase-4a-safety-floor-design.md`)
**Predecessors:** Phase 2c (`knowledge`/`entities`/edges schema + `src/memory/knowledge.js`), Phase 4a (inbound PII guard), Phase 4d (daemon endpoint pattern + AGENTS.md regen).
**Sibling-aware:** Coordinates with the in-flight Phase 4f conversation-capture work — knowledge-ops tools are READ-mostly over existing tables and do NOT touch `src/capture/`, `src/hooks/handlers/`, `src/daemon/sessions.js`, `runtime_sessions`, `runtime_auto_recall_telemetry`, or `src/cli/commands/biographer-*`.

---

## 1. Goal

Three agent-callable MCP tools for memory hygiene:
- **`ingest`** — write a source document into events + entities + edges + knowledge in one shot.
- **`lint`** — read-only mechanical health-check (orphans, dead edges, duplicates, near-dupes, stale).
- **`audit`** — read-only LLM-driven contradiction-pair scan over recent knowledge.

All three are **user-triggered only** — never autonomous, never on a loop. AGENTS.md enforces this rule by prose; no code-level autorun.

## 2. Out of scope

- **Save Conversation** (Phase 4c candidate originally) — overlaps with 4f's session capture; revisit after 4f stabilizes.
- **Deep-ripple** (Phase 4c candidate originally) — overlaps with biographer queue; revisit later.
- **CLI auto-dispatch / scheduling** — these tools are explicit. If the user wants `lint` weekly, they wire it as a Phase 4d job pointing at `run_job({name})` of a thin internal-runtime wrapper. Not in this phase.
- **New schema** — reuses existing `events`, `entities`, `knowledge`, `mentions`, `about` tables.

## 3. `ingest` — write source documents into the memory graph

### 3.1 Inputs

```ts
{ content?: string, url?: string, file_path?: string }
```

Exactly one must be non-empty. Refuse with `{ok:false, reason:'missing_arg'}` if zero or `{ok:false, reason:'ambiguous_input'}` if multiple.

**Size cap:** 1 MB across all input types (content length, fetched body, file size). Over-cap → `{ok:false, reason:'too_large', max_bytes: 1048576, given: N}`.

**`url`:** fetched via global `fetch` with `AbortSignal.timeout(30_000)`. `Content-Type` header must match `text/*` or `application/json`. Binary → `{ok:false, reason:'unsupported_content_type', content_type}`.

**`file_path`:** any absolute path the daemon process can read. No sandboxing — daemon runs as the user; the PII guard is the safety boundary, not the path. If the path is a directory → refuse with `{ok:false, reason:'not_a_file'}`.

### 3.2 Pipeline

1. **Acquire content** per §3.1.
2. **Compute `content_hash`** (`sha256(content)` first 16 chars).
3. **Dedup check** — query events `WHERE content_hash = $hash LIMIT 1`. Hit → return `{ok:true, deduped:true, event_id}` immediately.
4. **PII guard** — `inboundGuard(content)` from `src/hooks/inbound-guard.js`. Refusal → `{ok:false, reason:'pii:<pattern>'}`; refusal already logged to `outbound_refusals(direction='inbound')` by the guard.
5. **Write 1 event** — `source: 'ingest'`, `content`, `content_hash`, `meta: {kind: 'document', source_kind: 'inline'|'url'|'file', source_ref: <url or path>}`. Embedded via existing recordEvent path. Returns `event_id`.
6. **LLM call** (`host.invokeLLM`, `tier: 'deep'`, timeout 15 min) with the ingest-specific prompt (NOT biographer's — biographer is shaped for short conversation events; document extraction needs different shape). Strict JSON output schema:
   ```ts
   {
     entities: [{ name: string, type: string, aliases?: string[], confidence: number }],
     edges:    [{ src_name: string, dst_name: string, kind: string, meta?: object }],
     knowledge:[{ content: string, subject_name?: string, confidence: number }]
   }
   ```
   Malformed JSON → terminal failure, return `{ok:false, reason:'extraction_failed', detail}`.
7. **Apply outputs** — new helper `resolveOrCreateEntity(db, embedder, {name, type, aliases?})` in `src/jobs/ingest-resolver.js` (NOT under `src/graph/cascade.js` — that one is biographer-shaped). Resolution rules, in order:
   - **Exact name+type match:** `SELECT id FROM entities WHERE name_lower = $name_lower AND type = $type` (covered by the existing `entities_name_lower` composite index).
   - **Alias-as-name match:** for each `alias` in the LLM-provided `aliases?` array, repeat the lookup above with `name_lower = alias.toLowerCase()`. First hit wins.
   - **Otherwise:** CREATE a new entity row with the LLM's `name`, `type`, and an embedding (use the existing embedder; entities table requires an `embedding` array per the 0003 schema). The `meta` field gets `{ingest_source: event_id, aliases: [...]}` so the alternate names are preserved for future ingest passes to match against.
   Returns the resolved record ID.
   
   For each `edges[i]`: resolve `src_name` + `dst_name` to entity IDs (skip edge if either resolution fails with a `console.warn`); RELATE the resolved pair into the named edge table. Edge tables in v2 are `TYPE RELATION ENFORCED` (per migration 0003), so the syntax is `RELATE $src->$kind->$dst CONTENT {meta?}` and dangling edges are rejected by SurrealDB. The 6 valid edge kinds are: `mentions`, `about`, `precedes`, `works_on`, `participates_in`, `co_occurs_with`. Unknown `kind` → skip with a `console.warn`. The `precedes` edge connects `events->events` not `events->entities`, so the ingest resolver rejects `precedes` outputs.
   
   For each `knowledge[i]`: call `writeKnowledge(db, embedder, {content, subject_id?, confidence, source_events: [event_id]})` from existing `src/memory/knowledge.js`. Dedup by `content_hash` is handled by `writeKnowledge`.

8. **Return** `{ok:true, deduped:false, event_id, entities_created, edges_created, knowledge_created}`. Counts are insert counts only (not UPSERT or no-op cases).

### 3.3 Why not reuse biographer's cascade

Biographer's pipeline (Stages 1+2+3 in `src/graph/cascade.js`) is shaped for short conversation events — a single LLM call produces 0-5 entities. Reusing it for a 200KB document would:
- Use the wrong prompt (conversation-shaped) → poor extraction quality.
- Re-LLM the document AFTER the ingest LLM already extracted from it → cost + latency double.
- Possibly conflict on entity resolution if both pipelines write at once.

Ingest owns its extraction. The captured `event` is still picked up by the regular biographer queue on next Stop hook fire — biographer will produce its own entity/edge extractions from the event, and the `resolveOrCreateEntity` helper's UPSERT-by-alias rule lets the two passes coexist (whichever runs second matches the first's entities and adds edges).

## 4. `lint` — read-only mechanical health check

### 4.1 Inputs

```ts
{ limit?: number }     // default 20, max 200
```

### 4.2 Checks (severity desc → asc)

| Severity | Kind | Query |
|---|---|---|
| 5 | `dead_edge` | edge rows whose `in` or `out` target doesn't exist in its table |
| 4 | `orphan_entity` | entity rows with zero inbound edges from `events` (any edge kind) |
| 3 | `duplicate_entity` | same lowercase alias on >1 entity (same `type`) |
| 2 | `near_duplicate_knowledge` | knowledge pairs found via HNSW: for each row, query `<|1,...|>` for its single nearest neighbor; if cosine > 0.95 AND the reverse pair hasn't been reported, report. O(N log N). |
| 1 | `stale_knowledge` | `confidence < 0.3 AND updated_at < now - 30d` |

### 4.3 Output

```ts
{
  ok: true,
  issues: [{ kind, severity, ref: string, message: string }, ...],
  total: number,        // count BEFORE limit
  returned: number,     // count after limit
}
```

`ref` is a stable record ID (e.g. `entities:foo123` or `knowledge:abc:knowledge:def` for pairs). Sorted by `severity desc, kind asc, ref asc` — deterministic for diffing across runs.

### 4.4 Edges over `mentions`/`about` etc.

For dead-edge + orphan-entity, walk **all six edge tables** declared in migration 0003 (`mentions`, `about`, `precedes`, `works_on`, `participates_in`, `co_occurs_with`). Hardcoded list — adding a new edge table requires updating `src/jobs/lint-checks.js` (call this out in the file's header comment).

## 5. `audit` — LLM contradiction-pair scan

### 5.1 Inputs

```ts
{ pair_count?: number }   // default 8, max 32
```

### 5.2 Pair selection (deterministic)

1. **Candidates:** `knowledge WHERE updated_at > now - 30d`.
2. **Pair build:** for each candidate, HNSW-NN within `knowledge` (excluding self). Keep if cosine > 0.7.
3. **Canonical ordering:** each pair stored as `[min(a_id, b_id), max(a_id, b_id)]` (string-sort) to dedupe symmetric pairs.
4. **Sort by cosine desc, take top `pair_count`**.

### 5.3 LLM call per pair

`host.invokeLLM` with `tier: 'balanced'` (cheaper than ingest's `deep`). Prompt:

```
You are checking two memory claims for contradiction.

Claim A: <a.content>
Claim B: <b.content>

Respond as strict JSON: { "contradict": boolean, "summary": string }
Summary is one sentence explaining your call.
```

Parse with malformed-JSON fallback: any parse failure → treat as `{contradict: false, summary: '<llm output unparseable>'}`. Don't fail the audit on a single bad pair.

### 5.4 Output

```ts
{
  ok: true,
  pairs_checked: number,
  contradictions: [{ a_id: string, b_id: string, summary: string }, ...],
}
```

Pairs where `contradict: false` are dropped (only contradictions surfaced).

### 5.5 Cost discipline

8 LLM calls (default) at `balanced` tier. The AGENTS.md block warns the agent not to loop — single-shot per user request.

## 6. Schema

None. Reuses existing tables. No migration. The ingest-specific edge-kind names are constrained to the 6 already-declared edge tables in 0003.

## 7. Daemon endpoints

Three concrete POST routes (`src/daemon/server.js`):

- `/internal/knowledge/ingest` → body `{content?, url?, file_path?}` → calls the registered `ingest` tool's handler.
- `/internal/knowledge/lint` → body `{limit?}` → calls `lint` handler.
- `/internal/knowledge/audit` → body `{pair_count?}` → calls `audit` handler.

Each is small (≤15 lines). Mirrors the `/internal/jobs/run` pattern from 4d. No new auth — same `127.0.0.1`-only binding as existing internal routes.

## 8. MCP tool registration

`src/daemon/server.js` `tools[]` array gains three entries via factories from `src/mcp/tools/{ingest,lint,audit}.js`:

```js
createIngestTool({ db: dbHandle, embedder: embedderWrap, host }),
createLintTool({ db: dbHandle }),
createAuditTool({ db: dbHandle, host }),
```

Tool factory shapes follow the established pattern: `{ name, description, inputSchema, handler }`.

## 9. CLI

`bin/robin` dispatcher gains three top-level commands (additive — don't refactor the existing `if (cmd === '…')` chain in `src/cli/index.js`):

- `robin ingest <text>` | `robin ingest --url <URL>` | `robin ingest --file <PATH>`
- `robin lint [--limit N]`
- `robin audit [--pairs N]`

All three POST to the corresponding `/internal/knowledge/*` endpoint via the existing `daemon-request.js` helper (added in 4d). Refuse with a clear message if the daemon isn't running — same shape as `robin jobs run`.

## 10. AGENTS.md

New regenerable block `<!-- robin-knowledge-ops:start -->` rendering:

```
## Knowledge ops

Three tools for memory hygiene. ALL are user-triggered — never call
autonomously, never on a loop.

- `ingest({content|url|file_path})` — write a source document into
  events + entities + edges + knowledge in one shot. Call only when the
  user says "ingest this", "add this to memory", "process this document",
  or pastes a file/URL.
- `lint({limit})` — read-only mechanical sweep (orphans, dead edges,
  duplicates, near-dupes, stale). Cheap, no LLM calls. Call when the user
  says "check memory", "memory health", "lint memory".
- `audit({pair_count})` — read-only LLM scan for contradictions across
  recent knowledge. ~8 LLM calls per invocation (balanced tier). Call when
  the user says "audit memory" — never on a loop.
```

Inserted between the `robin-jobs` and the memory-tools section. Doesn't depend on DB state (the description is static), so `agentsMdContent()` callers don't need a new arg.

## 11. Tests

**Unit:**
- `ingest.test.js` — input validation (zero/multiple inputs, oversized, binary URL), dedup hit, PII refusal, content-type rejection, file-not-a-file, LLM extraction happy path with stub, entity resolution (existing match by alias, new entity create), edge resolution (skip unknown kind, skip unresolvable name), knowledge insert.
- `lint-checks.test.js` — each of the 5 check kinds in isolation with seeded data; severity + kind + ref ordering; limit cap.
- `audit.test.js` — pair selection (recent filter, cosine threshold, canonical ordering, dedupe symmetric), LLM stub returns `contradict: true/false`, malformed-JSON fallback, pair_count default + max.
- `agents-md-knowledge-ops.test.js` — block exists, mentions all three tools by name, mentions "user-triggered".
- `knowledge-cli.test.js` — argv parsing for ingest/lint/audit, refuse-when-daemon-down, deps-injected `daemonRequest` for the round-trips.

**Integration:**
- `knowledge-ops-roundtrip.test.js` — seed a small in-memory DB; call ingest with inline content (stub LLM produces 2 entities, 1 edge, 1 knowledge); verify counts; call lint (expects 1 orphan-entity since no inbound mentions edge from anything); call audit (HNSW NN over single knowledge row → no pairs → `pairs_checked: 0`).

Approx test count: ~30 unit + 1 integration. Brings full suite to ~940.

## 12. Migration / rollout

No schema migration. Strictly additive:
1. New files: 3 tool factories, 1 entity resolver, 1 lint-checks module, 1 audit-prompt module, 3 CLI commands, 1 AGENTS.md section.
2. Modified files: `src/daemon/server.js` (3 endpoints + 3 tool factory registrations), `src/install/agents-md.js` (one new section), `src/cli/index.js` (3 dispatcher branches).
3. After merge, restart daemon (`robin mcp restart`) so the new tools register. Verify with `robin mcp status` and an MCP `tools/list` from a fresh agent session.

## 13. Risk register

- **Document size + PII regex performance.** PII guard runs against the full content (up to 1 MB). Spot-check: the 5 inbound patterns are short regexes; 1 MB scan takes < 50ms in Node. Acceptable.
- **LLM hallucinating entity names that don't quite match existing aliases.** Resolution would create a near-duplicate entity. Mitigated by `lint`'s `duplicate_entity` check surfacing it on next run. Not blocking; expected behavior.
- **HNSW NN query semantics in SurrealDB v3.** The lint and audit pipelines depend on `<|1,...|>` returning the nearest neighbor reliably. Existing recall pipeline (Phase 1+2b) uses this same operator; verified working. New code uses the same shape.
- **`audit` cost runaway.** Default 8 pairs × 1 LLM call = 8 calls. Hard-cap `pair_count` at 32 (max user-controlled). Single user, single explicit invocation; no scheduled re-run unless user explicitly wraps it as a Phase 4d job.
- **`ingest` reading sensitive file via `file_path`.** Daemon runs as the user; agent passes the path. The threat model: user's own agent reads user's own files. Same as `cat $FILE`. PII guard prevents writing credential-shaped content into memory regardless of source.

## 14. Open questions / explicit deferrals

1. **Knowledge-confidence calibration.** Currently the ingest LLM sets `confidence` per knowledge row, then `lint`'s stale check uses `< 0.3` as the threshold. The threshold is a guess. Tune in 4b alongside the Phase 4b calibration work.
2. **Embedding profile drift.** Migration 0008-embedder-`<profile>` controls the embedding dimension. If the active profile changes after some knowledge is written, the cosine queries assume same-dim vectors. Existing Phase 3a `robin embedder switch` re-embeds and gates against the drift; out of scope here.
3. **Internal-job wrapper for periodic lint/audit.** When the user wants `lint` weekly, they'd add a Phase 4d internal-runtime job (`src/jobs/internal/lint.js`) that wraps the MCP tool's handler. Not built in 4c — wait for actual demand.

## 15. Phase exit criteria

- All tests green (~30 unit + 1 integration).
- `robin ingest <text>` writes 1 event + N entities + M edges + K knowledge against the live DB (when daemon is running and a real LLM is reachable).
- `robin lint` returns a deterministic sorted list of issues against a seeded DB.
- `robin audit` produces 0-8 contradictions against a seeded DB with stub LLM.
- AGENTS.md `<!-- robin-knowledge-ops:start -->` block renders.
- No new schema files, no edits to capture/, hooks/handlers/, sessions, biographer-*.
