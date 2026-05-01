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

test('applyEntityLinks: idempotent — second run is a no-op', async () => {
  const ws = await copyFixtureToTmp('linker-idempotence');
  const reg = await buildEntityRegistry(ws);
  const r1 = await applyEntityLinks(ws, 'profile/case.md', reg);
  assert.equal(r1.inserted, 1);
  const r2 = await applyEntityLinks(ws, 'profile/case.md', reg);
  assert.equal(r2.inserted, 0);
  assert.equal(r2.written, false);
});

test('applyEntityLinks: case-insensitive match, case-preserving replacement', async () => {
  const ws = await copyFixtureToTmp('linker-idempotence');
  const reg = await buildEntityRegistry(ws);
  await applyEntityLinks(ws, 'profile/case.md', reg);
  const after = await readFile(join(ws, 'user-data/memory/profile/case.md'), 'utf-8');
  assert.match(after, /\[DR\. LEE\]\(\.\.\/knowledge\/medical\/hemonc-lee\.md\)/);
});

test('applyEntityLinks: preserves trust frontmatter and UNTRUSTED markers', async () => {
  const ws = await copyFixtureToTmp('linker-trust');
  const reg = await buildEntityRegistry(ws);
  const result = await applyEntityLinks(ws, 'knowledge/sources/article.md', reg);
  assert.equal(result.inserted, 1);
  const after = await readFile(join(ws, 'user-data/memory/knowledge/sources/article.md'), 'utf-8');
  assert.match(after, /^---\n[\s\S]*?trust: untrusted[\s\S]*?trust-source: ingest:article[\s\S]*?\n---/);
  assert.match(after, /<!-- UNTRUSTED-START src=ingest:article -->/);
  assert.match(after, /<!-- UNTRUSTED-END -->/);
  assert.match(after, /\[Dr\. Lee\]\(\.\.\/medical\/hemonc-lee\.md\)/);
});

test('applyEntityLinks: fail-soft when registry build throws (alias collision)', async () => {
  const ws = await copyFixtureToTmp('linker-failsoft');
  const result = await applyEntityLinks(ws, 'profile/note.md');
  assert.equal(result.written, false);
  assert.equal(result.inserted, 0);
  assert.ok(result.registryError);
  assert.match(result.registryError, /alias collision/);
  const after = await readFile(join(ws, 'user-data/memory/profile/note.md'), 'utf-8');
  assert.match(after, /Some content with Lee mentioned\./);
  assert.doesNotMatch(after, /\[Lee\]\(/);
});
