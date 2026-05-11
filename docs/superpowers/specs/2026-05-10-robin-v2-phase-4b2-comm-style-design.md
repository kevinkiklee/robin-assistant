# Robin v2 Phase 4b.2 — Comm-Style Profile Inference

**Status:** Design (pre-implementation)
**Date:** 2026-05-10
**Phase:** 4b.2 (second sub-phase of Phase 4b)
**Predecessors:** Phase 2c (`profile` singleton + Dream pipeline), Phase 2b (`record_correction` writes correction events), Phase 4b.1 (`record_correction` extended with action-class auto-demote).
**Sibling-aware:** Coordinates around 4f territory.

---

## 1. Goal

Infer the user's communication-style preferences (tone, formality, emoji-OK, direct-feedback-OK, code-comment density, summary style) from accumulated corrections. Synthesize nightly via Dream. Surface via MCP tool + AGENTS.md block. Manual refresh via CLI.

Inferred preferences are shown to the agent at session start so it can adapt its response style without requiring the user to repeat themselves every conversation.

## 2. Out of scope

- **Trained classifier.** This is LLM-driven inference, not ML training. Phase 4e.x covers training.
- **Per-context comm-style** (e.g. casual in Slack, formal in email). v1-of-this-feature is a single user-wide style.
- **Behavior-shaping enforcement** beyond surfacing the inference in AGENTS.md. The agent's job is to honor what's surfaced; we don't post-process its output.
- **History of inferences.** The singleton row stores only the latest synthesis; no versioning.

## 3. Storage

Migration 0013 extends the existing `profile` table (singleton at id `profile:singleton`, seeded by Phase 2c):

```sql
-- 0013-comm-style.surql
DEFINE FIELD comm_style ON profile TYPE option<object> FLEXIBLE;

-- Ensure singleton exists. Phase 2c was supposed to seed it but the seed may
-- not have happened in environments that pre-date the convention. Safe upsert:
UPSERT profile:singleton CONTENT { meta: {} } RETURN NONE;
```

`FLEXIBLE option<object>` over nested SCHEMAFUL fields because SurrealDB v3's nested-DEFINE-FIELD constraints are awkward when the outer field is optional. The synthesis code validates the inner shape in JS — see §5.

Inner shape:

```ts
{
  tone: 'terse' | 'balanced' | 'verbose';
  formality: 'casual' | 'balanced' | 'formal';
  emoji_ok: boolean;
  direct_feedback_ok: boolean;
  code_comment_density: 'minimal' | 'moderate' | 'verbose';
  summary_style: 'bullets' | 'prose' | 'mixed';
  evidence: string[];          // event IDs (correction events) that drove the inference
  confidence: number;          // 0..1, lower = synthesized from fewer signals
  last_synthesized_at: Date;
}
```

## 4. Helpers (`src/jobs/comm-style.js`)

```ts
DEFAULTS: { tone: 'balanced', formality: 'balanced', emoji_ok: false,
            direct_feedback_ok: true, code_comment_density: 'minimal',
            summary_style: 'mixed' }

getCommStyle(db): Promise<row | null>
// Reads profile:singleton.comm_style, or null if never synthesized.

setCommStyle(db, fields): Promise<void>
// UPSERT profile:singleton with the validated fields + last_synthesized_at = now.

validateCommStyleShape(obj): { ok: true, value } | { ok: false, reason }
// Strict enum + type validation. Used to gate LLM output before persisting.

synthesizeCommStyle(db, host, opts?): Promise<{
  ok: boolean,
  comm_style?: object,
  reason?: string,
  signals_used?: number,
}>
// See §5 for the full pipeline.
```

## 5. Synthesis pipeline

`synthesizeCommStyle(db, host, opts = {})`:

1. **Signal collection.** Query `events WHERE source = 'correction' AND created_at > now - 30d ORDER BY created_at DESC LIMIT 100`. (Implementer verification step: confirm the correction-event source is `'correction'`. If the schema uses `'reflection'` after the 4f rename pass, use that. Search for the source value via `git grep "source: 'correction'" src/mcp/tools/`.)

2. **Threshold guard.** If the candidate count is <3:
   - Persist `setCommStyle(db, { ...DEFAULTS, evidence: [], confidence: 0, last_synthesized_at: now })`.
   - Return `{ ok: true, comm_style: <defaults>, signals_used: <count> }`.
   - Rationale: synthesizing from 1-2 events is noisy. Defaults with confidence=0 tell the agent "no real signal yet."

3. **LLM call** (`tier: 'balanced'`, malformed-JSON fallback). Prompt:

   ```
   You are inferring a user's communication-style preferences from their
   recent corrections to an AI assistant.

   Recent corrections (last 30 days, newest first):
   1. <correction.content>
   2. <correction.content>
   …N. <correction.content>

   Respond with strict JSON only:

   {
     "tone": "terse" | "balanced" | "verbose",
     "formality": "casual" | "balanced" | "formal",
     "emoji_ok": boolean,
     "direct_feedback_ok": boolean,
     "code_comment_density": "minimal" | "moderate" | "verbose",
     "summary_style": "bullets" | "prose" | "mixed",
     "confidence": <float 0..1, how confident are you?>,
     "evidence_indices": <[int], 1-indexed indices of corrections that most informed this>
   }

   If a field has no signal, pick "balanced" (or false for booleans).
   No commentary, no markdown fences.
   ```

4. **Parse + validate.** `JSON.parse` → `validateCommStyleShape`. On any failure:
   - Log warning + return `{ ok: false, reason: 'parse_failed' | 'invalid_shape' }`.
   - Do NOT overwrite an existing `comm_style` — partial/bad inference leaves the previous valid one in place.

5. **Resolve evidence.** Map `evidence_indices` back to actual event IDs from the signal list (1-indexed). Drop indices out of range.

6. **Persist.** `setCommStyle(db, { ...validated, evidence, last_synthesized_at: now })`. Return `{ ok: true, comm_style: persisted, signals_used: candidates.length }`.

## 6. Dream integration

Read the existing Dream pipeline at `src/dream/pipeline.js`. The pipeline runs N steps in sequence (Phase 2c shipped 5 steps; the rename pass may have renamed `step-corrections.js` → `step-reflection.js` — verify).

Add a new step `src/dream/step-comm-style.js` that exports an async function `(ctx) => synthesizeCommStyle(ctx.db, ctx.host)`. Wire it into the pipeline's step list at the END (so it sees the latest correction-clustering work from prior steps if any).

The Dream step is FAIL-SOFT: an exception in comm-style synthesis does NOT abort the Dream run. Existing Dream steps follow this pattern; mirror it.

## 7. MCP tool

`src/mcp/tools/get-comm-style.js`:

```ts
{
  name: 'get_comm_style',
  description: 'Read the user\'s inferred communication-style preferences. Returns defaults with confidence: 0 if never synthesized.',
  inputSchema: { type: 'object', properties: {} },
  handler: async () => {
    const row = await getCommStyle(db);
    if (!row) {
      return {
        ...DEFAULTS,
        evidence: [],
        confidence: 0,
        last_synthesized_at: null,
        synthesized: false,
      };
    }
    return { ...row, synthesized: true };
  }
}
```

Always returns a populated shape — the agent never needs to handle null. `synthesized: false` flags "use these as cautious defaults; user hasn't given enough signal yet."

## 8. CLI

```
robin commstyle show     # print the current shape from DB
robin commstyle refresh  # force a synthesis NOW (via daemon endpoint)
```

`show` reads the DB directly (rocksdb open-and-close — accept the close-hang in daemon-running case; offer a flag `--via-daemon` for the resilient path? Not in v1; just open directly and trust the daemon to be down OR live with a one-time slow close).

`refresh` POSTs to `/internal/comm-style/refresh` which triggers `synthesizeCommStyle` synchronously and returns the result.

## 9. Daemon endpoint

`/internal/comm-style/refresh` POST → empty body → calls `synthesizeCommStyle(dbHandle, host)` → returns the result.

Daemon also registers the `get_comm_style` MCP tool at boot (additive to the existing `tools[]` array).

## 10. AGENTS.md

New regenerable block `<!-- robin-comm-style:start -->`. Static when no `comm_style` exists; populated otherwise.

```
## Communication style

Inferred preferences (synthesized nightly from your corrections):
{
  tone: "terse",
  formality: "casual",
  emoji_ok: false,
  direct_feedback_ok: true,
  code_comment_density: "minimal",
  summary_style: "mixed",
  confidence: 0.7,
  synthesized: 2026-05-10T04:00:00Z
}

If `confidence` is low (<0.4), treat these as soft hints; honor explicit
instructions in the current turn first. Use `get_comm_style()` to re-read
if you ever wonder whether something has updated mid-session.
```

When `comm_style` is null:
```
## Communication style

No comm-style inferred yet — too few corrections to synthesize from.
Use balanced defaults. Once enough signals accumulate, Dream will
populate this section nightly.
```

`agentsMdContent({integrations, jobs, commStyle})` signature extended. `mcp-install.js` reads the comm_style at install time via the same pattern as the jobs read (fail-soft on DB error).

## 11. Tests

**Unit:**
- `comm-style-helpers.test.js` — `getCommStyle` returns null when unset; `setCommStyle` UPSERTs into `profile:singleton`; `validateCommStyleShape` accepts valid shapes, rejects bad enums, rejects out-of-range confidence.
- `comm-style-synthesis.test.js` — <3 signals → defaults + confidence:0 without LLM call; 3+ signals with valid LLM output → persisted; malformed LLM output → previous shape preserved, error reason returned.
- `get-comm-style.test.js` — MCP tool returns defaults with `synthesized: false` when null; returns row with `synthesized: true` when populated.
- `commstyle-cli.test.js` — `show` calls helper; `refresh` POSTs to daemon endpoint.
- `agents-md-comm-style.test.js` — block exists; populated form vs null-fallback form both render.

**Integration:**
- `comm-style-roundtrip.test.js` — Seed 5 correction events → call `synthesizeCommStyle` with stub LLM → verify `comm_style` written → call `get_comm_style` tool → matches → AGENTS.md regenerator picks it up.

Approx test count: ~22 unit + 1 integration. Brings full suite to ~1035.

## 12. Migration / rollout

1. `robin migrate` applies 0013.
2. Daemon restart picks up the new MCP tool + endpoint + Dream step.
3. First Dream cycle (next 4 AM by default) attempts synthesis. If <3 corrections in the last 30d, persists defaults with `confidence: 0`.
4. Agent calls `get_comm_style()` at session start and respects what it gets.

## 13. Risk register

- **LLM hallucinates preferences from sparse signals.** Mitigated by the <3 threshold + the confidence field (agent treats low-confidence as soft hint).
- **Cost.** One `tier: 'balanced'` call per Dream cycle. ~30 calls/month. Cheap.
- **Stale inference after user behavior changes.** Synthesis is from-scratch each night (not append-only), so a recent stream of new-style corrections shifts the inference within a day. Acceptable.
- **AGENTS.md regenerator gap (same as 4d's jobs block).** If the DB-read fails at install time, the block renders an "unavailable" fallback. Fail-soft, same pattern.

## 14. Open questions / explicit deferrals

1. **Source values beyond 'correction'.** Phase 2b mentions preferences but the schema may only have a `correction` source. If a `'preference'` event source exists, include it in the signal pool — verify at implementation time.
2. **Quarterly bigger-picture inference.** Synthesis only looks at last 30d. A longer-window quarterly pass could detect slow-evolving preferences. Deferred.
3. **Per-modality comm-style** (chat vs code vs voice). Deferred until there's evidence one is wanted.
4. **Versioning.** A history table of past `comm_style` snapshots would let the user audit drift. Deferred.

## 15. Phase exit criteria

- Migration 0013 applies cleanly.
- 5 corrections seeded → Dream synthesis (or manual `commstyle refresh`) → `profile:singleton.comm_style` populated.
- `get_comm_style()` MCP tool returns the populated shape.
- `robin commstyle show` prints it.
- AGENTS.md `<!-- robin-comm-style:start -->` block renders the inferred shape.
- All tests green.
