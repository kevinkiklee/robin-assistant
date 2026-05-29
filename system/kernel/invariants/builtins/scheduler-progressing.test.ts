import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { closeDb, openDb } from '../../../brain/memory/db.ts';
import { allMigrations, applyMigrations } from '../../../brain/memory/migrations/index.ts';
import { schedulerProgressingInvariant } from './scheduler-progressing.ts';

function freshSetup(powerYaml = 'power:\n  state: active\n') {
  const dir = mkdtempSync(join(tmpdir(), 'robin-inv-sched-'));
  mkdirSync(join(dir, 'state', 'db'), { recursive: true });
  mkdirSync(join(dir, 'config'), { recursive: true });
  writeFileSync(join(dir, 'config', 'policies.yaml'), powerYaml);
  const db = openDb(join(dir, 'state', 'db', 'robin.sqlite'));
  applyMigrations(db, allMigrations);
  process.env.ROBIN_USER_DATA_DIR = dir;
  return { dir, db };
}

// created_at is set by CURRENT_TIMESTAMP, so to simulate an old/fresh job we insert
// then overwrite created_at with an explicit UTC 'YYYY-MM-DD HH:MM:SS' string.
function insertJobAt(db: ReturnType<typeof openDb>, createdAtUtc: string) {
  const id = db
    .prepare(
      `INSERT INTO jobs (name, trigger_kind, scheduled_at, state) VALUES ('biographer.run', 'cron', datetime('now'), 'completed')`,
    )
    .run().lastInsertRowid;
  db.prepare('UPDATE jobs SET created_at = ? WHERE id = ?').run(createdAtUtc, id);
}

const NOW = Date.parse('2026-05-29T10:00:00Z');

test('scheduler.progressing: ok when there are no jobs yet (fresh install)', async () => {
  const { db } = freshSetup();
  const r = await schedulerProgressingInvariant(db, {
    userData: process.env.ROBIN_USER_DATA_DIR as string,
    now: () => NOW,
  }).check();
  assert.equal(r.ok, true);
  closeDb(db);
});

test('scheduler.progressing: ok when the newest job is recent', async () => {
  const { db, dir } = freshSetup();
  insertJobAt(db, '2026-05-29 09:58:00'); // 2 min ago
  const r = await schedulerProgressingInvariant(db, { userData: dir, now: () => NOW }).check();
  assert.equal(r.ok, true);
  closeDb(db);
});

test('scheduler.progressing: FAILS and names the pause when idle past threshold while paused', async () => {
  const { db, dir } = freshSetup(
    "power:\n  state: paused\n  set_by: user\n  since: '2026-05-28T11:00:00Z'\n",
  );
  insertJobAt(db, '2026-05-28 11:00:00'); // ~23h before NOW — the incident shape
  const r = await schedulerProgressingInvariant(db, { userData: dir, now: () => NOW }).check();
  assert.equal(r.ok, false);
  assert.match(r.message ?? '', /paused/);
  assert.match(r.message ?? '', /set_by:user/);
  assert.equal(r.remediation, 'robin resume');
  closeDb(db);
});

test('scheduler.progressing: FAILS with wedge wording when idle while active', async () => {
  const { db, dir } = freshSetup('power:\n  state: active\n');
  insertJobAt(db, '2026-05-29 05:00:00'); // 5h ago, but power is active → wedge
  const r = await schedulerProgressingInvariant(db, { userData: dir, now: () => NOW }).check();
  assert.equal(r.ok, false);
  assert.match(r.message ?? '', /wedged/);
  assert.equal(r.remediation, 'restart daemon');
  closeDb(db);
});
