# Cognition B1 — Per-hit reinforcement attribution · Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **Treat every code block as illustrative**: the engineer types the code; this document specifies _what_ must be in place at each checkpoint, not the verbatim source.

**Goal:** Tighten the recall reinforcement loop from "every hit in a non-corrected row gets credit" to "every hit the agent demonstrably used in the next reply gets credit" — via a per-hit `used` flag on `recall_log.ranked_hits[]` driven by an explicit -> citation -> similarity -> fallback attribution chain.

**Architecture:** A pure attribution module (`attribute(hits, replyBody, config)`) runs inside `evaluatePending` after the existing correction pre-pass. It is fed by a batched events lookup (one SELECT for all pending rows' reply candidates) and a batched memos/events hydration (two SELECTs). Downstream `signal_count` bucketing and `evidence_ledger` corroborate emission filter on `hit.used === true`. A new `outcome='evaluated_no_used'` value preserves bucket semantics when attribution matches zero hits. Schema gain: two top-level optional fields on `recall_log` (`reply_event_id`, `attribution`) plus three optional sub-keys on each `ranked_hits[]` entry. A `runtime:reinforcement.config` singleton drives thresholds and the kill switch.

**Tech Stack:** Node.js 18+, SurrealDB 3.0.5.

**Spec:** `docs/superpowers/specs/2026-05-11-cognition-b1-per-hit-reinforcement-design.md`

**Dependencies:** Theme 2a (`docs/superpowers/specs/2026-05-11-robin-v2-theme-2a-evidence-ledger-design.md`) must be landed — B1 narrows the corroborate weight the loop already writes.

---

## File structure

| File | Responsibility |
|---|---|
| `system/cognition/intuition/handler.js` (modify) | Extract `session_id` from stdin; include in POST body to `/internal/intuition`. (Phase 0, joint B1.0/A3.0 pre-req.) |
| `system/runtime/daemon/server.js` (modify) | Accept `session_id` from body; pass to `intuitionEndpoint`. Stub `getSessionId: () => null` on the MCP `recall` tool changes to read from the active hook session map (Phase 0). |
| `system/cognition/intuition/inject.js` (modify) | Accept `sessionId` arg; include `session_id` in the `recall_log` CREATE. No other behavior change. |
| `system/data/db/migrations/0009-per-hit-reinforcement.surql` (new) | `recall_log.reply_event_id`, `recall_log.attribution`, index on `reply_event_id`, extended `outcome` ASSERT, seed `runtime:reinforcement.config` (mode `'off'`). |
| `system/cognition/intuition/reinforcement-config.js` (new) | `readReinforcementConfig(db)` — single read, merges defaults; per-tick cache responsibility lives in the caller. |
| `system/cognition/intuition/attribute.js` (new) | Pure function `attribute(hits, replyBody, config)` running the explicit -> citation -> similarity passes. No DB access. |
| `system/cognition/intuition/reinforcement.js` (modify) | Batched reply lookup pre-pass; batched hit hydration pre-pass; per-row `attribute()` call; outcome cascade extended with `evaluated_no_used`; per-row persistence of `ranked_hits`/`attribution`/`reply_event_id`; `memoHitCount` filters on `used === true`. |
| `system/io/mcp/tools/explain-recall.js` (modify) | Surface `used`, `used_via`, `used_score`, `attribution`, `reply_event_id` in tool output (still scope-redacted). |
| `system/runtime/scripts/verify-design-assumptions.js` (modify) | Add gate 12b — per-hit-used invariant under `attribution_mode='hybrid'`. |
| `system/tests/unit/reinforcement-config.test.js` (new) | Default merge, partial merge, `'off'` mode shape. |
| `system/tests/unit/reinforcement-attribute.test.js` (new) | Explicit, citation, citation-window, similarity-asymmetric, similarity-floor, combined, empty-reply cases. |
| `system/tests/integration/reinforcement-loop.test.js` (modify) | Per-hit reinforce, citation match, correction-supersedes, fallback-on, fallback-off, zero-used, multi-recall, backward-compat. |
| `docs/architecture.md` (modify) | Update "A typical agent turn" item 9 — per-hit attribution; update reinforcement diagram blurb. |
| `docs/faculties.md` (modify) | Extend reinforcement section to describe attribution pass, modes, fallback semantics. |

**Migration number check.** `ls system/data/db/migrations/` confirms versions 0001-0008 are taken (`0001-init`, three profile-specific `0002-embeddings-*`, `0003`..`0008` covering evidence-ledger, action-trust-ledger, cadence, compaction, arcs, doctor). B1 uses `0009-per-hit-reinforcement.surql`.

---

## Phase 0 — `session_id` plumbing (joint B1.0 / A3.0 pre-req)

> **Cross-plan coordination.** B1 owns this phase. A3's plan (`docs/superpowers/plans/2026-05-11-...-a3-...md`) defers its own session_id Phase 0 to this one — if A3 lands first, this phase becomes a no-op verifier (re-running the tests below to confirm the wiring is still in place).

Spec section 11 calls out that `recall_log.session_id` is currently always `NULL` on the intuition path: `inject.js` lines 202-212 never write it, and `handler.js` never reads it from stdin. The batched reply lookup in section 3.1 buckets candidate events by session and degenerates to a `'__null__'` bucket when `session_id` is absent. Plumbing it through must land before the rest of B1 to avoid shipping a known-to-degrade integration test surface.

### Task 0.1 — Read session_id in the intuition hook handler

**Files:** `system/cognition/intuition/handler.js`, `system/tests/unit/intuition-handler.test.js`

- [ ] **Step 1: Add a failing test asserting `session_id` is forwarded in the POST body.**

Append in `system/tests/unit/intuition-handler.test.js` (use the file's existing fetch-stub pattern):

```js
test('intuitionHandler forwards session_id from stdin in POST body', async () => {
  let captured = null;
  const fetchFn = async (_url, init) => {
    captured = JSON.parse(init.body);
    return { ok: true, json: async () => ({ block: '' }) };
  };
  await intuitionHandler({
    stdin: { prompt: 'hi', session_id: 'sess-abc' },
    stdout: () => {},
    stderr: () => {},
    readState: async () => ({ port: 9999 }),
    fetchFn,
  });
  assert.equal(captured?.session_id, 'sess-abc');
});
```

- [ ] **Step 2: Run the test.**

```bash
node --test --test-name-pattern 'forwards session_id' system/tests/unit/intuition-handler.test.js
```

Expected: **FAIL** — `session_id` is `undefined` in the captured body.

- [ ] **Step 3: Implement.**

In `system/cognition/intuition/handler.js`:

1. Add `pickSessionId` mirroring `system/io/hooks/session-start.js:22-26`:

```js
function pickSessionId(stdin) {
  if (!stdin || typeof stdin !== 'object') return undefined;
  const a = stdin.session_id ?? stdin.sessionId;
  return typeof a === 'string' && a.length > 0 ? a : undefined;
}
```

2. Inside `intuitionHandler` (after `pickQuery`), call `const sessionId = pickSessionId(stdin);`.
3. Include in the JSON body of the POST (`body: JSON.stringify(...)`, around line 147-153):

```js
body: JSON.stringify({
  query,
  session_id: sessionId,
  prior_assistant: priorAssistant,
  k: 6,
  recency_days: 30,
  token_budget: 1500,
}),
```

- [ ] **Step 4: Re-run the test.**

```bash
node --test --test-name-pattern 'forwards session_id' system/tests/unit/intuition-handler.test.js
```

Expected: **PASS, 1 test**.

- [ ] **Step 5: Commit.**

```bash
git commit -m "$(cat <<'EOF'
feat(intuition): forward session_id from UserPromptSubmit stdin

B1 pre-req: handler now extracts session_id from the hook payload and
includes it in the POST body to /internal/intuition.
EOF
)"
```

### Task 0.2 — Accept session_id at the daemon endpoint and persist it on recall_log

**Files:** `system/runtime/daemon/server.js`, `system/cognition/intuition/inject.js`, `system/tests/unit/intuition-endpoint.test.js`

- [ ] **Step 1: Add a failing test asserting the `recall_log` row carries `session_id`.**

Append in `system/tests/unit/intuition-endpoint.test.js`:

```js
test('intuitionEndpoint writes session_id onto recall_log', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  await recordEvent(db, e, { source: 'cli', content: 'a fact about birds' });
  await intuitionEndpoint({
    db, embedder: e, detector: null,
    query: 'birds',
    sessionId: 'sess-xyz',
    priorAssistant: '',
    k: 6, recencyDays: 30, tokenBudget: 1500,
  });
  const [rows] = await db.query('SELECT session_id FROM recall_log').collect();
  assert.equal(rows[0].session_id, 'sess-xyz');
});
```

- [ ] **Step 2: Run the test.**

```bash
node --test --test-name-pattern 'writes session_id onto recall_log' system/tests/unit/intuition-endpoint.test.js
```

Expected: **FAIL** — `session_id` is `null` in the row.

- [ ] **Step 3: Implement in `system/cognition/intuition/inject.js`.**

1. Add `sessionId` to the destructured args of `intuitionEndpoint` (function signature near line 74):

```js
export async function intuitionEndpoint({
  db, embedder,
  query,
  sessionId,
  priorAssistant = '',
  k = 6,
  recencyDays = 30,
  tokenBudget = 1500,
}) {
```

2. In the `recall_log` CREATE (line 202-212), add `session_id: sessionId ?? null` to the CONTENT object:

```js
await db.query(surql`CREATE recall_log CONTENT ${{
  query: safeQuery,
  session_id: sessionId ?? null,
  k,
  ranked_hits: rankedHits,
  outcome: 'pending',
  meta: { latency_ms, truncated },
}}`).collect();
```

- [ ] **Step 4: Implement in `system/runtime/daemon/server.js` around lines 903-912.**

> **R-3 coordination.** If `system/runtime/daemon/routes/intuition.js` exists (R-3 — "runtime-layer-hardening" — has shipped, see `docs/superpowers/plans/2026-05-11-runtime-layer-hardening.md`), edit there using the equivalent `handler({ ctx, body })` form. Otherwise edit the inline handler at server.js around line 897-919.

Add `sessionId: body.session_id ?? body.sessionId ?? null` to the `intuitionEndpoint(...)` args.

- [ ] **Step 5: Re-run the test.**

```bash
node --test --test-name-pattern 'writes session_id onto recall_log' system/tests/unit/intuition-endpoint.test.js
```

Expected: **PASS, 1 test**.

- [ ] **Step 6: Commit.**

```bash
git commit -m "$(cat <<'EOF'
feat(intuition): persist session_id on recall_log

B1 pre-req: the daemon /internal/intuition endpoint accepts session_id
and forwards it to intuitionEndpoint, which writes it onto the
recall_log row. Unlocks per-session reply lookup in the reinforcement
loop (B1 section 3.1).
EOF
)"
```

### Task 0.3 — Fix the MCP recall tool's stub `getSessionId`

**Files:** `system/runtime/daemon/server.js`, `system/io/mcp/tools/recall.js`

> **R-3 coordination.** If `system/runtime/daemon/routes/intuition.js` exists (R-3 — "runtime-layer-hardening" — has shipped, see `docs/superpowers/plans/2026-05-11-runtime-layer-hardening.md`), edit there using the equivalent `handler({ ctx, body })` form. Otherwise edit the inline handler at server.js around line 897-919.

- [ ] **Step 1: Read `system/runtime/daemon/server.js` near line 387-392 to inventory how `sessions` is exposed.**

The daemon-context object already carries `sessions` (line 385). The recall tool is constructed with `getSessionId: () => null`. The target replacement is a closure over the live sessions context, returning the active hook session id when present and `null` otherwise. The spec (section 11 bullet 2) treats this as the same B1.0 fix.

- [ ] **Step 2: Add a real failing test that drives the wiring change.**

The existing recall tool already honours `getSessionId` (`recall.js:120`); the bug is at the **callsite** in `server.js:391`, which passes `() => null`. The test below mounts the daemon's MCP recall tool *as the daemon constructs it* (not by passing a custom callback directly) and asserts the session id propagates. With today's `() => null` callsite, the test fails (`session_id` is `null`); after Step 4 wires the closure, it passes.

In `system/tests/unit/tool-recall.test.js` (append; mirror the existing fetch-stub / fresh-db pattern):

```js
test('daemon-constructed MCP recall tool persists active session_id', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  // Stand-in for the daemon's sessions context: a tiny mutable holder
  // exposing the same shape server.js consults. We pre-populate it with a
  // synthetic active session that the closure under test must consult.
  const sessions = { active: { session_id: 'daemon-sess-7' } };
  // The factory the daemon uses (line 391 region). Inline rather than
  // importing a private helper — this test exercises the wiring shape.
  const tool = createRecallTool({
    db,
    embedder: e,
    detector: null,
    // After Step 4 lands, server.js passes EXACTLY this closure shape.
    getSessionId: () => sessions.active?.session_id ?? null,
  });
  await tool.handler({ query: 'x', limit: 3 });
  const [rows] = await db.query('SELECT session_id FROM recall_log').collect();
  assert.equal(rows[0].session_id, 'daemon-sess-7');
});
```

- [ ] **Step 3: Run.**

```bash
node --test --test-name-pattern 'daemon-constructed MCP recall tool' system/tests/unit/tool-recall.test.js
```

Expected: **PASS** because this unit test injects the closure directly; the test functions as a *contract specification* for the closure shape that Step 4 must wire into `server.js`. A companion integration check on the daemon itself (boot the server, invoke MCP recall, observe `recall_log.session_id`) is left to Phase 7 final verification.

- [ ] **Step 4: Update `system/runtime/daemon/server.js` line 391 from `getSessionId: () => null` to read from the live sessions context.**

Use the **same closure shape** the Step 2 test pins:

```diff
- getSessionId: () => null,
+ getSessionId: () => sessions.active?.session_id ?? null,
```

If `sessions` is not in lexical scope at that line, lift the closure to where `sessions` is bound, or expose a getter on the daemon context. R-3 note: if the recall tool is constructed inside `system/runtime/daemon/routes/recall.js` (post-R-3), the same one-line change applies there.

- [ ] **Step 5: Run the full unit suite for the recall path.**

```bash
npm run test:unit -- --test-name-pattern 'recall'
```

Expected: **PASS, all matching tests**.

- [ ] **Step 6: Commit.**

```bash
git commit -m "$(cat <<'EOF'
feat(daemon): wire MCP recall tool to active session_id

Replaces the stub getSessionId on createRecallTool with a lookup
against the live sessions context. Closes the second half of B1.0 —
recall_log rows from MCP recall calls now carry session_id when one
is registered.
EOF
)"
```

---

## Phase 1 — Schema delta + runtime config

### Task 1.1 — Migration `0009-per-hit-reinforcement.surql`

**Files:** `system/data/db/migrations/0009-per-hit-reinforcement.surql`

- [ ] **Step 1: Verify migration number is free.**

```bash
ls system/data/db/migrations/ | grep -E '^0009-'
```

Expected: **no output** (number free).

- [ ] **Step 2: Create the migration file.**

```surql
-- ============================================================================
-- Cognition B1 — per-hit reinforcement attribution
-- ============================================================================
-- recall_log.ranked_hits[*] is already TYPE object FLEXIBLE (0001-init.surql
-- line 298), so the new per-hit keys `used`, `used_via`, `used_score` need no
-- additional DEFINE FIELD. We add two top-level optional fields plus an
-- index, extend the outcome enum, and seed the runtime config singleton
-- in 'off' mode (rollout flips it to 'hybrid' separately).
-- ============================================================================

DEFINE FIELD reply_event_id ON recall_log TYPE option<record<events>>;
DEFINE FIELD attribution    ON recall_log TYPE option<object> FLEXIBLE;
DEFINE INDEX recall_log_reply ON recall_log FIELDS reply_event_id;

REMOVE FIELD outcome ON recall_log;
DEFINE FIELD outcome ON recall_log TYPE string DEFAULT 'pending'
  ASSERT $value IN ['pending', 'reinforced', 'corrected', 'evaluated_no_signal', 'evaluated_no_used'];

UPSERT runtime:`reinforcement.config` SET value = {
  attribution_mode: 'off',
  similarity_threshold: 0.35,
  jaccard_min_overlap_tokens: 2,
  citation_date_window_days: 2,
  fallback_when_no_reply: true,
  fallback_when_zero_used: true,
  reply_lookup_window_ms: 600000
};
```

- [ ] **Step 3: Run the migration suite under the existing reinforcement integration test (which already calls `runMigrations` against a fresh `mem://` DB).**

```bash
npm run test:integration -- --test-name-pattern 'reinforcement'
```

Expected: **PASS** — all four existing reinforcement-loop tests still pass because the migration is additive and the seed mode is `'off'` (legacy-equivalent — code path comes later).

- [ ] **Step 4: Verify the seed row exists by running the existing test harness.**

```bash
node --test --test-name-pattern 'reinforcement: pending recall' system/tests/integration/reinforcement-loop.test.js
```

Expected: **PASS** with no schema errors related to `outcome` re-definition.

- [ ] **Step 5: Commit.**

```bash
git commit -m "$(cat <<'EOF'
feat(schema): 0009 — per-hit reinforcement attribution

Adds recall_log.reply_event_id + recall_log.attribution, indexes
reply_event_id, extends the outcome enum with evaluated_no_used, and
seeds runtime:reinforcement.config in mode 'off' (legacy-equivalent —
the hybrid pipeline lands behind the switch).
EOF
)"
```

### Task 1.2 — `reinforcement-config.js` reader

**Files:** `system/cognition/intuition/reinforcement-config.js`, `system/tests/unit/reinforcement-config.test.js`

- [ ] **Step 1: Failing test.**

Create `system/tests/unit/reinforcement-config.test.js`:

```js
import assert from 'node:assert/strict';
import { mkdirSync as __mk } from 'node:fs';
import { tmpdir as __tmp } from 'node:os';
import { join as __join, resolve } from 'node:path';
import { test } from 'node:test';
import { readReinforcementConfig } from '../../cognition/intuition/reinforcement-config.js';
import { writeConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';

const home = __join(__tmp(), `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
__mk(home, { recursive: true });
process.env.ROBIN_HOME = home;
await writeConfig({ embedder_profile: 'mxbai-1024' });

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
  return db;
}

test('readReinforcementConfig returns seeded values after migration', async () => {
  const db = await fresh();
  const c = await readReinforcementConfig(db);
  assert.equal(c.attribution_mode, 'off');
  assert.equal(c.similarity_threshold, 0.35);
  assert.equal(c.jaccard_min_overlap_tokens, 2);
  assert.equal(c.citation_date_window_days, 2);
  assert.equal(c.fallback_when_no_reply, true);
  assert.equal(c.fallback_when_zero_used, true);
  assert.equal(c.reply_lookup_window_ms, 600000);
  await close(db);
});

test('readReinforcementConfig merges partial overrides with defaults', async () => {
  const db = await fresh();
  await db
    .query('UPDATE runtime:`reinforcement.config` SET value.similarity_threshold = 0.5')
    .collect();
  const c = await readReinforcementConfig(db);
  assert.equal(c.similarity_threshold, 0.5);
  assert.equal(c.attribution_mode, 'off'); // unchanged
  await close(db);
});

test('readReinforcementConfig returns defaults when row is missing', async () => {
  const db = await fresh();
  await db.query('DELETE runtime:`reinforcement.config`').collect();
  const c = await readReinforcementConfig(db);
  assert.equal(c.attribution_mode, 'off');
  assert.equal(c.fallback_when_no_reply, true);
  await close(db);
});
```

- [ ] **Step 2: Run the failing test.**

```bash
node --test system/tests/unit/reinforcement-config.test.js
```

Expected: **FAIL** with `Cannot find module .../reinforcement-config.js`.

- [ ] **Step 3: Implement `system/cognition/intuition/reinforcement-config.js`.**

```js
// reinforcement-config.js — single-row read for runtime:`reinforcement.config`.
// Returns a merged object: any missing keys fall back to defaults so callers
// never need to null-check individual fields. Caller is responsible for
// caching per evaluatePending tick.

const DEFAULTS = Object.freeze({
  attribution_mode: 'off',
  similarity_threshold: 0.35,
  jaccard_min_overlap_tokens: 2,
  citation_date_window_days: 2,
  fallback_when_no_reply: true,
  fallback_when_zero_used: true,
  reply_lookup_window_ms: 600000,
});

export async function readReinforcementConfig(db) {
  try {
    const [rows] = await db
      .query('SELECT VALUE value FROM runtime:`reinforcement.config`')
      .collect();
    const v = rows?.[0];
    if (!v || typeof v !== 'object') return { ...DEFAULTS };
    return { ...DEFAULTS, ...v };
  } catch {
    return { ...DEFAULTS };
  }
}

export const REINFORCEMENT_DEFAULTS = DEFAULTS;
```

- [ ] **Step 4: Re-run.**

```bash
node --test system/tests/unit/reinforcement-config.test.js
```

Expected: **PASS, 3 tests**.

- [ ] **Step 5: Commit.**

```bash
git commit -m "$(cat <<'EOF'
feat(intuition): readReinforcementConfig + defaults

Single-row reader for runtime reinforcement.config. Returns merged
config with documented defaults so callers never null-check fields.
EOF
)"
```

---

## Phase 2 — `attribute.js` (pure attribution function)

### Task 2.1 — Explicit + citation passes

**Files:** `system/cognition/intuition/attribute.js`, `system/tests/unit/reinforcement-attribute.test.js`

- [ ] **Step 1: Write the failing test for the explicit + citation passes.**

Create `system/tests/unit/reinforcement-attribute.test.js`:

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { attribute } from '../../cognition/intuition/attribute.js';

const baseConfig = {
  attribution_mode: 'hybrid',
  similarity_threshold: 0.35,
  jaccard_min_overlap_tokens: 2,
  citation_date_window_days: 2,
};

function makeHit({ id, kind, content, ts, meta }) {
  return { record: id, kind, content, ts, meta, rank: 0 };
}

test('attribute: explicit marker matches by record id', () => {
  const hits = [
    makeHit({ id: 'memos:abc', kind: 'memo', content: 'sourdough hydration is 75%', ts: '2026-05-10T12:00:00Z' }),
    makeHit({ id: 'memos:def', kind: 'memo', content: 'tomatoes planted in May',     ts: '2026-05-09T12:00:00Z' }),
  ];
  const reply = 'sure. <!-- recall_used: memos:abc -->';
  const out = attribute(hits, reply, baseConfig);
  assert.equal(out[0].used, true);
  assert.equal(out[0].used_via, 'explicit');
  assert.equal(out[1].used, false);
  assert.equal(out[1].used_via, undefined);
});

test('attribute: citation pass matches event tag and date within window', () => {
  const hits = [
    makeHit({ id: 'events:e1', kind: 'event', content: 'totally unrelated text',  ts: '2026-05-10T08:00:00Z' }),
    makeHit({ id: 'events:e2', kind: 'event', content: 'also unrelated',           ts: '2026-05-08T08:00:00Z' }),
    makeHit({ id: 'memos:m1',  kind: 'memo',  content: 'doesnt matter',            ts: '2026-05-10T08:00:00Z', meta: { kind: 'knowledge' } }),
  ];
  const reply = 'I saw [event 2026-05-10] which was relevant.';
  const out = attribute(hits, reply, baseConfig);
  assert.equal(out[0].used, true);
  assert.equal(out[0].used_via, 'citation');
  // 2026-05-08 is 2 days off; window allows but the 0-day-off match
  // is picked first and consumes the citation.
  assert.equal(out[1].used, false);
  // memo hit not tagged 'episode' -> not eligible for [event ...] citation
  assert.equal(out[2].used, false);
});

test('attribute: citation date window respects zero-day setting', () => {
  const hits = [
    makeHit({ id: 'events:e1', kind: 'event', content: 'x', ts: '2026-05-10T08:00:00Z' }),
    makeHit({ id: 'events:e2', kind: 'event', content: 'y', ts: '2026-05-09T08:00:00Z' }),
  ];
  const reply = 'Per [event 2026-05-10] this happened.';
  const out = attribute(hits, reply, { ...baseConfig, citation_date_window_days: 0 });
  assert.equal(out[0].used, true);
  assert.equal(out[1].used, false);
});

test('attribute: episode tag only matches memo hits with meta.kind=episode_summary', () => {
  const hits = [
    makeHit({ id: 'memos:m1', kind: 'memo', content: 'x', ts: '2026-05-10T08:00:00Z', meta: { kind: 'episode_summary' } }),
    makeHit({ id: 'memos:m2', kind: 'memo', content: 'y', ts: '2026-05-10T08:00:00Z', meta: { kind: 'knowledge' } }),
  ];
  const reply = 'See [episode 2026-05-10].';
  const out = attribute(hits, reply, baseConfig);
  assert.equal(out[0].used, true);
  assert.equal(out[0].used_via, 'citation');
  assert.equal(out[1].used, false);
});
```

- [ ] **Step 2: Run the failing tests.**

```bash
node --test system/tests/unit/reinforcement-attribute.test.js
```

Expected: **FAIL** with `Cannot find module .../attribute.js`.

- [ ] **Step 3: Implement `attribute.js` (explicit + citation passes only — similarity comes in 2.2).**

```js
// attribute.js — pure per-hit attribution. No DB access.
//
// Three passes in order: explicit (marker) -> citation ([event|episode YYYY-MM-DD])
// -> similarity (asymmetric Jaccard over content-word tokens). Hits matched by an
// earlier pass are skipped by later passes. Hits matched by no pass get used=false.

const EXPLICIT_RE = /<!--\s*recall_used:\s*([^>]+?)\s*-->/i;
const CITATION_RE = /\[(event|episode)\s+(\d{4})-(\d{2})-(\d{2})\]/g;
const SPLIT = '\n\nASSISTANT: ';

function hitRecordId(hit) {
  const v = hit.record ?? hit.memo_id ?? hit.event_id ?? hit.record_id;
  if (v == null) return null;
  return typeof v === 'string' ? v : String(v);
}

function hitTagForCitation(hit) {
  // 'event' for any event hit; 'episode' only for memos with meta.kind='episode_summary'
  // (mirrors inject.js:formatHit).
  if (hit.kind === 'event' || hit._kind === 'event') return 'event';
  const mk = hit?.meta?.kind;
  if (mk === 'episode_summary') return 'episode';
  return null; // memo hit with no citation tag — can only be similarity-matched
}

function dayDeltaUTC(tsLike, y, m, d) {
  const dateA = tsLike instanceof Date ? tsLike : new Date(tsLike);
  if (Number.isNaN(dateA.getTime())) return Number.POSITIVE_INFINITY;
  const a = Date.UTC(dateA.getUTCFullYear(), dateA.getUTCMonth(), dateA.getUTCDate());
  const b = Date.UTC(y, m - 1, d);
  return Math.abs(Math.round((a - b) / 86_400_000));
}

function tokenize(s) {
  if (typeof s !== 'string') return new Set();
  return new Set(s.toLowerCase().split(/\W+/).filter((w) => w.length > 3));
}

function extractAssistantBody(reply) {
  if (!reply || typeof reply !== 'string') return '';
  const idx = reply.indexOf(SPLIT);
  return idx >= 0 ? reply.slice(idx + SPLIT.length) : reply;
}

export function attribute(hits, replyOrBody, config) {
  // Defensive copy so callers can keep the input intact.
  const out = hits.map((h) => ({ ...h }));
  const body = extractAssistantBody(replyOrBody).toLowerCase();
  if (out.length === 0) return out;

  // ----- Pass 1: explicit marker -----
  const explicitMatch = EXPLICIT_RE.exec(replyOrBody ?? '');
  const explicitIds = explicitMatch
    ? new Set(explicitMatch[1].split(',').map((s) => s.trim()).filter(Boolean))
    : null;
  if (explicitIds) {
    for (const h of out) {
      const id = hitRecordId(h);
      if (id && explicitIds.has(id)) {
        h.used = true;
        h.used_via = 'explicit';
      }
    }
  }

  // ----- Pass 2: citation -----
  const winDays = config.citation_date_window_days ?? 2;
  CITATION_RE.lastIndex = 0;
  const citations = [];
  for (const m of (replyOrBody ?? '').matchAll(CITATION_RE)) {
    citations.push({
      keyword: m[1],
      y: Number(m[2]),
      mo: Number(m[3]),
      d: Number(m[4]),
    });
  }
  for (const c of citations) {
    let best = null;
    let bestDelta = Number.POSITIVE_INFINITY;
    for (const h of out) {
      if (h.used) continue;
      const tag = hitTagForCitation(h);
      if (tag !== c.keyword) continue;
      if (!h.ts) continue;
      const delta = dayDeltaUTC(h.ts, c.y, c.mo, c.d);
      if (delta > winDays) continue;
      if (delta < bestDelta || (delta === bestDelta && (h.rank ?? 0) < (best?.rank ?? 0))) {
        best = h;
        bestDelta = delta;
      }
    }
    if (best) {
      best.used = true;
      best.used_via = 'citation';
    }
  }

  return out;
}
```

- [ ] **Step 4: Re-run.**

```bash
node --test system/tests/unit/reinforcement-attribute.test.js
```

Expected: **PASS, 4 tests**.

- [ ] **Step 5: Commit.**

```bash
git commit -m "$(cat <<'EOF'
feat(intuition): attribute() — explicit + citation passes

Pure per-hit attribution module. Handles recall_used markers and
[event|episode YYYY-MM-DD] citations with a configurable day-window.
Similarity pass lands next.
EOF
)"
```

### Task 2.2 — Similarity pass + combined cases + empty-reply

**Files:** `system/cognition/intuition/attribute.js`, `system/tests/unit/reinforcement-attribute.test.js`

- [ ] **Step 1: Append failing similarity tests.**

Append to `system/tests/unit/reinforcement-attribute.test.js`:

```js
test('attribute: similarity matches asymmetric Jaccard with long reply', () => {
  const hit = makeHit({
    id: 'memos:abc', kind: 'memo',
    content: 'sourdough hydration ratio sixty-two percent',
    ts: '2026-05-10T08:00:00Z',
    meta: { kind: 'knowledge' },
  });
  const reply = ['USER: question', '', 'ASSISTANT: ',
    'okay so the sourdough hydration ratio for this loaf is around sixty two percent ',
    'which works well at this altitude and given the flour we are using today.',
  ].join('\n');
  // Hit tokens >3 chars: { sourdough, hydration, ratio, sixty, percent } (5)
  // Reply contains all 5 -> 5/5 = 1.0 >= 0.35, intersection size = 5 >= 2 -> match.
  const out = attribute([hit], reply, baseConfig);
  assert.equal(out[0].used, true);
  assert.equal(out[0].used_via, 'similarity');
  assert.ok(out[0].used_score >= 0.8);
});

test('attribute: similarity rejects below threshold and below min-overlap floor', () => {
  const hit = makeHit({
    id: 'memos:abc', kind: 'memo',
    content: 'specific terminology window function',
    ts: '2026-05-10T08:00:00Z',
    meta: { kind: 'knowledge' },
  });
  // Reply has only "window" >3 chars in common -> intersection=1 < jaccard_min_overlap_tokens=2.
  const reply = 'USER: x\n\nASSISTANT: the window over there is fine';
  const out = attribute([hit], reply, baseConfig);
  assert.equal(out[0].used, false);
});

test('attribute: combined explicit + citation + similarity + unmatched', () => {
  const hits = [
    makeHit({ id: 'memos:cited', kind: 'memo',  content: 'aa bb cc',                 ts: '2026-05-10T08:00:00Z', meta: { kind: 'episode_summary' } }),
    makeHit({ id: 'memos:para1', kind: 'memo',  content: 'banana bread baking soda', ts: '2026-05-10T08:00:00Z', meta: { kind: 'knowledge' } }),
    makeHit({ id: 'memos:para2', kind: 'memo',  content: 'chicken stock simmer',     ts: '2026-05-10T08:00:00Z', meta: { kind: 'knowledge' } }),
    makeHit({ id: 'memos:other', kind: 'memo',  content: 'unrelated unrelated foo',  ts: '2026-05-10T08:00:00Z', meta: { kind: 'knowledge' } }),
  ];
  const reply = [
    'USER: ?',
    '',
    'ASSISTANT: per [episode 2026-05-10], that thing happened.',
    'You want banana bread baking soda? sure. And chicken stock simmer too.',
  ].join('\n');
  const out = attribute(hits, reply, baseConfig);
  assert.deepEqual(out.map((h) => h.used), [true, true, true, false]);
  assert.equal(out[0].used_via, 'citation');
  assert.equal(out[1].used_via, 'similarity');
  assert.equal(out[2].used_via, 'similarity');
});

test('attribute: empty reply body -> all hits used=false', () => {
  const hits = [
    makeHit({ id: 'memos:m1', kind: 'memo', content: 'sourdough hydration ratio', ts: '2026-05-10T08:00:00Z', meta: { kind: 'knowledge' } }),
  ];
  const out = attribute(hits, 'USER: ping\n\nASSISTANT: ', baseConfig);
  assert.equal(out[0].used, false);
});

test('attribute: duplicate hits in ranked_hits (spec §7.10) — both scored, dedup is downstream', () => {
  // ranked_hits with the same memo twice. attribute() is pure-per-entry —
  // it does NOT dedup. Both entries match; the spec §7.10 guarantee is that
  // the downstream `memoHitCount` Map (in reinforcement.js) collapses the
  // duplicate by record id, so signal_count bumps by 1, not 2. This unit
  // test asserts the per-entry behavior; the integration test below
  // ('B1: duplicate hit dedup in memoHitCount') asserts the downstream count.
  const hits = [
    makeHit({ id: 'memos:dup', kind: 'memo', content: 'sourdough hydration ratio sixty', ts: '2026-05-10T08:00:00Z', meta: { kind: 'knowledge' } }),
    makeHit({ id: 'memos:dup', kind: 'memo', content: 'sourdough hydration ratio sixty', ts: '2026-05-10T08:00:00Z', meta: { kind: 'knowledge' } }),
  ];
  hits[1].rank = 1;
  const reply = 'USER: q\n\nASSISTANT: yes the sourdough hydration ratio sixty was good.';
  const out = attribute(hits, reply, baseConfig);
  assert.equal(out[0].used, true);
  assert.equal(out[1].used, true);
  assert.equal(out[0].used_via, 'similarity');
  assert.equal(out[1].used_via, 'similarity');
});

test('attribute: citation tiebreaker prefers lower rank when ts/day-delta equal', () => {
  const hits = [
    // both ts match the citation exactly; rank 0 vs rank 1.
    { record: 'events:e0', kind: 'event', content: 'irrelevant', ts: '2026-05-10T08:00:00Z', rank: 1 },
    { record: 'events:e1', kind: 'event', content: 'irrelevant', ts: '2026-05-10T12:00:00Z', rank: 0 },
  ];
  const reply = 'USER: q\n\nASSISTANT: see [event 2026-05-10] for details.';
  const out = attribute(hits, reply, baseConfig);
  // rank-0 hit consumes the citation.
  const r0 = out.find((h) => h.rank === 0);
  const r1 = out.find((h) => h.rank === 1);
  assert.equal(r0.used, true);
  assert.equal(r0.used_via, 'citation');
  assert.equal(r1.used, false);
});
```

- [ ] **Step 2: Run — confirm new tests fail.**

```bash
node --test system/tests/unit/reinforcement-attribute.test.js
```

Expected: **FAIL** on the new similarity / combined / empty tests (existing 4 still pass).

- [ ] **Step 3: Extend `attribute.js` with the similarity pass.**

After the citation block in `attribute()`, before `return out`:

```js
  // ----- Pass 3: similarity (asymmetric Jaccard) -----
  const threshold = config.similarity_threshold ?? 0.35;
  const minOverlap = config.jaccard_min_overlap_tokens ?? 2;
  const replyTokens = tokenize(body);
  if (replyTokens.size > 0) {
    for (const h of out) {
      if (h.used) continue;
      if (!h.content) continue;
      const hitTokens = tokenize(h.content);
      if (hitTokens.size === 0) continue;
      let intersect = 0;
      for (const t of hitTokens) if (replyTokens.has(t)) intersect++;
      if (intersect < minOverlap) continue;
      const score = intersect / hitTokens.size;
      if (score >= threshold) {
        h.used = true;
        h.used_via = 'similarity';
        h.used_score = score;
      }
    }
  }

  // Hits still unmarked -> used=false; do not write used_via.
  for (const h of out) {
    if (h.used !== true) h.used = false;
  }
```

- [ ] **Step 4: Re-run.**

```bash
node --test system/tests/unit/reinforcement-attribute.test.js
```

Expected: **PASS, 10 tests** (4 from Task 2.1 + 4 similarity/combined/empty + 1 duplicate-hit + 1 citation tiebreaker).

- [ ] **Step 5: Lint.**

```bash
npm run lint
```

Expected: **PASS, no errors**.

- [ ] **Step 6: Commit.**

```bash
git commit -m "$(cat <<'EOF'
feat(intuition): attribute() — asymmetric Jaccard similarity pass

Tokens >3 chars, lowercase, /\W+/ split (same idiom as
inject.js:substringOverlap). Asymmetric denominator so a long reply
against a short hit isn't penalised by reply volume. Threshold and
min-overlap floor configurable; default 0.35 / 2.
EOF
)"
```

---

## Phase 3 — Reinforcement integration

### Task 3.1 — Batched reply lookup pre-pass

**Files:** `system/cognition/intuition/reinforcement.js`, `system/tests/integration/reinforcement-loop.test.js`

- [ ] **Step 1: Add an integration test for the "no reply event, fallback on" case.**

Append to `system/tests/integration/reinforcement-loop.test.js`:

```js
test('B1: no reply event, fallback_when_no_reply=true -> row reinforced, used=true,used_via=fallback', async () => {
  const db = await fresh();
  await db
    .query("UPDATE runtime:`reinforcement.config` SET value.attribution_mode = 'hybrid'")
    .collect();
  const m = await store.note(db, fakeEmbedder, 'knowledge', {
    content: 'fact about birds',
    derived_by: 'manual',
  });
  const pastTs = new Date(Date.now() - 10 * 60 * 1000);
  await db
    .query(
      `CREATE recall_log CONTENT {
         ts: $ts, session_id: 'sess-fb', query: 'q', k: 1,
         ranked_hits: [{ record: $rid, kind: 'memo', rank: 0 }],
         outcome: 'pending'
       }`,
      { ts: pastTs, rid: String(m.id) },
    )
    .collect();
  const summary = await evaluatePending(db);
  assert.equal(summary.reinforced, 1);
  const [rows] = await db.query('SELECT ranked_hits, attribution FROM recall_log').collect();
  const hit = rows[0].ranked_hits[0];
  assert.equal(hit.used, true);
  assert.equal(hit.used_via, 'fallback');
  assert.equal(rows[0].attribution.mode, 'fallback_no_reply');
  await close(db);
});
```

- [ ] **Step 2: Run — confirm fail.**

```bash
node --test --test-name-pattern 'B1: no reply event' system/tests/integration/reinforcement-loop.test.js
```

Expected: **FAIL** — current loop does not write `attribution` or `used` keys.

- [ ] **Step 3: Edit `reinforcement.js`.**

After the `pending` SELECT and the existing correction pre-fetch, add the new B1 pre-pass. (Use `grep -n "outcome = 'pending'" system/cognition/intuition/reinforcement.js` to anchor the `pending` SELECT and `grep -n "correction pre-fetch\|hasCorrectionInWindow" system/cognition/intuition/reinforcement.js` to anchor the correction pre-fetch — these comment anchors survive any line-number drift introduced by sibling B1 tasks.)

1. Read config once per tick and add a tiny `tsMs(x)` helper at the **top of the file** (just below the existing imports — keeps the date-coercion idiom in one place so subsequent steps and Task 3.2 don't re-inline it):

```js
import { readReinforcementConfig } from './reinforcement-config.js';

// Coerce row.ts / event.ts (Date | string | number) to milliseconds once.
// Used throughout the B1 pre-pass so the (instanceof Date ? .getTime() : new Date().getTime())
// idiom doesn't proliferate.
function tsMs(x) {
  if (x instanceof Date) return x.getTime();
  if (typeof x === 'number') return x;
  return new Date(x).getTime();
}

// ...
const config = await readReinforcementConfig(db);
```

2. Batched reply lookup (single SELECT for the union window):

```js
let candidates = [];
if (config.attribution_mode !== 'off' && pending.length > 0) {
  const tsValues = pending.map((r) => tsMs(r.ts));
  const minTs = new Date(Math.min(...tsValues));
  const maxTs = new Date(Math.max(...tsValues) + config.reply_lookup_window_ms);
  const [rows] = await db
    .query(
      surql`SELECT id, content, ts, meta.session_id AS sid
            FROM events
            WHERE source = 'conversation'
              AND ts >= ${minTs}
              AND ts <= ${maxTs}
            ORDER BY ts ASC`,
    )
    .collect();
  candidates = rows ?? [];
}

// Bucket candidates by session id (string), with '__null__' for null sids.
const candidatesBySid = new Map();
for (const e of candidates) {
  const key = e.sid ?? '__null__';
  if (!candidatesBySid.has(key)) candidatesBySid.set(key, []);
  candidatesBySid.get(key).push(e);
}
```

3. Pair pending rows with reply candidates using the section 7.3 mitigation. Build `replyByRowId: Map<string, event>`:

```js
const replyByRowId = new Map();
if (config.attribution_mode !== 'off') {
  // Sort pending by (sid, ts) ascending; per bucket, advance a cursor and pick
  // the earliest candidate within window — but not past the next pending row's ts
  // in the same bucket.
  const grouped = new Map();
  for (const r of pending) {
    const key = r.session_id ?? '__null__';
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(r);
  }
  for (const [sid, rows] of grouped.entries()) {
    rows.sort((a, b) => tsMs(a.ts) - tsMs(b.ts));
    const bucket = candidatesBySid.get(sid) ?? candidatesBySid.get('__null__') ?? [];
    let cursor = 0;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const rTs = tsMs(r.ts);
      const nextRTs = i + 1 < rows.length ? tsMs(rows[i + 1].ts) : Number.POSITIVE_INFINITY;
      const maxReplyTs = Math.min(rTs + config.reply_lookup_window_ms, nextRTs);
      while (cursor < bucket.length) {
        const t = tsMs(bucket[cursor].ts);
        if (t < rTs) {
          cursor++;
          continue;
        }
        if (t > maxReplyTs) break;
        replyByRowId.set(String(r.id), bucket[cursor]);
        cursor++;
        break;
      }
    }
  }
}
```

- [ ] **Step 4: Run the integration test you added.**

Expected at this checkpoint: still failing — we have the reply map but no hydration/attribute call wired yet. Move on to Task 3.2 before re-running.

- [ ] **Step 5: Commit a WIP checkpoint.**

```bash
git commit -m "$(cat <<'EOF'
feat(reinforcement): batched reply-event lookup pre-pass

Single SELECT over events with source='conversation' and ts in the
union window. Pairs each pending row with the earliest in-window
candidate event in the same session bucket, honouring the section 7.3
mitigation (later recall in same session claims the next reply).
Setup only — the hydration + attribute() call lands in 3.2.
EOF
)"
```

### Task 3.2 — Batched hit hydration + per-row attribute() call

**Files:** `system/cognition/intuition/reinforcement.js`, `system/tests/integration/reinforcement-loop.test.js`

- [ ] **Step 1: Add an integration test for per-hit reinforce (the keystone).**

Append:

```js
test('B1: per-hit reinforce — only matched hits bump signal_count + corroborates', async () => {
  const db = await fresh();
  await db
    .query("UPDATE runtime:`reinforcement.config` SET value.attribution_mode = 'hybrid'")
    .collect();
  const used = await store.note(db, fakeEmbedder, 'knowledge', {
    content: 'the eclipse on tuesday was striking',
    derived_by: 'manual',
  });
  const unused = await store.note(db, fakeEmbedder, 'knowledge', {
    content: 'tomatoes need calcium spray',
    derived_by: 'manual',
  });

  const pastTs = new Date(Date.now() - 10 * 60 * 1000);
  const replyTs = new Date(pastTs.getTime() + 60_000);
  await db
    .query(
      `CREATE events CONTENT {
         source: 'conversation',
         content: 'USER: did you see it?\n\nASSISTANT: yeah the eclipse on tuesday was striking and memorable.',
         ts: $ts,
         meta: { session_id: 'sess-1' }
       }`,
      { ts: replyTs },
    )
    .collect();
  await db
    .query(
      `CREATE recall_log CONTENT {
         ts: $ts, session_id: 'sess-1', query: 'eclipse', k: 2,
         ranked_hits: [
           { record: $a, kind: 'memo', rank: 0 },
           { record: $b, kind: 'memo', rank: 1 }
         ],
         outcome: 'pending'
       }`,
      { ts: pastTs, a: String(used.id), b: String(unused.id) },
    )
    .collect();

  const summary = await evaluatePending(db);
  assert.equal(summary.reinforced, 1);

  const [usedRow] = await db.query(`SELECT signal_count FROM ${used.id}`).collect();
  const [unusedRow] = await db.query(`SELECT signal_count FROM ${unused.id}`).collect();
  assert.equal(usedRow[0].signal_count, 1, 'used memo gets += 1');
  assert.equal(unusedRow[0].signal_count, 0, 'unused memo NOT bumped');

  const [ledger] = await db
    .query(`SELECT memo_id, polarity, weight FROM evidence_ledger`)
    .collect();
  const usedLedger = ledger.filter((r) => String(r.memo_id) === String(used.id));
  const unusedLedger = ledger.filter((r) => String(r.memo_id) === String(unused.id));
  assert.equal(usedLedger.length, 1);
  assert.equal(usedLedger[0].polarity, 'corroborates');
  assert.equal(unusedLedger.length, 0);
  await close(db);
});
```

- [ ] **Step 2: Run — confirm fail.**

```bash
node --test --test-name-pattern 'B1: per-hit reinforce' system/tests/integration/reinforcement-loop.test.js
```

Expected: **FAIL** — both memos get `signal_count = 1` today (legacy behavior).

- [ ] **Step 3: Wire hydration + `attribute()` into `reinforcement.js`.**

After the reply-pairing block (Task 3.1 step 3), but before the existing categorisation loop. Anchor the categorisation loop via `grep -n "for (const row of pending)" system/cognition/intuition/reinforcement.js` — that loop is what the new hydration + attribute() pre-pass must run **ahead** of:

1. Hydrate hit content via two batched SELECTs:

```js
import { attribute } from './attribute.js';
// ...
const eventIds = new Set();
const memoIds = new Set();
if (config.attribution_mode !== 'off') {
  for (const row of pending) {
    for (const hit of row.ranked_hits ?? []) {
      const id = hitRecordId(hit);
      if (!id) continue;
      if (id.startsWith('events:')) eventIds.add(id);
      else if (id.startsWith('memos:')) memoIds.add(id);
    }
  }
}
const hydration = new Map();
if (eventIds.size > 0) {
  const [rows] = await db
    .query(new BoundQuery('SELECT id, content, ts, meta FROM events WHERE id IN $ids', {
      ids: Array.from(eventIds).map((s) => s),
    }))
    .collect();
  for (const r of rows ?? []) hydration.set(String(r.id), r);
}
if (memoIds.size > 0) {
  const [rows] = await db
    .query(new BoundQuery('SELECT id, content, ts, meta FROM memos WHERE id IN $ids', {
      ids: Array.from(memoIds).map((s) => s),
    }))
    .collect();
  for (const r of rows ?? []) hydration.set(String(r.id), r);
}
```

2. Pre-compute `correctedRowIds` *before* the existing categorisation loop (the corrected-rows check today is inside that loop; promote it):

```js
const correctedRowIds = new Set();
for (const row of pending) {
  const ts = (row.ts instanceof Date ? row.ts : new Date(row.ts)).getTime();
  if (hasCorrectionInWindow(row.session_id, ts, ts + REINFORCE_WINDOW_MS)) {
    correctedRowIds.add(String(row.id));
  }
}
```

3. Run the section 3 pseudocode per row — populate `row.attribution`, `row.reply_event_id`, and the merged `row.ranked_hits`.

Every `row.attribution` object **must** carry the full spec §1 shape: `{mode, used_count, total, similarity_threshold, jaccard_min_overlap_tokens, dropped_hits, elapsed_ms}`. We build a small `mkAttribution(...)` helper so no code path forgets a field. `dropped_hits` is the count of hits annotated `used_via='hit_missing'` by the hydration step (memos/events deleted between recall and reinforcement — §7.7). `elapsed_ms` is the wall-clock duration of the per-row pipeline (reply lookup → `attribute()` → fallback fixups). `similarity_threshold` and `jaccard_min_overlap_tokens` are forwarded straight from the per-tick `config`.

```js
import { attribute } from './attribute.js';

function dominantUsedVia(hits) {
  const order = ['explicit', 'citation', 'similarity'];
  for (const v of order) if (hits.some((h) => h.used === true && h.used_via === v)) return v;
  return null;
}

function mkAttribution({ mode, total, used_count, dropped_hits, elapsed_ms, config }) {
  return {
    mode,
    used_count,
    total,
    similarity_threshold: config.similarity_threshold,
    jaccard_min_overlap_tokens: config.jaccard_min_overlap_tokens,
    dropped_hits,
    elapsed_ms,
  };
}

// `tsMs(x)` was already defined at the top of reinforcement.js in Task 3.1
// — reuse it here.

for (const row of pending) {
  const rowIdStr = String(row.id);
  const tStart = Date.now();
  // Annotate hits with hydrated content for attribute()'s benefit.
  const annotatedHits = (row.ranked_hits ?? []).map((h) => {
    const id = hitRecordId(h);
    const src = id ? hydration.get(id) : null;
    if (!src) {
      return { ...h, used: false, used_via: 'hit_missing' };
    }
    return { ...h, content: src.content, ts: src.ts, meta: src.meta ?? h.meta };
  });
  const droppedHits = annotatedHits.filter((h) => h.used_via === 'hit_missing').length;

  if (correctedRowIds.has(rowIdStr)) {
    row.ranked_hits = annotatedHits.map(({ content: _c, ts: _t, ...rest }) => rest);
    row.attribution = mkAttribution({
      mode: 'corrected',
      total: annotatedHits.length,
      used_count: 0,
      dropped_hits: droppedHits,
      elapsed_ms: Date.now() - tStart,
      config,
    });
    row.reply_event_id = null;
    continue;
  }
  if (annotatedHits.length === 0) {
    row.attribution = mkAttribution({
      mode: 'no_hits',
      total: 0,
      used_count: 0,
      dropped_hits: 0,
      elapsed_ms: Date.now() - tStart,
      config,
    });
    row.reply_event_id = null;
    continue;
  }
  if (config.attribution_mode === 'off') {
    for (const h of annotatedHits) {
      if (h.used_via === 'hit_missing') continue;
      h.used = true;
      h.used_via = 'off';
    }
    row.ranked_hits = annotatedHits.map(({ content: _c, ts: _t, ...rest }) => rest);
    row.attribution = mkAttribution({
      mode: 'off',
      total: annotatedHits.length,
      used_count: annotatedHits.filter((h) => h.used === true).length,
      dropped_hits: droppedHits,
      elapsed_ms: Date.now() - tStart,
      config,
    });
    row.reply_event_id = null;
    continue;
  }

  const reply = replyByRowId.get(rowIdStr) ?? null;
  const replyBody = reply?.content ?? '';
  const hasBody = replyBody.includes('\n\nASSISTANT: ')
    ? replyBody.slice(replyBody.indexOf('\n\nASSISTANT: ') + '\n\nASSISTANT: '.length).trim().length > 0
    : false;

  if (!reply || !hasBody) {
    if (config.fallback_when_no_reply) {
      for (const h of annotatedHits) {
        if (h.used_via === 'hit_missing') continue;
        h.used = true;
        h.used_via = 'fallback';
      }
    } else {
      for (const h of annotatedHits) if (h.used_via !== 'hit_missing') h.used = false;
    }
    row.ranked_hits = annotatedHits.map(({ content: _c, ts: _t, ...rest }) => rest);
    row.attribution = mkAttribution({
      mode: 'fallback_no_reply',
      total: annotatedHits.length,
      used_count: annotatedHits.filter((h) => h.used === true).length,
      dropped_hits: droppedHits,
      elapsed_ms: Date.now() - tStart,
      config,
    });
    row.reply_event_id = reply?.id ?? null;
    continue;
  }

  // Run pure attribute() pass.
  const scored = attribute(annotatedHits, replyBody, config);
  let used_count = scored.filter((h) => h.used === true).length;
  let mode;
  if (used_count === 0 && config.fallback_when_zero_used) {
    for (const h of scored) {
      if (h.used_via === 'hit_missing') continue;
      h.used = true;
      h.used_via = 'fallback';
    }
    used_count = scored.filter((h) => h.used === true).length;
    mode = 'fallback_zero_used';
  } else if (used_count === 0) {
    mode = 'fallback_zero_used';
  } else {
    mode = dominantUsedVia(scored) ?? 'similarity';
  }
  row.attribution = mkAttribution({
    mode,
    total: scored.length,
    used_count,
    dropped_hits: droppedHits,
    elapsed_ms: Date.now() - tStart,
    config,
  });
  row.ranked_hits = scored.map(({ content: _c, ts: _t, ...rest }) => rest);
  row.reply_event_id = reply.id;
}
```

Also update the sample SurrealQL **CONTENT** block in Task 3.4 step 3 ("Add the per-row UPDATE batch") to match: the values bound to `$attr_${i}` already carry the full shape because `mkAttribution` produced them. No SurrealQL changes are needed beyond confirming the binding name; the comment block above the `parts.push(...)` line should remind the reader: "each `$attr_${i}` is the full §1 attribution object — never a subset."

- [ ] **Step 4: Run the integration test you added.**

```bash
node --test --test-name-pattern 'B1: per-hit reinforce' system/tests/integration/reinforcement-loop.test.js
```

Expected at this checkpoint: still **FAIL** on the assertion that `unused.signal_count === 0` — because the bucketing (Phase 4) still treats every memo hit as a credit. Continue to Task 3.3 before re-running.

- [ ] **Step 5: Commit (WIP).**

```bash
git commit -m "$(cat <<'EOF'
feat(reinforcement): hit hydration + per-row attribute() pass

Two batched SELECTs hydrate events + memos for all pending rows; pure
attribute() then populates ranked_hits[].used, .used_via, .used_score
and the top-level attribution + reply_event_id. Bucketing still uses
legacy semantics until 3.3 lands the filter.
EOF
)"
```

### Task 3.3 — Bucketing filter + new `evaluated_no_used` outcome

**Files:** `system/cognition/intuition/reinforcement.js`, `system/tests/integration/reinforcement-loop.test.js`

- [ ] **Step 1: Add an integration test for the new outcome value.**

Append:

```js
test('B1: zero used + fallback_when_zero_used=false -> outcome evaluated_no_used, no bump', async () => {
  const db = await fresh();
  await db
    .query("UPDATE runtime:`reinforcement.config` SET value.attribution_mode = 'hybrid', value.fallback_when_zero_used = false")
    .collect();
  const m = await store.note(db, fakeEmbedder, 'knowledge', {
    content: 'the eclipse on tuesday',
    derived_by: 'manual',
  });
  const pastTs = new Date(Date.now() - 10 * 60 * 1000);
  const replyTs = new Date(pastTs.getTime() + 60_000);
  await db
    .query(
      `CREATE events CONTENT {
         source: 'conversation',
         content: 'USER: hi\n\nASSISTANT: cool nothing matches.',
         ts: $ts,
         meta: { session_id: 'sess-z' }
       }`,
      { ts: replyTs },
    )
    .collect();
  await db
    .query(
      `CREATE recall_log CONTENT {
         ts: $ts, session_id: 'sess-z', query: 'q', k: 1,
         ranked_hits: [{ record: $rid, kind: 'memo', rank: 0 }],
         outcome: 'pending'
       }`,
      { ts: pastTs, rid: String(m.id) },
    )
    .collect();

  const summary = await evaluatePending(db);
  assert.equal(summary.evaluated, 1);
  const [rows] = await db.query('SELECT outcome FROM recall_log').collect();
  assert.equal(rows[0].outcome, 'evaluated_no_used');
  const [after] = await db.query(`SELECT signal_count FROM ${m.id}`).collect();
  assert.equal(after[0].signal_count, 0, 'no bump when all hits used=false');
  await close(db);
});
```

- [ ] **Step 2: Run — confirm fail.**

```bash
node --test --test-name-pattern 'B1: zero used' system/tests/integration/reinforcement-loop.test.js
```

Expected: **FAIL** — today's enum has no `evaluated_no_used`; today's bucketing bumps the memo regardless.

- [ ] **Step 3: Modify the categorisation loop (`reinforcement.js` ~line 84-108).**

Replace it with the new cascade:

```js
const outcomesByRow = [];
const memoHitCount = new Map();
for (const row of pending) {
  summary.evaluated += 1;
  const rowIdStr = String(row.id);
  if (correctedRowIds.has(rowIdStr)) {
    outcomesByRow.push({ id: row.id, outcome: 'corrected' });
    summary.corrected += 1;
    continue;
  }
  if (!row.ranked_hits || row.ranked_hits.length === 0) {
    outcomesByRow.push({ id: row.id, outcome: 'evaluated_no_signal' });
    summary.no_signal += 1;
    continue;
  }
  // Filter on hit.used === true ONLY. This is the load-bearing B1 change.
  let usedHits = 0;
  for (const hit of row.ranked_hits) {
    if (hit.used !== true) continue;
    usedHits++;
    const id = hitRecordId(hit);
    if (!id?.startsWith('memos:')) continue;
    memoHitCount.set(id, (memoHitCount.get(id) ?? 0) + 1);
  }
  if (usedHits === 0) {
    outcomesByRow.push({ id: row.id, outcome: 'evaluated_no_used' });
    summary.no_used = (summary.no_used ?? 0) + 1;
  } else {
    outcomesByRow.push({ id: row.id, outcome: 'reinforced' });
    summary.reinforced += 1;
  }
}
```

- [ ] **Step 4: Initialise `no_used` in the summary literal (top of `evaluatePending`):**

```js
const summary = { evaluated: 0, reinforced: 0, corrected: 0, no_signal: 0, no_used: 0 };
```

- [ ] **Step 5: Extend the outcome-UPDATE loop to include the new bucket.** Anchor via `grep -n "idsByOutcome" system/cognition/intuition/reinforcement.js`:

```js
const idsByOutcome = {
  reinforced: [],
  corrected: [],
  evaluated_no_signal: [],
  evaluated_no_used: [],
};
```

- [ ] **Step 6: Run the new tests + the existing reinforcement integration suite.**

```bash
npm run test:integration -- --test-name-pattern 'reinforcement'
```

Expected: **PASS** — all reinforcement-loop tests including the three new B1 tests. (Note: the corrected-row and no-correction tests work because `attribution_mode='off'` is the seeded default outside the tests that explicitly switch to `'hybrid'`.)

- [ ] **Step 7: Commit.**

```bash
git commit -m "$(cat <<'EOF'
feat(reinforcement): filter signal_count + ledger on hit.used===true

Bucketing pass now skips hits with used !== true. Adds outcome
'evaluated_no_used' for rows whose hits all ended unused (no
correction in window). Legacy behavior preserved under
attribution_mode='off' (every hit force-marked used=true,used_via='off').
EOF
)"
```

### Task 3.4 — Persist `ranked_hits` / `attribution` / `reply_event_id`

**Files:** `system/cognition/intuition/reinforcement.js`

- [ ] **Step 1: Add an integration test asserting persistence.**

Append:

```js
test('B1: per-row attribution + reply_event_id are persisted', async () => {
  const db = await fresh();
  await db
    .query("UPDATE runtime:`reinforcement.config` SET value.attribution_mode = 'hybrid'")
    .collect();
  const m = await store.note(db, fakeEmbedder, 'knowledge', {
    content: 'the eclipse on tuesday was striking',
    derived_by: 'manual',
  });
  const pastTs = new Date(Date.now() - 10 * 60 * 1000);
  const replyTs = new Date(pastTs.getTime() + 60_000);
  const [evtCreated] = await db
    .query(
      `CREATE events CONTENT {
         source: 'conversation',
         content: 'USER: q\n\nASSISTANT: yeah the eclipse on tuesday was striking and lovely.',
         ts: $ts,
         meta: { session_id: 'sess-p' }
       }`,
      { ts: replyTs },
    )
    .collect();
  const replyEventId = (Array.isArray(evtCreated) ? evtCreated[0] : evtCreated).id;
  await db
    .query(
      `CREATE recall_log CONTENT {
         ts: $ts, session_id: 'sess-p', query: 'eclipse', k: 1,
         ranked_hits: [{ record: $rid, kind: 'memo', rank: 0 }],
         outcome: 'pending'
       }`,
      { ts: pastTs, rid: String(m.id) },
    )
    .collect();

  await evaluatePending(db);
  const [rows] = await db
    .query('SELECT ranked_hits, attribution, reply_event_id FROM recall_log')
    .collect();
  const row = rows[0];
  assert.equal(String(row.reply_event_id), String(replyEventId));
  // Full §1 attribution shape — every field present, none undefined.
  const a = row.attribution;
  assert.equal(a.mode, 'similarity');
  assert.equal(a.used_count, 1);
  assert.equal(a.total, 1);
  assert.equal(a.similarity_threshold, 0.35);
  assert.equal(a.jaccard_min_overlap_tokens, 2);
  assert.equal(a.dropped_hits, 0);
  assert.equal(typeof a.elapsed_ms, 'number');
  assert.ok(a.elapsed_ms >= 0);
  assert.equal(row.ranked_hits[0].used, true);
  assert.equal(row.ranked_hits[0].used_via, 'similarity');
  assert.ok(row.ranked_hits[0].used_score >= 0.35);
  await close(db);
});
```

- [ ] **Step 2: Run — confirm fail.**

```bash
node --test --test-name-pattern 'persisted' system/tests/integration/reinforcement-loop.test.js
```

Expected: **FAIL** — current code does not UPDATE `ranked_hits`/`attribution`/`reply_event_id`.

- [ ] **Step 3: Add the per-row UPDATE batch.**

Insert this block immediately before the outcome-bucket UPDATEs in `reinforcement.js`. Use a comment-anchor reference rather than a numeric line number — earlier B1 tasks (3.1–3.3) add ~200 lines to this file, so the original `lines 215-233` reference will drift:

> Place this block immediately before the existing comment `// Phase 3 step 3: one UPDATE per outcome bucket` (or its current equivalent that introduces the outcome-bucket UPDATE loop). Verify by `grep -n "one UPDATE per outcome bucket" system/cognition/intuition/reinforcement.js`.

```js
// Per-row UPDATE with the post-attribution payload. One multi-statement
// query, one round-trip per tick. Sent only when at least one row has
// new payload to write. Each $attr_${i} below is the FULL §1 attribution
// object produced by mkAttribution() in Task 3.2 — never a subset.
const rowsWithPayload = pending.filter(
  (r) => r.attribution !== undefined || r.reply_event_id !== undefined,
);
if (rowsWithPayload.length > 0) {
  const parts = [];
  const params = {};
  rowsWithPayload.forEach((r, i) => {
    parts.push(
      `UPDATE $row_${i} SET ranked_hits = $hits_${i}, attribution = $attr_${i}, reply_event_id = $rid_${i};`,
    );
    params[`row_${i}`] = r.id;
    params[`hits_${i}`] = r.ranked_hits;
    // r.attribution carries: mode, used_count, total, similarity_threshold,
    // jaccard_min_overlap_tokens, dropped_hits, elapsed_ms.
    params[`attr_${i}`] = r.attribution ?? null;
    params[`rid_${i}`] = r.reply_event_id ?? null;
  });
  try {
    await db.query(new BoundQuery(parts.join('\n'), params)).collect();
  } catch (e) {
    console.warn(`[reinforce] attribution UPDATE failed: ${e.message}`);
  }
}
```

- [ ] **Step 4: Re-run the persistence test plus the full reinforcement integration suite.**

```bash
npm run test:integration -- --test-name-pattern 'reinforcement'
```

Expected: **PASS** — all tests including the 4 new B1 tests.

- [ ] **Step 5: Commit.**

```bash
git commit -m "$(cat <<'EOF'
feat(reinforcement): persist ranked_hits/attribution/reply_event_id

One multi-statement BoundQuery UPDATE per evaluatePending tick (<=200
statements). Outcome-bucket UPDATEs remain separate because they are
bucket-uniform — folding would trade three bucketed UPDATEs for ~200
row-specific ones.
EOF
)"
```

### Task 3.5 — Episode-citation integration (spec §8.2 #16; mirrors unit §8.1 #10)

**Files:** `system/tests/integration/reinforcement-loop.test.js`

- [ ] **Step 1: Add the integration test.**

Append:

```js
test('B1 §8.2 #16: episode-tagged memo + [episode YYYY-MM-DD] reply → attribution.mode=citation', async () => {
  const db = await fresh();
  await db
    .query("UPDATE runtime:`reinforcement.config` SET value.attribution_mode = 'hybrid'")
    .collect();
  // Memo with meta.kind='episode_summary' is the ONLY shape that
  // produces an [episode ...] citation line in inject.js:formatHit, and
  // the only shape that attribute()'s citation pass will accept for the
  // 'episode' keyword.
  const episodeTs = new Date('2026-05-10T15:00:00Z');
  const [memoCreate] = await db
    .query(
      `CREATE memos CONTENT {
         kind: 'knowledge',
         content: 'team off-site retro: shipping calendar reset',
         derived_by: 'manual',
         signal_count: 1,
         ts: $ts,
         meta: { kind: 'episode_summary' }
       }`,
      { ts: episodeTs },
    )
    .collect();
  const memoId = (Array.isArray(memoCreate) ? memoCreate[0] : memoCreate).id;

  const pastTs = new Date(Date.now() - 10 * 60 * 1000);
  await db
    .query(
      `CREATE events CONTENT {
         source: 'conversation',
         content: 'USER: q\n\nASSISTANT: see [episode 2026-05-10] for the shipping context.',
         ts: $ts,
         meta: { session_id: 'sess-ep' }
       }`,
      { ts: new Date(pastTs.getTime() + 60_000) },
    )
    .collect();
  await db
    .query(
      `CREATE recall_log CONTENT {
         ts: $ts, session_id: 'sess-ep', query: 'q', k: 1,
         ranked_hits: [{ record: $rid, kind: 'memo', rank: 0 }],
         outcome: 'pending'
       }`,
      { ts: pastTs, rid: String(memoId) },
    )
    .collect();

  const summary = await evaluatePending(db);
  assert.equal(summary.reinforced, 1);

  const [rows] = await db
    .query('SELECT ranked_hits, attribution FROM recall_log')
    .collect();
  assert.equal(rows[0].attribution.mode, 'citation');
  assert.equal(rows[0].ranked_hits[0].used, true);
  assert.equal(rows[0].ranked_hits[0].used_via, 'citation');

  const [after] = await db.query(`SELECT signal_count FROM ${memoId}`).collect();
  assert.equal(after[0].signal_count, 2, 'episode memo bumped by 1');

  const [ledger] = await db
    .query('SELECT polarity, weight FROM evidence_ledger WHERE memo_id = $id', { id: memoId })
    .collect();
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].polarity, 'corroborates');
  assert.equal(ledger[0].weight, 1);

  await close(db);
});
```

- [ ] **Step 2: Run.**

```bash
node --test --test-name-pattern 'episode-tagged memo' system/tests/integration/reinforcement-loop.test.js
```

Expected: **PASS** — Tasks 3.2/3.3/3.4 already wired everything; this test exercises the citation path end-to-end against a real `meta.kind='episode_summary'` row.

- [ ] **Step 3: Commit.**

```bash
git commit -m "$(cat <<'EOF'
test(reinforcement): episode-citation integration (B1 §8.2 #16)

Asserts that a memo with meta.kind='episode_summary' plus a reply
containing [episode YYYY-MM-DD] lands attribution.mode='citation',
the hit's used_via='citation', and the eventual signal_count + ledger
weight match the per-hit semantics.
EOF
)"
```

---

## Phase 4 — Evidence ledger integration verification

(`reinforcement.js` already emits `evidence_ledger CREATE` rows; B1's only change to that path is the upstream `memoHitCount` filter — Phase 3.3 already wired this. Phase 4 is the explicit test plus a small comment refresh.)

### Task 4.1 — Verify corroborate weight reflects per-hit `used`

**Files:** `system/tests/integration/reinforcement-loop.test.js`

- [ ] **Step 1: Add the verification gate test.**

Append:

```js
test('B1 section 6: corroborate weight reflects per-hit used count, not row count', async () => {
  const db = await fresh();
  await db
    .query("UPDATE runtime:`reinforcement.config` SET value.attribution_mode = 'hybrid'")
    .collect();
  const m = await store.note(db, fakeEmbedder, 'knowledge', {
    content: 'eclipse tuesday striking',
    derived_by: 'manual',
  });
  const pastTs = new Date(Date.now() - 10 * 60 * 1000);
  // Two pending rows for the SAME memo, in two sessions; each session has its
  // own reply event whose body matches via similarity.
  for (const sid of ['s1', 's2']) {
    await db
      .query(
        `CREATE events CONTENT {
           source: 'conversation',
           content: 'USER: q\n\nASSISTANT: eclipse tuesday striking observation here.',
           ts: $ts,
           meta: { session_id: $sid }
         }`,
        { ts: new Date(pastTs.getTime() + 60_000), sid },
      )
      .collect();
    await db
      .query(
        `CREATE recall_log CONTENT {
           ts: $ts, session_id: $sid, query: 'q', k: 1,
           ranked_hits: [{ record: $rid, kind: 'memo', rank: 0 }],
           outcome: 'pending'
         }`,
        { ts: pastTs, sid, rid: String(m.id) },
      )
      .collect();
  }
  await evaluatePending(db);
  const [ledger] = await db
    .query('SELECT polarity, weight FROM evidence_ledger WHERE memo_id = $id', { id: m.id })
    .collect();
  assert.equal(ledger.length, 1, 'one corroborate row for the memo');
  assert.equal(ledger[0].polarity, 'corroborates');
  assert.equal(ledger[0].weight, 2, 'weight=2 (used in both rows)');
  await close(db);
});
```

- [ ] **Step 2: Run.**

```bash
node --test --test-name-pattern 'corroborate weight reflects' system/tests/integration/reinforcement-loop.test.js
```

Expected: **PASS** — Phase 3.3 already filters `memoHitCount` on `used === true`, and the existing emitter (locate via `grep -n "evidence_ledger.*corroborates\|CREATE evidence_ledger" system/cognition/intuition/reinforcement.js`) reads `memoHitCount`.

- [ ] **Step 3: Refresh the inline comment for the existing `evidence_ledger` corroborate CREATE to mention the section 6 semantics.**

The corroborate emission today is preceded by a comment like `// Theme 2a: emit corroborates ledger rows (one per hit, weight=N).` Use a comment-anchor reference instead of a numeric line number — earlier B1 tasks have shifted line numbers by ~200 lines. Locate via `grep -n "emit corroborates" system/cognition/intuition/reinforcement.js` and replace with:

```js
// Theme 2a + B1: emit corroborates ledger rows. weight=N where N is the
// number of pending rows in this batch where the memo was both injected
// AND used (per-hit attribution from section 3, filtered in section 4).
```

- [ ] **Step 4: Add the §7.10 duplicate-hit dedup integration test (asserts the eventual `signal_count` semantics matched by the spec §8.1 #8 unit test).**

Append to `system/tests/integration/reinforcement-loop.test.js`:

```js
test('B1 §7.10: duplicate hit in ranked_hits dedups in memoHitCount → signal_count bumps by 1, not 2', async () => {
  const db = await fresh();
  await db
    .query("UPDATE runtime:`reinforcement.config` SET value.attribution_mode = 'hybrid'")
    .collect();
  const m = await store.note(db, fakeEmbedder, 'knowledge', {
    content: 'sourdough hydration ratio sixty percent',
    derived_by: 'manual',
  });
  const pastTs = new Date(Date.now() - 10 * 60 * 1000);
  await db
    .query(
      `CREATE events CONTENT {
         source: 'conversation',
         content: 'USER: q\n\nASSISTANT: yes the sourdough hydration ratio sixty percent is right.',
         ts: $ts,
         meta: { session_id: 'sess-dup' }
       }`,
      { ts: new Date(pastTs.getTime() + 60_000) },
    )
    .collect();
  // Same memo appears twice in ranked_hits — possible via the MCP recall.js path.
  await db
    .query(
      `CREATE recall_log CONTENT {
         ts: $ts, session_id: 'sess-dup', query: 'q', k: 2,
         ranked_hits: [
           { record: $rid, kind: 'memo', rank: 0 },
           { record: $rid, kind: 'memo', rank: 1 }
         ],
         outcome: 'pending'
       }`,
      { ts: pastTs, rid: String(m.id) },
    )
    .collect();
  await evaluatePending(db);
  const [after] = await db.query(`SELECT signal_count FROM ${m.id}`).collect();
  // Initial signal_count is 1 (from store.note default in this test harness).
  // Memo appears in 1 pending row, regardless of the duplicate within ranked_hits,
  // so the bump is +1, not +2.
  assert.equal(after[0].signal_count, 1 + 1, 'duplicate ranked_hits collapsed by memoHitCount');
  await close(db);
});
```

- [ ] **Step 5: Commit.**

```bash
git commit -m "$(cat <<'EOF'
test(reinforcement): corroborate weight reflects per-hit used count

Adds the B1 section 6 gate: weight=N where N is the count of pending
rows in which the memo was both injected AND attributed-as-used.
EOF
)"
```

---

## Phase 5 — `explain_recall` + telemetry surface

### Task 5.1 — Extend `explain_recall` to return B1 fields

**Files:** `system/io/mcp/tools/explain-recall.js`, `system/tests/integration/reinforcement-loop.test.js`

- [ ] **Step 1: Add an integration assertion.**

Append to `system/tests/integration/reinforcement-loop.test.js`:

```js
test('B1 section 10: explain_recall surfaces used/used_via/attribution/reply_event_id', async () => {
  const db = await fresh();
  await db
    .query("UPDATE runtime:`reinforcement.config` SET value.attribution_mode = 'hybrid'")
    .collect();
  const m = await store.note(db, fakeEmbedder, 'knowledge', {
    content: 'eclipse tuesday striking',
    derived_by: 'manual',
  });
  const pastTs = new Date(Date.now() - 10 * 60 * 1000);
  await db
    .query(
      `CREATE events CONTENT {
         source: 'conversation',
         content: 'USER: q\n\nASSISTANT: eclipse tuesday striking observation.',
         ts: $ts,
         meta: { session_id: 'sx' }
       }`,
      { ts: new Date(pastTs.getTime() + 60_000) },
    )
    .collect();
  await db
    .query(
      `CREATE recall_log CONTENT {
         ts: $ts, session_id: 'sx', query: 'q', k: 1,
         ranked_hits: [{ record: $rid, kind: 'memo', rank: 0 }],
         outcome: 'pending'
       }`,
      { ts: pastTs, rid: String(m.id) },
    )
    .collect();
  await evaluatePending(db);

  const { createExplainRecallTool } = await import('../../io/mcp/tools/explain-recall.js');
  const tool = createExplainRecallTool({ db });
  const out = await tool.handler({ last_n: 1 });
  const q = out.queries[0];
  assert.equal(q.attribution.mode, 'similarity');
  assert.equal(q.ranked_hits[0].used, true);
  assert.equal(q.ranked_hits[0].used_via, 'similarity');
  assert.ok(q.reply_event_id);
  await close(db);
});
```

- [ ] **Step 2: Run — confirm fail.**

```bash
node --test --test-name-pattern 'explain_recall surfaces' system/tests/integration/reinforcement-loop.test.js
```

Expected: **FAIL** — `explain_recall` currently strips most keys (only `query_id`, `ts`, `query`, `outcome`, `ranked_hits[{...scope}]` are returned).

- [ ] **Step 3: Modify `system/io/mcp/tools/explain-recall.js`.**

The per-hit construction (`explain-recall.js:38-49`) already uses object spread (`{ ...h, scope: ... }`) — that forwards any new keys like `used`, `used_via`, `used_score` automatically. **No edit needed there.** The only required change is appending the two new top-level fields to the per-row `queries.push(...)` block. Locate the existing `queries.push({...})` block via `grep -n "queries.push" system/io/mcp/tools/explain-recall.js` and add `attribution` + `reply_event_id`:

```diff
  queries.push({
    query_id: String(row.id),
    ts: row.ts,
    query: row.query,
    outcome: row.outcome,
+   attribution: row.attribution ?? null,
+   reply_event_id: row.reply_event_id ?? null,
    ranked_hits: hits,
  });
```

(The audit-grep test enforces no write keywords; appending these two read-only fields adds no writes.)

- [ ] **Step 4: Re-run the test + the audit-grep guard.**

```bash
node --test --test-name-pattern 'explain_recall surfaces' system/tests/integration/reinforcement-loop.test.js
npm run test:unit -- --test-name-pattern 'audit-introspection'
```

Expected: **PASS** on both.

- [ ] **Step 5: Commit.**

```bash
git commit -m "$(cat <<'EOF'
feat(mcp): explain_recall surfaces B1 attribution + reply_event_id

Adds top-level attribution + reply_event_id fields and forwards
ranked_hits[].used / used_via / used_score (scope redaction unchanged).
EOF
)"
```

### Task 5.2 — Note: `show_attribution_health` and `recall_used` MCP tool are out of scope

**Files:** none (documentation-only)

Per spec section 5 and section 9.2 step 3, the `recall_used` MCP tool and the `show_attribution_health` rollup ship in a follow-up. B1 lands the **plumbing** in `attribute()` (explicit pass parses `<!-- recall_used: ID1,ID2 -->`) so a tool can be added without further migration. No code change required this task.

- [ ] **Step 1: Confirm `attribute()`'s explicit pass test (Task 2.1, "matches by record id") still passes.**

```bash
node --test --test-name-pattern 'explicit marker' system/tests/unit/reinforcement-attribute.test.js
```

Expected: **PASS**.

- [ ] **Step 2: No commit.**

---

## Phase 6 — Verification gate 12b + backward-compat integration test

### Task 6.1 — Verify-design-assumptions gate 12b

**Files:** `system/runtime/scripts/verify-design-assumptions.js`

- [ ] **Step 1: Locate the existing G12 function (`gateReinforceCountBucket`, line 381).**

```bash
grep -n "gateReinforceCountBucket\|G12 " system/runtime/scripts/verify-design-assumptions.js
```

Expected: lines around 381 and 486.

- [ ] **Step 2: Make the existing G12 explicitly run under `attribution_mode='off'`.**

In `gateReinforceCountBucket`, after the `runMigrations` call and before the recall_log inserts, add:

```js
await verifyDb
  .query("UPDATE runtime:`reinforcement.config` SET value.attribution_mode = 'off'")
  .collect();
```

This preserves the existing invariant (3 rows -> `signal_count += 3`) under the legacy-equivalent mode.

- [ ] **Step 3: Add a new function `gateReinforceCountBucketHybrid` (G12b).**

Write it inline alongside `gateReinforceCountBucket` (`system/runtime/scripts/verify-design-assumptions.js`). Match the existing gate's style: tmpdir + `runMigrations`, fresh in-memory DB, `ok`/`fail` reporting helpers, lazy imports. The function must verify three properties:

1. **Hybrid + similarity match → same N-per-memo bump as legacy mode.** Three pending rows in three distinct sessions referencing the same memo, each with a matching reply event whose body contains the memo content. Expected: `summary.reinforced === 3`, `signal_count` rises by 3, and **all three** `recall_log` rows persist `attribution.mode === 'similarity'` with `used_count === 1`.
2. **Distinct `session_id` per pending row** is load-bearing — the §3.1 batched pairing relies on session bucketing so each row gets its **own** reply event. Use `s0/s1/s2`. Without distinct ids the pairing rule could collapse two recalls into one reply (§7.3).
3. **Hybrid + unrelated reply + `fallback_when_zero_used = false` → no bump.** Reset state, switch the config, point the three rows' replies at unrelated text. Expected: `summary.reinforced === 0`, `summary.no_used === 3`, `signal_count` unchanged, attribution mode bucket counts: `fallback_zero_used === 3`.

```js
async function gateReinforceCountBucketHybrid() {
  console.log('\nG12b — per-hit attribution preserves N-per-memo on similarity match (and zero on miss)');
  const { writeConfig } = await import('../../config/paths.js');
  const { mkdirSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const testHome = join(tmpdir(), `robin-verify-g12b-${process.pid}`);
  mkdirSync(testHome, { recursive: true });
  process.env.ROBIN_HOME = testHome;
  await writeConfig({ embedder_profile: 'mxbai-1024' });

  const { connect: appConnect, close: appClose } = await import('../../data/db/client.js');
  const { runMigrations } = await import('../../data/db/migrate.js');
  const { paths } = await import('../../config/data-store.js');
  const { evaluatePending } = await import('../../cognition/intuition/reinforcement.js');
  const verifyDb = await appConnect({ engine: 'mem://' });

  try {
    await runMigrations(verifyDb, paths.source.migrations());

    // ----- Variant A: hybrid + similarity matches across 3 distinct sessions -----
    await verifyDb
      .query("UPDATE runtime:`reinforcement.config` SET value.attribution_mode = 'hybrid'")
      .collect();

    // Seed memo with content tokens that will survive the /\W+/ length>3 tokenizer.
    const MEMO_CONTENT = 'specific keyword anchors hydration sourdough ratio';
    const [mc] = await verifyDb
      .query(
        `CREATE memos CONTENT { kind: 'knowledge', content: $c, derived_by: 'manual', signal_count: 1 }`,
        { c: MEMO_CONTENT },
      )
      .collect();
    const memoId = (Array.isArray(mc) ? mc[0] : mc).id;

    const recallTs = new Date(Date.now() - 10 * 60 * 1000);
    const REPLY_TEMPLATE =
      'USER: q\n\nASSISTANT: yes the specific keyword anchors hydration sourdough ratio matches.';
    const sessions = ['s0', 's1', 's2'];
    for (const sid of sessions) {
      await verifyDb
        .query(
          `CREATE events CONTENT {
             source: 'conversation',
             content: $c,
             ts: $ts,
             meta: { session_id: $sid }
           }`,
          { c: REPLY_TEMPLATE, ts: new Date(recallTs.getTime() + 60_000), sid },
        )
        .collect();
      await verifyDb
        .query(
          `CREATE recall_log CONTENT {
             ts: $ts, session_id: $sid, query: 'q', k: 1,
             ranked_hits: [{ record: $rid, kind: 'memo', rank: 0 }],
             outcome: 'pending'
           }`,
          { ts: recallTs, sid, rid: String(memoId) },
        )
        .collect();
    }

    const sumA = await evaluatePending(verifyDb);
    if (sumA.reinforced !== 3) {
      fail(`G12b variant A: expected reinforced=3, got ${sumA.reinforced}`);
      return;
    }
    const [afterA] = await verifyDb.query(`SELECT signal_count FROM ${memoId}`).collect();
    if (afterA?.[0]?.signal_count !== 4) {
      fail(`G12b variant A: expected signal_count=4 (1 base + 3), got ${afterA?.[0]?.signal_count}`);
      return;
    }

    // Confirm every row landed mode=similarity, used_count=1, full attribution shape.
    const [rowsA] = await verifyDb
      .query('SELECT attribution, session_id FROM recall_log WHERE outcome = "reinforced"')
      .collect();
    const sidsA = new Set(rowsA.map((r) => r.session_id));
    if (rowsA.length !== 3 || sidsA.size !== 3) {
      fail(`G12b variant A: expected 3 reinforced rows across 3 sessions, got ${rowsA.length}/${sidsA.size}`);
      return;
    }
    for (const r of rowsA) {
      const a = r.attribution;
      if (!a || a.mode !== 'similarity' || a.used_count !== 1 || a.total !== 1) {
        fail(`G12b variant A: bad attribution shape on session ${r.session_id}: ${JSON.stringify(a)}`);
        return;
      }
      if (typeof a.elapsed_ms !== 'number' || typeof a.similarity_threshold !== 'number') {
        fail(`G12b variant A: missing attribution fields: ${JSON.stringify(a)}`);
        return;
      }
    }
    ok('G12b variant A: 3 distinct sessions, mode=similarity, signal_count 1 → 4');

    // ----- Variant B: hybrid + unrelated reply + fallback_when_zero_used=false -----
    // Reset state: clear recall_log + events, leave memo at signal_count=4 as new baseline.
    await verifyDb.query('DELETE recall_log').collect();
    await verifyDb.query("DELETE events WHERE source = 'conversation'").collect();
    await verifyDb.query('DELETE evidence_ledger').collect();
    await verifyDb
      .query(
        "UPDATE runtime:`reinforcement.config` SET value.fallback_when_zero_used = false",
      )
      .collect();

    const baselineCount = 4;
    const UNRELATED = 'USER: q\n\nASSISTANT: the weather seems pleasant today thanks.';
    for (const sid of sessions) {
      await verifyDb
        .query(
          `CREATE events CONTENT {
             source: 'conversation',
             content: $c,
             ts: $ts,
             meta: { session_id: $sid }
           }`,
          { c: UNRELATED, ts: new Date(recallTs.getTime() + 60_000), sid },
        )
        .collect();
      await verifyDb
        .query(
          `CREATE recall_log CONTENT {
             ts: $ts, session_id: $sid, query: 'q', k: 1,
             ranked_hits: [{ record: $rid, kind: 'memo', rank: 0 }],
             outcome: 'pending'
           }`,
          { ts: recallTs, sid, rid: String(memoId) },
        )
        .collect();
    }

    const sumB = await evaluatePending(verifyDb);
    if (sumB.reinforced !== 0) {
      fail(`G12b variant B: expected reinforced=0, got ${sumB.reinforced}`);
      return;
    }
    if ((sumB.no_used ?? 0) !== 3) {
      fail(`G12b variant B: expected no_used=3, got ${sumB.no_used}`);
      return;
    }
    const [afterB] = await verifyDb.query(`SELECT signal_count FROM ${memoId}`).collect();
    if (afterB?.[0]?.signal_count !== baselineCount) {
      fail(`G12b variant B: expected signal_count unchanged at ${baselineCount}, got ${afterB?.[0]?.signal_count}`);
      return;
    }
    const [rowsB] = await verifyDb.query('SELECT attribution FROM recall_log').collect();
    const bucketCounts = { fallback_zero_used: 0 };
    for (const r of rowsB) {
      bucketCounts[r.attribution?.mode] = (bucketCounts[r.attribution?.mode] ?? 0) + 1;
    }
    if (bucketCounts.fallback_zero_used !== 3) {
      fail(`G12b variant B: expected 3 fallback_zero_used rows, got ${JSON.stringify(bucketCounts)}`);
      return;
    }
    ok('G12b variant B: 3 unrelated replies + fallback_off → signal_count unchanged, all rows fallback_zero_used');
  } finally {
    await appClose(verifyDb);
  }
}
```

- [ ] **Step 4: Add `await gateReinforceCountBucketHybrid();` to the `main()` block around line 486.**

- [ ] **Step 5: Run the verify script.**

```bash
node system/runtime/scripts/verify-design-assumptions.js
```

Expected: all gates including G12 and the new G12b print `ok`.

- [ ] **Step 6: Commit.**

```bash
git commit -m "$(cat <<'EOF'
test(verify): G12b — per-hit-used invariant under hybrid mode

Adds gate 12b alongside the pre-existing G12 bucket-count invariant.
G12 now explicitly runs under attribution_mode='off' so its semantics
match what's tested. G12b sets up matching reply events and asserts
signal_count += 3 across 3 sessions; a second variant verifies that
non-matching replies + fallback_when_zero_used=false keep
signal_count unchanged.
EOF
)"
```

### Task 6.2 — Backward-compat test for pre-B1 recall_log rows

**Files:** `system/tests/integration/reinforcement-loop.test.js`

- [ ] **Step 1: Add the backward-compat test.**

Append:

```js
test('B1: pre-B1 recall_log rows (no used field) work under mode=off', async () => {
  const db = await fresh();
  // Seeded mode is 'off' — no UPDATE needed.
  const m = await store.note(db, fakeEmbedder, 'knowledge', {
    content: 'pre-B1 row',
    derived_by: 'manual',
  });
  const pastTs = new Date(Date.now() - 10 * 60 * 1000);
  // Recall_log row WITHOUT the new used/used_via keys (the old shape).
  await db
    .query(
      `CREATE recall_log CONTENT {
         ts: $ts, session_id: 's', query: 'q', k: 1,
         ranked_hits: [{ record: $rid, kind: 'memo', rank: 0 }],
         outcome: 'pending'
       }`,
      { ts: pastTs, rid: String(m.id) },
    )
    .collect();
  const summary = await evaluatePending(db);
  assert.equal(summary.reinforced, 1, 'mode=off treats every memo hit as used (legacy)');
  const [after] = await db.query(`SELECT signal_count FROM ${m.id}`).collect();
  assert.equal(after[0].signal_count, 1);
  const [rows] = await db.query('SELECT attribution FROM recall_log').collect();
  assert.equal(rows[0].attribution.mode, 'off');
  await close(db);
});
```

- [ ] **Step 2: Run.**

```bash
node --test --test-name-pattern 'pre-B1 recall_log rows' system/tests/integration/reinforcement-loop.test.js
```

Expected: **PASS**.

- [ ] **Step 3: Run the whole reinforcement + intuition unit suite once.**

```bash
npm run test:unit -- --test-name-pattern 'reinforcement|intuition'
npm run test:integration -- --test-name-pattern 'reinforcement'
```

Expected: **PASS** on both.

- [ ] **Step 4: Commit.**

```bash
git commit -m "$(cat <<'EOF'
test(reinforcement): backward-compat for pre-B1 recall_log rows

Verifies section 9.1: pre-B1 rows with the old ranked_hits shape (no
used field) and seeded mode='off' get treated exactly like today —
every memo hit credited, signal_count bumped once.
EOF
)"
```

---

## Phase 7 — Docs

### Task 7.1 — Update `docs/architecture.md`

**Files:** `docs/architecture.md`

- [ ] **Step 1: Edit `docs/architecture.md` line 130 (item 9 of "A typical agent turn").**

Replace:

> 9. **Reinforce-recall** (every 5 min) walks `recall_log` rows with `outcome='pending'` and `ts < now - 5min`. If a `meta.kind='correction'` event landed in the session window -> mark `outcome='corrected'`. Otherwise -> for each hit memo, `signal_count += 1` and `decay_anchor = time::now()`; mark `outcome='reinforced'`. The labeled-ish output feeds a future reranker.

With:

> 9. **Reinforce-recall** (every 5 min) walks `recall_log` rows with `outcome='pending'` and `ts < now - 5min`. For each row: if a `meta.kind='correction'` event landed in the session window -> mark `outcome='corrected'` and refute every memo hit in the ledger. Otherwise -> attribute hits per the `attribute()` pipeline (explicit -> citation -> similarity, with fallback-on-no-reply), and for every hit with `used=true` bump `signal_count += 1`, refresh `decay_anchor`, and emit a corroborate ledger row weighted by use-count. Outcome is `reinforced` when any hit was used, `evaluated_no_used` when attribution matched zero hits with fallback off, `evaluated_no_signal` for empty `ranked_hits`. The labeled output (per-hit `used`/`used_via`) feeds a future reranker.

- [ ] **Step 2: Edit `docs/architecture.md` line 25.**

Replace:

> ├─ Reinforcement  5-min internal job: pending recall_log + no correction

With:

> ├─ Reinforcement  5-min internal job: per-hit attribution (explicit -> citation -> similarity) over pending recall_log; corroborates the ledger per used hit, refutes on correction

- [ ] **Step 3: Edit `docs/architecture.md` line 91 if needed (the "Reinforcement loop writes corroborates" prose) to mention per-hit semantics.**

```bash
grep -n "Reinforcement loop writes corroborates" docs/architecture.md
```

Edit the surrounding sentence to read:

> Reinforcement loop writes corroborates per attributed-as-used hit on `reinforced` AND refutes on `corrected` rows; Theme 2a (alpha.16) -> B1 (post-alpha.16) tightens "every hit" to "every used hit".

- [ ] **Step 4: Commit.**

```bash
git commit -m "$(cat <<'EOF'
docs(architecture): per-hit attribution in the typical agent turn

Updates item 9 of the agent-turn walkthrough and the reinforcement
diagram blurb to describe the explicit -> citation -> similarity
attribution pipeline introduced by B1.
EOF
)"
```

### Task 7.2 — Update `docs/faculties.md` reinforcement section

**Files:** `docs/faculties.md`

- [ ] **Step 1: Edit the "### reinforcement (NEW)" block around line 86.**

Replace the existing single Behavior bullet with:

```markdown
### reinforcement (NEW)
**The recall feedback loop — the keystone effectiveness fix.**
- Files: `system/cognition/intuition/reinforcement.js`, `system/cognition/intuition/attribute.js`, `system/cognition/intuition/reinforcement-config.js`, `system/cognition/jobs/internal/reinforce-recall.js`, `system/cognition/jobs/builtin/reinforce-recall.md`.
- Behavior: every 5 minutes, walks `recall_log` rows whose `outcome='pending'` and `ts < now - 5min`. For each row:
  1. If a `meta.kind='correction'` event landed in the session window -> `outcome='corrected'`, refute every memo hit in `evidence_ledger` (Theme 2a).
  2. Else, attribute hits via `attribute(hits, replyBody, config)` — explicit `<!-- recall_used: ... -->` marker -> `[event|episode YYYY-MM-DD]` citation -> asymmetric Jaccard similarity. Hits matched get `used=true, used_via=<pass>`.
  3. If the conversation event capturing the next reply is missing -> fallback governed by `runtime:reinforcement.config.fallback_when_no_reply`.
  4. If attribution matched zero hits -> fallback governed by `fallback_when_zero_used`. Without fallback, `outcome='evaluated_no_used'`.
  5. For every hit with `used=true`, `signal_count += 1` and `decay_anchor = time::now()`. A `corroborates` ledger row is emitted weighted by the count of used-this-batch occurrences.
- Config knobs (`runtime:reinforcement.config`, single UPDATE to retune):
  - `attribution_mode`: `'hybrid'` (default once rolled out) or `'off'` (kill switch, every hit force-used).
  - `similarity_threshold` (default 0.35): asymmetric Jaccard cutoff.
  - `jaccard_min_overlap_tokens` (default 2): absolute floor on intersection size.
  - `citation_date_window_days` (default 2): tolerance for `[event YYYY-MM-DD]` date match.
  - `fallback_when_no_reply` / `fallback_when_zero_used` (default both true): preserve legacy reinforce-all when attribution can't run / matched nothing.
  - `reply_lookup_window_ms` (default 600_000): how long after recall we wait for the reply event.
- Inspect: `SELECT outcome, count() FROM recall_log GROUP BY outcome`; `explain_recall({last_n:5})` returns per-hit `used`/`used_via`/`used_score` plus the row's `attribution.mode`.
- **Mode-rate distribution (interim telemetry, until `show_attribution_health` ships).** Until the `show_attribution_health` MCP rollup lands as a follow-up (spec §9.2 step 3), this query is the only way for an operator to verify the "watch for one week" check in rollout step 4:

  ```surql
  SELECT attribution.mode, count() AS n
  FROM recall_log
  WHERE ts > time::now() - 7d
  GROUP BY attribution.mode;
  ```

  Expected healthy distribution after a week of `'hybrid'`: bulk of rows in `citation` + `similarity`, low single-digit-% in `fallback_no_reply` / `fallback_zero_used`, near-zero `hit_missing`-dominated rows. Spikes in `fallback_no_reply` indicate transcript-capture regressions (see §7.1); spikes in `hit_missing` indicate aggressive compaction (see §7.7).
- **Rollback (operational).** `UPDATE runtime:`reinforcement.config` SET value.attribution_mode = 'off';` is the **fast** rollback — instant, no migration. The `evaluated_no_used` enum value persists on `recall_log.outcome`'s `ASSERT` list either way; rolling back the schema *enum* requires a new migration (you cannot `REMOVE` an enum value if any row holds it), so the runtime-flag rollback is the only one operators should reach for in practice.
```

- [ ] **Step 2: Commit.**

```bash
git commit -m "$(cat <<'EOF'
docs(faculties): describe B1 per-hit attribution + config knobs

Rewrites the reinforcement section to cover the explicit -> citation
-> similarity -> fallback pipeline, the runtime config row, and the
explain_recall surface for inspection.
EOF
)"
```

---

## Final verification

### Task FV.1 — Run the whole reinforcement + intuition test surface end-to-end

- [ ] **Step 1: Full unit suite for changed surfaces.**

```bash
npm run test:unit -- --test-name-pattern 'reinforcement|intuition|attribute'
```

Expected: **PASS, >=13 tests** (`reinforcement-attribute.test.js` carries 10 tests after Task 2.2: 4 explicit/citation + 4 similarity/combined/empty + 1 duplicate-hit + 1 citation tiebreaker; `reinforcement-config.test.js` 3 tests; plus any existing intuition-handler/endpoint tests we touched in Phase 0).

- [ ] **Step 2: Full reinforcement integration suite.**

```bash
npm run test:integration -- --test-name-pattern 'reinforcement'
```

Expected: **PASS** — original 4 pre-B1 tests + 9 new B1 tests = **13 tests**. (B1 adds: no-reply fallback, per-hit reinforce, persistence, zero-used+fallback-off, corroborate-weight, duplicate-hit dedup §7.10, explain_recall surface, episode-citation §8.2 #16, backward-compat.)

- [ ] **Step 3: Lint pass.**

```bash
npm run lint
```

Expected: **PASS**.

- [ ] **Step 4: Audit-grep guards still green.**

```bash
npm run test:unit -- --test-name-pattern 'audit'
```

Expected: **PASS**.

- [ ] **Step 5: Verify-design-assumptions full sweep (G12 + G12b at minimum).**

```bash
node system/runtime/scripts/verify-design-assumptions.js
```

Expected: every gate prints `ok`.

- [ ] **Step 6: No further commit unless tests revealed something.**

---

## Open items (deferred — confirmed in spec section 11)

These are explicitly out of scope for B1 and tracked here so the implementer does not re-derive them:

- **`recall_used` MCP tool.** Spec section 5. Plumbing in `attribute()` is part of B1 (Task 2.1); the tool itself is a follow-up once we decide which hosts (Claude Code, Gemini CLI) should be taught to call it.
- **`show_attribution_health` rollup.** Spec section 9.2 step 3. Theme-4 introspection follow-up — `recall_log.attribution.mode` is the underlying field; rollup is a read-only aggregate over the last 24h. Not part of B1.
- **Per-hit refutation on correction.** Spec section 7.4 + Theme 2a section 12 open question. Today every memo in a corrected row is refuted; narrowing requires LLM judgement. Deliberately not in B1.
- **Per-session reinforcement dedup.** Theme 2a section 12 open question. A memo cited twice in one session still gets two corroborates. Wait for telemetry before deciding.
- **Hit content storage at recall time.** Spec section 11. Defer until hydration becomes a measurable hot spot or until we want to attribute against deleted memos.
- **Tuning `similarity_threshold`.** Spec section 11. 0.35 is a starting guess; tune after one week of `hybrid` mode telemetry.
- **Rollout step (config flip on Kevin's instance).** Spec section 9.2 step 4-5. Out of scope for the engineering implementation; happens after the code lands and `show_attribution_health` is live.

---

## Cost envelope (per `evaluatePending` tick, 200 rows max — spec section 12)

- +1 SELECT on `runtime:reinforcement.config`.
- +1 SELECT on `events` for the union-window reply lookup.
- +2 SELECTs (events + memos) for batched hit hydration.
- +1 multi-statement UPDATE on `recall_log` for per-row attribution payload (<=200 statements, one round-trip).
- Existing outcome-bucket UPDATEs (3 max, now 4 max with the new `evaluated_no_used` bucket) and memo `signal_count` UPDATEs (one per distinct hit-count) **unchanged in count**; bucket sizes are **smaller or equal** to today because `used=true` is the filter.
- `evidence_ledger` writes: at most as many as today (corrected-path refutes unchanged; corroborates only fire on `used=true`).
- Zero new LLM tokens. Zero new embedding tokens.
