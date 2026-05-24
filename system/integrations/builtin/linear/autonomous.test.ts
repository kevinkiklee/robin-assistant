import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { stringify as stringifyYaml } from 'yaml';
import { closeDb, openDb } from '../../../brain/memory/db.ts';
import { allMigrations, applyMigrations } from '../../../brain/memory/migrations/index.ts';
import type { RobinDb } from '../../../brain/memory/db.ts';
import { buildContext } from '../../_runtime/context.ts';
import type { IntegrationContext } from '../../_runtime/types.ts';
import { upsertMap } from './map.ts';
import { runAutonomousLoop } from './autonomous.ts';

/* ---------- helpers ---------- */

interface PolicyOverrides {
  autonomous_enabled?: boolean;
  dry_run?: boolean;
  writable_teams?: string[];
  integration_team_map?: Record<string, string>;
  rate_limit?: { per_tick?: number; per_day?: number };
}

function writePolicies(tmpDir: string, overrides: PolicyOverrides = {}): void {
  const configDir = join(tmpDir, 'config');
  mkdirSync(configDir, { recursive: true });
  const policies = {
    linear: {
      autonomous_enabled: overrides.autonomous_enabled ?? true,
      dry_run: overrides.dry_run ?? true,
      writable_teams: overrides.writable_teams ?? ['ENG'],
      integration_team_map: overrides.integration_team_map ?? { github: 'ENG' },
      rate_limit: {
        per_tick: overrides.rate_limit?.per_tick ?? 3,
        per_day: overrides.rate_limit?.per_day ?? 20,
      },
    },
  };
  writeFileSync(join(configDir, 'policies.yaml'), stringifyYaml(policies));
}

function seedIntegrationError(
  db: RobinDb,
  integrationName: string,
  errorCount: number,
  lastError: string,
): void {
  db.prepare(
    `INSERT OR REPLACE INTO integration_state (integration_name, key, value, updated_at)
     VALUES (?, 'consecutive_errors', ?, datetime('now'))`,
  ).run(integrationName, String(errorCount));
  db.prepare(
    `INSERT OR REPLACE INTO integration_state (integration_name, key, value, updated_at)
     VALUES (?, 'last_error', ?, datetime('now'))`,
  ).run(integrationName, lastError);
}

function makeExpectedRef(integrationName: string, lastError: string): string {
  const hash = lastError
    .slice(0, 100)
    .replace(/[^a-zA-Z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return `integration-error:${integrationName}:${hash}`;
}

/* ---------- tests ---------- */

describe('autonomous loop', () => {
  let db: RobinDb;
  let tmpDir: string;
  let ctx: IntegrationContext;
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env.ROBIN_USER_DATA_DIR;
    tmpDir = mkdtempSync(join(tmpdir(), 'robin-auto-'));
    mkdirSync(join(tmpDir, 'state', 'db'), { recursive: true });
    db = openDb(join(tmpDir, 'state', 'db', 'robin.sqlite'));
    applyMigrations(db, allMigrations);
    ctx = buildContext('linear', db, null);
    process.env.ROBIN_USER_DATA_DIR = tmpDir;
  });

  afterEach(() => {
    closeDb(db);
    rmSync(tmpDir, { recursive: true, force: true });
    if (savedEnv !== undefined) {
      process.env.ROBIN_USER_DATA_DIR = savedEnv;
    } else {
      delete process.env.ROBIN_USER_DATA_DIR;
    }
  });

  it('returns zeros when autonomous_enabled=false', async () => {
    writePolicies(tmpDir, { autonomous_enabled: false });
    const result = await runAutonomousLoop(ctx);
    assert.equal(result.proposed, 0);
    assert.equal(result.created, 0);
    assert.equal(result.skipped, 0);
  });

  it('detects integration errors from integration_state', async () => {
    writePolicies(tmpDir, {
      autonomous_enabled: true,
      dry_run: true,
      writable_teams: ['ENG'],
      integration_team_map: { github: 'ENG' },
    });
    seedIntegrationError(db, 'github', 5, 'fetch failed');
    const result = await runAutonomousLoop(ctx);
    assert.equal(result.proposed, 1);
    assert.equal(result.created, 0);
  });

  it('dry-run emits proposed event', async () => {
    writePolicies(tmpDir, {
      autonomous_enabled: true,
      dry_run: true,
      writable_teams: ['ENG'],
      integration_team_map: { github: 'ENG' },
    });
    seedIntegrationError(db, 'github', 5, 'fetch failed');
    await runAutonomousLoop(ctx);

    const rows = db
      .prepare(`SELECT * FROM events WHERE kind = 'linear.write.proposed'`)
      .all() as Array<{ kind: string; payload: string }>;
    assert.equal(rows.length, 1, 'should have emitted one proposed event');
    const payload = JSON.parse(rows[0].payload);
    assert.equal(payload.action, 'create_issue_proposed');
    assert.equal(payload.autonomous, true);
  });

  it('skips satisfied refs', async () => {
    writePolicies(tmpDir, {
      autonomous_enabled: true,
      dry_run: true,
      writable_teams: ['ENG'],
      integration_team_map: { github: 'ENG' },
    });
    const lastError = 'fetch failed';
    seedIntegrationError(db, 'github', 5, lastError);

    // Seed a map row with this ref as completed
    const ref = makeExpectedRef('github', lastError);
    upsertMap(db, {
      robin_ref: ref,
      linear_issue_id: 'issue-done',
      last_state_type: 'completed',
      last_action: 'transition',
    });

    const result = await runAutonomousLoop(ctx);
    assert.equal(result.skipped, 1);
    assert.equal(result.proposed, 0);
  });

  it('skips existing (non-satisfied) refs', async () => {
    writePolicies(tmpDir, {
      autonomous_enabled: true,
      dry_run: true,
      writable_teams: ['ENG'],
      integration_team_map: { github: 'ENG' },
    });
    const lastError = 'fetch failed';
    seedIntegrationError(db, 'github', 5, lastError);

    // Seed a map row with this ref but NOT completed
    const ref = makeExpectedRef('github', lastError);
    upsertMap(db, {
      robin_ref: ref,
      linear_issue_id: 'issue-open',
      last_action: 'create',
    });

    const result = await runAutonomousLoop(ctx);
    assert.equal(result.skipped, 1);
    assert.equal(result.proposed, 0);
  });

  it('respects per-tick rate limit', async () => {
    writePolicies(tmpDir, {
      autonomous_enabled: true,
      dry_run: true,
      writable_teams: ['ENG'],
      integration_team_map: {
        github: 'ENG',
        gitlab: 'ENG',
        slack: 'ENG',
        discord: 'ENG',
        jira: 'ENG',
      },
      rate_limit: { per_tick: 2, per_day: 20 },
    });

    // Seed 5 different integration errors
    seedIntegrationError(db, 'github', 5, 'error-github');
    seedIntegrationError(db, 'gitlab', 4, 'error-gitlab');
    seedIntegrationError(db, 'slack', 3, 'error-slack');
    seedIntegrationError(db, 'discord', 6, 'error-discord');
    seedIntegrationError(db, 'jira', 7, 'error-jira');

    const result = await runAutonomousLoop(ctx);
    assert.ok(
      result.proposed <= 2,
      `proposed (${result.proposed}) should be <= per_tick limit of 2`,
    );
  });

  it('circuit-breaker skips when auth_failed=true', async () => {
    writePolicies(tmpDir, {
      autonomous_enabled: true,
      dry_run: true,
      writable_teams: ['ENG'],
      integration_team_map: { github: 'ENG' },
    });
    seedIntegrationError(db, 'github', 5, 'fetch failed');

    ctx.state.set('auth_failed', 'true');

    const result = await runAutonomousLoop(ctx);
    assert.equal(result.proposed, 0);
    assert.equal(result.created, 0);
    assert.equal(result.skipped, 0);
  });
});
