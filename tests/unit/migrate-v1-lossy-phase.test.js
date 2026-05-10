import assert from 'node:assert';
import { test } from 'node:test';
import { LOSSY_TABLES, buildLossyEvent } from '../../src/migrate-v1/phases/lossy.js';

test('LOSSY_TABLES covers exactly 17 v1 tables', () => {
  const expected = [
    'mentions',
    'preference',
    'correction',
    'learning_question',
    'prediction',
    'action_outcome',
    'action_trust',
    'domain_confidence',
    'communication_style',
    'depends_on',
    'relates_to',
    'supersedes',
    'cites',
    'produces',
    'knows',
    'transaction',
    'watch',
  ];
  assert.equal(LOSSY_TABLES.length, expected.length);
  for (const t of expected) {
    assert.ok(
      LOSSY_TABLES.find((x) => x.table === t),
      `missing ${t}`,
    );
  }
});

test('buildLossyEvent — preference shape', () => {
  const ev = buildLossyEvent(
    'preference',
    {
      id: 'preference:p1',
      what_worked: 'concise replies',
      domain: 'communication',
      signal_count: 3,
      evidence: [],
      promoted_to_style: null,
      created: '2026-01-01T00:00:00Z',
    },
    { resolver: null },
  );
  assert.equal(ev.source, 'migration');
  assert.equal(ev.content, 'concise replies');
  assert.equal(ev.meta.kind, 'v1_preference');
  assert.equal(ev.meta.v1_payload.signal_count, 3);
  assert.equal(ev.external_id, 'v1:preference:p1');
  assert.equal(ev.trust, 'trusted');
  assert.ok(!('embedding' in ev), 'embedding must be omitted, not null');
});

test('buildLossyEvent — transaction shape includes notes + lm_id', () => {
  const ev = buildLossyEvent(
    'transaction',
    {
      id: 'transaction:t1',
      date: '2026-04-01T00:00:00Z',
      payee: 'Whole Foods',
      amount: -42.5,
      category: 'groceries',
      notes: 'organic stuff',
      account: 'checking',
      lm_id: 'lm-123',
      source_file: 'inbox.csv',
      created: '2026-04-01T00:00:00Z',
    },
    { resolver: null },
  );
  assert.match(ev.content, /Whole Foods/);
  assert.match(ev.content, /organic stuff/);
  assert.equal(ev.meta.kind, 'v1_transaction');
  assert.equal(ev.meta.v1_payload.lm_id, 'lm-123');
  assert.equal(ev.meta.v1_payload.notes, 'organic stuff');
});

test('buildLossyEvent — edge table includes v2 endpoint resolution', () => {
  const resolver = {
    get: (kind, v1) => (kind === 'entity' && v1 === 'entity:e1' ? 'entities:E1' : null),
  };
  const ev = buildLossyEvent(
    'depends_on',
    {
      id: 'depends_on:d1',
      in: 'entity:e1',
      out: 'entity:e2',
      confidence: 'verified',
      valid_from: '2026-01-01T00:00:00Z',
      valid_until: null,
    },
    { resolver },
  );
  assert.equal(ev.meta.kind, 'v1_depends_on');
  assert.equal(ev.meta.v1_payload.v2_in_id, 'entities:E1');
  assert.equal(ev.meta.v1_payload.v2_out_id, null);
  assert.match(ev.content, /depends_on:.*entity:e1.*entity:e2/);
});

test('buildLossyEvent — empty content fallback', () => {
  const ev = buildLossyEvent(
    'preference',
    {
      id: 'preference:p2',
      what_worked: '',
      created: '2026-01-01T00:00:00Z',
    },
    { resolver: null },
  );
  assert.ok(ev.content.includes('preference:p2'));
});
