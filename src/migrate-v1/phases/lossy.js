import { surql } from 'surrealdb';
import { sha256 } from '../../embed/hash.js';
import { buildFromV1, sourceHash } from '../audit.js';
import { recordFailure } from '../failures.js';
import { scanTable } from '../v1-client.js';

export const LOSSY_TABLES = [
  {
    table: 'mentions',
    summarize: (r) => `mention: episode ${r.in} → entity ${r.out}`,
    payload: (r, ctx) => ({
      v1_episode_id: String(r.in),
      v1_entity_id: String(r.out),
      v2_episode_id: ctx.resolver?.get('episode', String(r.in)) ?? null,
      v2_entity_id: ctx.resolver?.get('entity', String(r.out)) ?? null,
    }),
  },
  {
    table: 'preference',
    summarize: (r) => r.what_worked ?? '',
    payload: (r) => ({
      what_worked: r.what_worked,
      domain: r.domain,
      signal_count: r.signal_count,
      evidence: r.evidence ?? [],
      promoted_to_style: r.promoted_to_style,
    }),
  },
  {
    table: 'correction',
    summarize: (r) => `corrected: ${r.what_went_wrong} → ${r.what_to_do}`,
    payload: (r) => ({
      what_went_wrong: r.what_went_wrong,
      what_to_do: r.what_to_do,
      domain: r.domain,
    }),
  },
  {
    table: 'learning_question',
    summarize: (r) => r.question ?? '',
    payload: (r) => ({
      question: r.question,
      why_it_matters: r.why_it_matters,
      domain: r.domain,
      status: r.status,
      asked_at: r.asked_at,
      resolved_at: r.resolved_at,
    }),
  },
  {
    table: 'prediction',
    summarize: (r) => r.claim ?? '',
    payload: (r) => ({
      claim: r.claim,
      confidence: r.confidence,
      status: r.status,
      check_by: r.check_by,
      resolved_at: r.resolved_at,
      reasoning: r.reasoning,
    }),
  },
  {
    table: 'action_outcome',
    summarize: (r) => `action_outcome: ${r.class} → ${r.outcome}`,
    payload: (r) => ({
      class: r.class,
      outcome: r.outcome,
      ref: r.ref,
      source_capture: r.source_capture ? String(r.source_capture) : null,
    }),
  },
  {
    table: 'action_trust',
    summarize: (r) => `action_trust: ${r.class} (${r.policy}/${r.state})`,
    payload: (r) => ({
      class: r.class,
      policy: r.policy,
      state: r.state,
      attempts: r.attempts,
      successes: r.successes,
      corrections: r.corrections,
      notes: r.notes,
      last_action_at: r.last_action_at,
    }),
  },
  {
    table: 'domain_confidence',
    summarize: (r) => `domain confidence (${r.level}): ${r.domain} — ${r.basis}`,
    payload: (r) => ({ domain: r.domain, level: r.level, basis: r.basis }),
  },
  {
    table: 'communication_style',
    summarize: (r) => r.style_notes ?? '',
    payload: (r) => ({
      scope: r.scope,
      domain: r.domain,
      source_preferences: (r.source_preferences ?? []).map(String),
    }),
  },
  { table: 'depends_on', isEdge: true },
  { table: 'relates_to', isEdge: true },
  { table: 'supersedes', isEdge: true },
  { table: 'cites', isEdge: true },
  { table: 'produces', isEdge: true },
  { table: 'knows', isEdge: true },
  {
    table: 'transaction',
    summarize: (r) =>
      `${r.date?.slice?.(0, 10) ?? ''} · ${r.payee} · ${r.amount} · ${r.category ?? ''} · ${r.notes ?? ''}`.trim(),
    payload: (r) => ({
      account: r.account,
      amount: r.amount,
      category: r.category,
      payee: r.payee,
      notes: r.notes,
      lm_id: r.lm_id,
      source_file: r.source_file,
      date: r.date,
    }),
  },
  {
    table: 'watch',
    summarize: (r) => `watch: ${r.description}`,
    payload: (r) => ({
      active: r.active,
      description: r.description,
      pattern: r.pattern,
      last_seen: r.last_seen,
      config: r.config,
    }),
  },
];

function buildEdgePayload(table, r, ctx) {
  return {
    v1_in_id: String(r.in),
    v1_out_id: String(r.out),
    v2_in_id: ctx.resolver?.get('entity', String(r.in)) ?? null,
    v2_out_id: ctx.resolver?.get('entity', String(r.out)) ?? null,
    confidence: r.confidence,
    valid_from: r.valid_from,
    valid_until: r.valid_until,
  };
}

const edgeSummary = (table, r) => `${table}: ${r.in} → ${r.out}`;

export function buildLossyEvent(table, v1Row, ctx = {}) {
  const def = LOSSY_TABLES.find((t) => t.table === table);
  if (!def) throw new Error(`unknown lossy table: ${table}`);
  const rawContent = def.isEdge ? edgeSummary(table, v1Row) : (def.summarize?.(v1Row) ?? '');
  const safeContent =
    String(rawContent).length === 0 ? `(v1 ${table} ${v1Row.id})` : String(rawContent);
  const v1_payload = def.isEdge
    ? buildEdgePayload(table, v1Row, ctx)
    : (def.payload?.(v1Row, ctx) ?? {});
  const ev = {
    content: safeContent,
    source: 'migration',
    content_hash: sha256(safeContent),
    ts: v1Row.ts ?? v1Row.created ?? v1Row.date ?? new Date().toISOString(),
    external_id: `v1:${v1Row.id}`,
    trust: 'trusted',
    meta: {
      kind: `v1_${table}`,
      v1_payload,
      from_v1: buildFromV1({ v1_table: table, v1_id: String(v1Row.id) }),
    },
  };
  // intentionally omit `embedding` — backfill picks up where embedding IS NONE
  return ev;
}

export async function runLossyPhase({ v1, v2db, resolver, progress }) {
  const stats = {};
  for (const def of LOSSY_TABLES) {
    let imported = 0;
    let dup = 0;
    let any = false;
    let lastId = progress?.cursor?.[`lossy:${def.table}`]?.last_v1_id ?? null;
    try {
      for await (const batch of scanTable(v1, def.table, { batch: 200, startAfter: lastId })) {
        any = true;
        for (const v1Row of batch) {
          const hash = sourceHash(String(v1Row.id));
          const [existing] = await v2db
            .query(surql`SELECT id FROM events WHERE meta.from_v1.source_hash = ${hash} LIMIT 1`)
            .collect();
          if (existing[0]?.id) {
            dup++;
            lastId = String(v1Row.id);
            continue;
          }
          try {
            const ev = buildLossyEvent(def.table, v1Row, { resolver });
            await v2db.query(surql`CREATE events CONTENT ${ev}`).collect();
            imported++;
          } catch (e) {
            await recordFailure(v2db, {
              v1_table: def.table,
              v1_id: String(v1Row.id),
              error_message: e.message,
              phase: `lossy:${def.table}`,
            });
          }
          lastId = String(v1Row.id);
        }
        progress.advance({ phase: `lossy:${def.table}`, last_v1_id: lastId, imported, dup });
      }
    } catch (e) {
      // Table may not exist in this v1 instance — continue.
      if (!/(?:not found|does not exist)/i.test(String(e?.message))) throw e;
    }
    stats[def.table] = { imported, dup, present: any };
  }
  return stats;
}
