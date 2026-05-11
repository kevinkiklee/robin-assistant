# Robin v2 — Theme 1c: Scope semantics rework

**Status:** Design (working draft; impl waits for `feat/surrealdb-improvements` merge)
**Date:** 2026-05-11
**Umbrella:** `2026-05-11-robin-v2-evolution-roadmap.md` (Theme 1c)
**Depends on:** `2026-05-11-surrealdb-improvements-design.md` (arrow traversal for the recursive-block check)

## Why

Three real issues:

1. **`private` scope is unenforced.** The redesign spec promised "outbound discretion always refuses to forward private," but `src/outbound/policy.js` has no scope-aware guard. Private memos are filterable in recall but freely included in outbound payloads. **Bug, not just feature gap.**
2. **Flat strings — no hierarchy.** `project:robin/v2/theme-1b` is a different scope from `project:robin/v2` from `project:robin`. Project-scoped recall can't naturally pick up sub-project memos.
3. **Hardcoded prefix lists everywhere.** `store.js:439` lists known persistent scopes in a literal SQL string; `step-scope-cleanup.js` lists ephemeral prefixes; nothing centralised. Adding a new prefix means editing N files and risks drift.

## Goals

- Fix the private-scope enforcement bug — outbound discretion checks scope before forwarding.
- Introduce hierarchical scopes via `/`-separator path notation (no schema change).
- Centralise scope policy in a registry analogous to `EDGE_KIND_REGISTRY` / `MEMO_KIND_REGISTRY`.
- Replace hardcoded prefix lists with registry-derived behavior.

## Non-goals

- Multi-tier sensitivity (`public` / `shared` / `private` / `sensitive` as a separate field). Considered; rejected for v1. Binary `private` covers the outbound-block need. Adding a tier without a concrete consumer is premature.
- Multi-membership scopes (`scopes: array<string>`). Considered; rejected. Cost (every recall filter becomes set-intersection) outweighs benefit at single-user scale.
- Encryption at rest for `private` rows. Separate concern; needs key management; out of scope.
- Schema migration. Hierarchy is purely interpretive; the `scope` field stays a string.

## Anchoring decisions

**Why path notation over a separate parent_id:**

- Scope is conceptually one identifier, not a tree node. Path notation (`project:robin/v2/theme-1b`) captures hierarchy in the string itself; no second column, no JOIN-to-resolve.
- Prefix-match SQL (`string::starts_with(scope, $prefix + '/')`) is fast and indexable.
- Migration cost: zero (existing flat scopes are already valid paths of depth 1).

**Why a registry, not validation-at-write only:**

- The hardcoded SQL filter and the hardcoded cleanup prefix list are the same thing — a fact about which scopes are persistent vs ephemeral. They belong together.
- Outbound policy (`'block'` vs `'allow'`) is the same shape — keyed by scope prefix.
- One registry → recall filter, cleanup step, outbound guard all derive from one source of truth.

**Why binary private, not a sensitivity tier:**

- The actual unmet need is "don't forward this memo in outbound payloads." Binary is sufficient.
- A tier (`shared` / `sensitive`) without a concrete behavior difference is decorative.
- If a real need surfaces ("share with this team, not that one"), a follow-up spec can layer a sensitivity field on top without breaking this design.

**Why strict-on-write, lenient-on-read for unknown scopes:**

- Writes go through the registry validator → caller learns immediately if they typo'd `proj:foo`.
- Reads tolerate legacy data → migrating from older instances or hand-edits don't break recall.
- Matches the open-enum-with-registry philosophy used elsewhere.

## Section 1 — Scope registry

```js
// src/memory/scope-registry.js
export const SCOPE_REGISTRY = {
  // exact matches
  global:      { lifetime: 'persistent', outbound: 'allow', ephemeral: false },
  private:     { lifetime: 'persistent', outbound: 'block', ephemeral: false },

  // prefix matches (key ends with ':')
  'project:':     { lifetime: 'persistent', outbound: 'allow', ephemeral: false, hierarchical: true },
  'integration:': { lifetime: 'persistent', outbound: 'allow', ephemeral: false },
  'session:':     { lifetime: 'ephemeral',  outbound: 'allow', ephemeral: true,  ttl_days: 7 },
  'temp:':        { lifetime: 'ephemeral',  outbound: 'allow', ephemeral: true,  ttl_days: 1 },
};

const PREFIX_KEYS = Object.keys(SCOPE_REGISTRY).filter(k => k.endsWith(':'));

export function policyFor(scope) {
  if (SCOPE_REGISTRY[scope]) return SCOPE_REGISTRY[scope];
  for (const prefix of PREFIX_KEYS) {
    if (scope.startsWith(prefix)) return SCOPE_REGISTRY[prefix];
  }
  return { lifetime: 'persistent', outbound: 'allow', ephemeral: false };  // safe default
}

export function isEphemeral(scope)     { return policyFor(scope).ephemeral; }
export function isHierarchical(scope)  { return policyFor(scope).hierarchical === true; }
export function isOutboundBlocked(scope) { return policyFor(scope).outbound === 'block'; }
export function ttlDays(scope)         { return policyFor(scope).ttl_days ?? null; }

export function validateScope(scope) {
  if (typeof scope !== 'string' || scope.length === 0) throw new Error('scope: empty');
  if (SCOPE_REGISTRY[scope]) return scope;                              // exact match
  for (const prefix of PREFIX_KEYS) if (scope.startsWith(prefix)) return scope;  // valid prefix
  throw new Error(`scope: unknown pattern '${scope}'; register prefix in SCOPE_REGISTRY first`);
}

// SQL fragment used by store.searchMemos / searchEvents / searchEntities defaults
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

## Section 2 — Hierarchical match

Helper used by recall queries and any user-facing scope filter:

```js
// "project:robin" matches itself + any descendant
export function scopeMatches(query, target) {
  return target === query || target.startsWith(query + '/');
}
```

Recall surface (`store.searchMemos`, `searchEvents`, `searchEntities`) gains:

```js
opts.scope_descends_from?: string    // matches exact + descendants
opts.scope?: string                  // exact match only (existing behavior)
```

SQL form for `scope_descends_from`:

```surql
WHERE (scope = $scope_root OR string::starts_with(scope, $scope_root + '/'))
```

## Section 3 — `store.js` changes

### 3.1 Validate on write

`remember`, `note`, `upsertEntity`, `relate` all flow through:

```js
import { validateScope } from './scope-registry.js';
// at the top of each writer that accepts scope:
if (scope !== undefined) validateScope(scope);
```

### 3.2 Default-exclusion filter computed from registry

Replace the hardcoded literal at `store.js:439`:

```js
// before:
filters.push(`(scope = 'global' OR string::starts_with(scope, 'project:') ...)`);

// after:
import { persistentScopesSqlFilter } from './scope-registry.js';
filters.push(persistentScopesSqlFilter());     // cached once per import
```

Snapshot test pins the fragment so accidental registry edits surface as test diffs.

### 3.3 New query option

```js
async function _surfaceSearch(db, embedder, surface, query, opts) {
  // ... existing kNN/BM25 ...
  if (opts.scope_descends_from) {
    filters.push(`(scope = $scope_root OR string::starts_with(scope, $scope_root + '/'))`);
    bindings.scope_root = opts.scope_descends_from;
  }
}
```

## Section 4 — Outbound private-scope block

The actual bug fix. `src/outbound/policy.js` gains a scope-aware guard called before any outbound forward.

```js
// src/outbound/policy.js
import { surql } from 'surrealdb';
import { isOutboundBlocked } from '../memory/scope-registry.js';
import { logRefusal } from './refusals.js';   // existing helper

export async function checkOutboundScope(db, { tool, payload, refs }) {
  // refs: array of record IDs the payload references (memo/event/entity IDs)
  if (!refs || refs.length === 0) return { ok: true };

  // direct check
  const [rows] = await db.query(surql`
    SELECT id, scope FROM ${refs}
  `).collect();
  const directBlocked = rows.filter(r => isOutboundBlocked(r.scope));

  // transitive check: events derived_from a private memo are also blocked
  const [derived] = await db.query(surql`
    SELECT id, scope FROM events
    WHERE id IN ${refs}
      AND count(<-derived_from<-memos[WHERE scope = 'private']) > 0
  `).collect();

  const allBlocked = [...directBlocked, ...derived];
  if (allBlocked.length === 0) return { ok: true };

  await logRefusal(db, {
    direction: 'outbound',
    reason: 'private_scope',
    tool,
    meta: { blocked_ids: allBlocked.map(r => String(r.id)) },
  });
  return {
    ok: false,
    reason: `${allBlocked.length} record(s) in private scope; refused to forward`,
    blocked: allBlocked,
  };
}
```

Tool wrappers (Discord send, integration write, etc.) call `checkOutboundScope` before serializing the payload to the network.

## Section 5 — `step-scope-cleanup` refactor

Iterate registry, not hardcoded prefixes:

```js
import { SCOPE_REGISTRY } from '../memory/scope-registry.js';

export async function dreamStepScopeCleanup(db, host, opts) {
  for (const [pattern, policy] of Object.entries(SCOPE_REGISTRY)) {
    if (!policy.ephemeral) continue;
    const ttlMs = policy.ttl_days * 86_400_000;
    const isExact = !pattern.endsWith(':');
    const where = isExact
      ? surql`scope = ${pattern}`
      : surql`string::starts_with(scope, ${pattern})`;

    // promote referenced ephemerals first (existing logic, parameterised)
    await promoteReferencedEphemerals(db, where);

    // prune the rest
    await db.query(surql`
      DELETE memos WHERE ${where} AND derived_at < time::now() - ${ttlMs}ms
    `).collect();
  }
}
```

`promoteReferencedEphemerals` is the existing "promote if inbound `derived_from` from a persistent memo exists" logic, parameterised on the where-clause.

## Section 6 — MCP tool surface

No new MCP tools. Existing `recall` MCP tool gains an optional `scope_descends_from` parameter:

```json
{
  "name": "recall",
  "inputSchema": {
    "type": "object",
    "properties": {
      "query": {"type": "string"},
      "scope": {"type": "string"},
      "scope_descends_from": {"type": "string"}
    }
  }
}
```

## Section 7 — Cost envelope

- Outbound scope check: one SELECT per tool call (cheap; refs is small). Microseconds at realistic scale.
- Recall filter computed once at module load; no per-query overhead.
- Validation on write: O(prefix count) string comparison. Negligible.
- New embedding/LLM cost: **zero.**

Well within roadmap §4 envelope.

## Section 8 — Verification gates

1. **Private blocks outbound:** memo in `private` scope referenced in tool payload → outbound refuses; `refusals` row written with `reason='private_scope'`.
2. **Transitive private block:** event with `derived_from` edge to a private memo → also blocked.
3. **Hierarchical match correct:** `scope_descends_from='project:robin'` returns memos at `project:robin`, `project:robin/v2`, `project:robin/v2/theme-1b`. Excludes `project:robin-other` (similar prefix but no `/`).
4. **Registry-derived filter equivalent:** snapshot test of `persistentScopesSqlFilter()` matches the pre-rework hardcoded SQL semantically.
5. **Unknown scope rejected at write:** `store.note(..., { scope: 'projeect:typo' })` throws `unknown pattern`.
6. **Legacy data readable:** seeded memo with `scope='legacy:unknown'` is queryable when explicitly filtered; not surfaced by default recall.
7. **Registry-driven cleanup:** add a new ephemeral entry to `SCOPE_REGISTRY` (test-only), run `step-scope-cleanup`, confirm the new prefix is swept without editing the step.
8. **`refusals` audit trail:** every outbound block produces one `refusals` row; no silent drops.

## Section 9 — File-by-file changes

**Created:**

- `src/memory/scope-registry.js`
- `tests/unit/scope-registry.test.js`
- `tests/unit/outbound-private-block.test.js`
- `tests/unit/scope-hierarchical-match.test.js`
- `tests/integration/scope-cleanup-registry.test.js`

**Modified:**

- `src/memory/store.js` — `_surfaceSearch` filter from registry; `validateScope` on writes; `scope_descends_from` query option.
- `src/dream/step-scope-cleanup.js` — iterate registry.
- `src/outbound/policy.js` — add `checkOutboundScope`.
- `src/mcp/tools/recall.js` — accept `scope_descends_from`.
- `src/mcp/tools/*.js` (outbound tools: Discord send, integration write) — call `checkOutboundScope` before forwarding.
- `docs/architecture.md` — scope semantics section rewrite.
- `docs/faculties.md` — discretion section mentions outbound scope-block.

## Section 10 — Sequencing within Theme 1c

1. **Scope registry + validation.** Additive; no behavior change yet.
2. **Hierarchical-match query option** in `_surfaceSearch`. Additive.
3. **Refactor default-exclusion filter** to use the registry. Equivalence test pins behavior.
4. **Refactor `step-scope-cleanup`** to iterate registry.
5. **Outbound private-block guard** — the actual bug fix. Lands last because it changes behavior; earlier waves keep things green.
6. **Tests + verification gates.**

## Section 11 — Dependencies

- **Waits for** `feat/surrealdb-improvements` merge (uses `<-derived_from<-memos[WHERE scope='private']` arrow traversal in §4's transitive check).
- Independent of Themes 1a / 1b — lands in any order after the in-flight branch.

## Section 12 — Open questions (post-impl review)

- **Should `integration:<name>` scopes default to `outbound: 'block'` for the same-integration?** A Gmail-sourced memo shouldn't necessarily be sent right back to Gmail. Current default is `'allow'`; revisit when telemetry shows accidental forwarding.
- **Hierarchical match for non-`project:` prefixes.** `integration:gmail` has no natural sub-hierarchy today, but future could ("integration:gmail/work" vs "integration:gmail/personal"). Path notation already supports it; defer the policy bit (which prefixes are `hierarchical: true`) until use case lands.
- **Scope inheritance for `derived_from` chains.** Today a knowledge memo inherits no scope from its source events. Maybe should default to the most-restrictive source scope? Out of scope here; flag for a future tighter privacy spec.

## See also

- `2026-05-11-robin-v2-evolution-roadmap.md` — umbrella.
- `2026-05-11-robin-v2-database-and-memory-redesign-design.md` — original scope conventions (§9).
- `docs/architecture.md`, `docs/faculties.md` — to be updated.
