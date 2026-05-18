// Coverage for the toRecordRef coercion helper. The helper exists because
// SurrealDB v2.0.3's `surql` tagged template treats JS strings as string
// parameters — interpolating a bare `'entities:foo'` produces a string
// LITERAL and the engine rejects UPDATE/SELECT-FROM against it. RecordId /
// StringRecordId instances round-trip as record references.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RecordId, StringRecordId } from 'surrealdb';
import { toRecordRef } from '../../data/db/record-ref.js';

test('string is wrapped in StringRecordId', () => {
  const r = toRecordRef('entities:place__new_york_city');
  assert.ok(r instanceof StringRecordId);
  assert.equal(String(r), 'entities:place__new_york_city');
});

test('RecordId passes through untouched', () => {
  const rid = new RecordId('entities', 'kevin');
  const r = toRecordRef(rid);
  assert.strictEqual(r, rid);
});

test('StringRecordId passes through untouched', () => {
  const sid = new StringRecordId('entities:kevin');
  const r = toRecordRef(sid);
  assert.strictEqual(r, sid);
});

test('null / undefined pass through', () => {
  assert.equal(toRecordRef(null), null);
  assert.equal(toRecordRef(undefined), undefined);
});

test('row-shape object unwraps .id and recurses', () => {
  const row = { id: 'entities:kevin', name: 'Kevin' };
  const r = toRecordRef(row);
  assert.ok(r instanceof StringRecordId);
  assert.equal(String(r), 'entities:kevin');
});

test('row with RecordId .id field passes that through', () => {
  const rid = new RecordId('entities', 'kevin');
  const row = { id: rid, name: 'Kevin' };
  const r = toRecordRef(row);
  assert.strictEqual(r, rid);
});
