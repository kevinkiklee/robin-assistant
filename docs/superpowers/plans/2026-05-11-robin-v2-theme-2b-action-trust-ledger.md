# Theme 2b — Action-trust ledger · Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add audit history, time-decay, and consecutive-failure escalation to action-trust. Flat `action_trust` table stays as hot-path cache; new `action_trust_ledger` is the source of truth for state changes.

**Architecture:** Mirror of Theme 2a's ledger pattern. Producers: existing `setActionTrust`/`recordOutcome`/`demoteOnCorrection` paths gain ledger inserts. New: heartbeat decay sweep + consecutive-correction → `DENY` escalation. `update_action_policy` MCP gains optional `reason`.

**Tech Stack:** Node.js 18+, SurrealDB 3.0.5.

**Spec:** `docs/superpowers/specs/2026-05-11-robin-v2-theme-2b-action-trust-ledger-design.md`

**Dependencies:** `feat/surrealdb-improvements` merge.

---

## File structure

| File | Responsibility |
|---|---|
| `src/schema/migrations/0001-init.surql` | `action_trust_ledger` table, seed `runtime:action_trust.config` |
| `src/jobs/action-trust.js` (modify) | Ledger emission on every state change; consecutive-correction logic |
| `src/jobs/internal/action-trust-decay.js` (new) | Heartbeat decay sweep |
| `src/jobs/builtin/action-trust-decay.md` (new) | Manifest (every 6h) |
| `src/mcp/tools/update-action-policy.js` (modify) | Accept optional `reason` |
| Tests: ledger emit, decay selective, consecutive block, replay |

---

## Phase 1 — Schema

### Task 1: action_trust_ledger table + config

**Files:** `src/schema/migrations/0001-init.surql`

- [ ] **Step 1: Append DDL + seed**

```surql
DEFINE TABLE action_trust_ledger SCHEMAFULL TYPE NORMAL;
DEFINE FIELD class       ON action_trust_ledger TYPE string;
DEFINE FIELD old_state   ON action_trust_ledger TYPE option<string>;
DEFINE FIELD new_state   ON action_trust_ledger TYPE option<string>;
DEFINE FIELD action      ON action_trust_ledger TYPE string;
DEFINE FIELD set_by      ON action_trust_ledger TYPE string;
DEFINE FIELD reason      ON action_trust_ledger TYPE option<string>;
DEFINE FIELD ts          ON action_trust_ledger TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD meta        ON action_trust_ledger TYPE option<object> FLEXIBLE;
DEFINE INDEX atl_class_ts  ON action_trust_ledger FIELDS class, ts;
DEFINE INDEX atl_action    ON action_trust_ledger FIELDS action;

UPSERT runtime:action_trust.config CONTENT {
  value: {
    decay_days: 90,
    consecutive_corrections_to_block: 3,
    default_state: 'ASK'
  }
};
```

- [ ] **Step 2: Run migration → clean**

- [ ] **Step 3: Commit**

```bash
git commit -m "feat(schema): action_trust_ledger + config seed"
```

---

## Phase 2 — Ledger emission on every state change

### Task 2: setActionTrust emits ledger row

**Files:** `src/jobs/action-trust.js`, `tests/unit/action-trust-ledger.test.js`

- [ ] **Step 1: Failing test**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setActionTrust } from '../../src/jobs/action-trust.js';
import { openMemDb } from './helpers/db.js';

test('setActionTrust emits ledger row with old/new state + reason', async () => {
  const db = await openMemDb();
  await setActionTrust(db, 'gmail:send', 'AUTO', 'user', 'trust this action');
  const [rows] = await db.query(`SELECT * FROM action_trust_ledger WHERE class = 'gmail:send'`).collect();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].new_state, 'AUTO');
  assert.equal(rows[0].set_by, 'user');
  assert.equal(rows[0].reason, 'trust this action');
});
```

- [ ] **Step 2: Run → fail**

- [ ] **Step 3: Modify setActionTrust**

```js
export async function setActionTrust(db, cls, state, set_by, reason) {
  const parts = cls.split(':');
  const tool = parts[0];
  const action = parts.slice(1).join(':') || '_default';
  const old = await getActionTrust(db, cls);
  await checkActionTrust(db, tool, action);
  await db.query(
    surql`UPDATE action_trust MERGE ${{ state, set_by, last_state_change_at: new Date() }} WHERE class = ${cls}`,
  );
  // NEW: ledger emit
  const action_kind = state === old?.state ? 'success' : (state === 'AUTO' ? 'manual_promote' : 'manual_demote');
  await db.query(surql`
    CREATE action_trust_ledger CONTENT ${{
      class: cls,
      old_state: old?.state ?? null,
      new_state: state,
      action: action_kind,
      set_by,
      reason,
    }}
  `).collect();
}
```

- [ ] **Step 4: Run → pass; commit**

```bash
git commit -m "feat(action-trust): ledger emission on setActionTrust"
```

### Task 3: recordOutcome emits ledger row

**Files:** `src/jobs/action-trust.js`, `tests/unit/action-trust-ledger.test.js`

- [ ] **Step 1: Failing test**

```js
test('recordOutcome(success) emits success-action ledger row', async () => {
  // …
});
test('recordOutcome(correction) emits correction-action ledger row + auto-demote ledger row when AUTO→ASK', async () => {
  // …
});
```

- [ ] **Step 2: Modify recordOutcome**

```js
export async function recordOutcome(db, cls, outcome) {
  const row = await getActionTrust(db, cls);
  if (!row) return;
  const patch = { last_used_at: new Date() };
  const oldState = row.state;
  let stateChanged = false;
  if (outcome === 'success') {
    patch.success_count = (row.success_count ?? 0) + 1;
  } else if (outcome === 'correction') {
    patch.correction_count = (row.correction_count ?? 0) + 1;
    if (row.state === 'AUTO') {
      patch.state = 'ASK';
      patch.set_by = 'correction';
      patch.last_state_change_at = new Date();
      stateChanged = true;
    }
  }
  await db.query(surql`UPDATE action_trust MERGE ${patch} WHERE class = ${cls}`);

  // NEW: ledger row
  await db.query(surql`
    CREATE action_trust_ledger CONTENT ${{
      class: cls,
      old_state: oldState,
      new_state: patch.state ?? oldState,
      action: outcome,        // 'success' | 'correction'
      set_by: stateChanged ? 'correction_loop' : (row.set_by ?? 'default'),
    }}
  `).collect();
}
```

- [ ] **Step 3: Run → pass; commit**

```bash
git commit -m "feat(action-trust): ledger emission on recordOutcome"
```

### Task 4: Consecutive-correction → DENY

**Files:** `src/jobs/action-trust.js`, `tests/unit/action-trust-consecutive-block.test.js`

- [ ] **Step 1: Failing test**

```js
test('3 consecutive corrections triggers state=DENY', async () => {
  const db = await openMemDb();
  await setActionTrust(db, 't:a', 'ASK', 'default');
  await recordOutcome(db, 't:a', 'correction');
  await recordOutcome(db, 't:a', 'correction');
  await recordOutcome(db, 't:a', 'correction');
  const row = await getActionTrust(db, 't:a');
  assert.equal(row.state, 'DENY');
});

test('success between corrections resets counter', async () => {
  const db = await openMemDb();
  await setActionTrust(db, 't:b', 'ASK', 'default');
  await recordOutcome(db, 't:b', 'correction');
  await recordOutcome(db, 't:b', 'success');
  await recordOutcome(db, 't:b', 'correction');
  await recordOutcome(db, 't:b', 'correction');
  const row = await getActionTrust(db, 't:b');
  assert.notEqual(row.state, 'DENY');
});
```

- [ ] **Step 2: Add consecutive check inside recordOutcome (after existing patch)**

```js
if (outcome === 'correction') {
  const cfg = await readActionTrustConfig(db);
  const [recent] = await db.query(surql`
    SELECT action FROM action_trust_ledger
    WHERE class = ${cls} ORDER BY ts DESC LIMIT ${cfg.consecutive_corrections_to_block}
  `).collect();
  let consecutive = 0;
  for (const r of recent ?? []) {
    if (r.action === 'success') break;
    if (r.action === 'correction') consecutive++;
  }
  if (consecutive >= cfg.consecutive_corrections_to_block) {
    await db.query(surql`
      UPDATE action_trust MERGE ${{ state: 'DENY', set_by: 'correction_loop', last_state_change_at: new Date() }} WHERE class = ${cls}
    `).collect();
    await db.query(surql`
      CREATE action_trust_ledger CONTENT ${{
        class: cls, old_state: 'ASK', new_state: 'DENY',
        action: 'auto_block', set_by: 'correction_loop',
        reason: `${consecutive} consecutive corrections`,
      }}
    `).collect();
  }
}
```

- [ ] **Step 3: Run → pass; commit**

```bash
git commit -m "feat(action-trust): consecutive-correction → DENY escalation"
```

---

## Phase 3 — Decay sweep

### Task 5: action-trust-decay heartbeat job

**Files:** `src/jobs/internal/action-trust-decay.js`, `src/jobs/builtin/action-trust-decay.md`, `tests/unit/action-trust-decay.test.js`

- [ ] **Step 1: Failing test**

```js
test('decay sweep demotes stale AUTO; preserves recent-used AUTO', async () => {
  const db = await openMemDb();
  await setActionTrust(db, 't:x', 'AUTO', 'user');
  await db.query(surql`UPDATE action_trust SET last_used_at = time::now() - 100d WHERE class = 't:x'`).collect();
  await setActionTrust(db, 't:y', 'AUTO', 'user');
  await db.query(surql`UPDATE action_trust SET last_used_at = time::now() - 30d WHERE class = 't:y'`).collect();

  await runActionTrustDecay(db);

  const [x] = await db.query(`SELECT state FROM action_trust WHERE class = 't:x'`).collect();
  const [y] = await db.query(`SELECT state FROM action_trust WHERE class = 't:y'`).collect();
  assert.equal(x[0].state, 'ASK');
  assert.equal(y[0].state, 'AUTO');
  const [log] = await db.query(`SELECT * FROM action_trust_ledger WHERE action = 'decay' AND class = 't:x'`).collect();
  assert.equal(log.length, 1);
});
```

- [ ] **Step 2: Implement**

```js
// src/jobs/internal/action-trust-decay.js
import { surql } from 'surrealdb';

export async function runActionTrustDecay(db) {
  const [cfg] = await db.query(surql`SELECT VALUE value FROM runtime:action_trust.config`).collect();
  const decay_days = cfg?.[0]?.decay_days ?? 90;
  const [stale] = await db.query(surql`
    SELECT class FROM action_trust
    WHERE state = 'AUTO'
      AND (last_used_at IS NONE OR last_used_at < time::now() - ${decay_days}d)
  `).collect();
  for (const r of stale ?? []) {
    await db.query(surql`
      UPDATE action_trust SET state='ASK', set_by='decay_sweep', last_state_change_at=time::now() WHERE class = ${r.class}
    `).collect();
    await db.query(surql`
      CREATE action_trust_ledger CONTENT ${{
        class: r.class, old_state: 'AUTO', new_state: 'ASK',
        action: 'decay', set_by: 'decay_sweep',
        reason: `unused for ${decay_days}d`,
      }}
    `).collect();
  }
  return { demoted: (stale ?? []).length };
}
```

- [ ] **Step 3: Add manifest** `src/jobs/builtin/action-trust-decay.md`

```md
---
name: action-trust-decay
schedule: "0 */6 * * *"
runtime: internal
catch_up: false
---
```

- [ ] **Step 4: Run → pass; commit**

```bash
git commit -m "feat(jobs): action-trust-decay every 6h"
```

---

## Phase 4 — MCP + tests + docs

### Task 6: update_action_policy accepts reason

**Files:** `src/mcp/tools/update-action-policy.js`

- [ ] **Step 1: Update inputSchema + pass reason to setActionTrust**

```js
inputSchema: {
  type: 'object',
  properties: { class: { type: 'string' }, state: { type: 'string' }, reason: { type: 'string' } },
  required: ['class', 'state'],
}
// handler:
await setActionTrust(db, input.class, input.state, 'user', input.reason);
```

- [ ] **Step 2: Test reason propagation to ledger**

- [ ] **Step 3: Commit**

```bash
git commit -m "feat(mcp): update_action_policy accepts reason"
```

### Task 7: Replay test

**Files:** `tests/integration/action-trust-replay.test.js`

- [ ] **Step 1: Test**

```js
test('replay ledger reproduces current state and counters', async () => {
  const db = await openMemDb();
  // sequence of operations
  await setActionTrust(db, 'x:y', 'AUTO', 'user', 'init');
  await recordOutcome(db, 'x:y', 'success');
  await recordOutcome(db, 'x:y', 'correction');   // AUTO → ASK
  await recordOutcome(db, 'x:y', 'success');

  // Read ledger; reapply mentally; compare
  const [ledger] = await db.query(`SELECT * FROM action_trust_ledger WHERE class='x:y' ORDER BY ts ASC`).collect();
  const final = replayActionTrust(ledger);   // helper that walks the ledger
  const row = await getActionTrust(db, 'x:y');
  assert.equal(final.state, row.state);
  assert.equal(final.success_count, row.success_count);
  assert.equal(final.correction_count, row.correction_count);
});
```

`replayActionTrust` is a test-only helper in the same file (or a `src/jobs/action-trust-replay.js` exported for the test).

- [ ] **Step 2: Commit**

```bash
git commit -m "test(action-trust): replay correctness"
```

### Task 8: Remaining gates + docs

Spec §5 gates:

1. Every state change logged (Task 2, 3)
2. Decay selective (Task 5)
3. Consecutive correction → DENY (Task 4)
4. Manual override resets counter (new test: after DENY, setActionTrust to AUTO clears the counter)
5. Replay correctness (Task 7)
6. Per-class history retrievable (basic select test)
7. Never-used class untouched by decay (Task 5 covers)
8. reason propagates (Task 6)

One commit per remaining gate.

- [ ] **Step N: Docs**

Update `docs/architecture.md` action-trust lifecycle section; `docs/faculties.md` discretion section.

```bash
git commit -m "docs(action-trust): ledger + decay + escalation"
```

## Self-review

- [ ] 8 spec gates covered.
- [ ] No placeholders.
- [ ] `setActionTrust`, `recordOutcome`, `runActionTrustDecay`, `replayActionTrust` consistently named.
- [ ] DENY (not BLOCK) used as canonical block state name throughout.

## Final commit

```bash
git push -u origin feat/theme-2b-action-trust-ledger
gh pr create --title "Theme 2b: Action-trust ledger + decay + escalation"
```
