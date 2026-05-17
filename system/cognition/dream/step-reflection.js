import { surql } from 'surrealdb';
import { embeddingTable, readProfile } from '../../data/embed/profile-router.js';
import { createCandidate, findOverlappingPendingCandidate } from './candidates.js';
import { CORRECTION_RULE_SYSTEM } from './prompts.js';

const DEFAULT_LOOKBACK_DAYS = 30;
const DEFAULT_MIN_CLUSTER = 3;
const DEFAULT_SIM_THRESHOLD = 0.85;
const DEFAULT_OVERLAP_THRESHOLD = 0.5;

// Cosine similarity over embeddings that are already L2-normalised at write
// time by the embedder, so dot product is sufficient.
function cosine(a, b) {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

/**
 * Single-link agglomerative clustering on event embeddings. Two clusters
 * merge if any pair of embeddings across them has cosine ≥ `threshold`.
 *
 * Implementation note: a labelled `break outer` would be the natural way
 * to restart the merge scan, but biome flags labelled statements; we use
 * a `merged` flag that's checked after each inner break instead.
 */
function clusterEvents(events, threshold) {
  const clusters = events.map((e) => ({ ids: [e.id], embeds: [e.embedding] }));
  let merged = true;
  while (merged) {
    merged = false;
    for (let i = 0; i < clusters.length && !merged; i++) {
      for (let j = i + 1; j < clusters.length && !merged; j++) {
        for (const ea of clusters[i].embeds) {
          if (merged) break;
          for (const eb of clusters[j].embeds) {
            if (cosine(ea, eb) >= threshold) {
              clusters[i].ids.push(...clusters[j].ids);
              clusters[i].embeds.push(...clusters[j].embeds);
              clusters.splice(j, 1);
              merged = true;
              break;
            }
          }
        }
      }
    }
  }
  return clusters;
}

export async function dreamStepReflection(
  db,
  host,
  {
    lookbackDays = DEFAULT_LOOKBACK_DAYS,
    minCluster = DEFAULT_MIN_CLUSTER,
    similarityThreshold = DEFAULT_SIM_THRESHOLD,
    overlapThreshold = DEFAULT_OVERLAP_THRESHOLD,
  } = {},
) {
  const cutoff = new Date(Date.now() - lookbackDays * 86400_000);
  const [rows] = await db
    .query(
      surql`SELECT id, content FROM events
            WHERE meta.kind = 'correction' AND ts >= ${cutoff}`,
    )
    .collect();
  if (!rows || rows.length < minCluster) return { clusters: 0, proposed: 0 };

  // Join-back to the active read profile's events embedding surface.
  const profile = await readProfile(db);
  const eventsEmbTbl = embeddingTable(profile, 'events');
  const [embRows] = await db
    .query(`SELECT record, vector FROM ${eventsEmbTbl} WHERE record IN $ids`, {
      ids: rows.map((r) => r.id),
    })
    .collect();
  const vecById = new Map((embRows ?? []).map((r) => [String(r.record), r.vector]));
  const hydrated = rows
    .map((r) => ({ id: r.id, content: r.content, embedding: vecById.get(String(r.id)) }))
    .filter((r) => Array.isArray(r.embedding) || ArrayBuffer.isView(r.embedding));
  if (hydrated.length < minCluster) return { clusters: 0, proposed: 0 };

  const clusters = clusterEvents(hydrated, similarityThreshold).filter(
    (c) => c.ids.length >= minCluster,
  );
  let proposed = 0;
  let tokens_in = 0;
  let tokens_out = 0;

  for (const cluster of clusters) {
    const overlap = await findOverlappingPendingCandidate(
      db,
      'behavior',
      cluster.ids,
      overlapThreshold,
    );
    if (overlap) continue;

    const [evRows] = await db
      .query(surql`SELECT content FROM events WHERE id IN ${cluster.ids}`)
      .collect();
    const userPrompt = `Cluster of corrections:
${(evRows ?? []).map((e) => `- ${e.content}`).join('\n')}

Distill into a behavioral rule.`;

    let result;
    try {
      const r = await host.invokeLLM([{ role: 'user', content: userPrompt }], {
        tier: 'fast',
        json: true,
        system: [
          {
            role: 'system',
            content: CORRECTION_RULE_SYSTEM,
            cache_control: { type: 'ephemeral' },
          },
        ],
      });
      tokens_in += r?.usage?.input_tokens ?? 0;
      tokens_out += r?.usage?.output_tokens ?? 0;
      result = JSON.parse(r.content);
    } catch {
      continue;
    }

    if (result?.propose && result.rule_text) {
      await createCandidate(db, {
        content: result.rule_text,
        kind: 'behavior',
        signal_events: cluster.ids,
        confidence: Math.min(1, Math.max(0, result.confidence ?? 0.7)),
      });
      proposed++;
    }
  }
  return { clusters: clusters.length, proposed, tokens_in, tokens_out };
}
