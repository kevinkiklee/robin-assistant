import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
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
