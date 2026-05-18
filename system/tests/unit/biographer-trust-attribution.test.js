import assert from 'node:assert/strict';
import test from 'node:test';
import { applyDerivedTrust } from '../../cognition/biographer/output.js';

test('per-record derived_from_trust uses cited sources only', () => {
  const events = [
    { id: 'events:e1', trust: 'trusted' },
    { id: 'events:e2', trust: 'untrusted' },
  ];
  const extraction = {
    entities: [
      { name: 'Alice', source_event_ids: ['events:e1'] }, // cites trusted
      { name: 'Bob', source_event_ids: ['events:e2'] }, // cites untrusted
      { name: 'Carol', source_event_ids: ['events:e1', 'events:e2'] }, // mixed
      { name: 'Dan', source_event_ids: ['events:bogus'] }, // not in batch → fallback
    ],
  };
  const stamped = applyDerivedTrust(extraction.entities, events);
  assert.equal(stamped[0].derived_from_trust, 'trusted');
  assert.equal(stamped[1].derived_from_trust, 'untrusted');
  assert.equal(stamped[2].derived_from_trust, 'untrusted');
  // Fallback: invalid citation → mergeTrust over the full batch.
  // Batch contains an untrusted event, so fallback = untrusted.
  assert.equal(stamped[3].derived_from_trust, 'untrusted');
});

test('all-trusted batch produces all-trusted records even on bogus citations', () => {
  const events = [{ id: 'events:e1', trust: 'trusted' }];
  const stamped = applyDerivedTrust([{ name: 'X', source_event_ids: ['events:bogus'] }], events);
  assert.equal(stamped[0].derived_from_trust, 'trusted');
});
