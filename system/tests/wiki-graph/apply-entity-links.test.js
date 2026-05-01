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

test('applyEntityLinks: does not link inside frontmatter', async () => {
  const ws = await copyFixtureToTmp('linker-skip-rules');
  const reg = await buildEntityRegistry(ws);
  await applyEntityLinks(ws, 'profile/test.md', reg);
  const after = await readFile(join(ws, 'user-data/memory/profile/test.md'), 'utf-8');
  assert.match(after, /^---\n[\s\S]*?notes: Dr\. Lee mentioned in frontmatter must NOT be linked[\s\S]*?\n---/);
});

test('applyEntityLinks: does not link inside inline code', async () => {
  const ws = await copyFixtureToTmp('linker-skip-rules');
  const reg = await buildEntityRegistry(ws);
  await applyEntityLinks(ws, 'profile/test.md', reg);
  const after = await readFile(join(ws, 'user-data/memory/profile/test.md'), 'utf-8');
  assert.match(after, /Inline code: `Dr\. Lee` here\./);
});

test('applyEntityLinks: does not link inside fenced code blocks', async () => {
  const ws = await copyFixtureToTmp('linker-skip-rules');
  const reg = await buildEntityRegistry(ws);
  await applyEntityLinks(ws, 'profile/test.md', reg);
  const after = await readFile(join(ws, 'user-data/memory/profile/test.md'), 'utf-8');
  assert.match(after, /```\nFenced: Dr\. Lee here\n```/);
});

test('applyEntityLinks: skips entire file when target already linked anywhere in body', async () => {
  const ws = await copyFixtureToTmp('linker-skip-rules');
  const reg = await buildEntityRegistry(ws);
  const result = await applyEntityLinks(ws, 'profile/test.md', reg);
  assert.equal(result.inserted, 0);
  const after = await readFile(join(ws, 'user-data/memory/profile/test.md'), 'utf-8');
  assert.match(after, /Plain mention: I see Dr\. Lee\./);
});

test('applyEntityLinks: does not link inside bare URL', async () => {
  const ws = await copyFixtureToTmp('linker-skip-rules');
  const reg = await buildEntityRegistry(ws);
  await applyEntityLinks(ws, 'profile/test.md', reg);
  const after = await readFile(join(ws, 'user-data/memory/profile/test.md'), 'utf-8');
  assert.match(after, /URL: https:\/\/example\.com\/Dr\.-Lee mentions\./);
});

test('applyEntityLinks: page never links to itself', async () => {
  const ws = await copyFixtureToTmp('linker-self-multi');
  const reg = await buildEntityRegistry(ws);
  const result = await applyEntityLinks(ws, 'knowledge/medical/hemonc-lee.md', reg);
  assert.equal(result.inserted, 0);
  const after = await readFile(join(ws, 'user-data/memory/knowledge/medical/hemonc-lee.md'), 'utf-8');
  assert.doesNotMatch(after, /\[Dr\. Lee\]\(/);
});

test('applyEntityLinks: only first mention per file is linked (W1)', async () => {
  const ws = await copyFixtureToTmp('linker-self-multi');
  const reg = await buildEntityRegistry(ws);
  const result = await applyEntityLinks(ws, 'profile/multi.md', reg);
  assert.equal(result.inserted, 1);
  const after = await readFile(join(ws, 'user-data/memory/profile/multi.md'), 'utf-8');
  const links = after.match(/\[Dr\. Lee\]\([^)]+\)/g) || [];
  assert.equal(links.length, 1);
  assert.match(after, /First, \[Dr\. Lee\]/);
  assert.match(after, /Later, Dr\. Lee did Y/);
  assert.match(after, /And then Dr\. Lee did Z/);
});
