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

test('two parallel applyEntityLinks invocations on the same file: no corruption', async () => {
  const src = join(__dirname, '..', 'fixtures', 'wiki-graph', 'linker-basic');
  const ws = await mkdtemp(join(tmpdir(), 'wiki-graph-concurrent-'));
  await cp(src, ws, { recursive: true });
  const reg = await buildEntityRegistry(ws);

  const [r1, r2] = await Promise.all([
    applyEntityLinks(ws, 'profile/identity.md', reg),
    applyEntityLinks(ws, 'profile/identity.md', reg),
  ]);

  // Final content must contain exactly one link, regardless of which call won
  const after = await readFile(join(ws, 'user-data/memory/profile/identity.md'), 'utf-8');
  const links = after.match(/\[Dr\. Lee\]\(/g) || [];
  assert.equal(links.length, 1, 'exactly one link expected after two concurrent runs');

  // At least one of the calls reports inserted == 1
  assert.ok(r1.inserted === 1 || r2.inserted === 1);
});
