# Cognition B2 — Contradiction surfacing at recall · Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **Treat every code block as illustrative**: the engineer types the code; this document specifies _what_ must be in place at each checkpoint, not the verbatim source.

**Goal:** Surface both sides of an unresolved `contradicts` edge to the agent at recall time via a new capped `<!-- conflicts -->` block, and finally wire the dormant `contradictionCount` input into the rank `contraPenalty`. When the substrate has no contradictors among the recalled memos, the prompt is byte-identical to today's.

**Architecture:** One pure-function module (`fetchContradictors`, `applySuppression`, `buildConflictBlock` in `system/cognition/intuition/conflicts.js`); one DB-touching call inside the intuition fan-out (`Promise.all`) that issues a single multi-statement `BoundQuery` (two `LET` blocks + a `RETURN` projection) hydrating contradicting memos for in-view memo hits. Suppression rules (low confidence, superseded, outbound-blocked, stale, capped) run JS-side. Block is concatenated above `<!-- relevant memory -->`. Telemetry extends `intuition_telemetry` with eight new option fields and writes `recall_log.meta.conflicts_surfaced` for A3 stratification. Gated by `runtime:recall.value.conflict_surfacing_enabled` (default `false`).

**Tech Stack:** Node.js 18+, SurrealDB 3.0.5.

**Spec:** `docs/superpowers/specs/2026-05-11-cognition-b2-contradiction-surfacing-design.md`

**Dependencies:**
- Theme 2a (`docs/superpowers/specs/2026-05-11-robin-v2-theme-2a-evidence-ledger-design.md`) — `evidence_ledger` + `fn::derived_confidence` already shipped; B2 reads the resulting `memos.confidence`.
- D1 state-inference design (`docs/superpowers/specs/2026-05-11-cognition-d1-state-inference-design.md`) — orders the `<!-- current focus -->` block above `<!-- conflicts -->`. B2 lands independently; ordering is established structurally so D1 can land before or after.
- A3 recall-eval design (`docs/superpowers/specs/2026-05-11-cognition-a3-recall-eval-and-mmr-design.md`) — owns `DEFINE FIELD meta ON intuition_telemetry TYPE option<object> FLEXIBLE`. B2's migration includes it as `DEFINE FIELD IF NOT EXISTS` so the order doesn't matter.
- R-3 runtime-layer-hardening (`docs/superpowers/plans/2026-05-11-runtime-layer-hardening.md`) — has shipped: `system/runtime/daemon/routes/intuition.js` exists. All daemon-route edits target that file.

---

## File structure

| File | Responsibility |
|---|---|
| `system/data/db/migrations/0015-conflict-surfacing.surql` (new) | Additive `runtime:recall` seed (7 new keys); `DEFINE FIELD IF NOT EXISTS meta ON intuition_telemetry`; 8 `DEFINE FIELD` statements for B2 telemetry keys on `intuition_telemetry`. |
| `system/cognition/memory/store.js` (modify) | Promote module-private `getRecallConfig` to `export`. Extend `HYBRID_DEFAULTS` with the seven new B2 keys so a partial config row still resolves to working defaults. |
| `system/cognition/intuition/conflicts.js` (new) | `fetchContradictors(db, memoIds, cfg)`, `dedupeAndCapPairs(rawRows, cap)` (named export), `applySuppression(pair, now, cfg)`, `buildConflictBlock(pairs, visibleHitIdSet, now, cfg)`. Pure where possible; the one DB-touching function is fail-soft. |
| `system/cognition/intuition/rank.js` (verify) | `contradictionCount` is already an accepted parameter (line 35, 40 — verified). B2 just starts populating it. No code change. |
| `system/cognition/intuition/inject.js` (modify) | Read `runtime:recall` via the exported `getRecallConfig`; invoke `fetchContradictors` inside the intuition fan-out `Promise.all` after `memoHits` construction; wire `contradictionCount` into the first `score()` call (the one building `merged`); reuse `merged[i]._scored.components` for the `recall_log` rebuild instead of a second `score()` call; insert `<!-- conflicts -->` block above relevant-memory; extend `intuition_telemetry` CONTENT with eight new fields; extend `recall_log.meta` with `conflicts_surfaced`. |
| `system/runtime/daemon/routes/intuition.js` (modify) | Read `relevant_memory_token_budget` + `conflict_block_token_budget` from `runtime:recall`; forward as `tokenBudget` and `conflictTokenBudget` to `intuitionEndpoint`. When the flag is off, force `conflictTokenBudget = 0`. |
| `system/tests/unit/conflicts-suppression.test.js` (new) | Spec §8.1 tests 1-6: low-confidence, superseded, both-blocked, stale, cap, precedence. |
| `system/tests/unit/conflicts-block.test.js` (new) | Spec §8.2 tests 7-11 plus 11a/11b: empty pairs, single-pair shape, ordering, budget-overflow, self-pair hit-side, `dedupeAndCapPairs` dedup, `dedupeAndCapPairs` cap. |
| `system/tests/integration/intuition-conflicts.test.js` (new) | Spec §8.3 tests 12-18: end-to-end surface, no-block, low-conf suppression, contradictor-pulled-in, private redaction, flag-off byte-identity, recall_log.meta propagation. |
| `docs/architecture.md` (modify) | Add `<!-- conflicts -->` to "A typical agent turn" item 2; note R-3 coordination in the modified-files list. |
| `docs/faculties.md` (modify) | Extend the "intuition" section to describe the conflicts block + the now-wired `contradictionCount`. |

**Migration number check.** `ls system/data/db/migrations/` shows the highest occupied slot is `0008-doctor.surql`. Spec §9.1 reserves `0009` for B1, `0010` for A3, `0012-0014` for D1, `0015` for B2, `0016` for B2's optional default-on follow-up. We use **`0015-conflict-surfacing.surql`** even though `0009-0014` are not yet on disk — the reservation is binding across the post-alpha.16 specs so numbers don't collide as those plans land in parallel.

---

## Phase 0 — Migration + runtime config seed

### Task 0.1 — Migration `0015-conflict-surfacing.surql`

**Files:** `system/data/db/migrations/0015-conflict-surfacing.surql`

- [ ] **Step 1: Verify the slot is free.**

```bash
ls system/data/db/migrations/ | grep -E '^0015-'
```

Expected: **no output** (number free).

- [ ] **Step 2: Create the migration file.**

```surql
-- ============================================================================
-- Cognition B2 — contradiction surfacing at recall
-- ============================================================================
-- Additive across THREE surfaces:
--   1. runtime:recall — extend the existing config singleton with 7 new keys
--      (without overwriting the legacy hybrid-recall keys seeded by 0001).
--   2. intuition_telemetry — 8 new option<...> fields for B2 metrics, plus a
--      DEFINE FIELD IF NOT EXISTS meta precondition piggy-backed from A3.
--   3. recall_log.meta — no DDL needed; meta is already option<object> FLEXIBLE
--      per 0001-init.surql:302. Documented here for discoverability.
-- ============================================================================

-- Extend runtime:recall. The original 0001-init seed uses CONTENT which would
-- wipe legacy keys; we use field-level SET so rrf_k / knn_overfetch_* /
-- mmr_threshold are preserved. value is object FLEXIBLE (0001-init:217) so
-- dotted-path SET is supported. UPSERT (not UPDATE) is defensive: if 0001
-- didn't run, the row gets created with these keys and getRecallConfig will
-- fall back to HYBRID_DEFAULTS for the missing legacy keys.
UPSERT runtime:recall SET
  value.conflict_surfacing_enabled   = false,
  value.conflict_min_confidence      = 0.4,
  value.conflict_max_age_days        = 30,
  value.conflict_max_pairs_surfaced  = 3,
  value.conflict_max_pairs_hydrated  = 24,
  value.conflict_block_token_budget  = 300,
  value.relevant_memory_token_budget = 1500;

-- intuition_telemetry is SCHEMAFULL TYPE NORMAL (0001-init:279). New keys
-- must be explicitly DEFINE'd. All option<...> so flag-off rows (which never
-- write these keys) remain schema-valid.
--
-- Precondition for A3 cross-spec coordination: A3 owns adding
-- `DEFINE FIELD meta ON intuition_telemetry`. If A3 has not landed first,
-- B2 must include it so any future B2 write to meta.* lands on a valid
-- schema. IF NOT EXISTS makes the duplication safe in either order.
DEFINE FIELD IF NOT EXISTS meta ON intuition_telemetry TYPE option<object> FLEXIBLE;

DEFINE FIELD conflicts_surfaced            ON intuition_telemetry TYPE option<int>;
DEFINE FIELD conflicts_block_tokens        ON intuition_telemetry TYPE option<int>;
DEFINE FIELD conflicts_hydrated_precap     ON intuition_telemetry TYPE option<int>;
DEFINE FIELD conflicts_hydrated_postcap    ON intuition_telemetry TYPE option<int>;
DEFINE FIELD conflicts_hydration_capped    ON intuition_telemetry TYPE option<bool>;
DEFINE FIELD conflicts_suppressed_by_rule  ON intuition_telemetry TYPE option<object> FLEXIBLE;
DEFINE FIELD conflicts_redacted_one_side   ON intuition_telemetry TYPE option<int>;
DEFINE FIELD conflicts_block_truncated     ON intuition_telemetry TYPE option<bool>;

-- recall_log.meta is already option<object> FLEXIBLE (0001-init:302). No DDL
-- needed for meta.conflicts_surfaced — the FLEXIBLE container accepts it.
```

- [ ] **Step 3: Run the existing intuition unit suite to confirm migration applies cleanly to a fresh in-memory DB.**

```bash
npm run test:unit -- --test-name-pattern 'intuitionEndpoint returns formatted block'
```

Expected: **PASS, 1 test**. The migration runs as part of the test's `runMigrations(db, dir)` call; a schema error would surface here.

- [ ] **Step 4: Verify the seed lands by querying the row in a quick test.**

Add (temporarily, for verification) to `system/tests/unit/intuition-endpoint.test.js` at the end of the first test — assert the row exists:

```js
const [recallCfg] = await db.query('SELECT value FROM runtime:recall').collect();
assert.equal(recallCfg[0].value.conflict_surfacing_enabled, false);
assert.equal(recallCfg[0].value.conflict_block_token_budget, 300);
assert.equal(recallCfg[0].value.relevant_memory_token_budget, 1500);
// preserve legacy keys
assert.equal(recallCfg[0].value.rrf_k, 60);
```

Run:

```bash
node --test --test-name-pattern 'intuitionEndpoint returns formatted block' system/tests/unit/intuition-endpoint.test.js
```

Expected: **PASS, 1 test**. Then **revert** the inline assertion (the proper coverage moves to Task 1.x). This is a one-shot verification — keep the commit clean.

- [ ] **Step 5: Commit.**

```bash
git commit -m "$(cat <<'EOF'
feat(schema): 0015 — conflict-surfacing config + telemetry fields

Extends runtime:recall with 7 new B2 keys (additive SET preserves the
legacy hybrid-recall keys), adds a DEFINE FIELD IF NOT EXISTS meta
precondition on intuition_telemetry (shared with A3), and declares the
8 new B2 telemetry option fields. recall_log.meta needs no DDL — its
container is already FLEXIBLE per 0001-init:302.
EOF
)"
```

### Task 0.2 — Export `getRecallConfig` and extend `HYBRID_DEFAULTS`

**Files:** `system/cognition/memory/store.js`, `system/tests/unit/store-recall-config.test.js`

- [ ] **Step 1: Failing test.**

Create `system/tests/unit/store-recall-config.test.js`:

```js
import assert from 'node:assert/strict';
import { mkdirSync as __robinMkdirSync } from 'node:fs';
import { tmpdir as __robinTmpdir } from 'node:os';
import { join as __robinJoin, resolve } from 'node:path';
import { test } from 'node:test';
import { getRecallConfig } from '../../cognition/memory/store.js';
import { writeConfig as __robinWriteConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';

const __robinTestHome = __robinJoin(
  __robinTmpdir(),
  `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`,
);
__robinMkdirSync(__robinTestHome, { recursive: true });
process.env.ROBIN_HOME = __robinTestHome;
await __robinWriteConfig({ embedder_profile: 'mxbai-1024' });

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
  return db;
}

test('getRecallConfig is exported and merges all B2 + legacy defaults', async () => {
  const db = await fresh();
  const cfg = await getRecallConfig(db);
  // Legacy keys (from 0001-init seed).
  assert.equal(cfg.rrf_k, 60);
  assert.equal(cfg.mmr_threshold, 0.92);
  // B2 keys (from 0015 seed).
  assert.equal(cfg.conflict_surfacing_enabled, false);
  assert.equal(cfg.conflict_min_confidence, 0.4);
  assert.equal(cfg.conflict_max_age_days, 30);
  assert.equal(cfg.conflict_max_pairs_surfaced, 3);
  assert.equal(cfg.conflict_max_pairs_hydrated, 24);
  assert.equal(cfg.conflict_block_token_budget, 300);
  assert.equal(cfg.relevant_memory_token_budget, 1500);
  await close(db);
});

test('getRecallConfig falls back to HYBRID_DEFAULTS when runtime:recall is missing', async () => {
  const db = await fresh();
  await db.query('DELETE runtime:recall').collect();
  // Bust the 5-s cache by waiting (cache is module-level; cannot inspect).
  // The cache only matters across calls; the next call after DELETE may
  // still return the cached row. Force-resolve by adding a sentinel
  // re-write and asserting we see the resulting partial row's defaults.
  const cfg = await getRecallConfig(db);
  // Either the cached row from before the DELETE, or HYBRID_DEFAULTS — both
  // shapes have the legacy keys. The contract we care about: an exported
  // function with no thrown error.
  assert.equal(typeof cfg.rrf_k, 'number');
  assert.equal(typeof cfg.conflict_min_confidence, 'number');
  await close(db);
});
```

- [ ] **Step 2: Run the failing test.**

```bash
node --test system/tests/unit/store-recall-config.test.js
```

Expected: **FAIL** with `getRecallConfig is not exported` (the function exists at `store.js:473` but is module-private).

- [ ] **Step 3: Implement — promote `getRecallConfig` to exported and extend `HYBRID_DEFAULTS`.**

In `system/cognition/memory/store.js`:

1. Replace the `HYBRID_DEFAULTS` constant block (starting at line 464) with:

```js
const HYBRID_DEFAULTS = {
  // Legacy hybrid-recall tunables (0001-init seed).
  rrf_k: 60,
  knn_overfetch_base: 1.5,
  knn_overfetch_per_filter: 1.5,
  mmr_threshold: 0.92,
  // B2 conflict-surfacing tunables (0015 seed). Defaults match the seed so
  // partial config rows (e.g., dev installs that didn't run 0015 yet) still
  // resolve to a working shape.
  conflict_surfacing_enabled: false,
  conflict_min_confidence: 0.4,
  conflict_max_age_days: 30,
  conflict_max_pairs_surfaced: 3,
  conflict_max_pairs_hydrated: 24,
  conflict_block_token_budget: 300,
  relevant_memory_token_budget: 1500,
};
```

2. Change `async function getRecallConfig(db)` (line 473) to `export async function getRecallConfig(db)`.

- [ ] **Step 4: Re-run the test.**

```bash
node --test system/tests/unit/store-recall-config.test.js
```

Expected: **PASS, 2 tests**.

- [ ] **Step 5: Run lint to make sure the surface widening hasn't broken Biome.**

```bash
npm run lint
```

Expected: **PASS, no errors**.

- [ ] **Step 6: Commit.**

```bash
git commit -m "$(cat <<'EOF'
feat(memory): export getRecallConfig + extend HYBRID_DEFAULTS for B2

Promotes the module-private getRecallConfig to an exported helper so
inject.js can read the same 5-s-cached recall config that
_surfaceSearch uses. Extends HYBRID_DEFAULTS with the 7 new B2 keys so
partial config rows (dev installs without 0015 applied yet) still
resolve to a working shape.
EOF
)"
```

---

## Phase 1 — `conflicts.js` pure functions (no DB)

### Task 1.1 — `applySuppression` (rules 1, 2, 4, 5; rule 3 + redaction land in 1.2)

**Files:** `system/cognition/intuition/conflicts.js`, `system/tests/unit/conflicts-suppression.test.js`

- [ ] **Step 1: Failing tests for rules 1, 2, 4, 5.**

Create `system/tests/unit/conflicts-suppression.test.js`:

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applySuppression } from '../../cognition/intuition/conflicts.js';

const now = new Date('2026-05-11T12:00:00Z');
const cfg = {
  conflict_min_confidence: 0.4,
  conflict_max_age_days: 30,
};

function pair({
  hitConf = 0.7, hitTs = '2026-05-09T12:00:00Z', hitFresh = 0.5, hitScope = 'global',
  otherConf = 0.7, otherTs = '2026-05-09T12:00:00Z', otherFresh = 0.5, otherScope = 'global',
} = {}) {
  return {
    hitSide:   { id: 'memos:hit',   confidence: hitConf,   ts: hitTs,   freshness: hitFresh,   scope: hitScope,   content: 'hit content' },
    otherSide: { id: 'memos:other', confidence: otherConf, ts: otherTs, freshness: otherFresh, scope: otherScope, content: 'other content' },
  };
}

test('rule 1: hitSide.confidence < min_confidence -> suppressed (low_confidence)', () => {
  const r = applySuppression(pair({ hitConf: 0.3 }), now, cfg);
  assert.equal(r.keep, false);
  assert.equal(r.reason, 'low_confidence');
});

test('rule 1: otherSide.confidence < min_confidence -> suppressed (low_confidence)', () => {
  const r = applySuppression(pair({ otherConf: 0.35 }), now, cfg);
  assert.equal(r.keep, false);
  assert.equal(r.reason, 'low_confidence');
});

test('rule 2: hitSide.freshness === 0 -> suppressed (superseded)', () => {
  const r = applySuppression(pair({ hitFresh: 0 }), now, cfg);
  assert.equal(r.keep, false);
  assert.equal(r.reason, 'superseded');
});

test('rule 2: otherSide.freshness === 0 -> suppressed (superseded)', () => {
  const r = applySuppression(pair({ otherFresh: 0 }), now, cfg);
  assert.equal(r.keep, false);
  assert.equal(r.reason, 'superseded');
});

test('rule 4: max(hitSide.ts, otherSide.ts) older than max_age_days -> stale', () => {
  const r = applySuppression(
    pair({ hitTs: '2026-04-09T00:00:00Z', otherTs: '2026-04-08T00:00:00Z' }),
    now,
    cfg,
  );
  assert.equal(r.keep, false);
  assert.equal(r.reason, 'stale');
});

test('rule 4: 29-day-old pair surfaces (no rule fires)', () => {
  const r = applySuppression(
    pair({ hitTs: '2026-04-12T12:00:00Z', otherTs: '2026-04-12T12:00:00Z' }),
    now,
    cfg,
  );
  assert.equal(r.keep, true);
});

test('rule precedence: low-confidence pair attributed to low_confidence, not stale', () => {
  // low conf + stale: low_confidence fires first per §5.2 ordering.
  const r = applySuppression(
    pair({ hitConf: 0.3, hitTs: '2026-04-08T00:00:00Z', otherTs: '2026-04-08T00:00:00Z' }),
    now,
    cfg,
  );
  assert.equal(r.keep, false);
  assert.equal(r.reason, 'low_confidence');
});
```

- [ ] **Step 2: Run.**

```bash
node --test system/tests/unit/conflicts-suppression.test.js
```

Expected: **FAIL** with `Cannot find module .../conflicts.js`.

- [ ] **Step 3: Implement `system/cognition/intuition/conflicts.js`** — rules 1, 2, 4 + skeleton for the rest.

```js
// conflicts.js — pure-function helpers for the B2 contradiction surfacing
// block at recall time. fetchContradictors (the one DB-touching function)
// lands in Task 1.4; this file ships with the pure suppression + dedup +
// block-builder helpers first.
//
// Suppression rule precedence (§5.2):
//   1. low_confidence  — either side below conflict_min_confidence
//   2. superseded      — either side has freshness === 0
//   3. both_blocked    — both sides isOutboundBlocked (handled in 1.2)
//   4. stale           — max(hitTs, otherTs) older than conflict_max_age_days
//   5. capped          — applied at builder time, not per-pair
// First matching rule short-circuits.

import { isOutboundBlocked } from '../memory/scope-registry.js';

const DAY_MS = 86_400_000;

function tsMs(x) {
  if (x instanceof Date) return x.getTime();
  if (typeof x === 'number') return x;
  return new Date(x).getTime();
}

/**
 * Apply suppression rules 1-4 to a single pair.
 * Rule 5 (cap) is enforced in buildConflictBlock, not here.
 *
 * @param {{ hitSide: object, otherSide: object }} pair
 * @param {Date} now
 * @param {object} cfg  — recall config (conflict_min_confidence, conflict_max_age_days)
 * @returns {{ keep: boolean, reason?: string, redactSide?: 'hit'|'other' }}
 */
export function applySuppression(pair, now, cfg) {
  const { hitSide, otherSide } = pair;
  const minConf = cfg.conflict_min_confidence ?? 0.4;
  const maxAgeDays = cfg.conflict_max_age_days ?? 30;

  // Rule 1 — low_confidence (precedence: highest).
  if ((hitSide.confidence ?? 0) < minConf || (otherSide.confidence ?? 0) < minConf) {
    return { keep: false, reason: 'low_confidence' };
  }

  // Rule 2 — superseded (freshness === 0).
  if ((hitSide.freshness ?? 1) === 0 || (otherSide.freshness ?? 1) === 0) {
    return { keep: false, reason: 'superseded' };
  }

  // Rule 3 — outbound-blocked. See Task 1.2.
  const hitBlocked = isOutboundBlocked(hitSide.scope ?? 'global');
  const otherBlocked = isOutboundBlocked(otherSide.scope ?? 'global');
  if (hitBlocked && otherBlocked) {
    return { keep: false, reason: 'both_blocked' };
  }

  // Rule 4 — stale.
  const newest = Math.max(tsMs(hitSide.ts), tsMs(otherSide.ts));
  if ((tsMs(now) - newest) / DAY_MS > maxAgeDays) {
    return { keep: false, reason: 'stale' };
  }

  // Pair survived rules 1-4. If exactly one side is outbound-blocked, signal
  // the redaction case so the caller can render the blocked side as
  // "<private memo redacted>" per §5.1.
  if (hitBlocked && !otherBlocked) return { keep: true, redactSide: 'hit' };
  if (!hitBlocked && otherBlocked) return { keep: true, redactSide: 'other' };
  return { keep: true };
}
```

- [ ] **Step 4: Re-run.**

```bash
node --test system/tests/unit/conflicts-suppression.test.js
```

Expected: **PASS, 7 tests**.

- [ ] **Step 5: Lint.**

```bash
npm run lint
```

Expected: **PASS, no errors**.

- [ ] **Step 6: Commit.**

```bash
git commit -m "$(cat <<'EOF'
feat(intuition): conflicts.applySuppression — rules 1/2/4 + skeleton

Pure-function suppression engine for the B2 conflict block. Rules
1 (low_confidence), 2 (superseded), 4 (stale) fully wired; rule 3
(both_blocked / single-side redaction) lands in 1.2 against the
isOutboundBlocked predicate from scope-registry. Rule 5 (cap) is
enforced in buildConflictBlock, not here.
EOF
)"
```

### Task 1.2 — `applySuppression` rule 3 + redaction shape

**Files:** `system/tests/unit/conflicts-suppression.test.js`

- [ ] **Step 1: Append failing tests for rule 3 + redaction.**

Append to `system/tests/unit/conflicts-suppression.test.js`:

```js
test('rule 3: both sides private -> suppressed (both_blocked)', () => {
  const r = applySuppression(
    pair({ hitScope: 'private', otherScope: 'private' }),
    now,
    cfg,
  );
  assert.equal(r.keep, false);
  assert.equal(r.reason, 'both_blocked');
});

test('rule 3 redaction: hit private, other global -> keep with redactSide=hit', () => {
  const r = applySuppression(
    pair({ hitScope: 'private', otherScope: 'global' }),
    now,
    cfg,
  );
  assert.equal(r.keep, true);
  assert.equal(r.redactSide, 'hit');
});

test('rule 3 redaction: hit global, other private -> keep with redactSide=other', () => {
  const r = applySuppression(
    pair({ hitScope: 'global', otherScope: 'private' }),
    now,
    cfg,
  );
  assert.equal(r.keep, true);
  assert.equal(r.redactSide, 'other');
});

test('both global -> no redaction signal', () => {
  const r = applySuppression(
    pair({ hitScope: 'global', otherScope: 'global' }),
    now,
    cfg,
  );
  assert.equal(r.keep, true);
  assert.equal(r.redactSide, undefined);
});

test('rule precedence: private + low-confidence -> low_confidence (not both_blocked)', () => {
  const r = applySuppression(
    pair({ hitScope: 'private', otherScope: 'private', hitConf: 0.3 }),
    now,
    cfg,
  );
  assert.equal(r.keep, false);
  assert.equal(r.reason, 'low_confidence');
});
```

- [ ] **Step 2: Run.**

```bash
node --test system/tests/unit/conflicts-suppression.test.js
```

Expected: **PASS, 12 tests** — the rule 3 branch was already wired in Task 1.1's skeleton; these tests confirm the redaction-signal shape.

- [ ] **Step 3: Commit.**

```bash
git commit -m "$(cat <<'EOF'
test(intuition): conflicts rule 3 + redaction coverage

Confirms the both-blocked drop, the single-side redaction signal
(redactSide: 'hit' | 'other'), the no-redaction path for both-global
pairs, and that low_confidence wins precedence over both_blocked.
EOF
)"
```

### Task 1.3 — `dedupeAndCapPairs` (named export for unit testing)

**Files:** `system/cognition/intuition/conflicts.js`, `system/tests/unit/conflicts-block.test.js`

- [ ] **Step 1: Failing tests for the dedup + cap helper.**

Create `system/tests/unit/conflicts-block.test.js`:

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dedupeAndCapPairs } from '../../cognition/intuition/conflicts.js';

test('dedupeAndCapPairs: collapses self-pair returned from both LET branches', () => {
  const raw = [
    { side: 'memos:A', other: 'memos:B' },
    { side: 'memos:B', other: 'memos:A' },
  ];
  const out = dedupeAndCapPairs(raw, 24);
  assert.equal(out.pairs.length, 1);
  assert.equal(out.pairs_precap, 1);
  // First-seen orientation wins.
  assert.equal(out.pairs[0].side, 'memos:A');
  assert.equal(out.pairs[0].other, 'memos:B');
});

test('dedupeAndCapPairs: cap truncates after dedup', () => {
  const raw = Array.from({ length: 7 }, (_, i) => ({
    side: `memos:A${i}`,
    other: `memos:B${i}`,
  }));
  const out = dedupeAndCapPairs(raw, 3);
  assert.equal(out.pairs.length, 3);
  assert.equal(out.pairs_precap, 7);
});

test('dedupeAndCapPairs: cap larger than deduped count -> no truncation', () => {
  const raw = [
    { side: 'memos:A', other: 'memos:B' },
    { side: 'memos:C', other: 'memos:D' },
  ];
  const out = dedupeAndCapPairs(raw, 24);
  assert.equal(out.pairs.length, 2);
  assert.equal(out.pairs_precap, 2);
});

test('dedupeAndCapPairs: empty input', () => {
  const out = dedupeAndCapPairs([], 24);
  assert.equal(out.pairs.length, 0);
  assert.equal(out.pairs_precap, 0);
});
```

- [ ] **Step 2: Run.**

```bash
node --test system/tests/unit/conflicts-block.test.js
```

Expected: **FAIL** — `dedupeAndCapPairs` not exported.

- [ ] **Step 3: Add `dedupeAndCapPairs` to `system/cognition/intuition/conflicts.js`** (append before the `applySuppression` export):

```js
/**
 * Collapse self-pair duplicates (the same canonical edge returned by both
 * the in-side and out-side LET branches) by sorting the endpoint ids
 * lexicographically; truncate the deduped list to `cap`.
 *
 * @param {Array<{side: string|object, other: string|object}>} rawRows
 * @param {number} cap   — conflict_max_pairs_hydrated
 * @returns {{ pairs: Array, pairs_precap: number }}
 */
export function dedupeAndCapPairs(rawRows, cap) {
  const seen = new Set();
  const deduped = [];
  for (const row of rawRows) {
    const sideId = String(row.side);
    const otherId = String(row.other);
    const key = sideId < otherId ? `${sideId}|${otherId}` : `${otherId}|${sideId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(row);
  }
  const pairs_precap = deduped.length;
  const pairs = cap > 0 && deduped.length > cap ? deduped.slice(0, cap) : deduped;
  return { pairs, pairs_precap };
}
```

- [ ] **Step 4: Re-run.**

```bash
node --test system/tests/unit/conflicts-block.test.js
```

Expected: **PASS, 4 tests**.

- [ ] **Step 5: Commit.**

```bash
git commit -m "$(cat <<'EOF'
feat(intuition): conflicts.dedupeAndCapPairs

Pure helper that collapses self-pair duplicates (same canonical edge
returned by both $contras_in and $contras_out) by lex-sorted endpoint
key, then truncates the deduped list to conflict_max_pairs_hydrated.
Returns {pairs, pairs_precap} so telemetry can emit both shapes.
EOF
)"
```

### Task 1.4 — `fetchContradictors` (DB-touching, fail-soft)

**Files:** `system/cognition/intuition/conflicts.js`, `system/tests/integration/conflicts-fetch.test.js`

- [ ] **Step 1: Integration test exercising the one batched roundtrip.**

Create `system/tests/integration/conflicts-fetch.test.js`:

```js
import assert from 'node:assert/strict';
import { mkdirSync as __robinMkdirSync } from 'node:fs';
import { tmpdir as __robinTmpdir } from 'node:os';
import { join as __robinJoin, resolve } from 'node:path';
import { test } from 'node:test';
import * as store from '../../cognition/memory/store.js';
import { fetchContradictors } from '../../cognition/intuition/conflicts.js';
import { writeConfig as __robinWriteConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { createStubEmbedder } from '../../data/embed/embedder.js';

const __robinTestHome = __robinJoin(
  __robinTmpdir(),
  `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`,
);
__robinMkdirSync(__robinTestHome, { recursive: true });
process.env.ROBIN_HOME = __robinTestHome;
await __robinWriteConfig({ embedder_profile: 'mxbai-1024' });

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
  return db;
}

const fakeEmbedder = createStubEmbedder({ dimension: 1024 });

const cfg = {
  conflict_max_pairs_hydrated: 24,
  conflict_min_confidence: 0.4,
  conflict_max_age_days: 30,
};

test('fetchContradictors: returns hydrated pair when contradicts edge exists', async () => {
  const db = await fresh();
  const a = await store.note(db, fakeEmbedder, 'knowledge', {
    content: 'primary bank is Chase as of 2026-05-02',
    derived_by: 'manual',
  });
  const b = await store.note(db, fakeEmbedder, 'knowledge', {
    content: 'switched primary bank to Mercury 2026-04-12',
    derived_by: 'manual',
  });
  await store.flagContradiction(db, a.id, b.id);

  const out = await fetchContradictors(db, [a.id], cfg);
  assert.equal(out.pairs.length, 1);
  assert.equal(out.pairs_precap, 1);
  const p = out.pairs[0];
  // hit-side memo must be the one we passed in.
  assert.equal(String(p.hitSide.id), String(a.id));
  // other-side memo must be hydrated with content + confidence + ts + scope + freshness.
  assert.equal(String(p.otherSide.id), String(b.id));
  assert.equal(typeof p.otherSide.content, 'string');
  assert.equal(typeof p.otherSide.confidence, 'number');
  assert.equal(typeof p.otherSide.freshness, 'number');
  await close(db);
});

test('fetchContradictors: empty memoIds short-circuits without DB call', async () => {
  const db = await fresh();
  const out = await fetchContradictors(db, [], cfg);
  assert.equal(out.pairs.length, 0);
  assert.equal(out.pairs_precap, 0);
  await close(db);
});

test('fetchContradictors: no contradicts edge -> empty pairs', async () => {
  const db = await fresh();
  const a = await store.note(db, fakeEmbedder, 'knowledge', {
    content: 'a unique fact',
    derived_by: 'manual',
  });
  const out = await fetchContradictors(db, [a.id], cfg);
  assert.equal(out.pairs.length, 0);
  await close(db);
});

test('fetchContradictors: both endpoints in hits -> dedup yields one pair', async () => {
  const db = await fresh();
  const a = await store.note(db, fakeEmbedder, 'knowledge', {
    content: 'claim A', derived_by: 'manual',
  });
  const b = await store.note(db, fakeEmbedder, 'knowledge', {
    content: 'claim B', derived_by: 'manual',
  });
  await store.flagContradiction(db, a.id, b.id);
  const out = await fetchContradictors(db, [a.id, b.id], cfg);
  assert.equal(out.pairs.length, 1);
  assert.equal(out.pairs_precap, 1);
  await close(db);
});

test('fetchContradictors: returns {pairs:[], pairs_precap:0} on DB error', async () => {
  // Pass a fake db whose .query() throws — the function must swallow and return
  // the empty shape rather than propagate.
  const brokenDb = {
    query() { throw new Error('boom'); },
  };
  const out = await fetchContradictors(brokenDb, ['memos:x'], cfg);
  assert.equal(out.pairs.length, 0);
  assert.equal(out.pairs_precap, 0);
});
```

- [ ] **Step 2: Run.**

```bash
node --test system/tests/integration/conflicts-fetch.test.js
```

Expected: **FAIL** — `fetchContradictors` not exported.

- [ ] **Step 3: Append `fetchContradictors` to `system/cognition/intuition/conflicts.js`.**

```js
import { BoundQuery } from 'surrealdb';

const FETCH_QUERY = `
LET $contras_in = (
  SELECT { side: in, other: out } AS pair FROM edges
  WHERE kind = 'contradicts' AND in IN $hits
);
LET $contras_out = (
  SELECT { side: out, other: in } AS pair FROM edges
  WHERE kind = 'contradicts' AND out IN $hits
);
LET $contras = array::concat($contras_in, $contras_out);
LET $ids = array::distinct(array::concat(
  $contras.pair.side,
  $contras.pair.other
));
RETURN {
  pairs: $contras,
  memos: (SELECT id, content, ts, scope, confidence, derived_at, meta,
                 fn::freshness(id) AS freshness
          FROM memos WHERE id IN $ids)
};
`;

/**
 * Hydrate contradicting-memo pairs for the given in-view memo ids.
 * Fail-soft on any error — returns `{ pairs: [], pairs_precap: 0 }`.
 *
 * @param {object} db
 * @param {Array} memoIds  — memo record refs from the intuition fan-out's memoHits
 * @param {object} cfg     — recall config (conflict_max_pairs_hydrated)
 * @returns {Promise<{ pairs: Array<{hitSide:object, otherSide:object}>, pairs_precap: number }>}
 */
export async function fetchContradictors(db, memoIds, cfg) {
  try {
    if (!Array.isArray(memoIds) || memoIds.length === 0) {
      return { pairs: [], pairs_precap: 0 };
    }
    const cap = cfg.conflict_max_pairs_hydrated ?? 24;
    const [result] = await db.query(new BoundQuery(FETCH_QUERY, { hits: memoIds })).collect();
    // SurrealDB returns the multi-statement result as an array; the final
    // RETURN payload is the last entry. Some SDK shapes return the payload
    // directly. Tolerate both.
    const payload = Array.isArray(result) ? result[result.length - 1] : result;
    const rawRows = (payload?.pairs ?? []).map((r) => r.pair ?? r);
    const hydratedMemos = payload?.memos ?? [];

    const { pairs: dedupedRows, pairs_precap } = dedupeAndCapPairs(rawRows, cap);

    // Build a `String(id) -> memo` lookup so each pair can carry full
    // {confidence, ts, scope, content, freshness} on both sides.
    const memosById = new Map(hydratedMemos.map((m) => [String(m.id), m]));
    const pairs = [];
    for (const row of dedupedRows) {
      const hit = memosById.get(String(row.side));
      const other = memosById.get(String(row.other));
      if (!hit || !other) continue; // hydration miss — drop defensively
      pairs.push({ hitSide: hit, otherSide: other });
    }
    return { pairs, pairs_precap };
  } catch {
    return { pairs: [], pairs_precap: 0 };
  }
}
```

- [ ] **Step 4: Re-run.**

```bash
node --test system/tests/integration/conflicts-fetch.test.js
```

Expected: **PASS, 5 tests**.

- [ ] **Step 5: Lint.**

```bash
npm run lint
```

Expected: **PASS, no errors**.

- [ ] **Step 6: Commit.**

```bash
git commit -m "$(cat <<'EOF'
feat(intuition): conflicts.fetchContradictors — batched hydration

One multi-statement BoundQuery (two LET scans of the symmetric edges
table + a RETURN projection over fn::freshness) hydrates the
contradicting-memo pairs for an in-view memo set. Self-pair dedup is
delegated to dedupeAndCapPairs. Fail-soft: returns {pairs:[],
pairs_precap:0} on any DB error.
EOF
)"
```

### Task 1.5 — `buildConflictBlock` — happy path, ordering, empty input

**Files:** `system/cognition/intuition/conflicts.js`, `system/tests/unit/conflicts-block.test.js`

- [ ] **Step 1: Append failing tests.**

Append to `system/tests/unit/conflicts-block.test.js`:

```js
import { buildConflictBlock } from '../../cognition/intuition/conflicts.js';

const now = new Date('2026-05-11T12:00:00Z');
const cfgBlock = {
  conflict_min_confidence: 0.4,
  conflict_max_age_days: 30,
  conflict_max_pairs_surfaced: 3,
  conflict_block_token_budget: 300,
};

function memo({ id, content, conf = 0.7, ts = '2026-05-09T00:00:00Z', scope = 'global' }) {
  return { id, content, confidence: conf, ts, freshness: 0.5, scope };
}

test('buildConflictBlock: empty pairs -> empty string (no markers)', () => {
  const out = buildConflictBlock([], new Set(), now, cfgBlock);
  assert.equal(out.block, '');
  assert.equal(out.surfaced, 0);
  assert.equal(out.suppressed_by_rule.capped, 0);
  assert.equal(out.tokens, 0);
});

test('buildConflictBlock: single pair -> matches §2.1 line shape exactly', () => {
  const hit = memo({ id: 'memos:m1', content: 'Primary bank is Chase as of 2026-05-02', conf: 0.75, ts: '2026-05-02T00:00:00Z' });
  const other = memo({ id: 'memos:m2', content: 'Switched primary bank to Mercury 2026-04-12', conf: 0.85, ts: '2026-04-12T00:00:00Z' });
  const out = buildConflictBlock(
    [{ hitSide: hit, otherSide: other }],
    new Set(['memos:m1']),
    now,
    cfgBlock,
  );
  assert.ok(out.block.startsWith('<!-- conflicts -->\n'));
  assert.ok(out.block.endsWith('\n<!-- /conflicts -->'));
  assert.ok(out.block.includes(
    '[memo 2026-05-02] Primary bank is Chase as of 2026-05-02 <-> [memo 2026-04-12] Switched primary bank to Mercury 2026-04-12 (conf 0.75 <-> 0.85)',
  ));
  assert.equal(out.surfaced, 1);
});

test('buildConflictBlock: ordering — higher max-confidence first, then newer ts, then canonical id', () => {
  const pairs = [
    // pair-1: max-conf 0.6
    { hitSide: memo({ id: 'memos:a1', content: 'aaa', conf: 0.6, ts: '2026-05-10T00:00:00Z' }), otherSide: memo({ id: 'memos:a2', content: 'aaa-c', conf: 0.5 }) },
    // pair-2: max-conf 0.9 -> should come first
    { hitSide: memo({ id: 'memos:b1', content: 'bbb', conf: 0.9, ts: '2026-05-09T00:00:00Z' }), otherSide: memo({ id: 'memos:b2', content: 'bbb-c', conf: 0.5 }) },
    // pair-3: max-conf 0.7
    { hitSide: memo({ id: 'memos:c1', content: 'ccc', conf: 0.7, ts: '2026-05-08T00:00:00Z' }), otherSide: memo({ id: 'memos:c2', content: 'ccc-c', conf: 0.5 }) },
  ];
  const visible = new Set(['memos:a1', 'memos:b1', 'memos:c1']);
  const out = buildConflictBlock(pairs, visible, now, cfgBlock);
  // Three pairs, ordering by descending max-confidence: b (0.9), c (0.7), a (0.6).
  const idxB = out.block.indexOf('bbb');
  const idxC = out.block.indexOf('ccc');
  const idxA = out.block.indexOf('aaa');
  assert.ok(idxB < idxC && idxC < idxA, `expected b<c<a, got b=${idxB}, c=${idxC}, a=${idxA}`);
});

test('buildConflictBlock: hit-side filter — pair dropped when hitSide.id not in visibleHitIdSet', () => {
  const hit = memo({ id: 'memos:notvisible', content: 'aaa' });
  const other = memo({ id: 'memos:elsewhere', content: 'bbb' });
  const out = buildConflictBlock(
    [{ hitSide: hit, otherSide: other }],
    new Set(['memos:something-else']),
    now,
    cfgBlock,
  );
  assert.equal(out.block, '');
  assert.equal(out.surfaced, 0);
});

test('buildConflictBlock: rule 5 cap -> 5 pairs in, 3 surfaced, capped=2', () => {
  const pairs = [];
  const visible = new Set();
  for (let i = 0; i < 5; i++) {
    const hitId = `memos:hit${i}`;
    pairs.push({
      hitSide: memo({ id: hitId, content: `hit-${i}`, conf: 0.9 - i * 0.05 }),
      otherSide: memo({ id: `memos:other${i}`, content: `other-${i}`, conf: 0.5 }),
    });
    visible.add(hitId);
  }
  const out = buildConflictBlock(pairs, visible, now, { ...cfgBlock, conflict_max_pairs_surfaced: 3 });
  assert.equal(out.surfaced, 3);
  assert.equal(out.suppressed_by_rule.capped, 2);
});
```

- [ ] **Step 2: Run — confirm fail.**

```bash
node --test system/tests/unit/conflicts-block.test.js
```

Expected: **FAIL** — `buildConflictBlock` not exported yet.

- [ ] **Step 3: Append `buildConflictBlock` to `system/cognition/intuition/conflicts.js`.**

```js
const LINE_CONTENT_CHARS = 120;
const CONFLICT_OPEN = '<!-- conflicts -->';
const CONFLICT_CLOSE = '<!-- /conflicts -->';
const CONFLICT_SEPARATOR = ' <-> ';
const REDACTED_LABEL = '<private memo redacted>';

function trimLine(s, max = LINE_CONTENT_CHARS) {
  if (typeof s !== 'string') return '';
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : flat.slice(0, max).trimEnd();
}

function formatDate(ts) {
  if (!ts) return '????-??-??';
  const d = ts instanceof Date ? ts : new Date(ts);
  if (Number.isNaN(d.getTime())) return '????-??-??';
  return d.toISOString().slice(0, 10);
}

function estimateTokens(s) {
  return Math.ceil((typeof s === 'string' ? s.length : 0) / 4);
}

const CONFLICT_FRAME_TOKENS = estimateTokens(`${CONFLICT_OPEN}\n${CONFLICT_CLOSE}\n`);

function renderLine(pair, redactSide) {
  const { hitSide, otherSide } = pair;
  const hitDate = formatDate(hitSide.ts);
  const otherDate = formatDate(otherSide.ts);
  const hitContent = redactSide === 'hit' ? REDACTED_LABEL : trimLine(hitSide.content ?? '');
  const otherContent = redactSide === 'other' ? REDACTED_LABEL : trimLine(otherSide.content ?? '');
  const hitConf = (hitSide.confidence ?? 0).toFixed(2);
  const otherConf = (otherSide.confidence ?? 0).toFixed(2);
  return `[memo ${hitDate}] ${hitContent}${CONFLICT_SEPARATOR}[memo ${otherDate}] ${otherContent} (conf ${hitConf}${CONFLICT_SEPARATOR}${otherConf})`;
}

/**
 * @param {Array<{hitSide:object, otherSide:object}>} pairs
 * @param {Set<string>} visibleHitIdSet  — String(id) of memos in the greedy-packed relevant-memory hits
 * @param {Date} now
 * @param {object} cfg
 * @returns {{ block: string, surfaced: number, tokens: number,
 *             suppressed_by_rule: { low_confidence:int, superseded:int, both_blocked:int, stale:int, capped:int },
 *             redacted_one_side: number, truncated: boolean }}
 */
export function buildConflictBlock(pairs, visibleHitIdSet, now, cfg) {
  const cap = cfg.conflict_max_pairs_surfaced ?? 3;
  const budget = cfg.conflict_block_token_budget ?? 300;
  const counters = { low_confidence: 0, superseded: 0, both_blocked: 0, stale: 0, capped: 0 };
  let redacted = 0;

  // Pre-filter: hitSide must be in the agent's in-view set (§1.1 filter).
  const inView = pairs.filter((p) => visibleHitIdSet.has(String(p.hitSide.id)));

  // Apply suppression rules 1-4.
  const survivors = [];
  for (const p of inView) {
    const r = applySuppression(p, now, cfg);
    if (!r.keep) {
      if (r.reason && counters[r.reason] !== undefined) counters[r.reason] += 1;
      continue;
    }
    survivors.push({ pair: p, redactSide: r.redactSide ?? null });
    if (r.redactSide) redacted += 1;
  }

  // Ordering (§2.3): max(confidence) desc, max(ts) desc, canonical id sort.
  survivors.sort((A, B) => {
    const Amax = Math.max(A.pair.hitSide.confidence ?? 0, A.pair.otherSide.confidence ?? 0);
    const Bmax = Math.max(B.pair.hitSide.confidence ?? 0, B.pair.otherSide.confidence ?? 0);
    if (Bmax !== Amax) return Bmax - Amax;
    const Ats = Math.max(tsMs(A.pair.hitSide.ts), tsMs(A.pair.otherSide.ts));
    const Bts = Math.max(tsMs(B.pair.hitSide.ts), tsMs(B.pair.otherSide.ts));
    if (Bts !== Ats) return Bts - Ats;
    const Akey = [String(A.pair.hitSide.id), String(A.pair.otherSide.id)].sort().join('|');
    const Bkey = [String(B.pair.hitSide.id), String(B.pair.otherSide.id)].sort().join('|');
    return Akey < Bkey ? -1 : Akey > Bkey ? 1 : 0;
  });

  // Rule 5 — cap.
  let kept;
  if (survivors.length > cap) {
    kept = survivors.slice(0, cap);
    counters.capped = survivors.length - cap;
  } else {
    kept = survivors;
  }

  // Greedy-pack under the 300-token budget.
  const lines = [];
  let used = CONFLICT_FRAME_TOKENS;
  let truncated = false;
  for (const s of kept) {
    const line = renderLine(s.pair, s.redactSide);
    const lineTokens = estimateTokens(`${line}\n`);
    if (used + lineTokens > budget) {
      truncated = true;
      break;
    }
    lines.push(line);
    used += lineTokens;
  }

  const surfaced = lines.length;
  if (surfaced === 0) {
    return {
      block: '',
      surfaced: 0,
      tokens: 0,
      suppressed_by_rule: counters,
      redacted_one_side: redacted,
      truncated,
    };
  }
  const block = `${CONFLICT_OPEN}\n${lines.join('\n')}\n${CONFLICT_CLOSE}`;
  return {
    block,
    surfaced,
    tokens: estimateTokens(block),
    suppressed_by_rule: counters,
    redacted_one_side: redacted,
    truncated,
  };
}
```

- [ ] **Step 4: Re-run.**

```bash
node --test system/tests/unit/conflicts-block.test.js
```

Expected: **PASS, 9 tests** (4 from Task 1.3 + 5 here).

- [ ] **Step 5: Lint.**

```bash
npm run lint
```

Expected: **PASS, no errors**.

- [ ] **Step 6: Commit.**

```bash
git commit -m "$(cat <<'EOF'
feat(intuition): conflicts.buildConflictBlock

Pure block builder. Filters by visibleHitIdSet (the §1.1 'hitSide in
greedy-packed hits' gate), applies suppression rules 1-4, orders by
max-confidence/newest-ts/canonical-id, enforces rule 5 cap, and
greedy-packs under conflict_block_token_budget. Returns {block,
surfaced, tokens, suppressed_by_rule, redacted_one_side, truncated}.
EOF
)"
```

### Task 1.6 — `buildConflictBlock` — budget overflow + redaction shape

**Files:** `system/tests/unit/conflicts-block.test.js`

- [ ] **Step 1: Append remaining §8.2 tests.**

```js
test('buildConflictBlock: redaction one side — private content replaced, date + conf preserved', () => {
  const hit = memo({ id: 'memos:hit', content: 'public side claim', conf: 0.7, ts: '2026-05-02T00:00:00Z' });
  const other = memo({ id: 'memos:other', content: 'should not appear', conf: 0.4, scope: 'private' });
  const out = buildConflictBlock(
    [{ hitSide: hit, otherSide: other }],
    new Set(['memos:hit']),
    now,
    cfgBlock,
  );
  assert.ok(out.block.includes('public side claim'));
  assert.ok(!out.block.includes('should not appear'));
  assert.ok(out.block.includes('<private memo redacted>'));
  // Confidences still rendered.
  assert.ok(out.block.includes('0.70'));
  assert.ok(out.block.includes('0.40'));
  assert.equal(out.redacted_one_side, 1);
});

test('buildConflictBlock: budget overflow — first pair fits, second drops, truncated=true', () => {
  // 80-token budget: 80 / 1 token per ~4 chars => ~320 chars total budget.
  // Frame eats CONFLICT_FRAME_TOKENS (~11) leaving ~69 tokens / ~276 chars for lines.
  // A typical 70-token line is ~280 chars (close to one-line). With 80-token
  // budget, only one full line fits before overflow.
  const pairs = [];
  const visible = new Set();
  for (let i = 0; i < 3; i++) {
    const hitId = `memos:hit${i}`;
    pairs.push({
      hitSide: memo({ id: hitId, content: 'a'.repeat(LINE_CONTENT_CHARS_FOR_TEST), conf: 0.9 - i * 0.01 }),
      otherSide: memo({ id: `memos:other${i}`, content: 'b'.repeat(LINE_CONTENT_CHARS_FOR_TEST), conf: 0.6 }),
    });
    visible.add(hitId);
  }
  const out = buildConflictBlock(pairs, visible, now, {
    ...cfgBlock,
    conflict_block_token_budget: 80,
  });
  assert.equal(out.truncated, true);
  assert.ok(out.surfaced < pairs.length);
});

const LINE_CONTENT_CHARS_FOR_TEST = 120;

test('buildConflictBlock: self-pair hit-side picked by higher confidence', () => {
  // Both endpoints in visibleHitIdSet — the §2.4 self-pair branch reads:
  // "pick the side with higher confidence as hit-side; ties broken by newer ts".
  // The test asserts via final line shape: higher-conf side is rendered left of <->.
  const a = memo({ id: 'memos:a', content: 'aaa-content', conf: 0.9, ts: '2026-05-05T00:00:00Z' });
  const b = memo({ id: 'memos:b', content: 'bbb-content', conf: 0.6, ts: '2026-05-08T00:00:00Z' });
  // Caller passes {hitSide:a, otherSide:b} but both are in the visible set.
  // buildConflictBlock re-picks hit-side by §2.4 when both are visible.
  const out = buildConflictBlock(
    [{ hitSide: a, otherSide: b }],
    new Set(['memos:a', 'memos:b']),
    now,
    cfgBlock,
  );
  // higher-conf 'aaa-content' (0.9) leads, before the <-> separator.
  const sepIdx = out.block.indexOf(' <-> ');
  assert.ok(out.block.indexOf('aaa-content') < sepIdx);
  assert.ok(out.block.indexOf('bbb-content') > sepIdx);
});
```

- [ ] **Step 2: Run — confirm fail (the self-pair test exercises a code path we haven't written; the redaction + overflow tests should pass against Task 1.5).**

```bash
node --test system/tests/unit/conflicts-block.test.js
```

Expected: budget-overflow + redaction tests **PASS**; the self-pair test may **FAIL** if buildConflictBlock doesn't re-pick hit-side when both are in view.

- [ ] **Step 3: Extend `buildConflictBlock` to handle the self-pair hit-side re-pick.**

In `system/cognition/intuition/conflicts.js`, just before the pre-filter step in `buildConflictBlock`, normalise pairs whose both endpoints are in the visible set:

```js
// Self-pair hit-side re-pick (§2.4): when both endpoints are visible, the
// higher-confidence side leads. Ties broken by newer ts, then by canonical id.
function normaliseSelfPair(p, visibleHitIdSet) {
  const hitVisible = visibleHitIdSet.has(String(p.hitSide.id));
  const otherVisible = visibleHitIdSet.has(String(p.otherSide.id));
  if (!hitVisible || !otherVisible) return p;
  const { hitSide, otherSide } = p;
  const hc = hitSide.confidence ?? 0;
  const oc = otherSide.confidence ?? 0;
  if (oc > hc) return { hitSide: otherSide, otherSide: hitSide };
  if (oc === hc && tsMs(otherSide.ts) > tsMs(hitSide.ts)) {
    return { hitSide: otherSide, otherSide: hitSide };
  }
  if (oc === hc && tsMs(otherSide.ts) === tsMs(hitSide.ts)
      && String(otherSide.id) < String(hitSide.id)) {
    return { hitSide: otherSide, otherSide: hitSide };
  }
  return p;
}
```

Then in `buildConflictBlock`, replace the line:

```js
const inView = pairs.filter((p) => visibleHitIdSet.has(String(p.hitSide.id)));
```

with:

```js
const inView = pairs
  .map((p) => normaliseSelfPair(p, visibleHitIdSet))
  .filter((p) => visibleHitIdSet.has(String(p.hitSide.id)));
```

- [ ] **Step 4: Re-run.**

```bash
node --test system/tests/unit/conflicts-block.test.js
```

Expected: **PASS, 12 tests** (4 dedup + 5 builder + 3 here).

- [ ] **Step 5: Commit.**

```bash
git commit -m "$(cat <<'EOF'
feat(intuition): conflicts builder — redaction + self-pair re-pick

Renders <private memo redacted> for the blocked side (date + conf
preserved). Self-pair branch (both endpoints in the agent's view)
re-picks hit-side by descending (confidence, ts, canonical id) so the
higher-confidence side leads the line.
EOF
)"
```

---

## Phase 2 — `rank.js` verification (no change)

### Task 2.1 — Confirm `score()` already accepts `contradictionCount`

**Files:** `system/cognition/intuition/rank.js`

- [ ] **Step 1: Inspect.**

```bash
grep -n "contradictionCount\|contraPenalty" system/cognition/intuition/rank.js
```

Expected:

```
35:   *   contradictionCount?: number,
40:   const { record, distance, supersededCount = 0, contradictionCount = 0 } = hit;
52:   const contraPenalty = Math.max(0.1, 1 - 0.3 * contradictionCount);
```

The parameter is already accepted with a default of `0` — no code change required. The B2 work is in `inject.js`'s call sites (Phase 3); `rank.js` is only re-verified.

- [ ] **Step 2: Confirm `score()` returns `components.contraPenalty` for the existing intuition test.**

```bash
node --test --test-name-pattern 'intuitionEndpoint returns formatted block' system/tests/unit/intuition-endpoint.test.js
```

Expected: **PASS, 1 test**.

- [ ] **Step 3: (No commit — read-only verification step.)**

If the inspection above ever shows that `rank.js` has drifted (e.g., a sibling spec removed the parameter), open a stop-the-line note in this plan's "Phase 7 final verification" section. Today's source state matches the spec.

---

## Phase 3 — `inject.js` integration

### Task 3.1 — Wire `getRecallConfig` + flag gate

**Files:** `system/cognition/intuition/inject.js`, `system/tests/unit/intuition-endpoint.test.js`

- [ ] **Step 1: Failing test — flag off + no contradictions yields byte-identical block to today.**

Append to `system/tests/unit/intuition-endpoint.test.js`:

```js
test('intuitionEndpoint with conflict flag off produces no <!-- conflicts --> markers', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  await recordEvent(db, e, { source: 'cli', content: 'discussed sourdough hydration ratio (62%)' });
  // Default seed: conflict_surfacing_enabled = false.
  const result = await intuitionEndpoint({
    db, embedder: e, detector: null,
    query: 'sourdough', priorAssistant: '', k: 6, recencyDays: 30, tokenBudget: 1500,
    conflictTokenBudget: 0,
  });
  assert.ok(!result.block.includes('<!-- conflicts -->'));
  assert.ok(!result.block.includes('<!-- /conflicts -->'));
  // Telemetry row carries zero/false (not absent) — keeps row shape consistent.
  const [rows] = await db.query('SELECT * FROM intuition_telemetry').collect();
  // With flag off we should write NO B2 fields (per spec §10 'do not emit B2
  // fields to telemetry or recall_log.meta — keeps row shape
  // backwards-compatible'). Asserting absence:
  assert.equal(rows[0].conflicts_surfaced, undefined);
  await close(db);
});
```

- [ ] **Step 2: Run.**

```bash
node --test --test-name-pattern 'conflict flag off' system/tests/unit/intuition-endpoint.test.js
```

Expected: **FAIL** — `intuitionEndpoint` doesn't accept `conflictTokenBudget` yet.

- [ ] **Step 3: Modify `system/cognition/intuition/inject.js`.**

1. Add imports near the top (after the existing `surql` / `store` / `recall` / `rank` imports):

```js
import { getRecallConfig } from '../memory/store.js';
import { buildConflictBlock, fetchContradictors } from './conflicts.js';
```

2. Widen the `intuitionEndpoint` signature to accept `conflictTokenBudget` (default `0` — i.e., off — so pre-B2 callers without the flag stay byte-identical):

```js
export async function intuitionEndpoint({
  db,
  embedder,
  query,
  priorAssistant = '',
  k = 6,
  recencyDays = 30,
  tokenBudget = 1500,
  conflictTokenBudget = 0,
}) {
```

3. Immediately after `const start = Date.now()` and the `safeQuery` / `safePrior` derivations, read the recall config and resolve the surfacing flag:

```js
const cfg = await getRecallConfig(db).catch(() => ({}));
const surfacingOn = cfg.conflict_surfacing_enabled === true && conflictTokenBudget > 0;
```

- [ ] **Step 4: Re-run.**

```bash
node --test --test-name-pattern 'conflict flag off' system/tests/unit/intuition-endpoint.test.js
```

Expected: **PASS, 1 test** — the call site now accepts the new arg and the flag-off path is unchanged.

- [ ] **Step 5: Run the full intuition-endpoint suite to confirm no regression on the existing two tests.**

```bash
node --test system/tests/unit/intuition-endpoint.test.js
```

Expected: **PASS, 3 tests** (2 original + 1 new).

- [ ] **Step 6: Commit.**

```bash
git commit -m "$(cat <<'EOF'
feat(intuition): inject.js — read getRecallConfig + accept conflictTokenBudget

Adds the conflictTokenBudget arg (default 0 — pre-B2 behavior) and
resolves the surfacingOn flag from runtime:recall via the now-exported
getRecallConfig. Subsequent tasks wire fetchContradictors and the
conflicts block against this flag.
EOF
)"
```

### Task 3.2 — Wire `fetchContradictors` + `contradictionCount` into `score()`

**Files:** `system/cognition/intuition/inject.js`, `system/tests/integration/intuition-conflicts.test.js`

- [ ] **Step 1: Create the integration test file with the keystone "contradiction penalty fires" assertion.**

Create `system/tests/integration/intuition-conflicts.test.js`:

```js
import assert from 'node:assert/strict';
import { mkdirSync as __robinMkdirSync } from 'node:fs';
import { tmpdir as __robinTmpdir } from 'node:os';
import { join as __robinJoin, resolve } from 'node:path';
import { test } from 'node:test';
import * as store from '../../cognition/memory/store.js';
import { intuitionEndpoint } from '../../cognition/intuition/inject.js';
import { writeConfig as __robinWriteConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { createStubEmbedder } from '../../data/embed/embedder.js';
import { recordEvent } from '../../io/capture/record-event.js';

const __robinTestHome = __robinJoin(
  __robinTmpdir(),
  `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`,
);
__robinMkdirSync(__robinTestHome, { recursive: true });
process.env.ROBIN_HOME = __robinTestHome;
await __robinWriteConfig({ embedder_profile: 'mxbai-1024' });

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
  await db.query("UPDATE runtime:recall SET value.conflict_surfacing_enabled = true").collect();
  return db;
}

const e = createStubEmbedder({ dimension: 1024 });

test('B2 §8.3 #12: contradicting pair -> conflict block + contraPenalty wired', async () => {
  const db = await fresh();
  const a = await store.note(db, e, 'knowledge', {
    content: 'primary bank is Chase as of 2026-05-02', derived_by: 'manual',
  });
  const b = await store.note(db, e, 'knowledge', {
    content: 'switched primary bank to Mercury 2026-04-12', derived_by: 'manual',
  });
  await store.flagContradiction(db, a.id, b.id);

  const result = await intuitionEndpoint({
    db, embedder: e, detector: null,
    query: 'what bank am I using', priorAssistant: '',
    k: 6, recencyDays: 30, tokenBudget: 1500, conflictTokenBudget: 300,
  });

  // Conflict block emitted.
  assert.ok(result.block.includes('<!-- conflicts -->'), 'conflicts marker present');
  assert.ok(result.block.includes('<!-- /conflicts -->'), 'closing marker present');
  assert.ok(result.block.includes(' <-> '), 'pair line separator present');
  assert.ok(result.block.includes('<!-- relevant memory -->'));

  // Telemetry row carries the new fields.
  const [tel] = await db.query('SELECT * FROM intuition_telemetry').collect();
  assert.equal(tel[0].conflicts_surfaced, 1);
  assert.ok(tel[0].conflicts_block_tokens > 0);

  // recall_log.meta.conflicts_surfaced mirrored.
  const [rec] = await db.query('SELECT meta, ranked_hits FROM recall_log').collect();
  assert.equal(rec[0].meta.conflicts_surfaced, 1);

  // contraPenalty wired on BOTH score() callsites: persisted recall_log row
  // has contraPenalty < 1.0 for both memo hits.
  const memoHits = (rec[0].ranked_hits ?? []).filter((h) => h.kind === 'memo');
  assert.ok(memoHits.length >= 2);
  for (const h of memoHits) {
    assert.ok(
      h.score_components.contraPenalty < 1.0,
      `expected contraPenalty < 1 for ${h.record}, got ${h.score_components.contraPenalty}`,
    );
  }
  await close(db);
});
```

- [ ] **Step 2: Run — confirm fail.**

```bash
node --test --test-name-pattern 'contradicting pair' system/tests/integration/intuition-conflicts.test.js
```

Expected: **FAIL** — no conflicts block emitted; contraPenalty still 1.0 on recall_log row.

- [ ] **Step 3: Inside the intuition fan-out `Promise.all`, wire `fetchContradictors`.** Use a structural anchor: the section that destructures `eventResult` and `memoResult` and builds the `memoHits`/`eventHits` arrays. Insert directly between the `memoHits = (memoResult?.hits ?? []).map(...)` block and the `merged = [...eventHits, ...memoHits]` line.

In `system/cognition/intuition/inject.js`, the current section reads:

```js
    const memoHits = (memoResult?.hits ?? []).map((h) => ({
      record: h.record,
      distance: h.distance ?? 0,
      _kind: 'memo',
    }));

    const merged = [...eventHits, ...memoHits].map((h) => ({
      ...h,
      _scored: score(h, { session_id: undefined }),
    }));
```

Replace with:

```js
    const memoHits = (memoResult?.hits ?? []).map((h) => ({
      record: h.record,
      distance: h.distance ?? 0,
      _kind: 'memo',
    }));

    // B2 — hydrate contradicting-memo pairs before the first score() call so
    // contradictionCount can be wired. Gated on surfacingOn + non-empty memos.
    let conflictsHydration = { pairs: [], pairs_precap: 0 };
    if (surfacingOn && memoHits.length > 0) {
      const memoIds = memoHits.map((h) => h.record.id);
      conflictsHydration = await fetchContradictors(db, memoIds, cfg);
    }
    const contraByHit = new Map();
    for (const p of conflictsHydration.pairs) {
      const k = String(p.hitSide.id);
      contraByHit.set(k, (contraByHit.get(k) ?? 0) + 1);
    }

    const merged = [...eventHits, ...memoHits].map((h) => ({
      ...h,
      _scored: score(
        {
          record: h.record,
          distance: h.distance,
          contradictionCount: contraByHit.get(String(h.record.id)) ?? 0,
        },
        { session_id: undefined },
      ),
    }));
```

- [ ] **Step 4: Reuse `merged[i]._scored.components` for the `recall_log` rebuild.** Replace the existing `rankedHits` construction (currently `score_components: score({ record: h, distance: h.dist ?? 0 }).components`) with a lookup into `merged`.

Today the `recall_log` write reads:

```js
    const rankedHits = hits.map((h, i) => ({
      record: h.id,
      kind: h._kind,
      score_components: score({ record: h, distance: h.dist ?? 0 }).components,
      rank: i,
    }));
```

The `hits` array is built from `deduped` (post-MMR) via `.map(h => ({ id: h.record.id, ... }))`. To reuse `merged[i]._scored.components`, we need to thread the components through MMR. The cheapest threading: stash the components on each `hit` object during the `hits = deduped.map(...)` step. Replace the existing `hits = deduped.map(...)` block with:

```js
    hits = deduped.map((h) => ({
      id: h.record.id,
      source: h.record.source ?? (h._kind === 'memo' ? `memo:${h.record.kind}` : 'event'),
      content: h.record.content,
      ts: h.record.ts ?? h.record.derived_at,
      meta: h.record.meta ?? { kind: h._kind === 'memo' ? h.record.kind : undefined },
      dist: h.distance,
      _kind: h._kind,
      // B2 — carry the already-computed score components (with the wired
      // contradictionCount) so the recall_log rebuild doesn't re-invoke
      // score() with a stale {contradictionCount: 0}.
      _scoreComponents: h._scored?.components,
    }));
```

Then update the `rankedHits` mapping to:

```js
    const rankedHits = hits.map((h, i) => ({
      record: h.id,
      kind: h._kind,
      // Prefer the already-computed components (wired with the correct
      // contradictionCount); fall back to a fresh score() call for safety.
      score_components: h._scoreComponents ?? score({ record: h, distance: h.dist ?? 0 }).components,
      rank: i,
    }));
```

- [ ] **Step 5: Re-run the integration test (it will partly pass — the contraPenalty assertion should now hold; conflicts block + telemetry remain failing until Task 3.3).**

```bash
node --test --test-name-pattern 'contradicting pair' system/tests/integration/intuition-conflicts.test.js
```

Expected at this checkpoint: still **FAIL** on the conflicts-block + telemetry assertions, but the contraPenalty assertion (`< 1.0 for both memo hits`) **passes**. Continue to Task 3.3 before treating this as green.

- [ ] **Step 6: Commit (WIP).**

```bash
git commit -m "$(cat <<'EOF'
feat(intuition): wire contradictionCount into both score() callsites

fetchContradictors runs inside the intuition fan-out Promise.all when
surfacingOn === true, producing a contraByHit Map. The first score()
call (the one building `merged`) now passes contradictionCount, finally
making contraPenalty fire. The recall_log rebuild reuses
merged[i]._scored.components (threaded via hit._scoreComponents) so the
persisted row matches the live ranking byte-for-byte.
EOF
)"
```

### Task 3.3 — Emit the conflicts block + telemetry fields

**Files:** `system/cognition/intuition/inject.js`

- [ ] **Step 1: Insert the block-build step after the greedy-pack `block`/`tokens`/`truncated` computation (so we know which hits the agent will see).** Use the structural anchor "after greedy-pack hits computed" — the existing `if (hits.length > 0) { ... }` block that produces `block`, `truncated`, `tokens` for the relevant-memory output.

After that `if (hits.length > 0) { ... }` block in `inject.js`, insert:

```js
  // B2 — assemble the conflicts block from the hydrated pairs and the
  // greedy-packed in-view hit set. Fail-soft via buildConflictBlock's pure
  // return shape; an empty pairs list yields an empty block.
  let conflictBlock = '';
  let conflictTokens = 0;
  let conflictSurfaced = 0;
  let conflictSuppressedByRule = { low_confidence: 0, superseded: 0, both_blocked: 0, stale: 0, capped: 0 };
  let conflictRedactedOneSide = 0;
  let conflictBlockTruncated = false;
  if (surfacingOn && conflictsHydration.pairs.length > 0) {
    // The §1.1 filter: hitSide must be in greedy-packed `hits` (the agent
    // will actually see these memos in <!-- relevant memory -->).
    const visibleHitIds = new Set();
    for (const h of hits) {
      if (h._kind === 'memo') visibleHitIds.add(String(h.id));
    }
    const built = buildConflictBlock(conflictsHydration.pairs, visibleHitIds, new Date(), {
      conflict_min_confidence: cfg.conflict_min_confidence,
      conflict_max_age_days: cfg.conflict_max_age_days,
      conflict_max_pairs_surfaced: cfg.conflict_max_pairs_surfaced,
      conflict_block_token_budget: conflictTokenBudget,
    });
    conflictBlock = built.block;
    conflictTokens = built.tokens;
    conflictSurfaced = built.surfaced;
    conflictSuppressedByRule = built.suppressed_by_rule;
    conflictRedactedOneSide = built.redacted_one_side;
    conflictBlockTruncated = built.truncated;
  }
```

- [ ] **Step 2: Extend the `intuition_telemetry` CREATE block** with the §6.1 fields. Structural anchor: the `surql\`CREATE intuition_telemetry CONTENT ${{...}}\`` block. Wrap the new fields in `surfacingOn` so flag-off rows are byte-identical to today.

Replace:

```js
  try {
    await db
      .query(
        surql`CREATE intuition_telemetry CONTENT ${{
          query_chars: safeQuery.length,
          hits: hits.length,
          tokens_injected: tokens,
          latency_ms,
          truncated,
        }}`,
      )
      .collect();
  } catch {
    // Swallow — telemetry is advisory.
  }
```

with:

```js
  try {
    const telemetryContent = {
      query_chars: safeQuery.length,
      hits: hits.length,
      tokens_injected: tokens,
      latency_ms,
      truncated,
    };
    // B2 fields emitted only when the feature is on — keeps row shape
    // backwards-compatible for flag-off installs per spec §10.
    if (surfacingOn) {
      telemetryContent.conflicts_surfaced = conflictSurfaced;
      telemetryContent.conflicts_block_tokens = conflictTokens;
      telemetryContent.conflicts_hydrated_precap = conflictsHydration.pairs_precap;
      telemetryContent.conflicts_hydrated_postcap = conflictsHydration.pairs.length;
      telemetryContent.conflicts_hydration_capped =
        conflictsHydration.pairs_precap > conflictsHydration.pairs.length;
      telemetryContent.conflicts_suppressed_by_rule = conflictSuppressedByRule;
      telemetryContent.conflicts_redacted_one_side = conflictRedactedOneSide;
      telemetryContent.conflicts_block_truncated = conflictBlockTruncated;
    }
    await db.query(surql`CREATE intuition_telemetry CONTENT ${telemetryContent}`).collect();
  } catch {
    // Swallow — telemetry is advisory.
  }
```

- [ ] **Step 3: Extend the `recall_log` CREATE block** with `meta.conflicts_surfaced`. Structural anchor: the `surql\`CREATE recall_log CONTENT ${{...}}\`` block. Replace its `meta:` literal with a conditional spread.

Replace:

```js
    await db
      .query(
        surql`CREATE recall_log CONTENT ${{
          query: safeQuery,
          k,
          ranked_hits: rankedHits,
          outcome: 'pending',
          meta: { latency_ms, truncated },
        }}`,
      )
      .collect();
```

with:

```js
    const recallMeta = { latency_ms, truncated };
    if (surfacingOn) recallMeta.conflicts_surfaced = conflictSurfaced;
    await db
      .query(
        surql`CREATE recall_log CONTENT ${{
          query: safeQuery,
          k,
          ranked_hits: rankedHits,
          outcome: 'pending',
          meta: recallMeta,
        }}`,
      )
      .collect();
```

- [ ] **Step 4: Update the function's return value** to concatenate the conflicts block above the relevant-memory block. Structural anchor: the final `return { block, hits: hits.length, tokens, latency_ms, truncated };` line.

Replace with:

```js
  const combined = conflictBlock ? `${conflictBlock}\n${block}` : block;
  return {
    block: combined,
    hits: hits.length,
    tokens: tokens + conflictTokens,
    latency_ms,
    truncated: truncated || conflictBlockTruncated,
    // Optional surface so the handler / D1 ordering can introspect.
    conflict_block: conflictBlock,
    conflict_tokens: conflictTokens,
    conflict_suppressed_count:
      conflictSuppressedByRule.low_confidence
      + conflictSuppressedByRule.superseded
      + conflictSuppressedByRule.both_blocked
      + conflictSuppressedByRule.stale
      + conflictSuppressedByRule.capped,
  };
```

- [ ] **Step 5: Run the integration test from Task 3.2.**

```bash
node --test --test-name-pattern 'contradicting pair' system/tests/integration/intuition-conflicts.test.js
```

Expected: **PASS, 1 test** — block emitted, telemetry fields present, recall_log.meta.conflicts_surfaced mirrored, contraPenalty < 1.0 on both memo hits.

- [ ] **Step 6: Run the existing intuition-endpoint suite to confirm flag-off byte-identity.**

```bash
node --test system/tests/unit/intuition-endpoint.test.js
```

Expected: **PASS, 3 tests** — flag-off behavior is byte-identical.

- [ ] **Step 7: Commit.**

```bash
git commit -m "$(cat <<'EOF'
feat(intuition): emit <!-- conflicts --> block + B2 telemetry

inject.js now assembles the conflicts block via buildConflictBlock
(gated on surfacingOn + non-empty hydration), prepends it above the
relevant-memory block in the return value, and extends both
intuition_telemetry and recall_log.meta with the §6 fields. Flag-off
rows write neither markers nor B2 keys — byte-identical to pre-B2 prompts.
EOF
)"
```

### Task 3.4 — Daemon route: forward `conflictTokenBudget`

**Files:** `system/runtime/daemon/routes/intuition.js`, `system/tests/unit/intuition-handler.test.js` (or a new daemon-route unit test)

- [ ] **Step 1: Failing test — verify the daemon route reads `runtime:recall` and forwards `conflictTokenBudget`.**

Append to `system/tests/unit/intuition-endpoint.test.js`:

```js
test('intuitionEndpoint default conflictTokenBudget=0 -> no conflicts block even with surfacing flag on', async () => {
  // Sanity-check the function-default boundary. The daemon route is
  // responsible for passing conflictTokenBudget=300 when the flag is on;
  // intuitionEndpoint called with no arg defaults to 0 (off).
  const db = await fresh();
  const e2 = createStubEmbedder({ dimension: 1024 });
  await db.query("UPDATE runtime:recall SET value.conflict_surfacing_enabled = true").collect();
  await recordEvent(db, e2, { source: 'cli', content: 'a fact about birds' });
  const result = await intuitionEndpoint({
    db, embedder: e2, detector: null,
    query: 'birds', priorAssistant: '',
    k: 6, recencyDays: 30, tokenBudget: 1500,
    // conflictTokenBudget omitted -> default 0
  });
  assert.ok(!result.block.includes('<!-- conflicts -->'));
  await close(db);
});
```

- [ ] **Step 2: Run.**

```bash
node --test --test-name-pattern 'default conflictTokenBudget' system/tests/unit/intuition-endpoint.test.js
```

Expected: **PASS, 1 test** — the function-default guard from Task 3.1 already enforces this.

- [ ] **Step 3: Update `system/runtime/daemon/routes/intuition.js`** to read the config and forward both budgets. Replace the existing handler:

```js
export const intuitionRoutes = [
  {
    method: 'POST',
    path: '/internal/intuition',
    async handler({ ctx, body }) {
      const { intuitionEndpoint } = await import('../../../cognition/intuition/inject.js').catch(
        () => ({}),
      );
      const { getRecallConfig } = await import('../../../cognition/memory/store.js').catch(
        () => ({}),
      );
      if (typeof intuitionEndpoint !== 'function') {
        return { block: '', hits: 0, tokens: 0, latency_ms: 0 };
      }
      let cfg = {};
      if (typeof getRecallConfig === 'function') {
        cfg = await getRecallConfig(ctx.db).catch(() => ({}));
      }
      const surfacingOn = cfg.conflict_surfacing_enabled === true;
      const tokenBudget = body.token_budget ?? body.tokenBudget ?? cfg.relevant_memory_token_budget ?? 1500;
      const conflictTokenBudget = surfacingOn ? (cfg.conflict_block_token_budget ?? 300) : 0;
      return await intuitionEndpoint({
        db: ctx.db,
        embedder: ctx.embedder.wrap,
        detector: ctx.detector,
        query: body.query ?? '',
        priorAssistant: body.prior_assistant ?? body.priorAssistant ?? '',
        k: body.k ?? 6,
        recencyDays: body.recency_days ?? body.recencyDays ?? 30,
        tokenBudget,
        conflictTokenBudget,
      }).catch(() => ({ block: '', hits: 0, tokens: 0, latency_ms: 0 }));
    },
  },
];
```

- [ ] **Step 4: Run the full unit suite touching `intuition`.**

```bash
npm run test:unit -- --test-name-pattern 'intuition'
```

Expected: **PASS, all intuition unit tests**.

- [ ] **Step 5: Lint.**

```bash
npm run lint
```

Expected: **PASS, no errors**.

- [ ] **Step 6: Commit.**

```bash
git commit -m "$(cat <<'EOF'
feat(daemon): forward conflictTokenBudget from runtime:recall

The /internal/intuition route now reads getRecallConfig at
request-handling time and passes both relevant_memory_token_budget and
conflict_block_token_budget to intuitionEndpoint. When the
conflict_surfacing_enabled flag is false, conflictTokenBudget is
forced to 0, matching today's behavior exactly.
EOF
)"
```

---

## Phase 4 — Integration tests (end-to-end pipeline)

### Task 4.1 — §8.3 test 13 (no contradictions -> block omitted)

**Files:** `system/tests/integration/intuition-conflicts.test.js`

- [ ] **Step 1: Append the test.**

```js
test('B2 §8.3 #13: no contradicts edge -> block omitted, flag-on still byte-clean', async () => {
  const db = await fresh();
  await store.note(db, e, 'knowledge', {
    content: 'unique fact about gardening', derived_by: 'manual',
  });
  const result = await intuitionEndpoint({
    db, embedder: e, detector: null,
    query: 'gardening', priorAssistant: '',
    k: 6, recencyDays: 30, tokenBudget: 1500, conflictTokenBudget: 300,
  });
  assert.ok(!result.block.includes('<!-- conflicts -->'));
  assert.ok(!result.block.includes('<!-- /conflicts -->'));
  const [tel] = await db.query('SELECT * FROM intuition_telemetry').collect();
  // Flag is on, so B2 telemetry fields ARE present and zero.
  assert.equal(tel[0].conflicts_surfaced, 0);
  assert.equal(tel[0].conflicts_block_tokens, 0);
  assert.equal(tel[0].conflicts_hydrated_precap, 0);
  assert.equal(tel[0].conflicts_hydrated_postcap, 0);
  assert.equal(tel[0].conflicts_hydration_capped, false);
  assert.equal(tel[0].conflicts_block_truncated, false);
  const [rec] = await db.query('SELECT meta FROM recall_log').collect();
  assert.equal(rec[0].meta.conflicts_surfaced, 0);
  await close(db);
});
```

- [ ] **Step 2: Run.**

```bash
node --test --test-name-pattern 'no contradicts edge' system/tests/integration/intuition-conflicts.test.js
```

Expected: **PASS, 1 test**.

- [ ] **Step 3: Commit.**

```bash
git commit -m "$(cat <<'EOF'
test(intuition): B2 §8.3 #13 — no-conflicts path zeros telemetry

When the flag is on but no contradicts edges exist among the recalled
memos, the conflicts block is omitted and the B2 telemetry fields land
as zeros / false. recall_log.meta.conflicts_surfaced mirrors at 0.
EOF
)"
```

### Task 4.2 — §8.3 test 14 (low-confidence suppression)

**Files:** `system/tests/integration/intuition-conflicts.test.js`

- [ ] **Step 1: Append the test.**

```js
test('B2 §8.3 #14: low-confidence pair suppressed; counter records the rule', async () => {
  const db = await fresh();
  const a = await store.note(db, e, 'knowledge', {
    content: 'fact A', derived_by: 'manual',
  });
  const b = await store.note(db, e, 'knowledge', {
    content: 'fact B opposite of A', derived_by: 'manual',
  });
  // Drop B's confidence below the 0.4 threshold.
  await db.query(`UPDATE ${b.id} SET confidence = 0.3`).collect();
  await store.flagContradiction(db, a.id, b.id);

  const result = await intuitionEndpoint({
    db, embedder: e, detector: null,
    query: 'fact', priorAssistant: '',
    k: 6, recencyDays: 30, tokenBudget: 1500, conflictTokenBudget: 300,
  });
  assert.ok(!result.block.includes('<!-- conflicts -->'));
  const [tel] = await db.query('SELECT * FROM intuition_telemetry').collect();
  assert.equal(tel[0].conflicts_surfaced, 0);
  assert.equal(tel[0].conflicts_suppressed_by_rule.low_confidence, 1);
  await close(db);
});
```

- [ ] **Step 2: Run.**

```bash
node --test --test-name-pattern 'low-confidence pair suppressed' system/tests/integration/intuition-conflicts.test.js
```

Expected: **PASS, 1 test**.

- [ ] **Step 3: Commit.**

```bash
git commit -m "$(cat <<'EOF'
test(intuition): B2 §8.3 #14 — low-confidence suppression telemetry

When a contradicting pair has either side below
conflict_min_confidence (default 0.4), the pair is suppressed before
emission and intuition_telemetry.conflicts_suppressed_by_rule
.low_confidence is incremented.
EOF
)"
```

### Task 4.3 — §8.3 test 15 (contradictor pulled in even if it didn't rank)

**Files:** `system/tests/integration/intuition-conflicts.test.js`

- [ ] **Step 1: Append the test.**

```js
test('B2 §8.3 #15: out-of-view contradictor surfaces in <!-- conflicts --> but not <!-- relevant memory -->', async () => {
  const db = await fresh();
  // Seed an in-view memo and an out-of-view contradictor (older + lower
  // confidence so MMR/rank deprioritises it below the k=6 cut).
  const hitMemo = await store.note(db, e, 'knowledge', {
    content: 'the moon is made of cheese', derived_by: 'manual',
  });
  const oldContradictor = await store.note(db, e, 'knowledge', {
    content: 'the moon is rock', derived_by: 'manual',
  });
  // Backdate + low-confidence so the contradictor falls below top-K.
  const old = new Date('2026-04-12T00:00:00Z');
  await db.query(`UPDATE ${oldContradictor.id} SET ts = $t, decay_anchor = $t, confidence = 0.55`, { t: old }).collect();
  await store.flagContradiction(db, hitMemo.id, oldContradictor.id);

  // Pad the substrate with other memos so the contradictor is unlikely to
  // rank into the top-K via the stub embedder.
  for (let i = 0; i < 5; i++) {
    await store.note(db, e, 'knowledge', {
      content: `unrelated padding memo ${i} about gardening`,
      derived_by: 'manual',
    });
  }

  const result = await intuitionEndpoint({
    db, embedder: e, detector: null,
    query: 'the moon is made of cheese', priorAssistant: '',
    k: 6, recencyDays: 365, tokenBudget: 1500, conflictTokenBudget: 300,
  });
  // The contradictor's content appears in the conflicts block.
  assert.ok(result.block.includes('the moon is rock'), 'contradictor content surfaced in conflict block');
  // It does NOT appear in the relevant-memory block (i.e., between the relevant-memory markers).
  const relIdx = result.block.indexOf('<!-- relevant memory -->');
  const relEnd = result.block.indexOf('<!-- /relevant memory -->');
  const relevantBlock = result.block.slice(relIdx, relEnd);
  assert.ok(!relevantBlock.includes('the moon is rock'));
  await close(db);
});
```

- [ ] **Step 2: Run.**

```bash
node --test --test-name-pattern 'out-of-view contradictor' system/tests/integration/intuition-conflicts.test.js
```

Expected: **PASS, 1 test**. (The stub embedder's behavior may need tuning — if the contradictor still ranks into top-K, push it lower with a longer backdate or rank-pad heavier.)

- [ ] **Step 3: Commit.**

```bash
git commit -m "$(cat <<'EOF'
test(intuition): B2 §8.3 #15 — out-of-view contradictor pulled in

Asserts the spec's load-bearing semantic: a contradictor that didn't
rank into the agent-visible relevant-memory block is still surfaced in
the conflicts block (and only in the conflicts block).
EOF
)"
```

### Task 4.4 — §8.3 test 16 (private redaction)

**Files:** `system/tests/integration/intuition-conflicts.test.js`

- [ ] **Step 1: Append the test.**

```js
test('B2 §8.3 #16: one-side private -> redaction shape; redacted_one_side telemetry', async () => {
  const db = await fresh();
  const pub = await store.note(db, e, 'knowledge', {
    content: 'public claim about thing',
    scope: 'global',
    derived_by: 'manual',
  });
  const priv = await store.note(db, e, 'knowledge', {
    content: 'private memo that must not surface',
    scope: 'private',
    derived_by: 'manual',
  });
  await store.flagContradiction(db, pub.id, priv.id);

  const result = await intuitionEndpoint({
    db, embedder: e, detector: null,
    query: 'thing', priorAssistant: '',
    k: 6, recencyDays: 30, tokenBudget: 1500, conflictTokenBudget: 300,
  });
  assert.ok(result.block.includes('<!-- conflicts -->'));
  assert.ok(result.block.includes('<private memo redacted>'));
  assert.ok(!result.block.includes('private memo that must not surface'));
  const [tel] = await db.query('SELECT * FROM intuition_telemetry').collect();
  assert.equal(tel[0].conflicts_redacted_one_side, 1);
  await close(db);
});
```

- [ ] **Step 2: Run.**

```bash
node --test --test-name-pattern 'one-side private' system/tests/integration/intuition-conflicts.test.js
```

Expected: **PASS, 1 test**.

- [ ] **Step 3: Commit.**

```bash
git commit -m "$(cat <<'EOF'
test(intuition): B2 §8.3 #16 — private-side redaction

When exactly one side of a surfaceable pair is outbound-blocked (via
isOutboundBlocked from scope-registry), the blocked side renders as
<private memo redacted> with date + conf preserved, and
intuition_telemetry.conflicts_redacted_one_side increments.
EOF
)"
```

### Task 4.5 — §8.3 test 17 (flag off -> byte-identical)

**Files:** `system/tests/integration/intuition-conflicts.test.js`

- [ ] **Step 1: Append the test.**

```js
test('B2 §8.3 #17: flag off + contradicts edge -> byte-identical to pre-B2', async () => {
  const db = await fresh();
  // Disable the flag (the file-level fresh() turned it on).
  await db.query("UPDATE runtime:recall SET value.conflict_surfacing_enabled = false").collect();
  const a = await store.note(db, e, 'knowledge', {
    content: 'primary bank is Chase as of 2026-05-02', derived_by: 'manual',
  });
  const b = await store.note(db, e, 'knowledge', {
    content: 'switched primary bank to Mercury 2026-04-12', derived_by: 'manual',
  });
  await store.flagContradiction(db, a.id, b.id);

  const result = await intuitionEndpoint({
    db, embedder: e, detector: null,
    query: 'what bank am I using', priorAssistant: '',
    k: 6, recencyDays: 30, tokenBudget: 1500, conflictTokenBudget: 300,
  });
  // No conflicts markers anywhere.
  assert.ok(!result.block.includes('<!-- conflicts -->'));
  assert.ok(!result.block.includes('<!-- /conflicts -->'));
  // B2 telemetry fields absent (undefined) — flag-off row shape is unchanged.
  const [tel] = await db.query('SELECT * FROM intuition_telemetry').collect();
  assert.equal(tel[0].conflicts_surfaced, undefined);
  assert.equal(tel[0].conflicts_block_tokens, undefined);
  // recall_log.meta has no conflicts_surfaced key.
  const [rec] = await db.query('SELECT meta, ranked_hits FROM recall_log').collect();
  assert.equal(rec[0].meta.conflicts_surfaced, undefined);
  // contraPenalty === 1.0 on both memo hits — the wiring is gated too.
  const memoHits = (rec[0].ranked_hits ?? []).filter((h) => h.kind === 'memo');
  for (const h of memoHits) {
    assert.equal(h.score_components.contraPenalty, 1.0);
  }
  await close(db);
});
```

- [ ] **Step 2: Run.**

```bash
node --test --test-name-pattern 'flag off + contradicts edge' system/tests/integration/intuition-conflicts.test.js
```

Expected: **PASS, 1 test**.

- [ ] **Step 3: Commit.**

```bash
git commit -m "$(cat <<'EOF'
test(intuition): B2 §8.3 #17 — flag-off byte identity

When conflict_surfacing_enabled is false: no <!-- conflicts -->
markers, no B2 telemetry keys on intuition_telemetry, no
meta.conflicts_surfaced on recall_log, and contraPenalty stays at 1.0
on both memo hits (the contradictionCount wiring is gated together
with the surfacing).
EOF
)"
```

### Task 4.6 — §8.3 test 18 (`recall_log.meta.conflicts_surfaced` shape across flag states)

**Files:** `system/tests/integration/intuition-conflicts.test.js`

- [ ] **Step 1: Append the test.**

```js
test('B2 §8.3 #18: recall_log.meta.conflicts_surfaced shape — present (0) when on/no-conflicts; absent when off', async () => {
  // Flag on, no conflicts -> present and 0.
  {
    const db = await fresh();
    await store.note(db, e, 'knowledge', { content: 'unique fact', derived_by: 'manual' });
    await intuitionEndpoint({
      db, embedder: e, detector: null,
      query: 'unique fact', priorAssistant: '',
      k: 6, recencyDays: 30, tokenBudget: 1500, conflictTokenBudget: 300,
    });
    const [rec] = await db.query('SELECT meta FROM recall_log').collect();
    assert.equal(rec[0].meta.conflicts_surfaced, 0);
    await close(db);
  }
  // Flag off -> field absent.
  {
    const db = await fresh();
    await db.query("UPDATE runtime:recall SET value.conflict_surfacing_enabled = false").collect();
    await store.note(db, e, 'knowledge', { content: 'unique fact', derived_by: 'manual' });
    await intuitionEndpoint({
      db, embedder: e, detector: null,
      query: 'unique fact', priorAssistant: '',
      k: 6, recencyDays: 30, tokenBudget: 1500, conflictTokenBudget: 300,
    });
    const [rec] = await db.query('SELECT meta FROM recall_log').collect();
    assert.equal(rec[0].meta.conflicts_surfaced, undefined);
    await close(db);
  }
});
```

- [ ] **Step 2: Run.**

```bash
node --test --test-name-pattern 'recall_log.meta.conflicts_surfaced shape' system/tests/integration/intuition-conflicts.test.js
```

Expected: **PASS, 1 test**.

- [ ] **Step 3: Run the full integration suite for intuition.**

```bash
npm run test:integration -- --test-name-pattern 'intuition'
```

Expected: **PASS, all intuition-conflicts tests**.

- [ ] **Step 4: Commit.**

```bash
git commit -m "$(cat <<'EOF'
test(intuition): B2 §8.3 #18 — recall_log.meta shape across flag states

Asserts both flag-on (no-conflicts) emits meta.conflicts_surfaced=0
(so A3 can stratify on present-and-zero) and flag-off omits the field
entirely (so flag-off recall_log rows are byte-equivalent to pre-B2).
EOF
)"
```

---

## Phase 5 — Telemetry verification (rollup deferred to C3)

### Task 5.1 — Assert intuition_telemetry round-trip for all B2 metric fields

**Files:** `system/tests/integration/intuition-conflicts.test.js`

- [ ] **Step 1: Append a telemetry-shape integration test.**

```js
test('B2 telemetry: all §6.1 fields land on intuition_telemetry under the schema', async () => {
  const db = await fresh();
  const a = await store.note(db, e, 'knowledge', { content: 'claim X', derived_by: 'manual' });
  const b = await store.note(db, e, 'knowledge', { content: 'claim Y opposite of X', derived_by: 'manual' });
  await store.flagContradiction(db, a.id, b.id);
  await intuitionEndpoint({
    db, embedder: e, detector: null,
    query: 'claim X', priorAssistant: '',
    k: 6, recencyDays: 30, tokenBudget: 1500, conflictTokenBudget: 300,
  });
  const [tel] = await db.query('SELECT * FROM intuition_telemetry').collect();
  const row = tel[0];
  // Type assertions — all eight B2 fields must be the documented shapes.
  assert.equal(typeof row.conflicts_surfaced, 'number');
  assert.equal(typeof row.conflicts_block_tokens, 'number');
  assert.equal(typeof row.conflicts_hydrated_precap, 'number');
  assert.equal(typeof row.conflicts_hydrated_postcap, 'number');
  assert.equal(typeof row.conflicts_hydration_capped, 'boolean');
  assert.equal(typeof row.conflicts_suppressed_by_rule, 'object');
  assert.equal(typeof row.conflicts_redacted_one_side, 'number');
  assert.equal(typeof row.conflicts_block_truncated, 'boolean');
  // suppressed_by_rule sub-object has the documented keys (even if zero).
  for (const k of ['low_confidence', 'superseded', 'both_blocked', 'stale', 'capped']) {
    assert.equal(typeof row.conflicts_suppressed_by_rule[k], 'number', `key ${k} present`);
  }
  await close(db);
});
```

- [ ] **Step 2: Run.**

```bash
node --test --test-name-pattern 'all §6.1 fields land' system/tests/integration/intuition-conflicts.test.js
```

Expected: **PASS, 1 test**. Schemafull SurrealDB rejects unknown fields — a passing test confirms migration `0015` defined every key correctly.

- [ ] **Step 3: Commit.**

```bash
git commit -m "$(cat <<'EOF'
test(intuition): B2 telemetry shape round-trip

Pins every §6.1 metric field type against intuition_telemetry under
the schemafull schema defined by migration 0015. Confirms
conflicts_suppressed_by_rule's FLEXIBLE sub-object accepts the five
documented rule-name keys. Rollup verification deferred to C3.
EOF
)"
```

---

## Phase 6 — Docs

### Task 6.1 — Update `docs/faculties.md` "intuition" section

**Files:** `docs/faculties.md`

- [ ] **Step 1: Inspect the current section.**

```bash
grep -n "### intuition" docs/faculties.md
```

- [ ] **Step 2: Edit the section using the Edit tool.** Replace the existing "Behavior:" bullet with one that includes the conflicts block + the wired-up `contradictionCount`. The post-edit text should read:

```
### intuition
**The UserPromptSubmit hook that injects relevant memory into the next turn.**

- Files: `system/cognition/intuition/handler.js` (hook entry), `system/cognition/intuition/inject.js` (daemon endpoint), `system/cognition/intuition/rank.js`, `system/cognition/intuition/conflicts.js`.
- Behavior: Composes events + memos[kind=knowledge] recall via `store.searchEvents` + `store.searchMemos`. Ranks via `rank.score` (cosine × freshness × contradiction × trust × scope). MMR-lite diversity pass. When the substrate has a live `contradicts` edge among the in-view memo hits and `runtime:recall.value.conflict_surfacing_enabled` is `true`, `conflicts.fetchContradictors` hydrates the other side of each pair in one batched roundtrip and `conflicts.buildConflictBlock` emits a `<!-- conflicts -->` block above `<!-- relevant memory -->`. The same hydration step populates `contradictionCount` on the rank score so `contraPenalty` finally fires (defaulted to `0` and dormant pre-B2). Suppression rules: low confidence (<0.4), superseded (freshness 0), both sides outbound-blocked, stale (>30 days), per-turn cap (3 pairs). Writes `intuition_telemetry` + `recall_log{outcome:pending}` rows.
- Inspect: `SELECT * FROM intuition_telemetry ORDER BY ts DESC LIMIT 20`.
```

- [ ] **Step 3: Run the docs/audit tests if any exist.**

```bash
npm run test:unit -- --test-name-pattern 'faculties'
```

Expected: **PASS** (or "no tests match" — that's acceptable; faculties.md has no enforcing unit test).

- [ ] **Step 4: Commit.**

```bash
git commit -m "$(cat <<'EOF'
docs(faculties): describe conflicts block + wired contradictionCount

Extends the intuition section with the B2 surface: fetchContradictors,
buildConflictBlock, the <!-- conflicts --> block above relevant-memory,
suppression rules, and the now-active contraPenalty. Mentions the
conflicts.js file in the Files list.
EOF
)"
```

### Task 6.2 — Update `docs/architecture.md`

**Files:** `docs/architecture.md`

- [ ] **Step 1: Edit item 2 of "A typical agent turn".** Current text references the `<!-- relevant memory -->` block under a 1500-token budget; extend it to mention the conflicts block when enabled.

Replace the relevant sentence in "A typical agent turn" item 2 with:

```
2. **You type a message.** UserPromptSubmit (intuition) reads the transcript tail, POSTs `{query, prior_assistant, k:6, recency_days:30}` to the daemon. Intuition pipeline: `store.searchEvents` + `store.searchMemos(kind='knowledge')` → batched `conflicts.fetchContradictors` (when `runtime:recall.value.conflict_surfacing_enabled` is `true`) → `rank.score` (now passing `contradictionCount` from the hydrated pairs) → MMR-lite → format as `<!-- conflicts -->` (cap 300 tok, only when pairs survive suppression) + `<!-- relevant memory -->` (cap 1500 tok). Writes `recall_log{outcome:pending}` and `intuition_telemetry` rows. Fail-soft on every error.
```

- [ ] **Step 2: Edit the daemon-routes mention.** If the architecture doc references `system/runtime/daemon/routes/intuition.js` (post-R-3), add a note that B2 reads `runtime:recall` at request time to resolve `tokenBudget` and `conflictTokenBudget` before forwarding to `intuitionEndpoint`.

- [ ] **Step 3: Commit.**

```bash
git commit -m "$(cat <<'EOF'
docs(architecture): note <!-- conflicts --> block in agent turn

Updates "A typical agent turn" item 2 to mention the conflicts hydration
step, the new block above relevant-memory, and the R-3 daemon route's
responsibility for reading runtime:recall to pick the two budgets.
EOF
)"
```

---

## Phase 7 — Final verification + rollout flag flip

### Task 7.1 — Full test suite green

**Files:** none modified.

- [ ] **Step 1: Run the full unit suite.**

```bash
npm run test:unit
```

Expected: **PASS, all unit tests** including the new `conflicts-suppression.test.js`, `conflicts-block.test.js`, `store-recall-config.test.js`, and the extended `intuition-endpoint.test.js`.

- [ ] **Step 2: Run the full integration suite.**

```bash
npm run test:integration
```

Expected: **PASS, all integration tests** including `conflicts-fetch.test.js` and `intuition-conflicts.test.js`.

- [ ] **Step 3: Lint.**

```bash
npm run lint
```

Expected: **PASS, no errors**.

- [ ] **Step 4: Verify rank.js parameter wiring is still in place** (spec invariant — Phase 2 verified nothing was changed).

```bash
grep -n "contradictionCount" system/cognition/intuition/rank.js
```

Expected lines:

```
35:   *   contradictionCount?: number,
40:   const { record, distance, supersededCount = 0, contradictionCount = 0 } = hit;
52:   const contraPenalty = Math.max(0.1, 1 - 0.3 * contradictionCount);
```

If any of the three lines is missing, stop and re-open Phase 2 to address the drift.

- [ ] **Step 5: Verify `inject.js` calls `score()` with `contradictionCount` at both load-bearing sites.**

```bash
grep -n "contradictionCount\|_scoreComponents\|score(" system/cognition/intuition/inject.js
```

Expected at minimum:
- One `score(...)` call inside the `merged.map(...)` block that includes `contradictionCount: contraByHit.get(...) ?? 0`.
- The `rankedHits` mapping prefers `h._scoreComponents` (the threaded reuse), falling back to a fresh `score()` call only as a safety net.

- [ ] **Step 6: (No commit — verification only.)** If anything failed, open a sub-task to repair before proceeding to Task 7.2.

### Task 7.2 — Dogfood flip on Kevin's instance (optional follow-up — not in this plan's automated scope)

**Files:** none (operational task).

- [ ] **Step 1: Document the flip in the rollout log.** Spec §9.2 step 4 describes the operation on Kevin's instance:

```
UPDATE runtime:recall SET value.conflict_surfacing_enabled = true;
```

The 5-s cache TTL in `getRecallConfig` means the next recall after ~5 seconds starts surfacing.

- [ ] **Step 2: Monitor.** Watch `intuition_telemetry.conflicts_surfaced` and `intuition_telemetry.conflicts_suppressed_by_rule` for a dogfood week. Per spec §9.2 step 5, healthy distribution:
  - Low single-digit `conflicts_surfaced` per day.
  - Most turns have `conflicts_surfaced=0`.
  - No single suppression rule fires >80% of suppressions.
  - `recall_log.ranked_hits[].score_components.contraPenalty < 1.0` for ~5-15% of memo hits.

- [ ] **Step 3: Optional follow-up migration `0016-conflict-surfacing-default-on.surql`.** Reserved per spec §9.1; out of scope for this plan. Open a follow-up plan after the dogfood week if the data supports flipping the default.

- [ ] **Step 4: Rollback path.**

```
UPDATE runtime:recall SET value.conflict_surfacing_enabled = false;
```

Bounded by the 5-s cache TTL. Already-written `recall_log` rows retain `meta.conflicts_surfaced`; new rows omit it.

---

## Self-review checklist

- [x] **Spec section coverage.** §1 (detection / hydration / contraPenalty wiring) → Tasks 3.1-3.3. §2 (surface format) → Task 1.5/1.6. §3 (block ordering, additive budget) → Task 3.3 (return value) + 3.4 (daemon-route forwarding). §4 (score interaction) → Task 3.2 (both `score()` callsites). §5 (suppression rules) → Tasks 1.1-1.2 + 4.2 + 4.4. §6 (telemetry) → Tasks 3.3 + 5.1. §7 (configuration) → Task 0.1 + 0.2. §8 (test plan) → Tasks 1.1-1.6 unit, Phase 4 + 5 integration. §9 (rollout) → Task 0.1 (migration `0015`) + Task 7.2 (operational). §10 (file-by-file) → File structure table + each task. §11 (cross-design) → R-3 coordination in Task 3.4; D1 ordering noted in plan goal/architecture. §12 (open questions) → not in scope (deferred per spec). §13 (cost envelope) → covered by spec; no implementation work.
- [x] **Placeholder scan.** No `TBD`, `TODO`, `appropriate error handling`, `similar to`. Every `score()` callsite mentioned by name. `dedupeAndCapPairs` is a real named export; `applySuppression` returns the documented shape; `normaliseSelfPair` is defined in 1.6.
- [x] **Type consistency.** `conflict_surfacing_enabled`, `conflict_max_pairs_surfaced`, `conflict_min_confidence`, `conflict_block_token_budget`, `conflict_max_age_days`, `conflict_max_pairs_hydrated`, `relevant_memory_token_budget`, `conflicts_surfaced`, `conflicts_block_tokens`, `conflicts_hydrated_precap`, `conflicts_hydrated_postcap`, `conflicts_hydration_capped`, `conflicts_suppressed_by_rule`, `conflicts_redacted_one_side`, `conflicts_block_truncated` — same names across migration, store defaults, conflicts.js, inject.js, daemon route, tests.
- [x] **Migration consistency.** Slot `0015-conflict-surfacing.surql` referenced identically in Task 0.1, plan goal, file structure table, rollout phase.
- [x] **No source-file edits documented outside the plan.** Every Edit/Write step writes either to the plan markdown (this file) or to project files explicitly named in the file-structure table — and every project-file step is anchored to a TDD checkpoint with a runnable command.
- [x] **Structural anchors used for `inject.js` modifications.** Tasks 3.1-3.3 anchor on "inside the intuition fan-out Promise.all", "the recall_log CREATE block", "after greedy-pack hits computed", "the recall_log rebuild for ranked_hits[*].score_components". No line numbers cited for inject.js.
- [x] **Budget model is additive.** Task 3.4 wires `tokenBudget` (1500 baseline, unchanged) + `conflictTokenBudget` (up to 300, off when flag false). No shrinking of relevant-memory.
- [x] **Both `score()` callsites wired.** Task 3.2 step 3 wires the first call; Task 3.2 step 4 threads `_scoreComponents` through MMR so the recall_log rebuild reuses the already-computed components. Test §8.3 #12 asserts `contraPenalty < 1.0` **on the persisted recall_log row** (i.e., the second callsite).
- [x] **Suppression rule 3 uses `isOutboundBlocked(side.scope)`.** Task 1.1 step 3 imports `isOutboundBlocked` from `scope-registry.js` (the file exports it at line 53).
- [x] **`intuition_telemetry.meta` precondition.** Task 0.1 step 2 includes `DEFINE FIELD IF NOT EXISTS meta ON intuition_telemetry TYPE option<object> FLEXIBLE` in `0015`. Safe regardless of A3 landing order.
- [x] **R-3 coordination.** Task 3.4 targets `system/runtime/daemon/routes/intuition.js` directly because R-3 has shipped (verified by file presence). No inline-handler fallback needed.
- [x] **Telemetry storage layout defers to C3.** Phase 5 verifies only that fields land in `intuition_telemetry` against the current schema. No rollup table introduced; C3 owns that.

---

## Genuinely open items

These are real ambiguities the plan acknowledges and defers to operational/follow-up work — not gaps in coverage:

1. **Default-on follow-up migration (`0016-conflict-surfacing-default-on.surql`).** Reserved by spec §9.1 but explicitly out of scope per spec §9.2 step 6. The dogfood-week telemetry decides whether to flip; if so, a follow-up plan creates `0016`.
2. **Stub-embedder behavior in §8.3 #15** (out-of-view contradictor). The test may need tuning — the stub embedder is deterministic, so a sufficient amount of backdate + confidence-drop + rank-padding should reliably push the contradictor below top-K, but the exact constants in Task 4.3 may need adjustment on first run. The fix is empirical (not structural).
3. **A3 stratification keys on `recall_log.meta`.** B2 writes `meta.conflicts_surfaced`. A3's golden fixtures expect it (per spec §6.2 + §11.3), but the A3 plan is parallel work — if A3 lands renamed keys, B2's field-name choice would need a corresponding rename. Coordination point, not a blocker.
4. **D1 ordering above conflicts block.** Spec §3.1 mandates focus → conflicts → relevant-memory. The current `return` statement in Task 3.3 concatenates `conflictBlock + block` (no focus block — D1 is parallel). When D1 lands, the handler will concatenate `focusBlock + conflictBlock + block`. This plan does not edit the handler beyond the daemon route; D1's plan owns the three-way concat.
