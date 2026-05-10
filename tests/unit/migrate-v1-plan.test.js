import assert from 'node:assert';
import { test } from 'node:test';
import { PLAN_TABLES, renderPlan } from '../../src/migrate-v1/plan.js';

test('PLAN_TABLES enumerates all v1 tables (3 row-to-row + 17 lossy + 1 fold + 3 SKIP + 1 native_edge = 25)', () => {
  // capture, entity, episode (3 row-to-row), derived_from (1 fold), participates_in (1 native edge),
  // mentions, preference, correction, learning_question, prediction, action_outcome, action_trust,
  // domain_confidence, communication_style, depends_on, relates_to, supersedes, cites, produces,
  // knows, transaction, watch (17 lossy), embedding_cache, _migrations, _migration_failures (3 SKIP) = 25
  assert.equal(PLAN_TABLES.length, 25);
  for (const t of [
    'capture',
    'entity',
    'episode',
    'mentions',
    'participates_in',
    'preference',
    'correction',
    'transaction',
    'watch',
    'embedding_cache',
  ]) {
    assert.ok(
      PLAN_TABLES.find((x) => x.table === t),
      `missing ${t}`,
    );
  }
});

test('renderPlan formats per-table rows + totals', () => {
  const plan = {
    rows: [
      { table: 'capture', target: 'events', src: 2393, dup: 0, write: 2393 },
      { table: 'entity', target: 'entities', src: 949, dup: 0, write: 949 },
      {
        table: 'embedding_cache',
        target: 'SKIP (re-derived)',
        src: '?',
        dup: '-',
        write: 0,
        skip: true,
      },
    ],
    totals: { events: 2393, entities: 949, episodes: 0, edges: 0, embedQueue: 2393 },
  };
  const out = renderPlan(plan);
  assert.match(out, /capture\s+events\s+2393/);
  assert.match(out, /SKIP/);
  assert.match(out, /events written\s*:\s*2393/i);
});
