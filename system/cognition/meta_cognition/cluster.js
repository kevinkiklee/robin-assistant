// cluster.js — pure in-Node clustering for D2 meta-cognition.
// Spec §3.2. No DB imports; the orchestrator hydrates `aboutByMemoId` and
// `entityNameById` upstream and passes them in.

const SECONDARY_OUTCOME = 'unused'; // sentinel set by the orchestrator on
// rows pulled from the unused-hits query.

/**
 * Cluster recall failures by shared `about` endpoints of their retrieved
 * memos. Returns up to `config.top_k_clusters` clusters, each with at least
 * `config.min_cluster_size` member rows.
 *
 * @param {{
 *   rows: Array<{
 *     id: string,
 *     outcome: 'corrected' | 'unused' | string,
 *     ranked_hits: Array<{ record: string, kind?: string }>,
 *     query?: string,
 *     ts?: any,
 *     meta?: any,
 *   }>,
 *   aboutByMemoId: Map<string, string[]>,   // memo id (stringified) → entity ids
 *   entityNameById?: Map<string, string>,   // optional; only used to label clusters
 * }} hydrated
 * @param {{
 *   top_k_clusters: number,
 *   min_cluster_size: number,
 *   unused_signal_weight: number,
 * }} config
 * @returns {Array<{
 *   entity_id: string,
 *   entity_name: string | null,
 *   score: number,
 *   rows: Array<object>,           // truncated to ≤ 10
 *   memo_ids: string[],            // dedup'd retrieved memo ids in this cluster
 * }>}
 */
export function clusterByAboutEndpoints(hydrated, config) {
  const { rows = [], aboutByMemoId, entityNameById } = hydrated ?? {};
  if (!rows.length) return [];

  // Pass 1: per-entity weighted score + member-row sets.
  const entityScore = new Map();
  const memberRowsByEntity = new Map();

  for (const row of rows) {
    const weight = row.outcome === SECONDARY_OUTCOME ? config.unused_signal_weight : 1.0;
    const touched = new Set();
    for (const hit of row.ranked_hits ?? []) {
      const recordStr = String(hit?.record ?? '');
      const isMemo = hit?.kind === 'memo' || recordStr.startsWith('memos:');
      if (!isMemo) continue;
      const entities = aboutByMemoId?.get(recordStr) ?? [];
      for (const eid of entities) touched.add(eid);
    }
    for (const eid of touched) {
      entityScore.set(eid, (entityScore.get(eid) ?? 0) + weight);
      if (!memberRowsByEntity.has(eid)) memberRowsByEntity.set(eid, []);
      memberRowsByEntity.get(eid).push(row);
    }
  }

  // Pass 2: sort, cap, min-size filter.
  const sorted = [...entityScore.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, config.top_k_clusters);

  const clusters = [];
  for (const [entity_id, score] of sorted) {
    const member = memberRowsByEntity.get(entity_id) ?? [];
    if (member.length < config.min_cluster_size) continue;
    const memo_ids = dedupRetrievedMemoIds(member);
    clusters.push({
      entity_id,
      entity_name: entityNameById?.get(entity_id) ?? null,
      score,
      rows: member.slice(0, 10),
      memo_ids,
    });
  }
  return clusters;
}

function dedupRetrievedMemoIds(rows) {
  const seen = new Set();
  for (const row of rows) {
    for (const hit of row.ranked_hits ?? []) {
      const recordStr = String(hit?.record ?? '');
      const isMemo = hit?.kind === 'memo' || recordStr.startsWith('memos:');
      if (isMemo) seen.add(recordStr);
    }
  }
  return [...seen];
}
