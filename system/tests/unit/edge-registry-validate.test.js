import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RecordId } from 'surrealdb';
import { validateEdge } from '../../cognition/memory/edge-registry.js';

test('validateEdge accepts safe ids', () => {
  const result = validateEdge('events:abc', 'entities:thing__b_h', 'mentions');
  assert.equal(result.ok, true);
});

test('validateEdge rejects endpoint with & in id key (string form)', () => {
  const result = validateEdge('events:abc', 'entities:thing__b&h', 'mentions');
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /unsafe id key 'thing__b&h'/);
});

test('validateEdge rejects endpoint with & in id key (RecordId form)', () => {
  const bad = new RecordId('entities', 'thing__b&h');
  const result = validateEdge('events:abc', bad, 'mentions');
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /unsafe id key 'thing__b&h'/);
});

test('validateEdge rejects ids with spaces, brackets, dashes', () => {
  for (const badKey of ['thing__b h', 'thing__b-h', 'thing__b[h]', 'thing__b—h']) {
    const r = validateEdge('events:abc', `entities:${badKey}`, 'mentions');
    assert.equal(r.ok, false, `expected reject for '${badKey}'`);
  }
});

test('validateEdge does not regress on self-loop / unknown-kind detection', () => {
  const selfLoop = validateEdge('entities:foo', 'entities:foo', 'occurs_with');
  assert.equal(selfLoop.ok, false);
  assert.match(selfLoop.errors.join(' '), /self-loop/);

  const unknown = validateEdge('events:abc', 'entities:foo', 'nonexistent_kind');
  assert.equal(unknown.ok, false);
  assert.match(unknown.errors.join(' '), /unknown edge kind/);
});
