import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OUTCOME_ENVELOPE_FORMAT, parseOutcomeEnvelope } from './outcome.ts';

test('format is an SDK json_schema outputFormat requiring outcome + impact', () => {
  assert.equal(OUTCOME_ENVELOPE_FORMAT.type, 'json_schema');
  const schema = OUTCOME_ENVELOPE_FORMAT.schema as Record<string, unknown>;
  assert.deepEqual(schema.required, ['outcome', 'impact']);
});

test('parses a full valid envelope', () => {
  const env = parseOutcomeEnvelope({
    outcome: 'did-work',
    changes: [{ type: 'note', summary: 'rewrote stale section' }],
    impact: 'medium',
    notes: 'one file touched',
  });
  assert.ok(env);
  assert.equal(env.outcome, 'did-work');
  assert.equal(env.impact, 'medium');
  assert.equal(env.changes?.length, 1);
});

test('parses a minimal envelope (outcome + impact only)', () => {
  const env = parseOutcomeEnvelope({ outcome: 'no-op', impact: 'low' });
  assert.ok(env);
  assert.equal(env.outcome, 'no-op');
});

test('handler-specific extension fields are tolerated', () => {
  const env = parseOutcomeEnvelope({ outcome: 'blocked', impact: 'low', sources: ['x'] });
  assert.ok(env);
});

test('invalid shapes return null, never throw', () => {
  assert.equal(parseOutcomeEnvelope(undefined), null);
  assert.equal(parseOutcomeEnvelope(null), null);
  assert.equal(parseOutcomeEnvelope('did-work'), null);
  assert.equal(parseOutcomeEnvelope({ outcome: 'partied', impact: 'low' }), null);
  assert.equal(parseOutcomeEnvelope({ outcome: 'did-work' }), null); // impact missing
});
