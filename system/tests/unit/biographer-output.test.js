import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateBiographerOutput } from '../../src/capture/biographer-output.js';

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

test('non-object output fails', () => {
  const r = validateBiographerOutput(null);
  assert.equal(r.ok, false);
});

test('missing entities array fails', () => {
  const r = validateBiographerOutput({ edges: [], about: [], episode_continues_previous: false });
  assert.equal(r.ok, false);
  assert.match(r.error, /entities/);
});

test('invalid entity type fails', () => {
  const r = validateBiographerOutput({
    entities: [{ name: 'X', type: 'invalid_type' }],
    edges: [],
    about: [],
    episode_continues_previous: false,
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /type/);
});

test('empty entity name fails', () => {
  const r = validateBiographerOutput({
    entities: [{ name: '', type: 'person' }],
    edges: [],
    about: [],
    episode_continues_previous: false,
  });
  assert.equal(r.ok, false);
});

test('invalid edge type fails', () => {
  const r = validateBiographerOutput({
    entities: [{ name: 'X', type: 'person' }],
    edges: [{ from: 'X', type: 'unknown_edge', to: 'Y' }],
    about: [],
    episode_continues_previous: false,
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /edge/);
});

test('edge referencing unknown entity fails', () => {
  const r = validateBiographerOutput({
    entities: [{ name: 'X', type: 'person' }],
    edges: [{ from: 'X', type: 'mentions', to: 'Y_not_extracted' }],
    about: [],
    episode_continues_previous: false,
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /unknown entity/);
});

test('non-boolean episode_continues_previous fails', () => {
  const r = validateBiographerOutput({
    entities: [],
    edges: [],
    about: [],
    episode_continues_previous: 'yes',
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /episode_continues_previous/);
});
