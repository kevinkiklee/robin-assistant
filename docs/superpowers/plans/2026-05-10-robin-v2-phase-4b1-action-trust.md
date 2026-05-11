# Phase 4b.1 — Action-Trust Ledger — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Ship the per-(tool, action) trust ledger + AUTO/ASK/NEVER pre-call gates wired into the three existing outbound tools, with manual user promotion via CLI/MCP and auto-demotion on `record_correction`.

**Architecture:** New `action_trust` table; `src/jobs/action-trust.js` helpers; 2 new MCP tools (`check_action`, `update_action_policy`); 4 CLI commands (`robin actions <list|show|set|reset>`); 3 outbound tools wrapped with a pre-check + post-success outcome recording; `record_correction` extended with optional `tool`+`action` args that trigger demotion.

**Spec:** `docs/superpowers/specs/2026-05-10-robin-v2-phase-4b1-action-trust-design.md` (commit `d10032a`).

**Coordination note (every subagent):**
- Avoid 4f territory: `src/capture/`, `src/hooks/handlers/`, `src/daemon/sessions.js`, `runtime_sessions`, `runtime_auto_recall_telemetry`, `src/cli/commands/biographer-*`.
- **Rename pass in working tree** affecting ~40 files. Stage by explicit path ONLY. Never `git add -A` or `git add .`. Run `git status` before staging and confirm only your authored files are queued.

---

## File map

**New:**
```
src/schema/migrations/0012-action-trust.surql
src/jobs/action-trust.js
src/mcp/tools/check-action.js
src/mcp/tools/update-action-policy.js
src/cli/commands/actions-list.js
src/cli/commands/actions-show.js
src/cli/commands/actions-set.js
src/cli/commands/actions-reset.js
tests/unit/action-trust.test.js
tests/unit/check-action.test.js
tests/unit/update-action-policy.test.js
tests/unit/discord-send-trust.test.js
tests/unit/github-write-trust.test.js
tests/unit/spotify-write-trust.test.js
tests/unit/actions-cli.test.js
tests/unit/record-correction-demote.test.js
tests/unit/agents-md-actions.test.js
tests/integration/actions-roundtrip.test.js
```

**Modified (additive only):**
```
src/integrations/discord/tools/discord-send.js        # pre-check + post-success
src/integrations/github_write/tools/github-write.js   # pre-check + post-success per action
src/integrations/spotify_write/tools/spotify-write.js # pre-check + post-success per action
src/mcp/tools/record-correction.js                    # optional tool+action → auto-demote
src/cli/index.js                                      # `actions` dispatcher
src/daemon/server.js                                  # 2 MCP tool registrations + 2 /internal/actions/* endpoints
src/install/agents-md.js                              # robin-actions block
```

---

## Wave plan (parallelism)

| Wave | Tasks | Parallel agents |
|---|---|---|
| 1 | 1 (migration+helpers), 2 (check_action), 3 (update_action_policy) | 3 |
| 2 | 4 (discord_send wrap), 5 (github_write wrap), 6 (spotify_write wrap) | 3 |
| 3 | 7 (CLI list+show), 8 (CLI set+reset) | 2 |
| 4 | 9 (daemon wiring + AGENTS.md + record_correction demote wiring) | 1 |
| 5 | 10 (integration roundtrip) | 1 |

10 implementer subagents total + 1 reviewer per wave = ~15 subagents.

---

## Task 1: Migration 0012 + `action-trust.js` helpers

**Files:** create `src/schema/migrations/0012-action-trust.surql`, `src/jobs/action-trust.js`, `tests/unit/action-trust.test.js`.

- [ ] **Step 1: Write the migration**

```sql
-- 0012-action-trust.surql — per-(tool, action_template) trust ledger.
DEFINE TABLE action_trust SCHEMAFULL;
DEFINE FIELD class            ON action_trust TYPE string;
DEFINE FIELD state            ON action_trust TYPE string ASSERT $value IN ['AUTO', 'ASK', 'NEVER'];
DEFINE FIELD set_by           ON action_trust TYPE string ASSERT $value IN ['user', 'correction', 'default'];
DEFINE FIELD success_count    ON action_trust TYPE int DEFAULT 0;
DEFINE FIELD correction_count ON action_trust TYPE int DEFAULT 0;
DEFINE FIELD last_used_at     ON action_trust TYPE option<datetime>;
DEFINE FIELD last_state_change_at ON action_trust TYPE datetime DEFAULT time::now();
DEFINE FIELD updated_at       ON action_trust TYPE datetime VALUE time::now();
DEFINE INDEX action_trust_class ON action_trust FIELDS class UNIQUE;
```

- [ ] **Step 2: Write failing tests**

```js
// tests/unit/action-trust.test.js
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import {
  checkActionTrust,
  demoteOnCorrection,
  getActionTrust,
  listActionTrust,
  recordOutcome,
  resetActionTrust,
  setActionTrust,
} from '../../src/jobs/action-trust.js';

import { writeConfig as __wc } from '../../src/runtime/config.js';

const __h = join(tmpdir(), `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
mkdirSync(__h, { recursive: true });
process.env.ROBIN_HOME = __h;
await __wc({ embedder_profile: 'mxbai-1024' });

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  return db;
}

test('checkActionTrust — auto-creates with default ASK on first sight', async () => {
  const db = await fresh();
  const r = await checkActionTrust(db, 'discord_send', 'send_dm');
  assert.equal(r.class, 'discord_send:send_dm');
  assert.equal(r.state, 'ASK');
  assert.equal(r.set_by, 'default');
  assert.ok(r.last_state_change_at instanceof Date);
  await close(db);
});

test('checkActionTrust — idempotent on repeat call', async () => {
  const db = await fresh();
  const a = await checkActionTrust(db, 'discord_send', 'send_dm');
  const b = await checkActionTrust(db, 'discord_send', 'send_dm');
  assert.equal(a.class, b.class);
  // Same row, same last_state_change_at
  assert.equal(+a.last_state_change_at, +b.last_state_change_at);
  await close(db);
});

test('setActionTrust — flips state + updates set_by + last_state_change_at', async () => {
  const db = await fresh();
  await checkActionTrust(db, 'spotify_write', 'queue');
  await new Promise((r) => setTimeout(r, 5));
  await setActionTrust(db, 'spotify_write:queue', 'AUTO', 'user');
  const r = await getActionTrust(db, 'spotify_write:queue');
  assert.equal(r.state, 'AUTO');
  assert.equal(r.set_by, 'user');
  await close(db);
});

test('recordOutcome — success increments success_count + last_used_at', async () => {
  const db = await fresh();
  await checkActionTrust(db, 'github_write', 'create-issue');
  await recordOutcome(db, 'github_write:create-issue', 'success');
  await recordOutcome(db, 'github_write:create-issue', 'success');
  const r = await getActionTrust(db, 'github_write:create-issue');
  assert.equal(r.success_count, 2);
  assert.ok(r.last_used_at instanceof Date);
  await close(db);
});

test('recordOutcome — correction on AUTO row auto-demotes to ASK with set_by=correction', async () => {
  const db = await fresh();
  await checkActionTrust(db, 'discord_send', 'send_channel');
  await setActionTrust(db, 'discord_send:send_channel', 'AUTO', 'user');
  await recordOutcome(db, 'discord_send:send_channel', 'correction');
  const r = await getActionTrust(db, 'discord_send:send_channel');
  assert.equal(r.state, 'ASK');
  assert.equal(r.set_by, 'correction');
  assert.equal(r.correction_count, 1);
  await close(db);
});

test('recordOutcome — correction on ASK row only increments count, no flip', async () => {
  const db = await fresh();
  await checkActionTrust(db, 'discord_send', 'send_dm');
  await recordOutcome(db, 'discord_send:send_dm', 'correction');
  const r = await getActionTrust(db, 'discord_send:send_dm');
  assert.equal(r.state, 'ASK');
  assert.equal(r.set_by, 'default');
  assert.equal(r.correction_count, 1);
  await close(db);
});

test('demoteOnCorrection — returns {demoted: true, from: AUTO} on flip', async () => {
  const db = await fresh();
  await checkActionTrust(db, 'spotify_write', 'queue');
  await setActionTrust(db, 'spotify_write:queue', 'AUTO', 'user');
  const r = await demoteOnCorrection(db, 'spotify_write:queue');
  assert.equal(r.demoted, true);
  assert.equal(r.from, 'AUTO');
  await close(db);
});

test('demoteOnCorrection — returns {demoted: false} when already ASK', async () => {
  const db = await fresh();
  await checkActionTrust(db, 'spotify_write', 'skip');
  const r = await demoteOnCorrection(db, 'spotify_write:skip');
  assert.equal(r.demoted, false);
  await close(db);
});

test('resetActionTrust — flips back to ASK + default, preserves counts', async () => {
  const db = await fresh();
  await checkActionTrust(db, 'github_write', 'comment');
  await setActionTrust(db, 'github_write:comment', 'AUTO', 'user');
  await recordOutcome(db, 'github_write:comment', 'success');
  await resetActionTrust(db, 'github_write:comment');
  const r = await getActionTrust(db, 'github_write:comment');
  assert.equal(r.state, 'ASK');
  assert.equal(r.set_by, 'default');
  assert.equal(r.success_count, 1, 'counts preserved');
  await close(db);
});

test('listActionTrust — returns all rows ordered by class', async () => {
  const db = await fresh();
  await checkActionTrust(db, 'spotify_write', 'queue');
  await checkActionTrust(db, 'discord_send', 'send_dm');
  await checkActionTrust(db, 'github_write', 'comment');
  const rows = await listActionTrust(db);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].class, 'discord_send:send_dm');
  assert.equal(rows[1].class, 'github_write:comment');
  assert.equal(rows[2].class, 'spotify_write:queue');
  await close(db);
});
```

- [ ] **Step 3: Run — fail (module not found)**

```
node --test --test-force-exit tests/unit/action-trust.test.js
```

- [ ] **Step 4: Implement `src/jobs/action-trust.js`**

```js
// src/jobs/action-trust.js
import { surql } from 'surrealdb';

function classOf(tool, action) {
  return `${tool}:${action}`;
}

export async function getActionTrust(db, cls) {
  const [rows] = await db
    .query(surql`SELECT * FROM action_trust WHERE class = ${cls} LIMIT 1`)
    .collect();
  return rows?.[0] ?? null;
}

export async function listActionTrust(db) {
  const [rows] = await db.query(surql`SELECT * FROM action_trust ORDER BY class ASC`).collect();
  return rows ?? [];
}

export async function checkActionTrust(db, tool, action) {
  const cls = classOf(tool, action);
  const existing = await getActionTrust(db, cls);
  if (existing) return existing;
  const row = {
    class: cls,
    state: 'ASK',
    set_by: 'default',
    success_count: 0,
    correction_count: 0,
    last_state_change_at: new Date(),
  };
  await db.query(surql`CREATE action_trust CONTENT ${row}`).collect();
  return await getActionTrust(db, cls);
}

export async function setActionTrust(db, cls, state, set_by) {
  await checkActionTrust(db, cls.split(':')[0], cls.split(':').slice(1).join(':') || '_default');
  await db
    .query(
      surql`UPDATE action_trust MERGE ${{
        state,
        set_by,
        last_state_change_at: new Date(),
      }} WHERE class = ${cls}`,
    )
    .collect();
}

export async function recordOutcome(db, cls, outcome) {
  const row = await getActionTrust(db, cls);
  if (!row) return;
  const patch = { last_used_at: new Date() };
  if (outcome === 'success') {
    patch.success_count = (row.success_count ?? 0) + 1;
  } else if (outcome === 'correction') {
    patch.correction_count = (row.correction_count ?? 0) + 1;
    if (row.state === 'AUTO') {
      patch.state = 'ASK';
      patch.set_by = 'correction';
      patch.last_state_change_at = new Date();
    }
  }
  await db
    .query(surql`UPDATE action_trust MERGE ${patch} WHERE class = ${cls}`)
    .collect();
}

export async function demoteOnCorrection(db, cls) {
  const row = await getActionTrust(db, cls);
  if (!row) return { demoted: false };
  if (row.state !== 'AUTO') {
    await recordOutcome(db, cls, 'correction');
    return { demoted: false };
  }
  await recordOutcome(db, cls, 'correction');
  return { demoted: true, from: 'AUTO' };
}

export async function resetActionTrust(db, cls) {
  const row = await getActionTrust(db, cls);
  if (!row) return;
  await db
    .query(
      surql`UPDATE action_trust MERGE ${{
        state: 'ASK',
        set_by: 'default',
        last_state_change_at: new Date(),
      }} WHERE class = ${cls}`,
    )
    .collect();
}
```

- [ ] **Step 5: Run — pass**

```
node --test --test-force-exit tests/unit/action-trust.test.js
```

Expected: 10 pass.

- [ ] **Step 6: Lint + commit (explicit paths)**

```
npm run lint
git status                              # verify only your 3 files staged
git add src/schema/migrations/0012-action-trust.surql src/jobs/action-trust.js tests/unit/action-trust.test.js
git commit -m "feat(4b.1): action-trust migration 0012 + helpers"
```

---

## Task 2: `check_action` MCP tool

**Files:** create `src/mcp/tools/check-action.js`, `tests/unit/check-action.test.js`.

- [ ] **Step 1: Write failing tests**

```js
// tests/unit/check-action.test.js
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { setActionTrust } from '../../src/jobs/action-trust.js';
import { createCheckActionTool } from '../../src/mcp/tools/check-action.js';

import { writeConfig as __wc } from '../../src/runtime/config.js';

const __h = join(tmpdir(), `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
mkdirSync(__h, { recursive: true });
process.env.ROBIN_HOME = __h;
await __wc({ embedder_profile: 'mxbai-1024' });

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  return db;
}

test('check_action — first sight returns ASK + default', async () => {
  const db = await fresh();
  const t = createCheckActionTool({ db });
  const r = await t.handler({ tool: 'discord_send', action: 'send_dm' });
  assert.equal(r.class, 'discord_send:send_dm');
  assert.equal(r.state, 'ASK');
  assert.equal(r.set_by, 'default');
  assert.equal(r.success_count, 0);
  await close(db);
});

test('check_action — reflects current state after manual flip', async () => {
  const db = await fresh();
  await setActionTrust(db, 'spotify_write:queue', 'AUTO', 'user');
  const t = createCheckActionTool({ db });
  const r = await t.handler({ tool: 'spotify_write', action: 'queue' });
  assert.equal(r.state, 'AUTO');
  assert.equal(r.set_by, 'user');
  await close(db);
});
```

- [ ] **Step 2: Run — fail**

- [ ] **Step 3: Implement**

```js
// src/mcp/tools/check-action.js
import { checkActionTrust } from '../../jobs/action-trust.js';

export function createCheckActionTool({ db }) {
  return {
    name: 'check_action',
    description: 'Read the trust state of a (tool, action) class. Auto-creates with state ASK on first sight. Read-only otherwise.',
    inputSchema: {
      type: 'object',
      properties: {
        tool: { type: 'string' },
        action: { type: 'string' },
      },
      required: ['tool', 'action'],
    },
    handler: async ({ tool, action }) => {
      const row = await checkActionTrust(db, tool, action);
      return {
        class: row.class,
        state: row.state,
        set_by: row.set_by,
        success_count: row.success_count ?? 0,
        correction_count: row.correction_count ?? 0,
        last_used_at: row.last_used_at ?? null,
        last_state_change_at: row.last_state_change_at,
      };
    },
  };
}
```

- [ ] **Step 4: Run — pass**

- [ ] **Step 5: Lint + commit (explicit paths)**

```
git add src/mcp/tools/check-action.js tests/unit/check-action.test.js
git commit -m "feat(4b.1): check_action MCP tool"
```

---

## Task 3: `update_action_policy` MCP tool

**Files:** create `src/mcp/tools/update-action-policy.js`, `tests/unit/update-action-policy.test.js`.

- [ ] **Step 1: Write failing tests**

```js
// tests/unit/update-action-policy.test.js
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { getActionTrust } from '../../src/jobs/action-trust.js';
import { createUpdateActionPolicyTool } from '../../src/mcp/tools/update-action-policy.js';

import { writeConfig as __wc } from '../../src/runtime/config.js';

const __h = join(tmpdir(), `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
mkdirSync(__h, { recursive: true });
process.env.ROBIN_HOME = __h;
await __wc({ embedder_profile: 'mxbai-1024' });

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  return db;
}

test('update_action_policy — sets AUTO with set_by user', async () => {
  const db = await fresh();
  const t = createUpdateActionPolicyTool({ db });
  const r = await t.handler({ class: 'discord_send:send_dm', state: 'AUTO' });
  assert.equal(r.ok, true);
  assert.equal(r.state, 'AUTO');
  const row = await getActionTrust(db, 'discord_send:send_dm');
  assert.equal(row.state, 'AUTO');
  assert.equal(row.set_by, 'user');
  await close(db);
});

test('update_action_policy — refuses invalid state', async () => {
  const db = await fresh();
  const t = createUpdateActionPolicyTool({ db });
  const r = await t.handler({ class: 'discord_send:send_dm', state: 'MAYBE' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'invalid_state');
  await close(db);
});

test('update_action_policy — refuses malformed class', async () => {
  const db = await fresh();
  const t = createUpdateActionPolicyTool({ db });
  const r = await t.handler({ class: 'not-valid-shape', state: 'AUTO' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'invalid_class');
  await close(db);
});
```

- [ ] **Step 2: Run — fail**

- [ ] **Step 3: Implement**

```js
// src/mcp/tools/update-action-policy.js
import { setActionTrust } from '../../jobs/action-trust.js';

const VALID_STATES = new Set(['AUTO', 'ASK', 'NEVER']);
const CLASS_PATTERN = /^[a-z_]+:[a-z_-]+$/;

export function createUpdateActionPolicyTool({ db }) {
  return {
    name: 'update_action_policy',
    description: 'Set the trust state for a (tool, action) class. Use when the user gives standing permission ("you can always X") or revokes it ("never X again").',
    inputSchema: {
      type: 'object',
      properties: {
        class: { type: 'string', pattern: '^[a-z_]+:[a-z_-]+$' },
        state: { type: 'string', enum: ['AUTO', 'ASK', 'NEVER'] },
      },
      required: ['class', 'state'],
    },
    handler: async ({ class: cls, state }) => {
      if (!CLASS_PATTERN.test(cls)) return { ok: false, reason: 'invalid_class' };
      if (!VALID_STATES.has(state)) return { ok: false, reason: 'invalid_state' };
      await setActionTrust(db, cls, state, 'user');
      return { ok: true, class: cls, state };
    },
  };
}
```

- [ ] **Step 4: Run — pass**

- [ ] **Step 5: Commit (explicit paths)**

```
git add src/mcp/tools/update-action-policy.js tests/unit/update-action-policy.test.js
git commit -m "feat(4b.1): update_action_policy MCP tool"
```

---

## Tasks 4, 5, 6: Wrap outbound tools (one per tool)

Each task follows the same pattern; the code below is the **shared template**. Each implementer adapts to its target tool's file shape.

### Shared pattern

For each outbound tool, modify the handler:

1. Read the existing import section. Add:
   ```js
   import { checkActionTrust, recordOutcome } from '../../../jobs/action-trust.js';
   ```
   (Adjust the relative path to match the tool's location in the tree.)

2. At handler entry, AFTER the rate-limit + missing-arg checks but BEFORE any auth/allowlist/policy checks, add:
   ```js
   const cls = `${TOOL_NAME}:${action}`;
   const trust = await checkActionTrust(db, TOOL_NAME, action);
   if (trust.state === 'NEVER') {
     return { ok: false, reason: 'action_not_allowed', class: cls };
   }
   if (trust.state === 'ASK' && args?.force !== true) {
     return {
       ok: false,
       reason: 'requires_permission',
       class: cls,
       last_state_change_at: trust.last_state_change_at,
     };
   }
   ```
   Where `TOOL_NAME` is the tool's literal name string (`'discord_send'`, `'github_write'`, `'spotify_write'`).

3. At each success-path point, BEFORE returning `{ok: true, ...}`, add:
   ```js
   await recordOutcome(db, cls, 'success');
   ```

4. Write a test file `tests/unit/<tool>-trust.test.js`. Each test:
   - **AUTO state** → call proceeds.
   - **ASK state, no force** → returns `{ok:false, reason:'requires_permission', class}`.
   - **ASK state, force:true** → call proceeds.
   - **NEVER state** → returns `{ok:false, reason:'action_not_allowed'}` regardless of force.
   - **Successful call** → `recordOutcome` was called (verify `success_count` post-call).

### Task 4: Wrap `discord_send`

- [ ] **Files:** modify `src/integrations/discord/tools/discord-send.js`; create `tests/unit/discord-send-trust.test.js`.

- [ ] **Step 1: Write failing tests** — see template above. Use `freshSetup` pattern from existing `tests/unit/discord-send.test.js`. Three action templates exist (`send_dm`, `send_channel`); test both with at least one ASK + AUTO + NEVER scenario.

- [ ] **Step 2: Run — fail (no trust gate yet)**

- [ ] **Step 3: Apply the shared pattern** to `src/integrations/discord/tools/discord-send.js`. Insert the check AFTER the rate-limit check, BEFORE the existing gateway/allowlist/outbound-policy checks. `recordOutcome` goes at both success returns (DM and channel).

- [ ] **Step 4: Run — pass**. Also re-run `tests/unit/discord-send.test.js` to confirm no existing-test regression.

```
node --test --test-force-exit tests/unit/discord-send-trust.test.js tests/unit/discord-send.test.js
```

- [ ] **Step 5: Commit**

```
git add src/integrations/discord/tools/discord-send.js tests/unit/discord-send-trust.test.js
git commit -m "feat(4b.1): wrap discord_send with action-trust gate"
```

### Task 5: Wrap `github_write`

Same pattern. `src/integrations/github_write/tools/github-write.js`. 4 actions (`create-issue`, `comment`, `label`, `mark-read`). New test: `tests/unit/github-write-trust.test.js`. Mirror existing `tests/unit/github-write-tool.test.js` setup pattern.

Commit message: `feat(4b.1): wrap github_write with action-trust gate`.

### Task 6: Wrap `spotify_write`

Same pattern. `src/integrations/spotify_write/tools/spotify-write.js`. 3 actions (`queue`, `skip`, `playlist-add`). New test: `tests/unit/spotify-write-trust.test.js`. Mirror existing `tests/unit/spotify-write-tool.test.js`.

Commit message: `feat(4b.1): wrap spotify_write with action-trust gate`.

---

## Task 7: CLI `robin actions list` + `show`

**Files:** create `src/cli/commands/actions-list.js`, `src/cli/commands/actions-show.js`, `tests/unit/actions-cli.test.js`.

- [ ] **Step 1: Write failing tests for list + show**

```js
// tests/unit/actions-cli.test.js  (this file grows in tasks 7 + 8)
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { writeConfig as __wc } from '../../src/runtime/config.js';

const __h = join(tmpdir(), `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
mkdirSync(__h, { recursive: true });
process.env.ROBIN_HOME = __h;
await __wc({ embedder_profile: 'mxbai-1024' });

const { actionsList } = await import('../../src/cli/commands/actions-list.js');
const { actionsShow } = await import('../../src/cli/commands/actions-show.js');

function capture() {
  const lines = [];
  return { lines, fn: (s) => lines.push(s) };
}

test('actions list — empty', async () => {
  const out = capture();
  await actionsList([], { out: out.fn, listActionTrust: async () => [] });
  assert.match(out.lines.join('\n'), /\(no action classes/);
});

test('actions list — formats rows', async () => {
  const out = capture();
  await actionsList([], {
    out: out.fn,
    listActionTrust: async () => [
      { class: 'discord_send:send_dm', state: 'AUTO', set_by: 'user', success_count: 5, correction_count: 0, last_used_at: new Date('2026-05-10T12:00:00Z'), last_state_change_at: new Date('2026-05-09T12:00:00Z') },
      { class: 'github_write:comment', state: 'ASK', set_by: 'default', success_count: 0, correction_count: 0, last_used_at: null, last_state_change_at: new Date('2026-05-08T12:00:00Z') },
    ],
  });
  const all = out.lines.join('\n');
  assert.match(all, /discord_send:send_dm\s+AUTO/);
  assert.match(all, /github_write:comment\s+ASK/);
});

test('actions show — prints all fields', async () => {
  const out = capture();
  await actionsShow(['discord_send:send_dm'], {
    out: out.fn,
    getActionTrust: async () => ({
      class: 'discord_send:send_dm',
      state: 'AUTO',
      set_by: 'user',
      success_count: 3,
      correction_count: 1,
      last_used_at: new Date('2026-05-10T12:00:00Z'),
      last_state_change_at: new Date('2026-05-09T12:00:00Z'),
    }),
  });
  const all = out.lines.join('\n');
  assert.match(all, /class: discord_send:send_dm/);
  assert.match(all, /state: AUTO/);
  assert.match(all, /set_by: user/);
  assert.match(all, /correction_count: 1/);
});

test('actions show — unknown class', async () => {
  const out = capture();
  const err = capture();
  await actionsShow(['nope:nope'], { out: out.fn, err: err.fn, getActionTrust: async () => null });
  assert.match(err.lines.join('\n'), /no such action class/);
});
```

- [ ] **Step 2: Run — fail**

- [ ] **Step 3: Implement**

```js
// src/cli/commands/actions-list.js
import { close, connect } from '../../db/client.js';
import { listActionTrust as defaultList } from '../../jobs/action-trust.js';
import { ensureHome, paths } from '../../runtime/home.js';

function fmt(d) {
  return d ? new Date(d).toISOString() : '—';
}

export async function actionsList(_argv = [], deps = {}) {
  const out = deps.out ?? ((s) => console.log(s));
  const list = deps.listActionTrust ?? (async () => {
    await ensureHome();
    const p = paths();
    const db = await connect({ engine: `rocksdb://${p.db}` });
    try {
      return await defaultList(db);
    } finally {
      await close(db);
    }
  });
  const rows = await list();
  if (rows.length === 0) {
    out('(no action classes — none invoked yet)');
    return;
  }
  out(`class                          state    set_by       successes  corrections  last_used                  last_change`);
  for (const r of rows) {
    out(
      `${r.class.padEnd(30)} ${r.state.padEnd(8)} ${r.set_by.padEnd(12)} ${String(r.success_count).padStart(9)}  ${String(r.correction_count).padStart(11)}  ${fmt(r.last_used_at).padEnd(25)} ${fmt(r.last_state_change_at)}`,
    );
  }
}
```

```js
// src/cli/commands/actions-show.js
import { close, connect } from '../../db/client.js';
import { getActionTrust as defaultGet } from '../../jobs/action-trust.js';
import { ensureHome, paths } from '../../runtime/home.js';

export async function actionsShow(argv = [], deps = {}) {
  const out = deps.out ?? ((s) => console.log(s));
  const err = deps.err ?? ((s) => console.error(s));
  const cls = argv[0];
  if (!cls) {
    err('usage: robin actions show <class>');
    process.exitCode = 1;
    return;
  }
  const fetch = deps.getActionTrust ?? (async (c) => {
    await ensureHome();
    const p = paths();
    const db = await connect({ engine: `rocksdb://${p.db}` });
    try {
      return await defaultGet(db, c);
    } finally {
      await close(db);
    }
  });
  const row = await fetch(cls);
  if (!row) {
    err(`no such action class: ${cls}`);
    process.exitCode = 1;
    return;
  }
  const fields = [
    'class', 'state', 'set_by',
    'success_count', 'correction_count',
    'last_used_at', 'last_state_change_at',
  ];
  for (const f of fields) {
    const v = row[f];
    out(`${f}: ${v instanceof Date ? v.toISOString() : v}`);
  }
}
```

- [ ] **Step 4: Run — pass**

- [ ] **Step 5: Commit (explicit paths)**

```
git add src/cli/commands/actions-list.js src/cli/commands/actions-show.js tests/unit/actions-cli.test.js
git commit -m "feat(4b.1): robin actions list + show CLI"
```

---

## Task 8: CLI `robin actions set` + `reset`

**Files:** create `src/cli/commands/actions-set.js`, `src/cli/commands/actions-reset.js`. Append tests to `tests/unit/actions-cli.test.js`.

- [ ] **Step 1: Append failing tests**

```js
// tests/unit/actions-cli.test.js (additions)
import { actionsSet } from '../../src/cli/commands/actions-set.js';
import { actionsReset } from '../../src/cli/commands/actions-reset.js';

test('actions set — POSTs class + state to daemon', async () => {
  let posted;
  await actionsSet(['discord_send:send_dm', 'AUTO'], {
    out: () => {},
    daemonRequest: async (path, body) => {
      posted = { path, body };
      return { ok: true, class: 'discord_send:send_dm', state: 'AUTO' };
    },
  });
  assert.equal(posted.path, '/internal/actions/set');
  assert.deepEqual(posted.body, { class: 'discord_send:send_dm', state: 'AUTO' });
});

test('actions set — refuses lowercase state input', async () => {
  let posted;
  await actionsSet(['discord_send:send_dm', 'auto'], {
    out: () => {},
    daemonRequest: async (path, body) => {
      posted = { path, body };
      return { ok: true };
    },
  });
  // Should normalize to uppercase
  assert.equal(posted.body.state, 'AUTO');
});

test('actions reset — POSTs class to daemon', async () => {
  let posted;
  await actionsReset(['github_write:comment'], {
    out: () => {},
    daemonRequest: async (path, body) => {
      posted = { path, body };
      return { ok: true };
    },
  });
  assert.equal(posted.path, '/internal/actions/reset');
  assert.deepEqual(posted.body, { class: 'github_write:comment' });
});
```

- [ ] **Step 2: Run — fail**

- [ ] **Step 3: Implement**

```js
// src/cli/commands/actions-set.js
import { daemonRequest as defaultRequest } from '../daemon-request.js';

export async function actionsSet(argv = [], deps = {}) {
  const out = deps.out ?? ((s) => console.log(s));
  const err = deps.err ?? ((s) => console.error(s));
  const request = deps.daemonRequest ?? defaultRequest;
  const cls = argv[0];
  const state = (argv[1] ?? '').toUpperCase();
  if (!cls || !['AUTO', 'ASK', 'NEVER'].includes(state)) {
    err('usage: robin actions set <class> <auto|ask|never>');
    process.exitCode = 1;
    return;
  }
  const r = await request('/internal/actions/set', { class: cls, state });
  if (r?.ok) {
    out(`${cls} → ${state}`);
  } else {
    err(`set failed: ${r?.reason ?? 'unknown'}`);
    process.exitCode = 1;
  }
}
```

```js
// src/cli/commands/actions-reset.js
import { daemonRequest as defaultRequest } from '../daemon-request.js';

export async function actionsReset(argv = [], deps = {}) {
  const out = deps.out ?? ((s) => console.log(s));
  const err = deps.err ?? ((s) => console.error(s));
  const request = deps.daemonRequest ?? defaultRequest;
  const cls = argv[0];
  if (!cls) {
    err('usage: robin actions reset <class>');
    process.exitCode = 1;
    return;
  }
  const r = await request('/internal/actions/reset', { class: cls });
  if (r?.ok) {
    out(`${cls} → ASK (default)`);
  } else {
    err(`reset failed: ${r?.reason ?? 'unknown'}`);
    process.exitCode = 1;
  }
}
```

- [ ] **Step 4: Run — pass**

- [ ] **Step 5: Commit (explicit paths)**

```
git add src/cli/commands/actions-set.js src/cli/commands/actions-reset.js tests/unit/actions-cli.test.js
git commit -m "feat(4b.1): robin actions set + reset CLI"
```

---

## Task 9: Daemon wiring + AGENTS.md block + `record_correction` demote

**Files:** modify `src/daemon/server.js`, `src/cli/index.js`, `src/install/agents-md.js`, `src/mcp/tools/record-correction.js`; create `tests/unit/record-correction-demote.test.js`, `tests/unit/agents-md-actions.test.js`.

- [ ] **Step 1: Write failing tests**

```js
// tests/unit/agents-md-actions.test.js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentsMdContent } from '../../src/install/agents-md.js';

test('robin-actions block exists', () => {
  const md = agentsMdContent({});
  assert.match(md, /<!-- robin-actions:start/);
  assert.match(md, /<!-- robin-actions:end -->/);
});

test('robin-actions describes AUTO/ASK/NEVER', () => {
  const md = agentsMdContent({});
  assert.match(md, /AUTO/);
  assert.match(md, /ASK/);
  assert.match(md, /NEVER/);
});

test('robin-actions mentions force:true and update_action_policy', () => {
  const md = agentsMdContent({});
  assert.match(md, /force:\s*true|force: true/);
  assert.match(md, /update_action_policy/);
});
```

```js
// tests/unit/record-correction-demote.test.js
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createStubEmbedder } from '../../src/embed/embedder.js';
import { getActionTrust, setActionTrust } from '../../src/jobs/action-trust.js';
import { createRecordCorrectionTool } from '../../src/mcp/tools/record-correction.js';

import { writeConfig as __wc } from '../../src/runtime/config.js';

const __h = join(tmpdir(), `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
mkdirSync(__h, { recursive: true });
process.env.ROBIN_HOME = __h;
await __wc({ embedder_profile: 'mxbai-1024' });

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  const embedder = createStubEmbedder({ dimension: 1024 });
  return { db, embedder };
}

test('record_correction with tool+action demotes AUTO → ASK', async () => {
  const { db, embedder } = await fresh();
  await setActionTrust(db, 'discord_send:send_dm', 'AUTO', 'user');
  const t = createRecordCorrectionTool({ db, embedder, processor: async () => {} });
  const r = await t.handler({
    content: 'that DM went to the wrong person',
    tool: 'discord_send',
    action: 'send_dm',
  });
  assert.equal(r.demoted_class, 'discord_send:send_dm');
  const row = await getActionTrust(db, 'discord_send:send_dm');
  assert.equal(row.state, 'ASK');
  assert.equal(row.set_by, 'correction');
  await close(db);
});

test('record_correction without tool+action does not touch action_trust', async () => {
  const { db, embedder } = await fresh();
  const t = createRecordCorrectionTool({ db, embedder, processor: async () => {} });
  const r = await t.handler({ content: 'general correction, not an action' });
  assert.ok(!('demoted_class' in r) || r.demoted_class == null);
  await close(db);
});
```

- [ ] **Step 2: Run — fail**

- [ ] **Step 3: Modify `src/install/agents-md.js`**

Read the file first to find the existing `knowledgeOpsSection` and template-literal section ordering. Add a new exported function `actionsSection()` near `knowledgeOpsSection`:

```js
export function actionsSection() {
  return `<!-- robin-actions:start (auto-generated, do not hand-edit) -->
## Action policy (AUTO / ASK / NEVER)

Outbound tools (\`discord_send\`, \`github_write\`, \`spotify_write\`, and
future writes) have a per-action trust state. Each (tool, action) is its
own class — e.g. \`discord_send:send_dm\`, \`github_write:create-issue\`.

- **AUTO** — proceed without asking.
- **ASK** — the tool refuses with \`{ ok: false, reason: 'requires_permission', class }\`.
  Surface this to the user. If the user authorizes, retry with
  \`args.force = true\` THIS TURN ONLY. Don't auto-force; the user has
  to actually say yes.
- **NEVER** — the tool refuses regardless of \`force\`. To resume use,
  the user must run \`robin actions set <class> ASK\` (or you can call
  \`update_action_policy({class, state: 'ASK'})\` on their explicit behalf).

Default for any new (tool, action) class is **ASK**. State auto-demotes
AUTO → ASK when you call \`record_correction({tool, action, ...})\` —
one correction is enough.

When the user gives **standing** permission ("you can always queue songs
for me"), call \`update_action_policy({class: 'spotify_write:queue', state: 'AUTO'})\`.
When they revoke ("don't ever do that again"), set state to 'NEVER'.

Use \`check_action({tool, action})\` to peek the state before planning
a multi-step action.
<!-- robin-actions:end -->`;
}
```

In `agentsMdContent`, insert `\n\n${actionsSection()}` after `${knowledgeOpsSection()}` (or wherever the knowledge-ops block currently lives). Don't change other section order.

- [ ] **Step 4: Modify `src/mcp/tools/record-correction.js`**

Read the file. The existing handler accepts `{content, ...}`. Add to `inputSchema.properties`:
```js
tool: { type: 'string' },
action: { type: 'string' },
```
(Don't add to `required`.)

In the handler, after the existing correction-event write but BEFORE returning, add:
```js
let demoted_class = null;
if (input.tool && input.action) {
  const cls = `${input.tool}:${input.action}`;
  const { demoteOnCorrection } = await import('../../jobs/action-trust.js');
  const r = await demoteOnCorrection(db, cls);
  if (r.demoted) demoted_class = cls;
}
return { ...existingReturn, demoted_class };
```

Adapt if the existing handler's return shape doesn't use `...existingReturn` — preserve current fields and add `demoted_class`. If the tool is in 4f-renamed territory now, find the renamed version and add the demote logic there (it might be `src/mcp/tools/record-reflection.js` after the 4f rename pass — verify before editing).

- [ ] **Step 5: Modify `src/daemon/server.js`**

Read first. Find the import block. Add:
```js
import { createCheckActionTool } from '../mcp/tools/check-action.js';
import { createUpdateActionPolicyTool } from '../mcp/tools/update-action-policy.js';
import { resetActionTrust, setActionTrust } from '../jobs/action-trust.js';
```

In the `tools` array, after the knowledge-ops tool registrations (Phase 4c), add:
```js
createCheckActionTool({ db: dbHandle }),
createUpdateActionPolicyTool({ db: dbHandle }),
```

In the HTTP handler, after the `/internal/knowledge/audit` handler, add:
```js
if (req.method === 'POST' && req.url === '/internal/actions/set') {
  const body = await readJsonBody(req);
  if (!body?.class || !['AUTO', 'ASK', 'NEVER'].includes(body?.state)) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, reason: 'invalid_input' }));
    return;
  }
  await setActionTrust(dbHandle, body.class, body.state, 'user');
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, class: body.class, state: body.state }));
  return;
}
if (req.method === 'POST' && req.url === '/internal/actions/reset') {
  const body = await readJsonBody(req);
  if (!body?.class) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, reason: 'missing_class' }));
    return;
  }
  await resetActionTrust(dbHandle, body.class);
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, class: body.class, state: 'ASK' }));
  return;
}
```

Match the existing helper names — if the file uses `parseBody` instead of `readJsonBody`, etc., adapt.

- [ ] **Step 6: Modify `src/cli/index.js`**

After the existing `if (cmd === 'audit')` block (Phase 4c), add:

```js
if (cmd === 'actions') {
  const sub = argv[1];
  if (sub === 'list') {
    const { actionsList } = await import('./commands/actions-list.js');
    return actionsList(argv.slice(2));
  }
  if (sub === 'show') {
    const { actionsShow } = await import('./commands/actions-show.js');
    return actionsShow(argv.slice(2));
  }
  if (sub === 'set') {
    const { actionsSet } = await import('./commands/actions-set.js');
    return actionsSet(argv.slice(2));
  }
  if (sub === 'reset') {
    const { actionsReset } = await import('./commands/actions-reset.js');
    return actionsReset(argv.slice(2));
  }
  console.error('usage: robin actions <list|show|set|reset>');
  process.exit(1);
}
```

- [ ] **Step 7: Run tests + daemon integration tests**

```
node --test --test-force-exit tests/unit/agents-md-actions.test.js tests/unit/record-correction-demote.test.js tests/integration/mcp-end-to-end.test.js tests/integration/scheduler-multi-integration.test.js
```

All must pass. If a daemon test breaks, you broke wiring — fix before committing.

- [ ] **Step 8: Lint + commit (explicit paths)**

```
npm run lint
git add src/daemon/server.js src/cli/index.js src/install/agents-md.js \
        src/mcp/tools/record-correction.js \
        tests/unit/agents-md-actions.test.js tests/unit/record-correction-demote.test.js
git commit -m "feat(4b.1): daemon wires action policy + AGENTS.md + record_correction demote"
```

---

## Task 10: Integration roundtrip

**Files:** create `tests/integration/actions-roundtrip.test.js`.

- [ ] **Step 1: Write the integration test**

```js
// tests/integration/actions-roundtrip.test.js
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createStubEmbedder } from '../../src/embed/embedder.js';
import { createCapture } from '../../src/integrations/_framework/capture.js';
import {
  checkActionTrust,
  demoteOnCorrection,
  getActionTrust,
  setActionTrust,
} from '../../src/jobs/action-trust.js';
import { createDiscordSendTool } from '../../src/integrations/discord/tools/discord-send.js';

import { writeConfig as __wc } from '../../src/runtime/config.js';

const __h = join(tmpdir(), `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
mkdirSync(__h, { recursive: true });
process.env.ROBIN_HOME = __h;
await __wc({ embedder_profile: 'mxbai-1024' });

const mockClient = () => ({
  users: {
    fetch: async (id) => ({ id, send: async () => ({ id: 'msg-1', channelId: 'dm-1' }) }),
  },
  channels: { fetch: async () => null },
});

test('actions roundtrip: ASK by default → user promotes → AUTO → correction demotes', async () => {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  const embedder = createStubEmbedder({ dimension: 1024 });
  const capture = createCapture({
    db, embedder, source: 'discord_send', embed: false, mode: 'insert-or-skip',
  });
  process.env.DISCORD_ALLOWED_USER_IDS = 'u1';

  const tool = createDiscordSendTool({ db, capture, getGatewayClient: () => mockClient() });

  // 1. First call: defaults to ASK → refuses
  let r = await tool.handler({ action: 'send_dm', args: { user_id: 'u1', content: 'hello' } });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'requires_permission');
  assert.equal(r.class, 'discord_send:send_dm');

  // 2. User authorizes this turn only: force:true succeeds
  r = await tool.handler({ action: 'send_dm', args: { user_id: 'u1', content: 'hello', force: true } });
  assert.equal(r.ok, true);

  // 3. User gives standing permission via setActionTrust
  await setActionTrust(db, 'discord_send:send_dm', 'AUTO', 'user');

  // 4. Next call without force succeeds
  r = await tool.handler({ action: 'send_dm', args: { user_id: 'u1', content: 'second send' } });
  assert.equal(r.ok, true);

  // 5. User corrects — demote
  const d = await demoteOnCorrection(db, 'discord_send:send_dm');
  assert.equal(d.demoted, true);
  assert.equal(d.from, 'AUTO');

  // 6. Next call without force refuses again
  r = await tool.handler({ action: 'send_dm', args: { user_id: 'u1', content: 'third send' } });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'requires_permission');

  // 7. Trust row reflects all of this
  const row = await getActionTrust(db, 'discord_send:send_dm');
  assert.equal(row.state, 'ASK');
  assert.equal(row.set_by, 'correction');
  assert.equal(row.success_count, 2, 'two prior successes recorded');
  assert.equal(row.correction_count, 1);

  Reflect.deleteProperty(process.env, 'DISCORD_ALLOWED_USER_IDS');
  await close(db);
});
```

- [ ] **Step 2: Run — pass**

- [ ] **Step 3: Run full test suite (skipping 4f hung file)**

```
node --test --test-force-exit $(find tests -name "*.test.js" | grep -v biographer-process-pending-captures | tr '\n' ' ') 2>&1 | tail -5
```

- [ ] **Step 4: Commit**

```
git add tests/integration/actions-roundtrip.test.js
git commit -m "test(4b.1): integration roundtrip — ASK→AUTO→correction→ASK"
```

---

## Self-review checklist (filled)

**Spec coverage:**
- §4 schema → Task 1
- §5 helpers → Task 1
- §6.1 in-tool gate → Tasks 4, 5, 6
- §6.2 demote-on-correction → Task 9
- §6.3 manual state flip → Tasks 7, 8, 9 (CLI + MCP + daemon endpoints)
- §7 MCP tools → Tasks 2, 3
- §8 CLI → Tasks 7, 8
- §9 daemon endpoints → Task 9
- §10 AGENTS.md → Task 9
- §11 tool wrapping → Tasks 4, 5, 6
- §12 record_correction wiring → Task 9
- §13 tests → all tasks
- §17 exit criteria → Task 10 + per-task acceptance

**Placeholder scan:** No TBDs.

**Type consistency:** `checkActionTrust(db, tool, action)` and `setActionTrust(db, class, state, set_by)` and `recordOutcome(db, class, outcome)` signatures used identically across tasks.
