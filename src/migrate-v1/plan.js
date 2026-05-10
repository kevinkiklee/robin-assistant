import { listTableCount } from './v1-client.js';

export const PLAN_TABLES = [
  { table: 'entity', target: 'entities', skip: false, kind: 'entity' },
  { table: 'episode', target: 'episodes', skip: false, kind: 'episode' },
  { table: 'capture', target: 'events', skip: false, kind: 'event' },
  { table: 'derived_from', target: 'events.episode_id (folded)', skip: false, kind: 'fold' },
  { table: 'mentions', target: 'events (lossy, kind=v1_mentions)', skip: false, kind: 'event' },
  { table: 'participates_in', target: 'participates_in', skip: false, kind: 'edge' },
  { table: 'preference', target: 'events (kind=v1_preference)', skip: false, kind: 'event' },
  { table: 'correction', target: 'events (kind=v1_correction)', skip: false, kind: 'event' },
  { table: 'learning_question', target: 'events (kind=v1)', skip: false, kind: 'event' },
  { table: 'prediction', target: 'events (kind=v1)', skip: false, kind: 'event' },
  { table: 'action_outcome', target: 'events (kind=v1)', skip: false, kind: 'event' },
  { table: 'action_trust', target: 'events (kind=v1)', skip: false, kind: 'event' },
  { table: 'domain_confidence', target: 'events (kind=v1)', skip: false, kind: 'event' },
  { table: 'communication_style', target: 'events (kind=v1)', skip: false, kind: 'event' },
  { table: 'depends_on', target: 'events (kind=v1)', skip: false, kind: 'event' },
  { table: 'relates_to', target: 'events (kind=v1)', skip: false, kind: 'event' },
  { table: 'supersedes', target: 'events (kind=v1)', skip: false, kind: 'event' },
  { table: 'cites', target: 'events (kind=v1)', skip: false, kind: 'event' },
  { table: 'produces', target: 'events (kind=v1)', skip: false, kind: 'event' },
  { table: 'knows', target: 'events (kind=v1)', skip: false, kind: 'event' },
  { table: 'transaction', target: 'events (kind=v1_transaction)', skip: false, kind: 'event' },
  { table: 'watch', target: 'events (kind=v1)', skip: false, kind: 'event' },
  { table: 'embedding_cache', target: 'SKIP (re-derived)', skip: true },
  { table: '_migrations', target: 'SKIP (v1 internal)', skip: true },
  { table: '_migration_failures', target: 'SKIP (v1 internal)', skip: true },
];

export async function buildPlan({ v1, v2db }) {
  const rows = [];
  const totals = { events: 0, entities: 0, episodes: 0, edges: 0, embedQueue: 0 };
  for (const shape of PLAN_TABLES) {
    if (shape.skip) {
      rows.push({ ...shape, src: '?', dup: '-', write: 0 });
      continue;
    }
    let src = 0;
    try {
      src = await listTableCount(v1, shape.table);
    } catch {
      /* missing tables ok */
    }
    rows.push({ ...shape, src, dup: 0, write: src });
    if (shape.kind === 'fold') continue;
    if (shape.kind === 'entity') totals.entities += src;
    else if (shape.kind === 'episode') totals.episodes += src;
    else if (shape.kind === 'edge') totals.edges += src;
    else if (shape.kind === 'event') {
      totals.events += src;
      totals.embedQueue += src;
    }
  }
  return { rows, totals };
}

export function renderPlan(plan) {
  const lines = [
    'v1 → v2 migration plan (dry-run, no writes)',
    '',
    '  v1 table              v2 target                                  src     dup    write',
  ];
  for (const r of plan.rows) {
    const t = String(r.table).padEnd(22);
    const tgt = String(r.target).padEnd(42);
    const src = String(r.src).padStart(6);
    const dup = String(r.dup).padStart(6);
    const wr = String(r.write).padStart(8);
    lines.push(`  ${t}${tgt}${src}${dup}${wr}`);
  }
  lines.push('');
  lines.push('  Totals');
  lines.push(`    events written           : ${plan.totals.events}`);
  lines.push(`    entities written         : ${plan.totals.entities}`);
  lines.push(`    episodes written         : ${plan.totals.episodes}`);
  lines.push(`    edges written            : ${plan.totals.edges}`);
  lines.push(`    rows to embed (events)   : ${plan.totals.embedQueue}`);
  return lines.join('\n');
}
