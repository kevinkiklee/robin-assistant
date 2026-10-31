import { createHash } from 'node:crypto';
import { clockDate } from '../../lib/clock.ts';
import type { LLMDispatcher } from '../llm/dispatcher.ts';
import type { RobinDb } from './db.ts';
import { embedBodies } from './embed-content.ts';

/**
 * Prompt-relevant corrections for auto-recall.
 *
 * The primer can only fit the ~5 newest of 300+ corrections under its sub-cap, and
 * 180 have no topic so apply-corrections never turns them into beliefs — so most
 * corrections (including "never pitch X again" rules) never reached a session.
 * This module embeds each correction into `correction_embeddings` (migration 040; a
 * derived cache, `corrections` stays the source of truth) and ranks them against the
 * turn-query embedding auto-recall already computed, so the 1–3 that matter for THIS
 * prompt are injected.
 */

/**
 * Cosine floor for injecting a correction. Calibrated 2026-10-03 on 60 real prompts ×
 * 316 corrections (Gemini 3072-d, the same `embed` role as recall): clearly-relevant
 * matches scored 0.70–0.82 (the best relevant pairs at
 * 0.774 and 0.817), while the best match for an unrelated prompt sat at 0.58–0.69
 * (0.583 and 0.670 at the extremes). 0.70 is the knee: it drops a few relevant 0.66–0.69
 * pairs to keep unrelated rules out. 0.70 cosine ≈ 0.775 L2 for unit vectors — stricter
 * than the 0.82 snippet floor, on purpose: a correction is injected as authoritative.
 */
export const CORRECTION_MIN_SIM = 0.7;
/** Keep a 2nd/3rd correction only when it is this close to the best one. */
export const CORRECTION_SIM_WINDOW = 0.05;
export const CORRECTION_INJECT_CAP = 3;
/** Per-run embed batch — one batched embed call per embedder tick. */
const EMBED_BATCH = 64;

export interface CorrectionRow {
  id: number;
  what: string;
  correction: string;
}

/** The text a correction is embedded as — what Robin got wrong plus the fix. */
export function correctionEmbedText(row: { what: string; correction: string }): string {
  return `${row.what.trim()}\nCorrection: ${row.correction.trim()}`;
}

function sha(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function vecToBlob(vec: number[] | Float32Array): Buffer {
  const f = vec instanceof Float32Array ? vec : Float32Array.from(vec);
  return Buffer.from(f.buffer, f.byteOffset, f.byteLength);
}

function blobToVec(buf: Buffer): Float32Array {
  // Copy: a Buffer slice can share an unaligned pool offset Float32Array rejects.
  const copy = new Uint8Array(buf.byteLength);
  copy.set(buf);
  return new Float32Array(copy.buffer);
}

function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * A correction that states a standing BEHAVIOR rule ("never re-pitch X", "always
 * label every jar", "the operator does not want meetings before 10am") rather than a one-off factual
 * fix ("the meeting is on the 9th"). Behavioral rules are the ones that change every
 * future session, so the primer prefers them when its sub-cap can't fit everything.
 */
export function isBehavioralCorrection(text: string): boolean {
  return /\b(never|always|don'?t|do not|does not want|doesn'?t want|not want|stop|avoid|must not|must|re-?pitch|declined?|no longer|prefer|instead of)\b/i.test(
    text,
  );
}

export interface EmbedCorrectionsResult {
  embedded: number;
  failed: number;
  /** Corrections still missing a current embedding after this run. */
  pending: number;
}

/**
 * Embed corrections whose cached embedding is missing or stale (text changed). Bounded
 * to one batch per call; the embedder job calls it every tick, so a backlog drains
 * over a few minutes. Best-effort: an embed failure leaves rows pending for next tick.
 */
export async function embedPendingCorrections(
  db: RobinDb,
  llm: LLMDispatcher,
  opts: { limit?: number; now?: Date } = {},
): Promise<EmbedCorrectionsResult> {
  const limit = opts.limit ?? EMBED_BATCH;
  const rows = db
    .prepare(
      `SELECT c.id, c.what, c.correction, ce.text_sha AS sha
         FROM corrections c
         LEFT JOIN correction_embeddings ce ON ce.correction_id = c.id
        ORDER BY c.id DESC`,
    )
    .all() as Array<CorrectionRow & { sha: string | null }>;
  const stale = rows
    .map((r) => ({ ...r, text: correctionEmbedText(r) }))
    .map((r) => ({ ...r, want: sha(r.text) }))
    .filter((r) => r.sha !== r.want);
  if (stale.length === 0) return { embedded: 0, failed: 0, pending: 0 };

  const batch = stale.slice(0, limit);
  let vecs: number[][];
  try {
    vecs = await embedBodies(
      llm,
      batch.map((r) => r.text),
    );
  } catch {
    return { embedded: 0, failed: batch.length, pending: stale.length };
  }
  const upsert = db.prepare(
    `INSERT INTO correction_embeddings (correction_id, text_sha, embedding, embedded_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(correction_id) DO UPDATE SET
       text_sha = excluded.text_sha, embedding = excluded.embedding, embedded_at = excluded.embedded_at`,
  );
  const at = (opts.now ?? clockDate()).toISOString();
  let embedded = 0;
  let failed = 0;
  db.transaction(() => {
    batch.forEach((r, i) => {
      const v = vecs[i];
      if (!v || v.length === 0) {
        failed++;
        return;
      }
      upsert.run(r.id, r.want, vecToBlob(v), at);
      embedded++;
    });
  })();
  return { embedded, failed, pending: stale.length - embedded };
}

interface CachedCorrection extends CorrectionRow {
  vec: Float32Array;
}

/**
 * In-process cache of the decoded embeddings (~300 × 12 KB). Re-read only when the
 * table's signature changes, so the per-prompt hot path is a cosine sweep, not a
 * 4 MB BLOB read.
 */
const caches = new WeakMap<RobinDb, { sig: string; items: CachedCorrection[] }>();

function loadEmbedded(db: RobinDb): CachedCorrection[] {
  const s = db
    .prepare(
      `SELECT COUNT(*) AS n, MAX(embedded_at) AS at, MAX(correction_id) AS maxId,
              (SELECT COUNT(*) FROM corrections) AS total
         FROM correction_embeddings`,
    )
    .get() as { n: number; at: string | null; maxId: number | null; total: number };
  const sig = `${s.n}|${s.at}|${s.maxId}|${s.total}`;
  const cached = caches.get(db);
  if (cached && cached.sig === sig) return cached.items;
  const rows = db
    .prepare(
      `SELECT c.id, c.what, c.correction, ce.embedding
         FROM correction_embeddings ce
         JOIN corrections c ON c.id = ce.correction_id`,
    )
    .all() as Array<CorrectionRow & { embedding: Buffer }>;
  const items = rows.map((r) => ({
    id: r.id,
    what: r.what,
    correction: r.correction,
    vec: blobToVec(r.embedding),
  }));
  caches.set(db, { sig, items });
  return items;
}

export interface RelevantCorrection {
  id: number;
  correction: string;
  similarity: number;
}

/**
 * The corrections most relevant to `queryEmbedding`: cosine ≥ `minSim`, at most `cap`,
 * and (after the first) within `window` of the best — so one strong match doesn't
 * drag two marginal ones in behind it. Best-effort: any error → [].
 */
export function selectRelevantCorrections(
  db: RobinDb,
  queryEmbedding: ArrayLike<number>,
  opts: { cap?: number; minSim?: number; window?: number } = {},
): RelevantCorrection[] {
  const cap = opts.cap ?? CORRECTION_INJECT_CAP;
  const minSim = opts.minSim ?? CORRECTION_MIN_SIM;
  const window = opts.window ?? CORRECTION_SIM_WINDOW;
  try {
    const scored = loadEmbedded(db)
      .map((c) => ({
        id: c.id,
        correction: c.correction,
        similarity: cosine(queryEmbedding, c.vec),
      }))
      .filter((c) => c.similarity >= minSim)
      .sort((a, b) => b.similarity - a.similarity);
    if (scored.length === 0) return [];
    const best = scored[0].similarity;
    const out: RelevantCorrection[] = [];
    const seenText = new Set<string>();
    for (const c of scored) {
      if (out.length >= cap) break;
      if (best - c.similarity > window) break;
      // Near-duplicate corrections (the same rule recorded twice) inject once.
      const key = c.correction.trim().toLowerCase().slice(0, 120);
      if (seenText.has(key)) continue;
      seenText.add(key);
      out.push(c);
    }
    return out;
  } catch {
    return [];
  }
}
