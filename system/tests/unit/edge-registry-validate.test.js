import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RecordId } from 'surrealdb';
import {
  recordIdFromString,
  recordStringId,
  validateEdge,
} from '../../cognition/memory/edge-registry.js';

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

test('recordIdFromString strips ⟨…⟩ wrapping (regression: hyphenated event ids)', () => {
  // Pre-fix, `String(new RecordId('events', 'daily_briefing_2026-05-16_13'))`
  // produced `events:⟨daily_briefing_2026-05-16_13⟩`, and the naive
  // `slice(idx+1)` form built a RecordId whose id key INCLUDED the angle
  // brackets — so the biographer query for that record looked up
  // `events:⟨⟨…⟩⟩` (double-wrapped) and got nothing, throwing
  // "event ... not found" on every accumulator retry.
  const wrapped = 'events:⟨daily_briefing__daily_briefing_2026-05-16_13⟩';
  const rid = recordIdFromString(wrapped);
  assert.equal(String(rid.table ?? rid.tb), 'events');
  assert.equal(rid.id, 'daily_briefing__daily_briefing_2026-05-16_13');
});

test('recordIdFromString round-trips backtick-wrapped ids', () => {
  // Alternative SurrealDB unsafe-key form: backticks.
  const wrapped = 'events:`my id with spaces`';
  const rid = recordIdFromString(wrapped);
  assert.equal(String(rid.table ?? rid.tb), 'events');
  assert.equal(rid.id, 'my id with spaces');
});

test('recordIdFromString passes through safe id keys unchanged', () => {
  const rid = recordIdFromString('entities:person__ej_debowski');
  assert.equal(String(rid.table ?? rid.tb), 'entities');
  assert.equal(rid.id, 'person__ej_debowski');
});

test('recordIdFromString is a no-op on non-strings', () => {
  const r = new RecordId('events', 'safe_id');
  assert.equal(recordIdFromString(r), r);
  assert.equal(recordIdFromString(null), null);
  assert.equal(recordIdFromString(undefined), undefined);
});

test('recordIdFromString ∘ recordStringId is lossless for unsafe-key ids', () => {
  const original = new RecordId('events', 'daily_briefing_2026-05-16_13');
  const round = recordIdFromString(recordStringId(original));
  assert.equal(String(round.table ?? round.tb), String(original.table ?? original.tb));
  assert.equal(round.id, original.id);
});
