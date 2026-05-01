import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildEntityRegistry } from '../../scripts/lib/wiki-graph/build-entity-registry.js';

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
