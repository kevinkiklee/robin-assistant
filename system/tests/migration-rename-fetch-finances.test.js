import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { up } from '../migrations/0007-rename-fetch-finances.js';

function workspace() {
  const ws = mkdtempSync(join(tmpdir(), 'mig0007-'));
  mkdirSync(join(ws, 'user-data/jobs'), { recursive: true });
  return ws;
}

test('migrates fetch-finances.md to sync-lunch-money.md, updating name and command', async () => {
  const ws = workspace();
  writeFileSync(
    join(ws, 'user-data/jobs/fetch-finances.md'),
    '---\nname: fetch-finances\ndescription: Pull Lunch Money\nruntime: node\nenabled: true\nschedule: "0 1 * * *"\ncommand: node system/scripts/fetch-lunch-money.js\ncatch_up: true\ntimeout_minutes: 5\nnotify_on_failure: true\n---\n\nbody\n'
  );
  await up({ workspaceDir: ws });
  assert.ok(!existsSync(join(ws, 'user-data/jobs/fetch-finances.md')));
  const newPath = join(ws, 'user-data/jobs/sync-lunch-money.md');
  assert.ok(existsSync(newPath));
  const content = readFileSync(newPath, 'utf-8');
  assert.match(content, /^name: sync-lunch-money$/m);
  assert.match(content, /^command: node user-data\/scripts\/sync-lunch-money\.js$/m);
  rmSync(ws, { recursive: true });
});

test('is idempotent — running twice is a no-op when sync-lunch-money.md already exists', async () => {
  const ws = workspace();
  writeFileSync(
    join(ws, 'user-data/jobs/sync-lunch-money.md'),
    'pre-existing content\n'
  );
  await up({ workspaceDir: ws });
  await up({ workspaceDir: ws });
  const content = readFileSync(join(ws, 'user-data/jobs/sync-lunch-money.md'), 'utf-8');
  assert.equal(content, 'pre-existing content\n');
  rmSync(ws, { recursive: true });
});

test('skips silently when neither file exists (fresh workspace)', async () => {
  const ws = workspace();
  await up({ workspaceDir: ws });
  assert.ok(!existsSync(join(ws, 'user-data/jobs/sync-lunch-money.md')));
  rmSync(ws, { recursive: true });
});

test('migrates state file from user-data/state/lunch-money-sync.json to user-data/state/sync/lunch-money.json', async () => {
  const ws = workspace();
  mkdirSync(join(ws, 'user-data/state'), { recursive: true });
  writeFileSync(
    join(ws, 'user-data/state/lunch-money-sync.json'),
    JSON.stringify({
      last_sync: '2026-04-28',
      last_run_at: '2026-04-28T19:20:59.518Z',
      transactions_pulled: 5032,
    }) + '\n'
  );
  await up({ workspaceDir: ws });

  assert.ok(!existsSync(join(ws, 'user-data/state/lunch-money-sync.json')));
  const newPath = join(ws, 'user-data/state/sync/lunch-money.json');
  assert.ok(existsSync(newPath));
  const next = JSON.parse(readFileSync(newPath, 'utf-8'));
  assert.equal(next.last_sync_date, '2026-04-28');
  assert.equal(next.last_success_at, '2026-04-28T19:20:59.518Z');
  assert.equal(next.last_attempt_at, '2026-04-28T19:20:59.518Z');
  assert.equal(next.error_count, 0);
  assert.equal(next.last_error, null);
  assert.equal(next.auth_status, 'ok');
  assert.deepEqual(next.cursor, { transactions_pulled: 5032 });
  rmSync(ws, { recursive: true });
});

test('state migration is idempotent', async () => {
  const ws = workspace();
  mkdirSync(join(ws, 'user-data/state/sync'), { recursive: true });
  writeFileSync(
    join(ws, 'user-data/state/sync/lunch-money.json'),
    '{"already": "migrated"}\n'
  );
  await up({ workspaceDir: ws });
  await up({ workspaceDir: ws });
  const content = readFileSync(join(ws, 'user-data/state/sync/lunch-money.json'), 'utf-8');
  assert.equal(content, '{"already": "migrated"}\n');
  rmSync(ws, { recursive: true });
});

test('state migration quarantines a corrupt old state file', async () => {
  const ws = workspace();
  mkdirSync(join(ws, 'user-data/state'), { recursive: true });
  const oldPath = join(ws, 'user-data/state/lunch-money-sync.json');
  writeFileSync(oldPath, '{ this is not valid');
  const origLog = console.log;
  console.log = () => {};
  try {
    await up({ workspaceDir: ws });
  } finally {
    console.log = origLog;
  }
  // Old file gone (renamed)
  assert.ok(!existsSync(oldPath));
  // No new file written
  assert.ok(!existsSync(join(ws, 'user-data/state/sync/lunch-money.json')));
  // Quarantine sibling exists
  const siblings = readdirSync(join(ws, 'user-data/state'));
  assert.ok(
    siblings.some((n) => n.startsWith('lunch-money-sync.json.corrupt-')),
    `expected a quarantine file, got: ${siblings.join(', ')}`
  );
  rmSync(ws, { recursive: true });
});

test('state migration removes leftover old file when new file already exists', async () => {
  const ws = workspace();
  mkdirSync(join(ws, 'user-data/state/sync'), { recursive: true });
  writeFileSync(
    join(ws, 'user-data/state/sync/lunch-money.json'),
    '{"already": "migrated"}\n'
  );
  writeFileSync(
    join(ws, 'user-data/state/lunch-money-sync.json'),
    '{"old": "leftover"}\n'
  );
  await up({ workspaceDir: ws });
  assert.ok(!existsSync(join(ws, 'user-data/state/lunch-money-sync.json')));
  rmSync(ws, { recursive: true });
});
