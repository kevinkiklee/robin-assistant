import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateBiographerOutput } from '../../cognition/biographer/output.js';

test('valid output passes', () => {
  const ok = validateBiographerOutput({
    entities: [
      { name: 'Alice', type: 'person' },
      { name: 'project-x', type: 'project' },
    ],
    edges: [{ from: 'Alice', type: 'works_on', to: 'project-x' }],
    about: ['Alice'],
    episode_continues_previous: true,
    episode_summary: null,
  });
  assert.equal(ok.ok, true);
});

test('valid output with project entity for "to" passes', () => {
  // Both endpoints of edges must appear in entities[]
  const ok = validateBiographerOutput({
    entities: [
      { name: 'Alice', type: 'person' },
      { name: 'Atlas', type: 'project' },
    ],
    edges: [{ from: 'Alice', type: 'works_on', to: 'Atlas' }],
    about: [],
    episode_continues_previous: false,
  });
  assert.equal(ok.ok, true);
});

test('non-object output hard-fails', () => {
  const r = validateBiographerOutput(null);
  assert.equal(r.ok, false);
});

// The validator is intentionally coercing: a single off-vocab field should
// drop only that field, not the whole batch. This is the source of the
// ~25% per-batch failure rate observed in biographer.log over 4 days.

test('null entities is coerced to empty array', () => {
  const r = validateBiographerOutput({
    entities: null,
    edges: [],
    about: [],
    episode_continues_previous: false,
  });
  assert.equal(r.ok, true);
});

test('missing entities array fails (only when type is wrong)', () => {
  const r = validateBiographerOutput({
    entities: 'not-an-array',
    edges: [],
    about: [],
    episode_continues_previous: false,
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /entities/);
});

test('invalid entity type is coerced to "thing"', () => {
  const out = {
    entities: [{ name: 'StripePay', type: 'service' }],
    edges: [],
    about: [],
    episode_continues_previous: false,
  };
  const r = validateBiographerOutput(out);
  assert.equal(r.ok, true);
  assert.ok(r.warnings?.some((w) => w.includes('"service" → "thing"')));
  assert.equal(out.entities[0].type, 'thing');
});

test('empty entity name drops the entity', () => {
  const out = {
    entities: [
      { name: '', type: 'person' },
      { name: 'Alice', type: 'person' },
    ],
    edges: [],
    about: [],
    episode_continues_previous: false,
  };
  const r = validateBiographerOutput(out);
  assert.equal(r.ok, true);
  assert.equal(out.entities.length, 1);
  assert.equal(out.entities[0].name, 'Alice');
});

test('invalid edge type drops the edge', () => {
  const out = {
    entities: [
      { name: 'X', type: 'person' },
      { name: 'Y', type: 'thing' },
    ],
    edges: [{ from: 'X', type: 'uses', to: 'Y' }],
    about: [],
    episode_continues_previous: false,
  };
  const r = validateBiographerOutput(out);
  assert.equal(r.ok, true);
  assert.equal(out.edges.length, 0);
  assert.ok(r.warnings?.some((w) => w.includes('"uses"')));
});

test('edge referencing unknown entity drops the edge', () => {
  const out = {
    entities: [{ name: 'X', type: 'person' }],
    edges: [{ from: 'X', type: 'mentions', to: 'Y_not_extracted' }],
    about: [],
    episode_continues_previous: false,
  };
  const r = validateBiographerOutput(out);
  assert.equal(r.ok, true);
  assert.equal(out.edges.length, 0);
  assert.ok(r.warnings?.some((w) => w.includes('to "Y_not_extracted"')));
});

test('non-boolean episode_continues_previous coerces to false', () => {
  const out = {
    entities: [],
    edges: [],
    about: [],
    episode_continues_previous: 'yes',
  };
  const r = validateBiographerOutput(out);
  assert.equal(r.ok, true);
  assert.equal(out.episode_continues_previous, false);
});

test('partial-bad batch returns warnings but keeps valid rows', () => {
  // The realistic incident: model returns 8 good entities + 2 with off-vocab
  // types + 1 edge with stray vocab. Old behavior: whole batch fails.
  // New behavior: 9 valid entities (1 dropped name-empty, 2 demoted), 0 edges.
  const out = {
    entities: [
      { name: 'Alice', type: 'person' },
      { name: 'Bob', type: 'person' },
      { name: 'Atlas', type: 'project' },
      { name: 'API Gateway', type: 'service' },
      { name: 'Costa Mesa', type: 'place' },
      { name: 'StripePay', type: 'organization' },
      { name: 'Kubernetes', type: 'thing' },
      { name: 'Migration', type: 'topic' },
      { name: '', type: 'person' },
    ],
    edges: [
      { from: 'Alice', type: 'works_on', to: 'Atlas' }, // valid
      { from: 'Bob', type: 'uses', to: 'Kubernetes' }, // stray vocab
      { from: 'Charlie', type: 'mentions', to: 'Atlas' }, // unknown from
    ],
    about: ['Atlas'],
    episode_continues_previous: false,
  };
  const r = validateBiographerOutput(out);
  assert.equal(r.ok, true);
  assert.equal(out.entities.length, 8, 'one dropped (empty name)');
  assert.equal(out.edges.length, 1, 'two dropped (vocab + unknown-from)');
  assert.equal(out.entities.find((e) => e.name === 'API Gateway')?.type, 'thing');
  assert.equal(out.entities.find((e) => e.name === 'StripePay')?.type, 'thing');
  assert.ok(r.warnings.length >= 4);
});
