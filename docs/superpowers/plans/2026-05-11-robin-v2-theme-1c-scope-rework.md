# Theme 1c — Scope semantics rework · Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** (1) Fix the unenforced `private`-scope bug — outbound discretion blocks payloads referencing private memos. (2) Introduce hierarchical scopes via `/` path notation. (3) Centralise scope policy in a registry replacing hardcoded prefix lists.

**Architecture:** Single new module (`src/memory/scope-registry.js`) is the source of truth. `store.js`, `step-scope-cleanup.js`, and `outbound/policy.js` all derive their behavior from it. No new tables; the `scope` field stays a single string interpreted hierarchically via `/`.

**Tech Stack:** Node.js 18+, SurrealDB 3.0.5.

**Spec:** `docs/superpowers/specs/2026-05-11-robin-v2-theme-1c-scope-rework-design.md`

**Dependencies:** `feat/surrealdb-improvements` (uses `<-derived_from<-memos[WHERE scope='private']` arrow traversal).

---

## File structure

| File | Responsibility |
|---|---|
| `src/memory/scope-registry.js` (new) | `SCOPE_REGISTRY`, `policyFor`, `validateScope`, `persistentScopesSqlFilter`, `scopeMatches` |
| `src/memory/store.js` (modify) | Use `validateScope` on writes; replace hardcoded SQL filter with `persistentScopesSqlFilter()`; add `scope_descends_from` query option |
| `src/dream/step-scope-cleanup.js` (refactor) | Iterate `SCOPE_REGISTRY`, not hardcoded prefixes |
| `src/outbound/policy.js` (modify) | Add `checkOutboundScope` — the actual bug fix |
| `src/mcp/tools/recall.js` (modify) | Accept `scope_descends_from` param |
| Outbound tool handlers (Discord send, integration write) | Call `checkOutboundScope` before forwarding |
| `tests/unit/scope-registry.test.js` (new) | Policy lookup, validation, SQL fragment snapshot |
| `tests/unit/scope-hierarchical-match.test.js` (new) | Path-prefix match |
| `tests/unit/outbound-private-block.test.js` (new) | The bug-fix test |
| `tests/integration/scope-cleanup-registry.test.js` (new) | Registry-driven cleanup |

---

## Phase 1 — Registry

### Task 1: SCOPE_REGISTRY + policyFor + helpers

**Files:** `src/memory/scope-registry.js`, `tests/unit/scope-registry.test.js`

- [ ] **Step 1: Failing test for policyFor**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { policyFor, isEphemeral, isHierarchical, isOutboundBlocked } from '../../src/memory/scope-registry.js';

test('policyFor exact matches and prefix matches', () => {
  assert.equal(policyFor('global').outbound, 'allow');
  assert.equal(policyFor('private').outbound, 'block');
  assert.equal(policyFor('project:robin').lifetime, 'persistent');
  assert.equal(policyFor('project:robin/v2/theme-1c').hierarchical, true);
  assert.equal(policyFor('session:abc123').ttl_days, 7);
  assert.equal(policyFor('temp:bash-out').ttl_days, 1);
  // unknown prefix → safe default
  assert.deepEqual(policyFor('legacy:weird'), { lifetime: 'persistent', outbound: 'allow', ephemeral: false });
});

test('isEphemeral / isHierarchical / isOutboundBlocked predicates', () => {
  assert.equal(isEphemeral('session:x'), true);
  assert.equal(isEphemeral('project:y'), false);
  assert.equal(isOutboundBlocked('private'), true);
  assert.equal(isOutboundBlocked('global'), false);
  assert.equal(isHierarchical('project:robin'), true);
  assert.equal(isHierarchical('integration:gmail'), false);
});
```

- [ ] **Step 2: Run → fail**

- [ ] **Step 3: Implement**

```js
// src/memory/scope-registry.js
export const SCOPE_REGISTRY = {
  global:      { lifetime: 'persistent', outbound: 'allow', ephemeral: false },
  private:     { lifetime: 'persistent', outbound: 'block', ephemeral: false },
  'project:':     { lifetime: 'persistent', outbound: 'allow', ephemeral: false, hierarchical: true },
  'integration:': { lifetime: 'persistent', outbound: 'allow', ephemeral: false },
  'session:':     { lifetime: 'ephemeral',  outbound: 'allow', ephemeral: true,  ttl_days: 7 },
  'temp:':        { lifetime: 'ephemeral',  outbound: 'allow', ephemeral: true,  ttl_days: 1 },
};

const PREFIX_KEYS = Object.keys(SCOPE_REGISTRY).filter(k => k.endsWith(':'));
const SAFE_DEFAULT = Object.freeze({ lifetime: 'persistent', outbound: 'allow', ephemeral: false });

export function policyFor(scope) {
  if (SCOPE_REGISTRY[scope]) return SCOPE_REGISTRY[scope];
  for (const p of PREFIX_KEYS) if (scope.startsWith(p)) return SCOPE_REGISTRY[p];
  return SAFE_DEFAULT;
}

export const isEphemeral        = (s) => policyFor(s).ephemeral === true;
export const isHierarchical     = (s) => policyFor(s).hierarchical === true;
export const isOutboundBlocked  = (s) => policyFor(s).outbound === 'block';
export const ttlDays            = (s) => policyFor(s).ttl_days ?? null;
```

- [ ] **Step 4: Run → pass; commit**

```bash
git add src/memory/scope-registry.js tests/unit/scope-registry.test.js
git commit -m "feat(memory): scope-registry with policy helpers"
```

### Task 2: validateScope + persistentScopesSqlFilter

**Files:** `src/memory/scope-registry.js`, `tests/unit/scope-registry.test.js`

- [ ] **Step 1: Failing tests**

```js
import { validateScope, persistentScopesSqlFilter } from '../../src/memory/scope-registry.js';

test('validateScope accepts known exact + prefix', () => {
  assert.equal(validateScope('global'), 'global');
  assert.equal(validateScope('project:robin/v2'), 'project:robin/v2');
});

test('validateScope rejects unknown patterns', () => {
  assert.throws(() => validateScope('projeect:typo'), /unknown pattern/);
  assert.throws(() => validateScope(''), /empty/);
});

test('persistentScopesSqlFilter produces a parseable SQL fragment with all persistent scopes', () => {
  const sql = persistentScopesSqlFilter();
  assert.match(sql, /scope = 'global'/);
  assert.match(sql, /scope = 'private'/);
  assert.match(sql, /string::starts_with\(scope, 'project:'\)/);
  assert.match(sql, /string::starts_with\(scope, 'integration:'\)/);
  // ephemerals NOT in default filter
  assert.doesNotMatch(sql, /'session:'/);
  assert.doesNotMatch(sql, /'temp:'/);
});
```

- [ ] **Step 2: Run → fail**

- [ ] **Step 3: Implement**

```js
export function validateScope(scope) {
  if (typeof scope !== 'string' || scope.length === 0) throw new Error('scope: empty');
  if (SCOPE_REGISTRY[scope]) return scope;
  for (const p of PREFIX_KEYS) if (scope.startsWith(p)) return scope;
  throw new Error(`scope: unknown pattern '${scope}'; register prefix in SCOPE_REGISTRY first`);
}

export function persistentScopesSqlFilter() {
  const exact  = Object.keys(SCOPE_REGISTRY).filter(k => !k.endsWith(':') && !SCOPE_REGISTRY[k].ephemeral);
  const prefix = PREFIX_KEYS.filter(p => !SCOPE_REGISTRY[p].ephemeral);
  const parts = [
    ...exact.map(s => `scope = '${s}'`),
    ...prefix.map(p => `string::starts_with(scope, '${p}')`),
  ];
  return `(${parts.join(' OR ')})`;
}
```

- [ ] **Step 4: Run → pass; commit**

```bash
git commit -m "feat(memory): validateScope + persistentScopesSqlFilter"
```

### Task 3: scopeMatches (hierarchical prefix match)

**Files:** `src/memory/scope-registry.js`, `tests/unit/scope-hierarchical-match.test.js`

- [ ] **Step 1: Failing test**

```js
import { scopeMatches } from '../../src/memory/scope-registry.js';

test('scopeMatches: descendant + exact + sibling-rejection', () => {
  assert.equal(scopeMatches('project:robin', 'project:robin'), true);
  assert.equal(scopeMatches('project:robin', 'project:robin/v2'), true);
  assert.equal(scopeMatches('project:robin', 'project:robin/v2/theme-1c'), true);
  assert.equal(scopeMatches('project:robin', 'project:robin-other'), false);  // similar prefix, no `/`
  assert.equal(scopeMatches('project:robin/v2', 'project:robin'), false);     // can't match ancestor
});
```

- [ ] **Step 2: Implement**

```js
export function scopeMatches(query, target) {
  return target === query || target.startsWith(query + '/');
}
```

- [ ] **Step 3: Run → pass; commit**

```bash
git commit -m "feat(memory): hierarchical scopeMatches helper"
```

---

## Phase 2 — `store.js` integration

### Task 4: validateScope on writes

**Files:** `src/memory/store.js`, `tests/unit/store-validate-scope.test.js`

- [ ] **Step 1: Failing test**

```js
test('store.note rejects unknown scope at write', async () => {
  const db = await openMemDb();
  await assert.rejects(
    () => store.note(db, stubEmbedder(), 'knowledge', {
      content: 'x', derived_by: 'manual', scope: 'projeect:typo'
    }),
    /unknown pattern/
  );
});

test('store.note accepts hierarchical project scope', async () => {
  const db = await openMemDb();
  await store.note(db, stubEmbedder(), 'knowledge', {
    content: 'x', derived_by: 'manual', scope: 'project:robin/v2/theme-1c'
  });
});
```

- [ ] **Step 2: Run → fail**

- [ ] **Step 3: Implement — add validateScope at top of every writer**

In `store.js`:

```js
import { validateScope } from './scope-registry.js';

// At top of `remember`, `note`, `upsertEntity`:
if (scope !== undefined) validateScope(scope);
```

- [ ] **Step 4: Run → pass; commit**

```bash
git commit -m "feat(store): validate scope on writes"
```

### Task 5: Replace hardcoded SQL filter

**Files:** `src/memory/store.js`, snapshot test

- [ ] **Step 1: Snapshot test of current filter**

```js
test('persistentScopesSqlFilter matches the pre-rework hardcoded filter semantically', () => {
  const sql = persistentScopesSqlFilter();
  // The pre-rework filter was:
  //   (scope = 'global' OR string::starts_with(scope, 'project:')
  //    OR string::starts_with(scope, 'integration:') OR scope = 'private')
  // Order may differ; assert each part appears
  assert.match(sql, /scope = 'global'/);
  assert.match(sql, /string::starts_with\(scope, 'project:'\)/);
  assert.match(sql, /string::starts_with\(scope, 'integration:'\)/);
  assert.match(sql, /scope = 'private'/);
});
```

- [ ] **Step 2: Replace in store.js**

In `_surfaceSearch`, replace:

```js
filters.push(`(scope = 'global' OR string::starts_with(scope, 'project:') OR string::starts_with(scope, 'integration:') OR scope = 'private')`);
```

with:

```js
import { persistentScopesSqlFilter } from './scope-registry.js';
const PERSISTENT_FILTER = persistentScopesSqlFilter();  // module-level cache
// …
filters.push(PERSISTENT_FILTER);
```

- [ ] **Step 3: Run existing recall tests + new snapshot → pass**

- [ ] **Step 4: Commit**

```bash
git commit -m "refactor(store): default-exclusion filter from scope-registry"
```

### Task 6: scope_descends_from query option

**Files:** `src/memory/store.js`, `tests/unit/scope-descends-from.test.js`

- [ ] **Step 1: Failing test**

```js
test('searchMemos with scope_descends_from returns descendants and exact', async () => {
  const db = await openMemDb();
  const e = stubEmbedder();
  await store.note(db, e, 'knowledge', { content: 'A', scope: 'project:robin',           derived_by: 'manual' });
  await store.note(db, e, 'knowledge', { content: 'B', scope: 'project:robin/v2',        derived_by: 'manual' });
  await store.note(db, e, 'knowledge', { content: 'C', scope: 'project:robin/v2/x',      derived_by: 'manual' });
  await store.note(db, e, 'knowledge', { content: 'D', scope: 'project:robin-other',     derived_by: 'manual' });

  const { hits } = await store.searchMemos(db, e, 'A', { scope_descends_from: 'project:robin' });
  const contents = hits.map(h => h.record.content);
  assert.ok(contents.includes('A'));
  assert.ok(contents.includes('B'));
  assert.ok(contents.includes('C'));
  assert.ok(!contents.includes('D'));  // similar-prefix without `/` excluded
});
```

- [ ] **Step 2: Run → fail**

- [ ] **Step 3: Implement in `_surfaceSearch`**

```js
if (opts.scope_descends_from) {
  filters.push(`(scope = $scope_root OR string::starts_with(scope, $scope_root + '/'))`);
  bindings.scope_root = opts.scope_descends_from;
}
```

- [ ] **Step 4: Run → pass; commit**

```bash
git commit -m "feat(store): scope_descends_from query option"
```

---

## Phase 3 — Outbound private-block (the bug fix)

### Task 7: checkOutboundScope

**Files:** `src/outbound/policy.js`, `tests/unit/outbound-private-block.test.js`

- [ ] **Step 1: Failing test (the bug-fix gate)**

```js
test('checkOutboundScope blocks payload referencing private memo', async () => {
  const db = await openMemDb();
  const e = stubEmbedder();
  const { id: priv } = await store.note(db, e, 'knowledge', {
    content: 'secret', derived_by: 'manual', scope: 'private',
  });
  const result = await checkOutboundScope(db, { tool: 'discord_send', refs: [priv] });
  assert.equal(result.ok, false);
  assert.match(result.reason, /private/);
  // refusal logged
  const [refusals] = await db.query(`SELECT * FROM refusals WHERE reason='private_scope'`).collect();
  assert.equal(refusals.length, 1);
});

test('checkOutboundScope allows payload of all global refs', async () => {
  const db = await openMemDb();
  const e = stubEmbedder();
  const { id: pub } = await store.note(db, e, 'knowledge', {
    content: 'public', derived_by: 'manual', scope: 'global',
  });
  const result = await checkOutboundScope(db, { tool: 'discord_send', refs: [pub] });
  assert.equal(result.ok, true);
});

test('transitive: event derived_from private memo also blocked', async () => {
  const db = await openMemDb();
  const e = stubEmbedder();
  const { id: priv } = await store.note(db, e, 'knowledge', {
    content: 'secret', derived_by: 'manual', scope: 'private',
  });
  const { id: ev } = await store.remember(db, e, { content: 'derived', source: 'manual' });
  await store.relate(db, ev, priv, 'derived_from');
  const result = await checkOutboundScope(db, { tool: 'x', refs: [ev] });
  assert.equal(result.ok, false);
});
```

- [ ] **Step 2: Run → fail**

- [ ] **Step 3: Implement**

```js
// src/outbound/policy.js
import { surql } from 'surrealdb';
import { isOutboundBlocked } from '../memory/scope-registry.js';
import { logRefusal } from './refusals.js';   // existing helper

export async function checkOutboundScope(db, { tool, refs }) {
  if (!refs || refs.length === 0) return { ok: true };

  const [rows] = await db.query(surql`SELECT id, scope FROM ${refs}`).collect();
  const directBlocked = (rows ?? []).filter(r => isOutboundBlocked(r.scope));

  // Transitive: events derived_from a private memo
  const [derived] = await db.query(surql`
    SELECT id, scope FROM events
    WHERE id IN ${refs}
      AND count(<-derived_from<-memos[WHERE scope = 'private']) > 0
  `).collect();

  const allBlocked = [...directBlocked, ...(derived ?? [])];
  if (allBlocked.length === 0) return { ok: true };

  await logRefusal(db, {
    direction: 'outbound',
    reason: 'private_scope',
    tool,
    meta: { blocked_ids: allBlocked.map(r => String(r.id)) },
    content: '<redacted: private-scope reference>',
  });
  return { ok: false, reason: `${allBlocked.length} record(s) in private scope; refused to forward`, blocked: allBlocked };
}
```

- [ ] **Step 4: Run → pass; commit**

```bash
git commit -m "fix(outbound): enforce private-scope block (closes redesign spec promise)"
```

### Task 8: Wire checkOutboundScope into outbound tool handlers

**Files:** Each outbound tool: Discord send, integration write, etc.

- [ ] **Step 1: Audit which tools forward payloads**

Run: `grep -rn "outbound\|forward\|send" src/mcp/tools/ src/integrations/` to enumerate.

- [ ] **Step 2: For each, add guard before serialization**

Pattern:

```js
import { checkOutboundScope } from '../../outbound/policy.js';

async handler(input) {
  const refs = collectMemoRefs(input);   // extract IDs from input
  const guard = await checkOutboundScope(db, { tool: this.name, refs });
  if (!guard.ok) return { error: guard.reason, blocked: guard.blocked };
  // … existing forward logic
}
```

- [ ] **Step 3: Integration test per tool** (or one integration test covering them)

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(mcp,integrations): wire checkOutboundScope into outbound paths"
```

---

## Phase 4 — `step-scope-cleanup` refactor

### Task 9: Iterate SCOPE_REGISTRY

**Files:** `src/dream/step-scope-cleanup.js`, `tests/integration/scope-cleanup-registry.test.js`

- [ ] **Step 1: Failing test**

```js
test('step-scope-cleanup iterates registry: new ephemeral prefix swept without code change', async () => {
  const db = await openMemDb();
  const e = stubEmbedder();
  // Seed a memo in temp:bash-out (ephemeral, 1d TTL)
  const { id } = await store.note(db, e, 'knowledge', {
    content: 'x', derived_by: 'manual', scope: 'temp:bash-out',
  });
  await db.query(surql`UPDATE ${id} SET derived_at = time::now() - 2d`).collect();

  await dreamStepScopeCleanup(db, stubHost());
  const [remaining] = await db.query(`SELECT * FROM ${id}`).collect();
  assert.equal(remaining.length, 0);
});
```

- [ ] **Step 2: Refactor**

```js
// src/dream/step-scope-cleanup.js
import { SCOPE_REGISTRY } from '../memory/scope-registry.js';

export async function dreamStepScopeCleanup(db, host, opts) {
  const promoted = [];
  const pruned = [];
  for (const [pattern, policy] of Object.entries(SCOPE_REGISTRY)) {
    if (!policy.ephemeral) continue;
    const isExact = !pattern.endsWith(':');
    const where = isExact ? `scope = '${pattern}'` : `string::starts_with(scope, '${pattern}')`;
    // Promote referenced ephemerals first
    await db.query(surql.unsafe(`
      UPDATE memos SET scope = 'global'
      WHERE (${where})
        AND id IN (
          SELECT VALUE in FROM edges
          WHERE kind = 'derived_from'
            AND out IN (SELECT id FROM memos WHERE scope = 'global' OR string::starts_with(scope, 'project:'))
        )
    `)).collect();
    // Prune rest
    await db.query(surql.unsafe(`
      DELETE memos WHERE (${where}) AND derived_at < time::now() - ${policy.ttl_days}d
    `)).collect();
  }
  return { promoted: promoted.length, pruned: pruned.length };
}
```

- [ ] **Step 3: Run → pass; commit**

```bash
git commit -m "refactor(dream): step-scope-cleanup iterates registry"
```

---

## Phase 5 — MCP + docs

### Task 10: `recall` MCP tool accepts `scope_descends_from`

**Files:** `src/mcp/tools/recall.js`

- [ ] **Step 1: Update input schema**

```js
inputSchema: {
  type: 'object',
  properties: {
    query: { type: 'string' },
    scope: { type: 'string' },
    scope_descends_from: { type: 'string' },
  },
  required: ['query'],
}
```

- [ ] **Step 2: Pass through to `store.searchMemos`/`searchEvents`**

- [ ] **Step 3: Test + commit**

```bash
git commit -m "feat(mcp): recall accepts scope_descends_from"
```

### Task 11: Docs

**Files:** `docs/architecture.md`, `docs/faculties.md`

- [ ] Rewrite scope-semantics section in architecture.md.
- [ ] Add outbound-scope-block to discretion section in faculties.md.

```bash
git commit -m "docs(scopes): registry + hierarchical + private enforcement"
```

---

## Phase 6 — Verification gates

Spec §8 gates as discrete tests:

1. Private blocks outbound (Task 7)
2. Transitive private block (Task 7)
3. Hierarchical match (Task 6)
4. Registry-derived filter equivalent (Task 5)
5. Unknown scope rejected at write (Task 4)
6. Legacy data readable (new test)
7. Registry-driven cleanup (Task 9)
8. Refusals audit trail (Task 7)

One commit per remaining gate.

## Self-review

- [ ] All 8 gates from spec §8 covered.
- [ ] No "TBD" placeholders.
- [ ] `validateScope`, `policyFor`, `scopeMatches`, `checkOutboundScope`, `persistentScopesSqlFilter` referenced consistently.
- [ ] Pre-rework SQL filter snapshot-tested.
- [ ] The actual bug-fix (private-block) has a dedicated test.

## Final commit

```bash
git push -u origin feat/theme-1c-scope-rework
gh pr create --title "Theme 1c: Hierarchical scopes + private enforcement"
```
