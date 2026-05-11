import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateMetaCognitionOutput } from '../../cognition/meta_cognition/output.js';

const CFG = { max_rules_per_run: 3 };

test('valid output passes', () => {
  const r = validateMetaCognitionOutput(
    {
      narrative: 'Across this week, recall about photo-tools surfaced a stale memo.',
      clusters: [
        {
          cluster_id: 'entities:E1',
          error_pattern: 'A stale memo about a different toolkit kept surfacing.',
          suggested_rules: ['When asked about photo-tools, do not cite memos older than 60 days.'],
          rule_confidence: [0.8],
        },
      ],
    },
    CFG,
  );
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.parsed.clusters.length, 1);
});

test('missing narrative is rejected', () => {
  const r = validateMetaCognitionOutput({ clusters: [] }, CFG);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('narrative')));
});

test('non-string narrative is rejected', () => {
  const r = validateMetaCognitionOutput({ narrative: 42, clusters: [] }, CFG);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('narrative')));
});

test('clusters not array is rejected', () => {
  const r = validateMetaCognitionOutput({ narrative: 'x', clusters: 'oops' }, CFG);
  assert.equal(r.ok, false);
});

test('cluster missing fields is rejected', () => {
  const r = validateMetaCognitionOutput(
    {
      narrative: 'x',
      clusters: [{ cluster_id: 'a' }],
    },
    CFG,
  );
  assert.equal(r.ok, false);
  assert.ok(r.errors.join(';').match(/error_pattern|suggested_rules|rule_confidence/));
});

test('mismatched rule_confidence length is rejected', () => {
  const r = validateMetaCognitionOutput(
    {
      narrative: 'x',
      clusters: [
        {
          cluster_id: 'a',
          error_pattern: 'p',
          suggested_rules: ['r1', 'r2'],
          rule_confidence: [0.5],
        },
      ],
    },
    CFG,
  );
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('rule_confidence')));
});

test('confidence outside [0,1] is clamped (not rejected)', () => {
  const r = validateMetaCognitionOutput(
    {
      narrative: 'x',
      clusters: [
        {
          cluster_id: 'a',
          error_pattern: 'p',
          suggested_rules: ['r1'],
          rule_confidence: [1.5],
        },
      ],
    },
    CFG,
  );
  assert.equal(r.ok, true);
  assert.equal(r.parsed.clusters[0].rule_confidence[0], 1);
});

test('empty suggested_rules is accepted (conservative cluster)', () => {
  const r = validateMetaCognitionOutput(
    {
      narrative: 'Patterns are too thin for confident rules this week.',
      clusters: [
        {
          cluster_id: 'a',
          error_pattern: 'maybe x',
          suggested_rules: [],
          rule_confidence: [],
        },
      ],
    },
    CFG,
  );
  assert.equal(r.ok, true);
});

test('null/non-object input is rejected gracefully', () => {
  assert.equal(validateMetaCognitionOutput(null, CFG).ok, false);
  assert.equal(validateMetaCognitionOutput('not json', CFG).ok, false);
});
