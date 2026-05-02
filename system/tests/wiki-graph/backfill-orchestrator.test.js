import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtemp, cp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { runBackfill } from '../../scripts/backfill-entity-links.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function copyFixtureToTmp(name) {
  const src = join(__dirname, '..', 'fixtures', 'wiki-graph', name);
  const dst = await mkdtemp(join(tmpdir(), `wiki-graph-bf-${name}-`));
  await cp(src, dst, { recursive: true });
  return dst;
}

test('runBackfill: dry-run produces a report and modifies no files', async () => {
  const ws = await copyFixtureToTmp('backfill-multi');
  const before = await readFile(join(ws, 'user-data/memory/profile/identity.md'), 'utf-8');
  const result = await runBackfill({ workspaceDir: ws, scope: 'all', apply: false });
  assert.ok(result.reportDir);
  assert.ok(result.totalInserted >= 2); // identity.md + finance/snapshot.md
  const after = await readFile(join(ws, 'user-data/memory/profile/identity.md'), 'utf-8');
  assert.equal(after, before, 'dry-run must not write');

  const entries = await readdir(result.reportDir);
  assert.ok(entries.length > 0);
});

test('runBackfill: apply mode writes files', async () => {
  const ws = await copyFixtureToTmp('backfill-multi');
  const result = await runBackfill({ workspaceDir: ws, scope: 'all', apply: true });
  assert.ok(result.totalInserted >= 2);
  const after = await readFile(join(ws, 'user-data/memory/profile/identity.md'), 'utf-8');
  assert.match(after, /\[Dr\. Lee\]\(/);
});

test('runBackfill: apply mode acquires wiki-backfill lock', async () => {
  const { readLock } = await import('../../scripts/jobs/lib/atomic.js');
  const ws = await copyFixtureToTmp('backfill-multi');
  const lockPath = join(ws, '.locks', 'wiki-backfill.lock');
  const result = await runBackfill({ workspaceDir: ws, scope: 'all', apply: true });
  assert.ok(result.totalInserted > 0);
  // After completion the lock file should be released (readLock returns null when not held)
  const lock = readLock(lockPath);
  assert.equal(lock, null);
});

test('runBackfill: scope filtering limits to a domain', async () => {
  const ws = await copyFixtureToTmp('backfill-multi');
  const result = await runBackfill({ workspaceDir: ws, scope: 'finance', apply: true });
  // Only finance/snapshot.md is touched; identity.md (profile) is not
  const identityAfter = await readFile(join(ws, 'user-data/memory/profile/identity.md'), 'utf-8');
  assert.doesNotMatch(identityAfter, /\[Dr\. Lee\]\(/);
  const financeAfter = await readFile(join(ws, 'user-data/memory/knowledge/finance/snapshot.md'), 'utf-8');
  assert.match(financeAfter, /\[Dr\. Lee\]\(/);
});

test('runBackfill: --apply regenerates LINKS.md with new edges', async () => {
  const ws = await copyFixtureToTmp('backfill-multi');
  await runBackfill({ workspaceDir: ws, scope: 'all', apply: true });
  const links = await readFile(join(ws, 'user-data/memory/LINKS.md'), 'utf-8');
  assert.match(links, /knowledge\/medical\/hemonc-lee\.md/);
  assert.match(links, /profile\/identity\.md/);
});
