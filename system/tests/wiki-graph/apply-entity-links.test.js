import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtemp, cp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { applyEntityLinks } from '../../scripts/lib/wiki-graph/apply-entity-links.js';
import { buildEntityRegistry } from '../../scripts/lib/wiki-graph/build-entity-registry.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function copyFixtureToTmp(name) {
  const src = join(__dirname, '..', 'fixtures', 'wiki-graph', name);
  const dst = await mkdtemp(join(tmpdir(), `wiki-graph-${name}-`));
  await cp(src, dst, { recursive: true });
  return dst;
}

test('applyEntityLinks: inserts first-mention markdown link to entity', async () => {
  const ws = await copyFixtureToTmp('linker-basic');
  const reg = await buildEntityRegistry(ws);
  const result = await applyEntityLinks(ws, 'profile/identity.md', reg);

  assert.equal(result.written, true);
  assert.equal(result.inserted, 1);
  const after = await readFile(join(ws, 'user-data/memory/profile/identity.md'), 'utf-8');
  assert.match(after, /\[Dr\. Lee\]\(\.\.\/knowledge\/medical\/hemonc-lee\.md\)/);
});
