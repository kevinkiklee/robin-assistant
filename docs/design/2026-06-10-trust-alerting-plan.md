# Trust & Alerting Layer (Phase A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persistent alert history + staleness/degraded/crash-loop/job-failure detection, surfaced via CLI, MCP, doctor, and the morning brief — so Robin's silent failures become loud.

**Architecture:** Detection is implemented as invariants run by the existing health monitor (`system/kernel/runtime/health-monitor.ts`, 1-minute cadence). A new `alert-store` module persists open/resolved alerts with dedup-by-`(source,key)`; the monitor writes/resolves alerts from invariant reports generically. New invariants: integration staleness (keyed on last successful tick), degraded streams, errored jobs, crash loops. Surfaces read the table.

**Tech Stack:** TypeScript ESM (Node 24), better-sqlite3 via `RobinDb`, `node:test` + `node:assert/strict` collocated tests, zod policies schema, cron-parser via `system/kernel/scheduler/cron.ts`.

**Spec:** `docs/design/2026-06-10-trust-feedback-memory-design.md` (Phase A).

**Conventions for every task:** run a single test file with `pnpm exec tsx --test <file>`; full gates at the end are `pnpm lint && pnpm typecheck && pnpm test`. Commit after each task. The pre-commit hook auto-formats — never `git add -A` (the autonomous daemon edits this tree concurrently); always stage explicit paths.

---

### Task 1: `alerts` table migration

**Files:**
- Create: `system/brain/memory/migrations/024-alerts.ts`
- Modify: `system/brain/memory/migrations/index.ts`

If slot 024 is taken by the time you start (the autonomous loop also lands migrations), use the next free number everywhere in this plan.

- [ ] **Step 1: Write the migration**

```typescript
// system/brain/memory/migrations/024-alerts.ts
import type { Migration } from './types.ts';

export const migration024: Migration = {
  version: 24,
  name: 'alerts',
  up: (db) => {
    db.exec(`
      CREATE TABLE alerts (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        severity      TEXT NOT NULL CHECK (severity IN ('info','warning','critical')),
        source        TEXT NOT NULL,
        key           TEXT NOT NULL,
        message       TEXT NOT NULL,
        context_json  TEXT,
        first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_seen_at  TEXT NOT NULL DEFAULT (datetime('now')),
        fire_count    INTEGER NOT NULL DEFAULT 1,
        resolved_at   TEXT,
        acked_at      TEXT
      );
      CREATE UNIQUE INDEX alerts_open_unique
        ON alerts (source, key) WHERE resolved_at IS NULL;
      CREATE INDEX alerts_resolved_idx ON alerts (resolved_at);
    `);
  },
};
```

The partial unique index is the dedup invariant: at most one OPEN alert per `(source, key)`; resolved rows are immutable history.

- [ ] **Step 2: Register it**

In `system/brain/memory/migrations/index.ts`, add `import { migration024 } from './024-alerts.ts';` and append `migration024` to `allMigrations`.

- [ ] **Step 3: Verify migrations apply**

Run: `pnpm exec tsx --test system/brain/memory/migrations/runner.test.ts`
Expected: PASS (runner tests apply all registered migrations against a temp DB).

- [ ] **Step 4: Commit**

```bash
git add system/brain/memory/migrations/024-alerts.ts system/brain/memory/migrations/index.ts
git commit -m "feat(alerts): alerts table migration (dedup-by-open-key)"
```

---

### Task 2: alert-store module

**Files:**
- Create: `system/kernel/runtime/alert-store.ts`
- Test: `system/kernel/runtime/alert-store.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// system/kernel/runtime/alert-store.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openTestDb } from '../../brain/memory/test-helpers.ts'; // if absent: openDb(':memory:') + applyMigrations — copy the pattern from alert-free migration tests
import {
  ackAlert, listAlerts, pruneResolvedAlerts, recordAlert, resolveAlert,
} from './alert-store.ts';

function db() {
  return openTestDb(); // in-memory RobinDb with all migrations applied
}

test('recordAlert opens one row and dedups re-fires into it', () => {
  const d = db();
  const a = recordAlert(d, { severity: 'warning', source: 'invariant', key: 'integration.staleness:whoop', message: 'stale 13h' });
  const b = recordAlert(d, { severity: 'warning', source: 'invariant', key: 'integration.staleness:whoop', message: 'stale 14h' });
  assert.equal(a.id, b.id);
  const open = listAlerts(d, {});
  assert.equal(open.length, 1);
  assert.equal(open[0].fire_count, 2);
  assert.equal(open[0].message, 'stale 14h'); // message refreshed
});

test('recordAlert escalates severity in place, never downgrades', () => {
  const d = db();
  recordAlert(d, { severity: 'warning', source: 'invariant', key: 'k', message: 'm' });
  recordAlert(d, { severity: 'critical', source: 'invariant', key: 'k', message: 'm' });
  assert.equal(listAlerts(d, {})[0].severity, 'critical');
  recordAlert(d, { severity: 'warning', source: 'invariant', key: 'k', message: 'm' });
  assert.equal(listAlerts(d, {})[0].severity, 'critical');
});

test('resolveAlert stamps resolved_at; recurrence opens a new row', () => {
  const d = db();
  const a = recordAlert(d, { severity: 'warning', source: 'invariant', key: 'k', message: 'm' });
  resolveAlert(d, 'invariant', 'k');
  assert.equal(listAlerts(d, {}).length, 0);
  const b = recordAlert(d, { severity: 'warning', source: 'invariant', key: 'k', message: 'm' });
  assert.notEqual(a.id, b.id);
  assert.equal(listAlerts(d, { all: true }).length, 2);
});

test('resolveAlert on nothing open is a no-op', () => {
  const d = db();
  resolveAlert(d, 'invariant', 'never-fired'); // must not throw
});

test('ack hides from default list but row stays open', () => {
  const d = db();
  const a = recordAlert(d, { severity: 'warning', source: 'invariant', key: 'k', message: 'm' });
  ackAlert(d, a.id);
  assert.equal(listAlerts(d, {}).length, 0);
  assert.equal(listAlerts(d, { includeAcked: true }).length, 1);
});

test('pruneResolvedAlerts removes only old resolved rows', () => {
  const d = db();
  recordAlert(d, { severity: 'warning', source: 's', key: 'old', message: 'm' });
  resolveAlert(d, 's', 'old');
  d.prepare(`UPDATE alerts SET resolved_at = datetime('now','-40 days') WHERE key='old'`).run();
  recordAlert(d, { severity: 'warning', source: 's', key: 'live', message: 'm' });
  assert.equal(pruneResolvedAlerts(d, 30), 1);
  assert.equal(listAlerts(d, { all: true }).length, 1);
});
```

If `openTestDb` does not exist, create the in-memory helper inline in the test file: `openDb(':memory:')` + `applyMigrations(db)` (see any migration-using test for the exact import paths).

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec tsx --test system/kernel/runtime/alert-store.test.ts`
Expected: FAIL — module `./alert-store.ts` not found.

- [ ] **Step 3: Implement the store**

```typescript
// system/kernel/runtime/alert-store.ts
import type { RobinDb } from '../../brain/memory/db.ts'; // match the RobinDb import used in invariants/builtins/*.ts

export type AlertSeverity = 'info' | 'warning' | 'critical';
const RANK: Record<AlertSeverity, number> = { info: 0, warning: 1, critical: 2 };

export interface AlertRow {
  id: number; severity: AlertSeverity; source: string; key: string; message: string;
  context_json: string | null; first_seen_at: string; last_seen_at: string;
  fire_count: number; resolved_at: string | null; acked_at: string | null;
}

export interface RecordAlertInput {
  severity: AlertSeverity; source: string; key: string; message: string;
  context?: Record<string, unknown>;
}

/** Open or refresh the single open alert for (source,key). Never throws — alerting must not break callers. */
export function recordAlert(db: RobinDb, input: RecordAlertInput): AlertRow {
  const open = db
    .prepare(`SELECT * FROM alerts WHERE source=? AND key=? AND resolved_at IS NULL`)
    .get(input.source, input.key) as AlertRow | undefined;
  if (!open) {
    const r = db
      .prepare(`INSERT INTO alerts (severity, source, key, message, context_json) VALUES (?,?,?,?,?)`)
      .run(input.severity, input.source, input.key, input.message,
           input.context ? JSON.stringify(input.context) : null);
    return db.prepare(`SELECT * FROM alerts WHERE id=?`).get(r.lastInsertRowid) as AlertRow;
  }
  const severity = RANK[input.severity] > RANK[open.severity] ? input.severity : open.severity;
  db.prepare(
    `UPDATE alerts SET severity=?, message=?, context_json=COALESCE(?, context_json),
       last_seen_at=datetime('now'), fire_count=fire_count+1 WHERE id=?`,
  ).run(severity, input.message, input.context ? JSON.stringify(input.context) : null, open.id);
  return db.prepare(`SELECT * FROM alerts WHERE id=?`).get(open.id) as AlertRow;
}

export function resolveAlert(db: RobinDb, source: string, key: string): void {
  db.prepare(
    `UPDATE alerts SET resolved_at=datetime('now') WHERE source=? AND key=? AND resolved_at IS NULL`,
  ).run(source, key);
}

export function ackAlert(db: RobinDb, id: number): boolean {
  return db.prepare(`UPDATE alerts SET acked_at=datetime('now') WHERE id=? AND resolved_at IS NULL`)
    .run(id).changes > 0;
}

export function listAlerts(
  db: RobinDb,
  opts: { all?: boolean; includeAcked?: boolean },
): AlertRow[] {
  if (opts.all) return db.prepare(`SELECT * FROM alerts ORDER BY last_seen_at DESC`).all() as AlertRow[];
  const ackClause = opts.includeAcked ? '' : 'AND acked_at IS NULL';
  return db.prepare(
    `SELECT * FROM alerts WHERE resolved_at IS NULL ${ackClause} ORDER BY last_seen_at DESC`,
  ).all() as AlertRow[];
}

export function pruneResolvedAlerts(db: RobinDb, retentionDays: number): number {
  return db.prepare(
    `DELETE FROM alerts WHERE resolved_at IS NOT NULL AND resolved_at < datetime('now', ?)`,
  ).run(`-${retentionDays} days`).changes;
}
```

Verify the `RobinDb` import path against `system/kernel/invariants/builtins/integrations-healthy.ts` and match it.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec tsx --test system/kernel/runtime/alert-store.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add system/kernel/runtime/alert-store.ts system/kernel/runtime/alert-store.test.ts
git commit -m "feat(alerts): alert-store with open/refresh/escalate/resolve/ack/prune"
```

---

### Task 3: record last successful tick (`last_ok_at`)

The staleness invariant keys on the last successful tick (status ok), NOT last ingest — zero-new-data runs are healthy. `integration_state` is a key-value table; this adds one key.

**Files:**
- Modify: `system/integrations/_runtime/scheduler-glue.ts` (the heartbeat block at ~lines 61–104 that writes `last_attempt_at` / `consecutive_errors` / `last_skip_*`)
- Test: extend the existing `system/integrations/_runtime/scheduler-glue.test.ts`

- [ ] **Step 1: Write the failing test** (follow the file's existing heartbeat-assert pattern)

```typescript
test('heartbeat writes last_ok_at on ok ticks only', async () => {
  // arrange an integration whose tick returns { status: 'ok', ingested: 0 }, run one tick
  // assert: integration_state has (name, 'last_ok_at') with a fresh timestamp
  // arrange a tick returning { status: 'error', message: 'boom' }, run one tick
  // assert: last_ok_at is UNCHANGED (same value as before)
});
```

Write it concretely using the same fixtures/mocks the surrounding tests use (the file already constructs fake integrations and runs ticks — copy the nearest `status: 'skipped'` test and adapt).

- [ ] **Step 2: Run to verify it fails** — `pnpm exec tsx --test system/integrations/_runtime/scheduler-glue.test.ts`

- [ ] **Step 3: Implement** — in the heartbeat write block, alongside the existing `consecutive_errors` reset:

```typescript
if (result.status === 'ok') {
  setState(name, 'last_ok_at', new Date().toISOString()); // use the file's existing state-write helper
}
```

- [ ] **Step 4: Run to verify pass**, then full file: same command, expected all PASS.

- [ ] **Step 5: Commit**

```bash
git add system/integrations/_runtime/scheduler-glue.ts system/integrations/_runtime/scheduler-glue.test.ts
git commit -m "feat(integrations): record last_ok_at on successful ticks"
```

---

### Task 4: cadence helper

**Files:**
- Create: `system/kernel/invariants/builtins/cadence.ts`
- Test: `system/kernel/invariants/builtins/cadence.test.ts`

- [ ] **Step 1: Failing tests**

```typescript
// cadence.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cadenceMs } from './cadence.ts';

test('30-minute cron → 30min cadence', () => {
  assert.equal(cadenceMs('*/30 * * * *'), 30 * 60_000);
});
test('daily cron → 24h cadence', () => {
  assert.equal(cadenceMs('30 4 * * *'), 24 * 60 * 60_000);
});
test('invalid cron → null', () => {
  assert.equal(cadenceMs('not a cron'), null);
});
```

- [ ] **Step 2: Run to verify fail** — `pnpm exec tsx --test system/kernel/invariants/builtins/cadence.test.ts`

- [ ] **Step 3: Implement** using the existing parser (`getNextRunAt` from `system/kernel/scheduler/cron.ts`): take two consecutive next-run times from a fixed anchor and diff them.

```typescript
// cadence.ts
import { getNextRunAt } from '../../scheduler/cron.ts';

/** Expected interval between runs of a cron expression, in ms; null when unparseable. */
export function cadenceMs(cron: string): number | null {
  try {
    const anchor = new Date('2026-01-05T00:00:00Z'); // fixed Monday anchor → deterministic
    const a = getNextRunAt(cron, anchor);
    const b = getNextRunAt(cron, a);
    return b.getTime() - a.getTime();
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run to verify pass.**
- [ ] **Step 5: Commit** — `git add system/kernel/invariants/builtins/cadence.ts system/kernel/invariants/builtins/cadence.test.ts && git commit -m "feat(alerts): cadence helper for cron schedules"`

---

### Task 5: staleness + skip-streak invariant (with power suppression)

**Files:**
- Create: `system/kernel/invariants/builtins/integration-staleness.ts`
- Test: `system/kernel/invariants/builtins/integration-staleness.test.ts`
- Modify: `system/kernel/config/schema.ts` (policies: staleness overrides)

- [ ] **Step 1: Extend policies schema.** In `schema.ts`, add to the policies object (alongside `network`):

```typescript
export const alertsPolicySchema = z.object({
  staleness: z.record(z.string(), z.object({
    exempt: z.boolean().optional(),
    warn_multiplier: z.number().positive().optional(),     // default 3
    critical_multiplier: z.number().positive().optional(), // default 10
  })).default({}),
}).default({ staleness: {} });
```

Wire it into the parsed policies the same way `network` is wired (both the schema object and the `parse` composition near line 111). Run `pnpm typecheck` — expected clean.

- [ ] **Step 2: Failing tests.** The invariant is a factory taking everything injectable — no clocks read inside:

```typescript
// integration-staleness.test.ts — core cases (in-memory DB, helpers to seed integration_state KV rows)
test('healthy: recent last_ok_at → ok');
test('warning at >3× cadence without successful tick');
test('escalates to critical at >10× cadence');
test('zero-ingest ok ticks are healthy (last_ok_at fresh, last_ingest_at ancient) → ok');
test('3 consecutive skips with reason → warning carrying the reason verbatim');
test('exempt integration via policies override → ok');
test('suppressed while power.state !== active → ok');
test('suppressed while network.mode !== online → ok');
test('grace: power resumed less than one cadence ago → ok');
```

Each test seeds `integration_state` rows (`last_ok_at`, `last_skip_reason`, plus a `consecutive_skips` counter — see Step 3) and calls `check()` with a fixed `now`. Write them all concretely; seed helper:

```typescript
function seed(db: RobinDb, name: string, key: string, value: string) {
  db.prepare(
    `INSERT INTO integration_state (integration_name, key, value) VALUES (?,?,?)
     ON CONFLICT(integration_name, key) DO UPDATE SET value=excluded.value`,
  ).run(name, key, value);
}
```

- [ ] **Step 3: Implement.** Two pieces:

(a) In `scheduler-glue.ts`, next to the `last_skip_reason` write, maintain a `consecutive_skips` counter (increment on skip, reset to '0' on ok), mirroring how `consecutive_errors` is maintained. Add a test in `scheduler-glue.test.ts` for it (same shape as Task 3's).

(b) The invariant factory:

```typescript
// integration-staleness.ts
import type { Invariant } from '../types.ts';
import type { RobinDb } from '../../../brain/memory/db.ts';
import type { Policies } from '../../config/schema.ts';
import { cadenceMs } from './cadence.ts';

export interface ScheduledIntegration { name: string; cron: string }

export function integrationStalenessInvariant(
  db: RobinDb,
  opts: {
    integrations: () => ScheduledIntegration[]; // enabled, schedule-bearing only
    policies: () => Policies;
    now?: () => Date;
  },
): Invariant {
  const now = opts.now ?? (() => new Date());
  return {
    name: 'integrations.fresh',
    severity: 'warning', // per-integration criticality is carried in the report message; alert escalation is handled by the alert-store wiring (Task 8)
    symptom: 'An integration has not completed a successful tick for several cadences, or is skipping repeatedly.',
    cause: 'Expired OAuth, missing secret (silent skip), upstream outage, or a wedged tick.',
    fix: 'robin alerts → see reason; robin reauth <name> for OAuth; check secrets .env for skips.',
    check: () => {
      const p = opts.policies();
      if (p.power.state !== 'active' || p.network.mode !== 'online') return { ok: true };
      const resumedAt = p.power.since ? Date.parse(p.power.since) : 0;
      const stale: string[] = [];
      const critical: string[] = [];
      for (const integ of opts.integrations()) {
        const o = p.alerts.staleness[integ.name];
        if (o?.exempt) continue;
        const cad = cadenceMs(integ.cron);
        if (cad === null) continue;
        if (now().getTime() - resumedAt < cad) continue; // post-resume grace
        const row = (k: string) =>
          (db.prepare(`SELECT value FROM integration_state WHERE integration_name=? AND key=?`)
            .get(integ.name, k) as { value: string } | undefined)?.value;
        const skips = Number(row('consecutive_skips') ?? '0');
        if (skips >= 3) {
          stale.push(`${integ.name}: skipping (${row('last_skip_reason') ?? 'unknown reason'})`);
          continue;
        }
        const lastOk = row('last_ok_at');
        const age = lastOk ? now().getTime() - Date.parse(lastOk) : Number.POSITIVE_INFINITY;
        const warnAt = cad * (o?.warn_multiplier ?? 3);
        const critAt = cad * (o?.critical_multiplier ?? 10);
        if (age > critAt) critical.push(`${integ.name}: no successful tick for ${Math.round(age / 3_600_000)}h`);
        else if (age > warnAt) stale.push(`${integ.name}: no successful tick for ${Math.round(age / 3_600_000)}h`);
      }
      if (stale.length === 0 && critical.length === 0) return { ok: true };
      return {
        ok: false,
        message: [...critical.map((s) => `CRITICAL ${s}`), ...stale].join('; '),
        remediation: 'robin doctor for detail; robin reauth <name> for OAuth-class skips',
      };
    },
  };
}
```

Note on `lastOk` being absent (fresh install / first run after this feature ships): treat as infinitely old ONLY if `last_attempt_at` exists (the integration has ticked before); if the integration has never ticked at all, skip it. Add that guard and a test for it.

The `integrations()` provider comes from the loader's enabled-integration list (the daemon already enumerates these to register handlers — pass `{name, cron: yaml.schedule}` through; locate the loader call in `system/kernel/runtime/daemon.ts` boot and reuse its list).

- [ ] **Step 4: Run to verify pass** — `pnpm exec tsx --test system/kernel/invariants/builtins/integration-staleness.test.ts`

- [ ] **Step 5: Commit**

```bash
git add system/kernel/invariants/builtins/integration-staleness.ts \
        system/kernel/invariants/builtins/integration-staleness.test.ts \
        system/kernel/config/schema.ts \
        system/integrations/_runtime/scheduler-glue.ts system/integrations/_runtime/scheduler-glue.test.ts
git commit -m "feat(alerts): integration staleness + skip-streak invariant with power suppression"
```

---

### Task 6: degraded-stream contract + invariant

**Files:**
- Modify: `system/integrations/_runtime/types.ts` (TickResult), `system/integrations/_runtime/scheduler-glue.ts`
- Create: `system/kernel/invariants/builtins/integration-degraded.ts` + test
- Modify (user-data, live instance only): `user-data/extensions/integrations/whoop/index.ts`

- [ ] **Step 1: Extend TickResult**

```typescript
export interface TickResult {
  status: 'ok' | 'skipped' | 'error';
  ingested?: number;
  message?: string;
  /** Streams that failed inside an otherwise-ok tick (e.g. whoop 'recovery'). */
  degraded?: string[];
}
```

- [ ] **Step 2: Failing test in `scheduler-glue.test.ts`:** a tick returning `{status:'ok', degraded:['recovery']}` increments KV `degraded:recovery` to '1'; a second such tick → '2'; a clean ok tick resets it to '0' (reset ALL `degraded:*` keys for that integration on a non-degraded ok tick).

- [ ] **Step 3: Implement in the heartbeat block:**

```typescript
if (result.status === 'ok') {
  const degraded = new Set(result.degraded ?? []);
  const rows = db.prepare(
    `SELECT key, value FROM integration_state WHERE integration_name=? AND key LIKE 'degraded:%'`,
  ).all(name) as Array<{ key: string; value: string }>;
  for (const s of degraded) {
    const prev = Number(rows.find((r) => r.key === `degraded:${s}`)?.value ?? '0');
    setState(name, `degraded:${s}`, String(prev + 1));
  }
  for (const r of rows) if (!degraded.has(r.key.slice('degraded:'.length))) setState(name, r.key, '0');
}
```

- [ ] **Step 4: Degraded invariant + test** (same factory shape as Task 5; fires warning when any `degraded:*` value ≥ 3):

```typescript
// integration-degraded.ts — check() body
const rows = db.prepare(
  `SELECT integration_name, key, value FROM integration_state
    WHERE key LIKE 'degraded:%' AND CAST(value AS INTEGER) >= 3`,
).all() as Array<{ integration_name: string; key: string; value: string }>;
if (rows.length === 0) return { ok: true };
return {
  ok: false,
  message: rows.map((r) => `${r.integration_name}/${r.key.slice(9)} degraded ${r.value} consecutive ticks`).join('; '),
};
```

Tests: seed counts 2 (ok) and 3 (fires); name `integrations.streams_healthy`.

- [ ] **Step 5: Whoop emits `degraded`** (user-data edit): in `whoop/index.ts`, the Promise.allSettled block (~lines 383–391) already builds the "degraded — skipped recovery(...)" message; additionally collect the failed stream names into `degraded: string[]` on the returned TickResult. One-line return change; `pnpm build` compiles user-data extensions in place.

- [ ] **Step 6: Run** scheduler-glue + new invariant tests; expected PASS. **Commit:**

```bash
git add system/integrations/_runtime/types.ts system/integrations/_runtime/scheduler-glue.ts \
        system/integrations/_runtime/scheduler-glue.test.ts \
        system/kernel/invariants/builtins/integration-degraded.ts \
        system/kernel/invariants/builtins/integration-degraded.test.ts
git commit -m "feat(alerts): structured degraded-stream detection"
# user-data is gitignored — the whoop edit is not committed (live instance only)
```

---

### Task 7: errored-jobs + crash-loop invariants

**Files:**
- Create: `system/kernel/invariants/builtins/jobs-erroring.ts` + test
- Create: `system/kernel/invariants/builtins/daemon-stable.ts` + test
- Modify: `system/kernel/runtime/daemon.ts` (boot timestamp recording)

- [ ] **Step 1: jobs-erroring invariant + tests.** Queries the existing `jobs` table for rows that went `errored` in the last 24h, grouped by job name:

```typescript
// jobs-erroring.ts — check() body
const rows = db.prepare(
  `SELECT name, COUNT(*) AS n FROM jobs
    WHERE state='errored' AND created_at > datetime('now','-1 day')
    GROUP BY name HAVING n >= 1`,
).all() as Array<{ name: string; n: number }>;
```

Verify the column names (`name`, `state`, `created_at`) against the jobs schema in `system/brain/memory/migrations/001-initial.ts` before writing — adjust if the job-name column differs. ok when empty; warning message `"<name> errored <n>× in 24h"` joined with `; `. Tests: seed an errored row → fires; an old errored row (2 days) → ok.

- [ ] **Step 2: boot timestamps.** In `daemon.ts` boot (next to the recovery sweep at ~line 129), append the boot time to `user-data/state/runtime/boots.json` (create dir if needed; keep last 20 entries):

```typescript
const bootsPath = join(runtimeStateDir, 'boots.json');
let boots: string[] = [];
try { boots = JSON.parse(readFileSync(bootsPath, 'utf8')); } catch { /* first boot */ }
boots.push(new Date().toISOString());
writeFileSync(bootsPath, JSON.stringify(boots.slice(-20)));
```

Use the same runtime-state dir the agent-runner cursor uses (`user-data/state/runtime/` — grep `agent-runner-cursor` for the exact path helper).

- [ ] **Step 3: daemon-stable invariant + tests.** Factory takes `bootsPath` (injectable for tests); reads the JSON; ≥3 timestamps within the trailing hour → warning `"daemon restarted N times in the last hour"`. Tests: 2 recent boots → ok; 3 → fires; 3 boots spread over 3 hours → ok; missing/corrupt file → ok (never throw).

- [ ] **Step 4: Run both test files; expected PASS. Commit:**

```bash
git add system/kernel/invariants/builtins/jobs-erroring.ts system/kernel/invariants/builtins/jobs-erroring.test.ts \
        system/kernel/invariants/builtins/daemon-stable.ts system/kernel/invariants/builtins/daemon-stable.test.ts \
        system/kernel/runtime/daemon.ts
git commit -m "feat(alerts): errored-jobs and crash-loop invariants"
```

---

### Task 8: health-monitor wiring — alerts, timeouts, in-flight skip

This is the integration point: invariant reports become alert rows; every invariant gets a timeout; slow checks can't overlap.

**Files:**
- Modify: `system/kernel/runtime/health-monitor.ts`
- Test: extend `system/kernel/runtime/health-monitor.test.ts`

- [ ] **Step 1: Failing tests** (the monitor's test file already fakes invariants — follow its pattern):

```typescript
test('failing invariant opens an alert; passing run auto-resolves it');
test('alert severity follows report severity');
test('invariant check that exceeds 5s reports {ok:false, "check timed out"}');
test('a check whose previous run is in flight is skipped, not run concurrently');
test('alert-store write failure does not crash the monitor tick');
```

- [ ] **Step 2: Implement.**

(a) Register the four new invariants (staleness, degraded, jobs-erroring, daemon-stable) in the monitor's invariant list (where `integrationsHealthyInvariant(...)` etc. are built, ~lines 85–102), passing `db`, the enabled-integration provider, a `() => loadPolicies(userData)` thunk, and the boots path.

(b) After reports are computed, write/resolve alerts generically:

```typescript
import { recordAlert, resolveAlert } from './alert-store.ts';
// ...after `reports` is built:
for (const r of reports) {
  try {
    if (r.ok) resolveAlert(this.opts.db, 'invariant', r.name);
    else recordAlert(this.opts.db, {
      severity: r.severity === 'critical' ? 'critical' : 'warning',
      source: 'invariant',
      key: r.name,
      message: r.message ?? r.name,
    });
  } catch (err) {
    this.log.warn({ err, invariant: r.name }, 'alert write failed');
  }
}
```

Note: the staleness invariant embeds per-integration detail in one report message. That yields ONE alert keyed `integrations.fresh`. This is the deliberate v1 behavior (one open row summarizing all stale integrations); per-integration alert rows are a future refinement.

(c) Timeout + overlap guard around each check (where checks are awaited):

```typescript
private inFlight = new Set<string>();

private async runChecked(inv: Invariant): Promise<InvariantReport> {
  if (this.inFlight.has(inv.name)) {
    return { name: inv.name, severity: inv.severity, ok: false, message: 'previous check still running', duration_ms: 0 };
  }
  this.inFlight.add(inv.name);
  const started = Date.now();
  try {
    const result = await Promise.race([
      Promise.resolve(inv.check()),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('check timed out')), 5_000).unref?.()),
    ]);
    return { name: inv.name, severity: inv.severity, ok: result.ok, message: result.message, duration_ms: Date.now() - started };
  } catch (err) {
    return { name: inv.name, severity: inv.severity, ok: false,
             message: err instanceof Error ? err.message : String(err), duration_ms: Date.now() - started };
  } finally {
    this.inFlight.delete(inv.name);
  }
}
```

Adapt the report shape to the monitor's existing one (it already builds `InvariantReport`-like objects — reuse, don't duplicate). The existing critical-toast path (notifyMacOSAction, ~lines 132–149) is untouched: escalation to critical re-enters it naturally.

- [ ] **Step 3: Run** `pnpm exec tsx --test system/kernel/runtime/health-monitor.test.ts` — expected PASS.

- [ ] **Step 4: Tick-failure capture in the run loop.** In `daemon.ts` `runLoop()` (~line 364), extend the catch:

```typescript
} catch (err) {
  this.log.error({ err }, 'tick failed');
  try {
    recordAlert(this.db, {
      severity: 'warning', source: 'daemon', key: 'tick.failed',
      message: err instanceof Error ? err.message : String(err),
    });
  } catch { /* alerting must never break the loop */ }
  await sleep(5_000); // back off before re-entering a possibly-broken tick
}
```

And resolve on recovery: after a successful `tickOnce()`, call `resolveAlert(this.db, 'daemon', 'tick.failed')` — but only when an open one might exist; cheapest correct form is calling it unconditionally (it's a single indexed UPDATE that no-ops when nothing is open).

- [ ] **Step 5: Commit**

```bash
git add system/kernel/runtime/health-monitor.ts system/kernel/runtime/health-monitor.test.ts system/kernel/runtime/daemon.ts
git commit -m "feat(alerts): monitor writes/resolves alerts; check timeouts + overlap guard; tick-failure capture"
```

---

### Task 9: retention — alerts-history-bounded invariant

**Files:**
- Create: `system/kernel/invariants/builtins/alerts-history-bounded.ts` + test
- Modify: wherever `buildDoctorInvariants` composes its list (`system/kernel/invariants/builtins/index.ts`)

- [ ] **Step 1: Implement following the `jobs-history-bounded.ts` pattern verbatim** (check fires at >10k resolved rows; `repair()` calls `pruneResolvedAlerts(db, 30)`), register it in `buildDoctorInvariants`, test both check and repair. The daily doctor's `--fix` pass is the prune scheduler — no new cron needed.

- [ ] **Step 2: Run test; commit:**

```bash
git add system/kernel/invariants/builtins/alerts-history-bounded.ts \
        system/kernel/invariants/builtins/alerts-history-bounded.test.ts \
        system/kernel/invariants/builtins/index.ts
git commit -m "feat(alerts): retention via doctor-repaired history bound"
```

---

### Task 10: CLI `robin alerts`

**Files:**
- Create: `system/surfaces/cli/alerts.ts`
- Test: `system/surfaces/cli/alerts.test.ts`
- Modify: `system/surfaces/cli/index.ts` (new case, following the `pause | resume` dynamic-import pattern)

- [ ] **Step 1: Failing tests** for the formatting/action functions (pass an in-memory db; don't test the process wiring):

```typescript
test('listAlertsText renders open alerts with age and severity');
test('listAlertsText says "No open alerts." when clean');
test('runAck acks an existing id and reports unknown ids');
```

- [ ] **Step 2: Implement**

```typescript
// alerts.ts
import { ackAlert, listAlerts } from '../../kernel/runtime/alert-store.ts';
import type { RobinDb } from '../../brain/memory/db.ts';

export function listAlertsText(db: RobinDb, opts: { all?: boolean }): string {
  const rows = listAlerts(db, { all: opts.all, includeAcked: opts.all });
  if (rows.length === 0) return opts.all ? 'No alerts on record.' : 'No open alerts.';
  return rows.map((a) => {
    const ageH = Math.round((Date.now() - Date.parse(a.first_seen_at + 'Z')) / 3_600_000);
    const state = a.resolved_at ? 'resolved' : a.acked_at ? 'acked' : 'open';
    return `#${a.id} [${a.severity}] ${a.key} — ${a.message} (${state}, first seen ${ageH}h ago, fired ${a.fire_count}×)`;
  }).join('\n');
}

export function runAck(db: RobinDb, id: number): string {
  return ackAlert(db, id) ? `Acked alert #${id}.` : `No open alert #${id}.`;
}
```

(Confirm the stored timestamp format first: `datetime('now')` produces `YYYY-MM-DD HH:MM:SS` UTC without a zone suffix — the `+ 'Z'` compensates; verify with one row in the test.)

Wire into `cli/index.ts`:

```typescript
case 'alerts': {
  const { runAlertsCommand } = await import('./alerts.ts');
  await runAlertsCommand(args); // parses: no args → open; --all; ack <id>; opens db via the same helper other db-using commands use (see ./recall.ts)
  exit(0);
  break;
}
```

`runAlertsCommand` opens the DB exactly the way `recall.ts` does (copy its open/resolve pattern) and prints the result of the two pure functions above.

- [ ] **Step 3: Run tests; expected PASS. Commit:**

```bash
git add system/surfaces/cli/alerts.ts system/surfaces/cli/alerts.test.ts system/surfaces/cli/index.ts
git commit -m "feat(alerts): robin alerts CLI (list/--all/ack)"
```

---

### Task 11: MCP core `alerts` tool

**Files:**
- Modify: `system/surfaces/mcp/core/server.ts`

- [ ] **Step 1: Register the tool** following the `journal` tool pattern exactly:

```typescript
server.registerTool(
  'alerts',
  {
    description: 'System health alerts — open problems Robin has detected (stale integrations, failing jobs, crash loops). action=list (default) or ack.',
    inputSchema: z.object({
      action: z.enum(['list', 'ack']).default('list'),
      id: z.number().optional().describe('alert id, required for ack'),
      all: z.boolean().optional().describe('include resolved/acked history'),
    }),
  },
  async ({ action, id, all }) => {
    const { listAlertsText, runAck } = await import('../../cli/alerts.ts');
    const text = action === 'ack'
      ? (id === undefined ? 'ack requires id' : runAck(deps.db, id))
      : listAlertsText(deps.db, { all });
    return { content: [{ type: 'text' as const, text }] };
  },
);
```

Reusing the CLI's pure formatters keeps one rendering path.

- [ ] **Step 2: Verify** — `pnpm typecheck` clean, plus the server's existing test file if one covers tool registration (run `pnpm exec tsx --test system/surfaces/mcp/core/server.test.ts` if present).

- [ ] **Step 3: Commit** — `git add system/surfaces/mcp/core/server.ts && git commit -m "feat(alerts): alerts MCP tool on core server"`

---

### Task 12: doctor freshness table

**Files:**
- Modify: `system/surfaces/cli/doctor.ts` (+ its test if assertions fit the existing pattern)

- [ ] **Step 1:** After the checks render, query and print a freshness table (skip in `--json` mode or include as a `freshness` array — match how the report object is composed):

```typescript
const fresh = db.prepare(`
  SELECT integration_name AS name,
         MAX(CASE WHEN key='last_ok_at' THEN value END) AS last_ok,
         MAX(CASE WHEN key='consecutive_skips' THEN value END) AS skips,
         MAX(CASE WHEN key='last_skip_reason' THEN value END) AS skip_reason
  FROM integration_state GROUP BY integration_name ORDER BY name
`).all() as Array<{ name: string; last_ok: string | null; skips: string | null; skip_reason: string | null }>;
```

Render: name, last_ok (humanized age or `never`), and `skipping: <reason>` when skips ≥ 3. The new staleness/degraded invariants are already in `buildDoctorInvariants` if Task 9's registration added them there — register staleness + degraded there too so doctor and monitor agree (same factories, doctor passes its own deps).

- [ ] **Step 2:** Run `pnpm exec tsx --test system/surfaces/cli/doctor.test.ts` — adjust expectations if the test snapshots output. **Commit:** `git add system/surfaces/cli/doctor.ts system/surfaces/cli/doctor.test.ts && git commit -m "feat(alerts): doctor integration-freshness table"`

---

### Task 13: morning-brief "System health" section (live instance, not committed)

**Files (user-data, gitignored):**
- Modify: `user-data/extensions/jobs/daily-brief/skeleton.ts`

- [ ] **Step 1:** Add `'system_health'` to `SECTION_IDS` (render it first, before `watching`). Add a render function following the existing section pattern (each section queries the DB and returns body text): query `SELECT * FROM alerts WHERE resolved_at IS NULL AND acked_at IS NULL ORDER BY severity DESC, last_seen_at DESC`, render one line per alert (same line format as `listAlertsText`), and return an EMPTY body when there are no rows — confirm how existing sections signal "omit me" (the nhl section is disabled/empty; copy its empty-state mechanism).

- [ ] **Step 2:** `pnpm build` (compiles user-data extensions in place), then dry-run the job if it exposes a manual trigger (`mcp robin-extension run` job daily-brief, or wait for tomorrow's 4:30 run). Verify with `robin alerts` empty → brief has no health section.

---

### Task 14: finalize

- [ ] **Step 1:** `pnpm lint && pnpm typecheck && pnpm test` — expected: clean, with only the 4 pre-existing failures (spotify ×2, ebird, recall — documented 2026-06-10) and zero NEW failures.
- [ ] **Step 2:** `pnpm build && launchctl kickstart -k gui/$(id -u)/io.robin-assistant.daemon`
- [ ] **Step 3:** Live verification:
  - `node dist/surfaces/cli/index.js doctor` → freshness table renders; all checks ok.
  - `node dist/surfaces/cli/index.js alerts` → "No open alerts." (or real findings — read them!).
  - Fault injection: `sqlite3` the live DB to set one integration's `last_ok_at` back 3 days → within ~1 min the monitor opens an alert (`robin alerts` shows it, toast only if critical); restore the value → alert auto-resolves on the next monitor tick. (Use a low-stakes integration like weather.)
- [ ] **Step 4:** Commit any stragglers (explicit paths only), then update `docs/STATUS.md` if it tracks shipped features.

---

## Self-review notes (already applied)

- Spec A1–A6 all map to tasks: A1→1/2, A2→3/4/5, A3→6, A4→7+8(step 4), A5→8, A6→10/11/12/13, retention→9.
- One deliberate v1 simplification vs spec: staleness produces ONE deduped alert (`integrations.fresh`) summarizing all stale integrations, rather than per-integration rows — the spec's "severity escalation updates the open row" semantics still hold; per-integration keys are a follow-up if the summary row proves too coarse.
- Phase B and C get their own plans once this lands (their tasks reference `recordAlert`/`integration_state` keys created here).
