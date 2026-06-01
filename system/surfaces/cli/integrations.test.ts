import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { closeDb, openDb } from '../../brain/memory/db.ts';
import { allMigrations, applyMigrations } from '../../brain/memory/migrations/index.ts';
import { dbFilePath } from '../../lib/paths.ts';
import { runIntegrationsReport } from './integrations.ts';

describe('robin integrations report', () => {
  let tmpRoot: string;
  let dataDir: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'robin-integ-cli-'));
    dataDir = join(tmpRoot, 'user-data');
    mkdirSync(join(dataDir, 'state', 'db'), { recursive: true });
    const db = openDb(dbFilePath(dataDir));
    applyMigrations(db, allMigrations);
    closeDb(db);
    process.env.ROBIN_USER_DATA_DIR = dataDir;
  });

  afterEach(() => {
    delete process.env.ROBIN_USER_DATA_DIR;
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('returns an empty rows array when no integrations have run or been scheduled', () => {
    const report = runIntegrationsReport();
    assert.equal(report.rows.length, 0);
  });

  it('reports `idle` for an integration that has a scheduled job but no state yet', () => {
    const db = openDb(dbFilePath(dataDir));
    db.prepare(
      `INSERT INTO jobs (name, trigger_kind, scheduled_at, state) VALUES (?, 'cron', datetime('now'), 'pending')`,
    ).run('integration.newone.tick');
    closeDb(db);

    const report = runIntegrationsReport();
    const row = report.rows.find((r) => r.name === 'newone');
    assert.ok(row, 'newone should appear from jobs table union');
    assert.equal(row.status, 'idle');
    assert.equal(row.last_attempt_at, null);
  });

  it('reports `silent` for an integration that has attempted but never ingested', () => {
    const db = openDb(dbFilePath(dataDir));
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO integration_state (integration_name, key, value, updated_at) VALUES (?, ?, ?, ?)`,
    ).run('silentone', 'last_attempt_at', now, now);
    db.prepare(
      `INSERT INTO integration_state (integration_name, key, value, updated_at) VALUES (?, ?, ?, ?)`,
    ).run('silentone', 'consecutive_errors', '0', now);
    closeDb(db);

    const report = runIntegrationsReport();
    const row = report.rows.find((r) => r.name === 'silentone');
    assert.ok(row);
    assert.equal(row.status, 'silent');
  });

  it('reports `ok` for an integration with recent ingest and zero consecutive errors', () => {
    const db = openDb(dbFilePath(dataDir));
    const now = new Date().toISOString();
    for (const [k, v] of [
      ['last_attempt_at', now],
      ['last_ingest_at', now],
      ['last_ingest_count', '5'],
      ['consecutive_errors', '0'],
    ] as const) {
      db.prepare(
        `INSERT INTO integration_state (integration_name, key, value, updated_at) VALUES (?, ?, ?, ?)`,
      ).run('healthy', k, v, now);
    }
    closeDb(db);

    const row = runIntegrationsReport().rows.find((r) => r.name === 'healthy');
    assert.ok(row);
    assert.equal(row.status, 'ok');
    assert.equal(row.last_ingest_count, 5);
  });

  it('reports `erroring` when consecutive_errors >= 3 (even with prior ingests)', () => {
    const db = openDb(dbFilePath(dataDir));
    const now = new Date().toISOString();
    for (const [k, v] of [
      ['last_attempt_at', now],
      ['last_ingest_at', now],
      ['consecutive_errors', '7'],
    ] as const) {
      db.prepare(
        `INSERT INTO integration_state (integration_name, key, value, updated_at) VALUES (?, ?, ?, ?)`,
      ).run('flaky', k, v, now);
    }
    // Add a recent successful job so it doesn't tip into 'broken' (which requires 0 recent ok)
    db.prepare(
      `INSERT INTO jobs (name, trigger_kind, scheduled_at, state) VALUES (?, 'cron', datetime('now', '-1 hour'), 'completed')`,
    ).run('integration.flaky.tick');
    closeDb(db);

    const row = runIntegrationsReport().rows.find((r) => r.name === 'flaky');
    assert.ok(row);
    assert.equal(row.status, 'erroring');
  });

  it('reports `broken` when every recent attempt has errored', () => {
    const db = openDb(dbFilePath(dataDir));
    const ins = db.prepare(
      `INSERT INTO jobs (name, trigger_kind, scheduled_at, state, last_error) VALUES (?, 'cron', datetime('now'), 'errored', ?)`,
    );
    for (let i = 0; i < 5; i++) {
      ins.run('integration.dead.tick', 'oauth invalid_grant');
    }
    closeDb(db);

    const row = runIntegrationsReport().rows.find((r) => r.name === 'dead');
    assert.ok(row);
    assert.equal(row.status, 'broken');
    assert.match(row.last_error ?? '', /invalid_grant/);
  });

  it('does not surface a stale (>24h) last_error for a currently-healthy integration', () => {
    const db = openDb(dbFilePath(dataDir));
    const now = new Date().toISOString();
    // Healthy state: recent attempt + ingest, no consecutive errors.
    for (const [k, v] of [
      ['last_attempt_at', now],
      ['last_ingest_at', now],
      ['consecutive_errors', '0'],
    ] as const) {
      db.prepare(
        `INSERT INTO integration_state (integration_name, key, value, updated_at) VALUES (?, ?, ?, ?)`,
      ).run('recovered', k, v, now);
    }
    // An old errored job (3 days ago) + a fresh success. The error is ancient.
    db.prepare(
      `INSERT INTO jobs (name, trigger_kind, scheduled_at, state, last_error) VALUES (?, 'cron', datetime('now','-3 days'), 'errored', ?)`,
    ).run('integration.recovered.tick', 'graphql 400 DateTime! mismatch');
    db.prepare(
      `INSERT INTO jobs (name, trigger_kind, scheduled_at, state) VALUES (?, 'cron', datetime('now','-1 hour'), 'completed')`,
    ).run('integration.recovered.tick');
    closeDb(db);

    const row = runIntegrationsReport().rows.find((r) => r.name === 'recovered');
    assert.ok(row);
    assert.equal(row.status, 'ok');
    assert.equal(row.recent_err, 0, 'no errors in the 24h window');
    assert.equal(row.last_error, null, 'stale >24h error is not surfaced alongside a healthy status');
  });
});
