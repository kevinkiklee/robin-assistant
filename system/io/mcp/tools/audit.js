// src/mcp/tools/audit.js — LLM-driven contradiction-pair scan over recent knowledge.
//
// Redesigned for the new schema:
//   - Knowledge rows now live in the unified `memos` table with `kind='knowledge'`.
//   - Embeddings live in the per-profile `embeddings_<profile>_memos` table;
//     we JOIN them back to the candidate rows by record id.
//   - Cosine still computed in JS because SurrealDB v3 cannot mix HNSW kNN
//     with `vector::similarity::cosine()` in the same SELECT (same constraint
//     the lint-checks job hits — pair count is bounded so O(N²) is fine).

import { surql } from 'surrealdb';
import { buildAuditPrompt } from '../../../cognition/jobs/audit-prompt.js';
import { embeddingTable, readProfile } from '../../../data/embed/profile-router.js';

const DEFAULT_PAIR_COUNT = 8;
const MAX_PAIR_COUNT = 32;
const COSINE_THRESHOLD = 0.7;
const RECENCY_MS = 30 * 86_400_000;

function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

async function selectPairs(db, pairCount) {
  const cutoff = new Date(Date.now() - RECENCY_MS);
  const [memoRows] = await db
    .query(
      surql`SELECT id, content FROM memos
            WHERE kind = 'knowledge' AND updated_at > ${cutoff}`,
    )
    .collect();
  const memos = memoRows ?? [];
  if (memos.length < 2) return [];

  // Hydrate embedding vectors from the active read profile's memos surface.
  const profile = await readProfile(db);
  const memoEmbTbl = embeddingTable(profile, 'memos');
  const ids = memos.map((m) => m.id);
  const [embRows] = await db
    .query(`SELECT record, vector FROM ${memoEmbTbl} WHERE record IN $ids`, { ids })
    .collect();
  const vecById = new Map((embRows ?? []).map((r) => [String(r.record), r.vector]));
  const candidates = memos
    .map((m) => ({ id: m.id, content: m.content, embedding: vecById.get(String(m.id)) }))
    .filter((c) => Array.isArray(c.embedding) || ArrayBuffer.isView(c.embedding));
  if (candidates.length < 2) return [];

  const seenPairs = new Set();
  const pairs = [];
  for (const c of candidates) {
    let bestNb = null;
    let bestSim = 0;
    for (const other of candidates) {
      if (String(other.id) === String(c.id)) continue;
      const sim = cosine(c.embedding, other.embedding);
      if (sim > bestSim) {
        bestSim = sim;
        bestNb = other;
      }
    }
    if (!bestNb || bestSim < COSINE_THRESHOLD) continue;
    const aId = String(c.id);
    const bId = String(bestNb.id);
    const [low, high] = [aId, bId].sort();
    const key = `${low}::${high}`;
    if (seenPairs.has(key)) continue;
    seenPairs.add(key);
    pairs.push({
      a_id: low,
      b_id: high,
      a_content: aId === low ? c.content : bestNb.content,
      b_content: bId === high ? bestNb.content : c.content,
      sim: bestSim,
    });
  }
  pairs.sort((a, b) => b.sim - a.sim);
  return pairs.slice(0, pairCount);
}

function parseLLMVerdict(text) {
  try {
    const v = JSON.parse(text);
    if (typeof v?.contradict === 'boolean' && typeof v?.summary === 'string') return v;
  } catch {
    /* fallthrough */
  }
  return { contradict: false, summary: '<llm output unparseable>' };
}

export function createAuditTool({ db, host }) {
  return {
    name: 'audit',
    description:
      'LLM-driven contradiction-pair scan over recent knowledge. ~8 LLM calls/invocation (balanced tier). User-triggered.',
    inputSchema: {
      type: 'object',
      properties: { pair_count: { type: 'integer', minimum: 1, maximum: MAX_PAIR_COUNT } },
    },
    handler: async (input = {}) => {
      const pairCount = Math.min(
        MAX_PAIR_COUNT,
        Math.max(1, input.pair_count ?? DEFAULT_PAIR_COUNT),
      );
      const pairs = await selectPairs(db, pairCount);
      const contradictions = [];
      for (const p of pairs) {
        if (!host?.invokeLLM) return { ok: false, reason: 'no_host' };
        const out = await host.invokeLLM(
          [{ role: 'user', content: buildAuditPrompt(p.a_content, p.b_content) }],
          { tier: 'balanced' },
        );
        const v = parseLLMVerdict(out?.content ?? '');
        if (v.contradict) {
          contradictions.push({ a_id: p.a_id, b_id: p.b_id, summary: v.summary });
        }
      }
      return { ok: true, pairs_checked: pairs.length, contradictions };
    },
  };
}
