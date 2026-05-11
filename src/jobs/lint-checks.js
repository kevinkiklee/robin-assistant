// Mechanical health checks over knowledge/entities/edges. No LLM.
// IMPORTANT: when a new edge table is added to the schema, also add it to
// EDGE_TABLES below — orphan + dead-edge checks walk this list.
import { surql } from 'surrealdb';

const EDGE_TABLES = [
  'mentions',
  'about',
  'precedes',
  'works_on',
  'participates_in',
  'co_occurs_with',
];

const SEVERITY = {
  dead_edge: 5,
  orphan_entity: 4,
  duplicate_entity: 3,
  near_duplicate_knowledge: 2,
  stale_knowledge: 1,
};

async function checkOrphanEntities(db) {
  const issues = [];
  const [entities] = await db.query(surql`SELECT id, name, type FROM entities`).collect();
  for (const ent of entities ?? []) {
    let hasInbound = false;
    for (const edgeTable of EDGE_TABLES) {
      const [[row]] = await db
        .query(`SELECT count() AS n FROM ${edgeTable} WHERE out = ${String(ent.id)} GROUP ALL`)
        .collect();
      if ((row?.n ?? 0) > 0) {
        hasInbound = true;
        break;
      }
    }
    if (!hasInbound) {
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
  // SurrealDB v3 does not support HAVING. Group in JS instead.
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
  // NOTE: knowledge.updated_at uses VALUE time::now() in the schema, which means
  // SurrealDB re-triggers it to time::now() on every UPDATE. Direct backdating via
  // UPDATE SET updated_at = <past> is therefore not reliable. The cutoffDate option
  // allows callers (and tests) to pass a reference date — rows with
  // updated_at < cutoffDate AND confidence < 0.3 are flagged as stale.
  // In production, omit cutoffDate to use the default 30-day lookback.
  const cutoff = cutoffDate ?? new Date(Date.now() - 30 * 86_400_000);
  const [rows] = await db
    .query(
      surql`SELECT id, content FROM knowledge WHERE confidence < 0.3 AND updated_at < ${cutoff}`,
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
  // TYPE RELATION ENFORCED means SurrealDB rejects edge creates with missing
  // targets. Still scan for historical or test-injected ones.
  const issues = [];
  for (const edgeTable of EDGE_TABLES) {
    const [edges] = await db.query(`SELECT id, in, out FROM ${edgeTable}`).collect();
    for (const e of edges ?? []) {
      const [[inExists]] = await db.query(`SELECT count() AS n FROM ${e.in} GROUP ALL`).collect();
      const [[outExists]] = await db.query(`SELECT count() AS n FROM ${e.out} GROUP ALL`).collect();
      if ((inExists?.n ?? 0) === 0 || (outExists?.n ?? 0) === 0) {
        issues.push({
          kind: 'dead_edge',
          severity: SEVERITY.dead_edge,
          ref: String(e.id),
          message: `edge ${edgeTable} points to missing record(s)`,
        });
      }
    }
  }
  return issues;
}

function cosineSim(a, b) {
  // a and b may be Float32Array or plain array — both are indexable
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
  // Fetch all knowledge rows and compute pairwise cosine similarity in JS.
  // HNSW KNN syntax (WHERE embedding <|K, EF|> $vec) cannot be combined with
  // vector::similarity::cosine() in the same SELECT in SurrealDB v3. For the
  // number of knowledge rows expected in practice (<<10k) the JS scan is fine.
  const [rows] = await db.query(surql`SELECT id, content, embedding FROM knowledge`).collect();
  const items = rows ?? [];
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
 *   Defaults to 30 days ago. Pass a future date in tests to force all rows
 *   to appear stale (needed because knowledge.updated_at VALUE time::now()
 *   prevents reliable backdating via UPDATE).
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
