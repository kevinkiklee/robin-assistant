// lint-checks.js — mechanical health checks over the knowledge graph.
//
// Redesigned for the unified `edges` table and `memos` table:
//   - Orphan + dead-edge checks: a single grouped query over `edges` replaces
//     the per-table fan-out.
//   - near_duplicate_knowledge + stale_knowledge: read from `memos` filtered
//     to `kind = 'knowledge'`. Embeddings come from `embeddings_<profile>_memos`.
//   - Output shape (kind / severity / ref / message) is preserved so existing
//     consumers (lint MCP tool, dashboards) don't need updates.

import { surql } from 'surrealdb';
import { embeddingTable, readProfile } from '../embed/profile-router.js';

const SEVERITY = {
  dead_edge: 5,
  orphan_entity: 4,
  duplicate_entity: 3,
  near_duplicate_knowledge: 2,
  stale_knowledge: 1,
};

async function checkOrphanEntities(db) {
  // An entity is an "orphan" if no edge of any kind points at it.
  const [entities] = await db.query(surql`SELECT id, name, type FROM entities`).collect();
  if (!entities || entities.length === 0) return [];
  // Build the set of entity ids that appear on either side of any edge.
  const [edgeRefs] = await db
    .query(
      `SELECT VALUE to FROM edges
       WHERE to IN $ids
       LIMIT 100000`,
      { ids: entities.map((e) => e.id) },
    )
    .collect();
  const referenced = new Set((edgeRefs ?? []).map((r) => String(r)));
  const issues = [];
  for (const ent of entities) {
    if (!referenced.has(String(ent.id))) {
      issues.push({
        kind: 'orphan_entity',
        severity: SEVERITY.orphan_entity,
        ref: String(ent.id),
        message: `entity '${ent.name}' (${ent.type}) has no inbound edges`,
      });
    }
  }
  return issues;
}

async function checkDuplicateEntities(db) {
  // SurrealDB v3 has no HAVING; group in JS.
  const [rows] = await db.query(surql`SELECT id, name_lower, type FROM entities`).collect();
  const groups = new Map();
  for (const r of rows ?? []) {
    const key = `${r.name_lower}::${r.type}`;
    if (!groups.has(key)) groups.set(key, { name_lower: r.name_lower, type: r.type, ids: [] });
    groups.get(key).ids.push(r.id);
  }
  const issues = [];
  for (const g of groups.values()) {
    if (g.ids.length < 2) continue;
    issues.push({
      kind: 'duplicate_entity',
      severity: SEVERITY.duplicate_entity,
      ref: g.ids.map(String).sort().join(','),
      message: `entity name '${g.name_lower}' (${g.type}) appears ${g.ids.length} times`,
    });
  }
  return issues;
}

async function checkStaleKnowledge(db, { cutoffDate } = {}) {
  // `memos.updated_at` uses VALUE time::now() — direct backdating via UPDATE
  // is not reliable, hence the cutoffDate override hook used by tests.
  const cutoff = cutoffDate ?? new Date(Date.now() - 30 * 86_400_000);
  const [rows] = await db
    .query(
      surql`SELECT id, content FROM memos
            WHERE kind = 'knowledge'
              AND confidence < 0.3
              AND updated_at < ${cutoff}`,
    )
    .collect();
  return (rows ?? []).map((r) => ({
    kind: 'stale_knowledge',
    severity: SEVERITY.stale_knowledge,
    ref: String(r.id),
    message: `low-confidence knowledge older than 30d: ${r.content.slice(0, 80)}`,
  }));
}

async function checkDeadEdges(db) {
  // DEFINE EVENT cascade_edges_* triggers prune edges on endpoint delete, so
  // dead edges should be rare in steady state. Test-injected or pre-cascade
  // rows can still exist; surface them here.
  const [edges] = await db.query(surql`SELECT id, kind, from, to FROM edges`).collect();
  const issues = [];
  // Group endpoint refs per source table to batch existence checks. Endpoints
  // can be from any of {events, memos, entities, episodes}; we look up each
  // referenced table once.
  const byTable = new Map();
  const enqueue = (ref) => {
    if (!ref) return;
    const tb = typeof ref === 'string' ? ref.split(':')[0] : (ref.table ?? ref.tb);
    if (!tb) return;
    if (!byTable.has(tb)) byTable.set(tb, new Set());
    byTable.get(tb).add(ref);
  };
  for (const e of edges ?? []) {
    enqueue(e.from);
    enqueue(e.to);
  }
  const alive = new Set();
  for (const [tb, refs] of byTable.entries()) {
    if (refs.size === 0) continue;
    try {
      const [rows] = await db
        .query(`SELECT VALUE id FROM ${tb} WHERE id IN $refs`, { refs: Array.from(refs) })
        .collect();
      for (const r of rows ?? []) alive.add(String(r));
    } catch {
      // If the table doesn't exist any more, treat all its refs as dead.
    }
  }
  for (const e of edges ?? []) {
    const fromAlive = alive.has(String(e.from));
    const toAlive = alive.has(String(e.to));
    if (!fromAlive || !toAlive) {
      issues.push({
        kind: 'dead_edge',
        severity: SEVERITY.dead_edge,
        ref: String(e.id),
        message: `edge ${e.kind} points to missing record(s)`,
      });
    }
  }
  return issues;
}

function cosineSim(a, b) {
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

async function checkNearDuplicateKnowledge(db) {
  // Read all knowledge memos and join-back to the active read profile's
  // embedding table. HNSW kNN cannot be combined with vector::similarity in
  // a single SELECT on SurrealDB v3; for the expected row count (<<10k) the
  // JS pairwise scan is fast enough.
  const [memoRows] = await db
    .query(surql`SELECT id, content FROM memos WHERE kind = 'knowledge'`)
    .collect();
  const memos = memoRows ?? [];
  if (memos.length < 2) return [];
  const profile = await readProfile(db);
  const tbl = embeddingTable(profile, 'memos');
  const [embRows] = await db
    .query(`SELECT record, vector FROM ${tbl} WHERE record IN $ids`, {
      ids: memos.map((m) => m.id),
    })
    .collect();
  const vecById = new Map((embRows ?? []).map((r) => [String(r.record), r.vector]));
  const items = memos
    .map((m) => ({ id: m.id, content: m.content, embedding: vecById.get(String(m.id)) }))
    .filter((c) => Array.isArray(c.embedding) || ArrayBuffer.isView(c.embedding));
  const issues = [];
  const seen = new Set();
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const sim = cosineSim(items[i].embedding, items[j].embedding);
      if (sim < 0.95) continue;
      const pair = [String(items[i].id), String(items[j].id)].sort().join('::');
      if (seen.has(pair)) continue;
      seen.add(pair);
      issues.push({
        kind: 'near_duplicate_knowledge',
        severity: SEVERITY.near_duplicate_knowledge,
        ref: pair,
        message: `near-duplicate knowledge: cosine ${sim.toFixed(3)}`,
      });
    }
  }
  return issues;
}

/**
 * Run all mechanical lint checks over the knowledge graph.
 *
 * @param {import('surrealdb').Surreal} db
 * @param {object} [opts]
 * @param {Date} [opts.cutoffDate] - Override the staleness cutoff date.
 *   Defaults to 30 days ago. Tests pass a future date to force all rows
 *   to appear stale (memos.updated_at uses VALUE time::now() so direct
 *   backdating via UPDATE is not reliable).
 * @returns {Promise<Array<{kind: string, severity: number, ref: string, message: string}>>}
 */
export async function runLintChecks(db, { cutoffDate } = {}) {
  const all = [
    ...(await checkDeadEdges(db)),
    ...(await checkOrphanEntities(db)),
    ...(await checkDuplicateEntities(db)),
    ...(await checkNearDuplicateKnowledge(db)),
    ...(await checkStaleKnowledge(db, { cutoffDate })),
  ];
  all.sort((a, b) => {
    if (a.severity !== b.severity) return b.severity - a.severity;
    if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
    return a.ref < b.ref ? -1 : 1;
  });
  return all;
}
