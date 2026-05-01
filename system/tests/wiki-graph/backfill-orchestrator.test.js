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
