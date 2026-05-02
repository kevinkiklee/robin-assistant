import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildEntityRegistry } from '../../scripts/wiki-graph/lib/build-entity-registry.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE_BASIC = join(__dirname, '..', 'fixtures', 'wiki-graph', 'registry-basic');

test('buildEntityRegistry: harvests canonical + aliases from entity pages', async () => {
  const reg = await buildEntityRegistry(FIXTURE_BASIC);
  assert.equal(reg.byPath.size, 1);
  const entry = reg.byPath.get('knowledge/medical/hemonc-lee.md');
  assert.equal(entry.canonical, 'Dong-Seok Lee');
  assert.deepEqual(entry.aliases.sort(), ['Dong-Seok Lee', 'Dr. Lee', 'hem-onc Lee'].sort());
});

test('buildEntityRegistry: byAlias is keyed by lowercased NFC alias', async () => {
  const reg = await buildEntityRegistry(FIXTURE_BASIC);
  assert.ok(reg.byAlias.has('dr. lee'));
  assert.ok(reg.byAlias.has('dong-seok lee'));
  assert.equal(reg.byAlias.get('dr. lee').path, 'knowledge/medical/hemonc-lee.md');
});

test('buildEntityRegistry: pages without canonical are not entities', async () => {
  const reg = await buildEntityRegistry(FIXTURE_BASIC);
  assert.equal(reg.byPath.has('profile/identity.md'), false);
});

const FIXTURE_COLLISION = join(__dirname, '..', 'fixtures', 'wiki-graph', 'registry-collision');

test('buildEntityRegistry: throws on alias collision with both paths in message', async () => {
  await assert.rejects(
    () => buildEntityRegistry(FIXTURE_COLLISION),
    (err) => /lee-john\.md/.test(err.message) && /lee-jane\.md/.test(err.message) && /Lee/.test(err.message)
  );
});

const FIXTURE_UNTRUSTED = join(__dirname, '..', 'fixtures', 'wiki-graph', 'registry-untrusted');

test('buildEntityRegistry: skips knowledge/sources, knowledge/conversations, archive', async () => {
  const reg = await buildEntityRegistry(FIXTURE_UNTRUSTED);
  assert.equal(reg.byPath.size, 0);
  assert.equal(reg.byAlias.size, 0);
});

const FIXTURE_QUOTED_COMMA = join(__dirname, '..', 'fixtures', 'wiki-graph', 'registry-quoted-comma');

test('buildEntityRegistry: aliases with quoted commas are preserved as a single alias', async () => {
  const reg = await buildEntityRegistry(FIXTURE_QUOTED_COMMA);
  const entry = reg.byPath.get('knowledge/people/smith-jr.md');
  assert.ok(entry);
  assert.deepEqual(
    entry.aliases.sort(),
    ['John Smith Jr.', 'Smith', 'Smith, Jr.'].sort()
  );
  assert.ok(reg.byAlias.has('smith, jr.'));
  // The naive comma-split would have produced a stray "Jr." alias.
  assert.equal(reg.byAlias.has('jr.'), false);
});

const FIXTURE_TRUST_FM = join(__dirname, '..', 'fixtures', 'wiki-graph', 'registry-trust-frontmatter');

test('buildEntityRegistry: pages with trust:untrusted frontmatter are skipped regardless of path', async () => {
  const reg = await buildEntityRegistry(FIXTURE_TRUST_FM);
  assert.equal(reg.byPath.size, 0);
  assert.equal(reg.byAlias.size, 0);
});
