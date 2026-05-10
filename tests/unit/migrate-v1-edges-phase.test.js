import assert from 'node:assert';
import { test } from 'node:test';
import { buildParticipatesInPayload } from '../../src/migrate-v1/phases/edges.js';

test('buildParticipatesInPayload preserves dropped v1 fields in meta.v1_payload', () => {
  const out = buildParticipatesInPayload({
    id: 'participates_in:pi1',
    in: 'entity:e1',
    out: 'entity:e2',
    confidence: 'verified',
    archived_at: null,
    valid_from: '2026-01-01T00:00:00Z',
    valid_until: null,
    derived_from: ['episode:ep1'],
  });
  assert.equal(out.meta.kind, 'v1_participates_in');
  assert.equal(out.meta.v1_payload.confidence, 'verified');
  assert.equal(out.meta.v1_payload.valid_from, '2026-01-01T00:00:00Z');
  assert.equal(out.meta.v1_payload.derived_from[0], 'episode:ep1');
  assert.equal(out.meta.from_v1.v1_id, 'participates_in:pi1');
});
