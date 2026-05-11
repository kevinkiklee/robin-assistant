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

test('malformed entry recorded as malformed; valid ones still returned', () => {
  const bad = {
    event_id: 'events:b',
    entities: [{ name: 'X', type: 'unicorn' }],
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
  assert.ok(r.events.has('events:a'));
  assert.ok(r.events.has('events:c'));
  assert.equal(r.malformed.length, 1);
  assert.equal(r.malformed[0].event_id, 'events:b');
  assert.match(r.malformed[0].error, /type/);
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
