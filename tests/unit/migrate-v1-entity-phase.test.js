import assert from 'node:assert';
import { test } from 'node:test';
import { buildEntityRow, mapEntityKind } from '../../src/migrate-v1/phases/entity.js';

test('mapEntityKind covers every v1 enum value', () => {
  const cases = {
    person: 'person',
    project: 'project',
    tool: 'thing',
    decision: 'topic',
    place: 'place',
    concept: 'topic',
    integration: 'thing',
    source: 'thing',
    event: 'topic',
    task: 'topic',
  };
  for (const [v1, v2] of Object.entries(cases)) {
    assert.equal(mapEntityKind(v1), v2, `${v1}→${v2} (got ${mapEntityKind(v1)})`);
  }
  assert.equal(mapEntityKind('unknown_value'), 'thing');
});

test('buildEntityRow shape', () => {
  const row = buildEntityRow({
    id: 'entity:abc',
    name: 'Eric',
    slug: 'eric',
    aliases: ['E'],
    summary: 'a person',
    kind: 'person',
    meta: { extra: 1 },
    created: '2026-01-01T00:00:00Z',
  });
  assert.equal(row.name, 'Eric');
  assert.equal(row.type, 'person');
  assert.equal(row.meta.kind, 'v1_entity');
  assert.equal(row.meta.v1_kind, 'person');
  assert.equal(row.meta.aliases[0], 'E');
  assert.equal(row.meta.from_v1.v1_id, 'entity:abc');
  assert.equal(row.created_at, '2026-01-01T00:00:00Z');
});

test('buildEntityRow defaults created_at when missing', () => {
  const before = new Date().toISOString();
  const row = buildEntityRow({ id: 'entity:e2', name: 'X', kind: 'project' });
  const after = new Date().toISOString();
  assert.ok(row.created_at >= before && row.created_at <= after);
});
