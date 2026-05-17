import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateBiographerBatchOutput } from '../../cognition/biographer/batch-output.js';

function validPerEvent(id) {
  return {
    event_id: id,
    entities: [{ name: 'Alice', type: 'person' }],
    edges: [],
    about: [],
    episode_continues_previous: false,
    episode_summary: null,
  };
}

test('well-formed batch with 3 entries returns ok with 3 entries', () => {
  const r = validateBiographerBatchOutput(
    {
      events: [validPerEvent('events:a'), validPerEvent('events:b'), validPerEvent('events:c')],
    },
    ['events:a', 'events:b', 'events:c'],
  );
  assert.equal(r.ok, true);
  assert.equal(r.events.size, 3);
  assert.deepEqual(r.missing, []);
  assert.deepEqual(r.malformed, []);
});

test('missing event_id in output recorded as missing', () => {
  const r = validateBiographerBatchOutput({ events: [validPerEvent('events:a')] }, [
    'events:a',
    'events:b',
  ]);
  assert.equal(r.ok, true);
  assert.equal(r.events.size, 1);
  assert.deepEqual(r.missing, ['events:b']);
});

test('entry with off-vocab entity type is coerced and kept, not malformed', () => {
  // After the validator was made coercing (raising end-to-end batch success
  // from ~75% to ~95% by dropping bad rows instead of failing the batch),
  // an off-vocabulary entity type demotes to `thing` and the entry is kept.
  // Only structural failures land in `malformed` now.
  const coerceable = {
    event_id: 'events:b',
    entities: [{ name: 'X', type: 'unicorn' }],
    edges: [],
    about: [],
    episode_continues_previous: false,
  };
  const r = validateBiographerBatchOutput(
    { events: [validPerEvent('events:a'), coerceable, validPerEvent('events:c')] },
    ['events:a', 'events:b', 'events:c'],
  );
  assert.equal(r.ok, true);
  assert.equal(r.events.size, 3);
  assert.equal(r.malformed.length, 0);
  // Coerced entry surfaces its warnings via _biographer_warnings.
  const entryB = r.events.get('events:b');
  assert.ok(Array.isArray(entryB._biographer_warnings));
  assert.ok(entryB._biographer_warnings.some((w) => w.includes('"unicorn" → "thing"')));
  assert.equal(entryB.entities[0].type, 'thing');
});

test('structurally bad entry still lands in malformed', () => {
  // Hard fail: `entities: "not-an-array"` is a structural issue the
  // validator can't coerce away (it has no rows to keep).
  const bad = {
    event_id: 'events:b',
    entities: 'not-an-array',
    edges: [],
    about: [],
    episode_continues_previous: false,
  };
  const r = validateBiographerBatchOutput(
    { events: [validPerEvent('events:a'), bad, validPerEvent('events:c')] },
    ['events:a', 'events:b', 'events:c'],
  );
  assert.equal(r.ok, true);
  assert.equal(r.events.size, 2);
  assert.equal(r.malformed.length, 1);
  assert.equal(r.malformed[0].event_id, 'events:b');
});

test('non-array events triggers batch-level fail', () => {
  const r = validateBiographerBatchOutput({ events: 'oops' }, ['events:a']);
  assert.equal(r.ok, false);
  assert.match(r.error, /events.*array/i);
});

test('non-object outer triggers batch-level fail', () => {
  const r = validateBiographerBatchOutput(null, ['events:a']);
  assert.equal(r.ok, false);
});

test('extra event_id in output not in expected is ignored', () => {
  const r = validateBiographerBatchOutput(
    {
      events: [validPerEvent('events:a'), validPerEvent('events:rogue')],
    },
    ['events:a'],
  );
  assert.equal(r.ok, true);
  assert.equal(r.events.size, 1);
  assert.ok(r.events.has('events:a'));
  // Extras must NOT be in malformed (they're simply discarded).
  assert.deepEqual(r.malformed, []);
});

test('entry missing event_id marked malformed with descriptive error', () => {
  const noId = { entities: [], edges: [], about: [], episode_continues_previous: false };
  const r = validateBiographerBatchOutput({ events: [noId] }, ['events:a']);
  assert.equal(r.ok, true);
  assert.equal(r.events.size, 0);
  // No event_id → can't pin malformed[].event_id. Use sentinel '<missing event_id>'.
  assert.equal(r.malformed.length, 1);
  assert.equal(r.malformed[0].event_id, '<missing event_id>');
});
