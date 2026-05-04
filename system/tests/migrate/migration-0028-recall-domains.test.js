// Tests for migration 0028 — seed user-data/runtime/config/recall-domains.md.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { up, id, description } from '../../migrations/0028-add-recall-domains.js';

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'mig0028-'));
  mkdirSync(join(dir, 'user-data/runtime/config'), { recursive: true });
  return dir;
}

test('migration metadata is correct', () => {
  assert.equal(id, '0028-add-recall-domains');
  assert.match(description, /recall-domains/);
});

test('creates the file when missing', async () => {
  const ws = workspace();
  await up({ workspaceDir: ws });
  const path = join(ws, 'user-data/runtime/config/recall-domains.md');
  assert.ok(existsSync(path));
  const text = readFileSync(path, 'utf8');
  assert.match(text, /^---\n/);
  assert.match(text, /## gardening/);
  assert.match(text, /## finance/);
  assert.match(text, /## health/);
  assert.match(text, /## briefing freshness/);
  assert.match(text, /keywords: garden, gardening, plant/);
});

test('idempotent: preserves an existing file untouched', async () => {
  const ws = workspace();
  const path = join(ws, 'user-data/runtime/config/recall-domains.md');
  const userContent = '## my custom domain\nkeywords: foo\nfiles:\n  - user-data/memory/foo.md\n';
  writeFileSync(path, userContent);
  await up({ workspaceDir: ws });
  assert.equal(readFileSync(path, 'utf8'), userContent);
});

test('idempotent: re-running is a no-op', async () => {
  const ws = workspace();
  await up({ workspaceDir: ws });
  const first = readFileSync(join(ws, 'user-data/runtime/config/recall-domains.md'), 'utf8');
  await up({ workspaceDir: ws });
  const second = readFileSync(join(ws, 'user-data/runtime/config/recall-domains.md'), 'utf8');
  assert.equal(first, second);
});

test('creates parent directory if missing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mig0028b-'));
  // No user-data/runtime/config/ created.
  await up({ workspaceDir: dir });
  const path = join(dir, 'user-data/runtime/config/recall-domains.md');
  assert.ok(existsSync(path));
});
