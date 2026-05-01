import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtemp, cp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { cmdLink } from '../../scripts/lib/wiki-graph/cli-link.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function copyFixtureToTmp(name) {
  const src = join(__dirname, '..', 'fixtures', 'wiki-graph', name);
  const dst = await mkdtemp(join(tmpdir(), `wiki-graph-cli-${name}-`));
  await cp(src, dst, { recursive: true });
  return dst;
}

test('cmdLink: links a single file argument', async () => {
  const ws = await copyFixtureToTmp('linker-basic');
  const exit = await cmdLink(['profile/identity.md'], { workspaceDir: ws });
  assert.equal(exit, 0);
  const after = await readFile(join(ws, 'user-data/memory/profile/identity.md'), 'utf-8');
  assert.match(after, /\[Dr\. Lee\]\(/);
});

test('cmdLink: --dry-run does not modify file', async () => {
  const ws = await copyFixtureToTmp('linker-basic');
  const before = await readFile(join(ws, 'user-data/memory/profile/identity.md'), 'utf-8');
  const exit = await cmdLink(['profile/identity.md', '--dry-run'], { workspaceDir: ws });
  assert.equal(exit, 0);
  const after = await readFile(join(ws, 'user-data/memory/profile/identity.md'), 'utf-8');
  assert.equal(after, before);
});

test('cmdLink: returns nonzero exit on missing path arg', async () => {
  const ws = await copyFixtureToTmp('linker-basic');
  const exit = await cmdLink([], { workspaceDir: ws });
  assert.equal(exit, 2);
});
