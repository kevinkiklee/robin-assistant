// prompt.js — system + user prompt construction for D2 meta-cognition.
// Spec §3.3. Token-budget enforcement is greedy: emit header → each cluster
// in score order. If adding a cluster would exceed `max_tokens_in`, first
// truncate that cluster's rows down to min_cluster_size (defaulted at 2);
// if still overflowing, drop the cluster. Return diagnostics so the
// orchestrator can record telemetry.

export const META_COGNITION_SYSTEM = `You analyze patterns in Robin's recall failures.

You will see clusters of recall events where Robin retrieved memos that led to a user correction (or surfaced memos the agent didn't use). Each cluster groups failure events by a shared topic (an entity Robin's memos are "about") or by surface (intuition vs MCP recall).

For each cluster, output:
- error_pattern: one sentence naming what Robin got wrong (not what the user said — what Robin's recall surfaced incorrectly).
- suggested_rules: 0–3 rule strings, second person, behavioral, one sentence each. Empty array if the cluster is too thin to support a confident rule.
- rule_confidence: number in [0,1] per rule (parallel array to suggested_rules; same length).

Output JSON only:
{
  "narrative": string,                  // 2-4 sentence summary across all clusters (becomes the reasoning memo body)
  "clusters": [
    {
      "cluster_id": string,             // echoes the input cluster identifier (entity_id or surface)
      "error_pattern": string,
      "suggested_rules": string[],
      "rule_confidence": number[]
    }
  ]
}

Rules:
- Be conservative. If a cluster has only 2-3 rows and the failures rhyme by coincidence, output suggested_rules: [].
- Distinguish "the memo content was wrong" (the underlying fact is stale) from "the memo was right but irrelevant" (recall surfaced it inappropriately) from "the agent acted on the right memo but in the wrong way" (this is upstream of recall — out of scope here).
- Rules should be actionable in recall ranking or in agent behavior. Avoid rules that require new infrastructure (e.g. "build a classifier").
- Never invent a cluster the input didn't contain.`;

/**
 * Rough token estimate: 4 chars ≈ 1 token. Conservative enough that token
 * accounting matches `host.invokeLLM`'s pricing model within ±15%.
 */
function approxTokens(s) {
  return Math.ceil((s?.length ?? 0) / 4);
}

/**
 * Build the user-prompt text plus diagnostics.
 *
 * @param {Array<object>} clusters    Output of `clusterByAboutEndpoints` OR a
 *                                    surface-grouped fallback (each cluster
 *                                    carries `cluster_id` and either
 *                                    `entity_id`+`entity_name` or `surface`).
 * @param {{ week_starting:string, n_corrected:number, n_unused:number, top_k_clusters:number }} meta
 * @param {{ max_tokens_in:number, top_k_clusters:number, min_cluster_size?:number }} config
 * @param {{ memoById: Map<string, { kind?:string, content?:string, derived_at?:any }> }} ctx
 * @returns {{ text:string, clusters_emitted:number, dropped_clusters:number }}
 */
export function buildUserPrompt(clusters, meta, config, ctx) {
  const memoById = ctx?.memoById ?? new Map();
  const minRows = config.min_cluster_size ?? 2;
  const budget = config.max_tokens_in;

  const header =
    `Week of ${meta.week_starting}. ${meta.n_corrected} corrected rows + ` +
    `${meta.n_unused} unused-hit rows in the trailing 7 days. ` +
    `${clusters.length} clusters below (top-${meta.top_k_clusters} by failure-weighted touch count).\n`;

  let buf = header;
  let emitted = 0;
  let dropped = 0;

  for (let i = 0; i < clusters.length; i++) {
    const cluster = clusters[i];
    let rows = cluster.rows ?? [];
    let block = renderCluster(cluster, rows, memoById, i + 1);
    if (approxTokens(buf + block) > budget) {
      // Try truncating rows down to minRows.
      while (rows.length > minRows && approxTokens(buf + block) > budget) {
        rows = rows.slice(0, rows.length - 1);
        block = renderCluster(cluster, rows, memoById, i + 1);
      }
      if (approxTokens(buf + block) > budget) {
        dropped += 1;
        continue;
      }
    }
    buf += block;
    emitted += 1;
  }

  return { text: buf, clusters_emitted: emitted, dropped_clusters: dropped };
}

function renderCluster(cluster, rows, memoById, n) {
  const label = cluster.entity_id
    ? (cluster.entity_name ?? cluster.entity_id)
    : `surface=${cluster.surface ?? 'unknown'}`;
  const rowsLines = rows
    .map((r) => {
      const tsStr = r.ts ? String(r.ts).slice(0, 19) : '';
      const q = String(r.query ?? '').slice(0, 120);
      const retrieved = (r.ranked_hits ?? []).map((h) => String(h.record).slice(0, 30)).join(', ');
      return `  - ${tsStr} | query: "${q}" | retrieved: [${retrieved}]`;
    })
    .join('\n');
  const memoLines = (cluster.memo_ids ?? [])
    .slice(0, 5)
    .map((mid) => {
      const m = memoById.get(mid);
      if (!m) return `  - [memo ${mid}] <not hydrated>`;
      const kind = m.kind ?? 'unknown';
      const derived = m.derived_at ? String(m.derived_at).slice(0, 10) : '?';
      const snippet = String(m.content ?? '').slice(0, 200);
      return `  - [memo ${kind} ${derived}] ${snippet}`;
    })
    .join('\n');
  return (
    `\n---\nCluster ${n}: ${label} (score: ${cluster.score})\n` +
    `Rows in this cluster:\n${rowsLines}\n` +
    `Representative retrieved memos:\n${memoLines}\n`
  );
}
