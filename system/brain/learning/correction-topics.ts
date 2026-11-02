import type { LLMDispatcher } from '../llm/dispatcher.ts';
import type { RobinDb } from '../memory/db.ts';
import { buildFtsQuery } from '../memory/fts-query.ts';

/**
 * Assign belief topics to topic-less corrections, so apply-corrections can act on them.
 *
 * apply-corrections only replays corrections that name an explicit `topic` — 180+ of
 * 316 had none, so their corrected value never reached the belief layer. Many of those
 * name the belief they refute in prose ("Belief 'garden-plan' (event 12345)
 * states…"); others are cross-topic reconciliations or behavioral rules that genuinely
 * have no single topic.
 *
 * Safety model — a wrong topic is worse than none, because apply-corrections RETRACTS
 * that topic's live head and asserts the correction text in its place:
 *   1. Candidates are only LIVE (non-retracted) belief topics: ones named in the
 *      correction's own text, plus the top lexical (FTS) matches among live heads.
 *   2. The LLM sees each candidate's current claim and must pick one only when the
 *      correction is a complete replacement for that claim — otherwise null.
 *   3. Any answer outside that correction's candidate set is discarded.
 *   4. Dry-run by default; `--apply` writes `topic` only where it is still NULL and
 *      the correction is still un-applied.
 */

export interface TopicCandidate {
  topic: string;
  claim: string;
}

export interface TopicProposal {
  correctionId: number;
  correction: string;
  topic: string | null;
  candidates: TopicCandidate[];
}

/** Candidates shown per correction (explicit mentions first, then lexical matches). */
const MAX_CANDIDATES = 5;
/** Corrections judged per classify call. */
const DEFAULT_BATCH = 8;
const CLAIM_CHARS = 280;
const CORRECTION_CHARS = 700;

interface Head {
  topic: string;
  eventId: number;
  claim: string;
}

/** Live (non-retracted) belief heads, keyed by topic. One window-function pass. */
function liveHeads(db: RobinDb): Map<string, Head> {
  const rows = db
    .prepare(
      `SELECT topic, eventId, claim FROM (
         SELECT json_extract(e.payload,'$.topic') AS topic, e.id AS eventId, c.body AS claim,
                json_extract(e.payload,'$.retracted') AS retracted,
                ROW_NUMBER() OVER (PARTITION BY json_extract(e.payload,'$.topic')
                                   ORDER BY e.ts DESC, e.id DESC) AS rn
           FROM events e JOIN events_content c ON c.id = e.content_ref
          WHERE e.kind = 'belief.update'
       ) WHERE rn = 1 AND (retracted IS NULL OR retracted != 1) AND topic IS NOT NULL`,
    )
    .all() as Array<{ topic: string; eventId: number; claim: string }>;
  return new Map(rows.map((r) => [r.topic, r]));
}

/** Topic-like slugs a correction mentions in quotes/backticks or after "topic". */
export function mentionedTopics(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/[`'"‘’“”]([a-z0-9][a-z0-9-]{2,80})[`'"‘’“”]/g)) out.add(m[1]);
  for (const m of text.matchAll(/\btopic[s]?\s+[`'"]?([a-z0-9][a-z0-9-]{2,80})/gi)) {
    out.add(m[1].toLowerCase());
  }
  return [...out];
}

function candidatesFor(
  db: RobinDb,
  heads: Map<string, Head>,
  row: { what: string; correction: string; context: string | null },
): TopicCandidate[] {
  const text = `${row.what}\n${row.correction}\n${row.context ?? ''}`;
  const picked: string[] = [];
  for (const t of mentionedTopics(text)) {
    if (heads.has(t) && !picked.includes(t)) picked.push(t);
  }
  const q = buildFtsQuery(`${row.what} ${row.correction}`, 'any');
  if (q && picked.length < MAX_CANDIDATES) {
    try {
      const rows = db
        .prepare(
          `SELECT e.id AS eventId, json_extract(e.payload,'$.topic') AS topic
             FROM events_content_fts
             JOIN events e ON e.content_ref = events_content_fts.rowid
            WHERE events_content_fts MATCH ? AND e.kind = 'belief.update'
            ORDER BY rank LIMIT 40`,
        )
        .all(q) as Array<{ eventId: number; topic: string | null }>;
      for (const r of rows) {
        if (picked.length >= MAX_CANDIDATES) break;
        if (!r.topic || picked.includes(r.topic)) continue;
        // Cross-topic conflict records (`conflict-*`) are long, word-rich notes that
        // match everything lexically; a correction never replaces one.
        if (r.topic.startsWith('conflict-')) continue;
        // Only the live head itself counts — a superseded row's topic may have moved on.
        if (heads.get(r.topic)?.eventId !== r.eventId) continue;
        picked.push(r.topic);
      }
    } catch {
      // FTS failure → explicit mentions only.
    }
  }
  return picked.slice(0, MAX_CANDIDATES).map((t) => ({
    topic: t,
    claim: (heads.get(t)?.claim ?? '').replace(/\s+/g, ' ').slice(0, CLAIM_CHARS),
  }));
}

const SYSTEM = `You link a personal assistant's recorded corrections to the belief topic each one corrects.
Each correction lists candidate topics with that topic's CURRENT claim. Applying a link RETRACTS the current claim and replaces it with the correction text, so pick a topic ONLY when:
- the correction is about the same single subject as that claim, AND
- the correction text, on its own, is a complete and correct replacement for that claim (nothing true in the claim would be lost).
Answer null when the correction spans several topics, reconciles multiple beliefs, is a general behavioral rule, or no candidate fits exactly. When unsure, answer null.
Respond with strict JSON only: {"assignments":[{"id":<correction id>,"topic":"<candidate topic>"|null}]}`;

function parseAssignments(text: string): Map<number, string | null> {
  const out = new Map<number, string | null>();
  try {
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return out;
    const parsed = JSON.parse(m[0]) as { assignments?: unknown };
    if (!Array.isArray(parsed.assignments)) return out;
    for (const a of parsed.assignments as Array<{ id?: unknown; topic?: unknown }>) {
      if (typeof a?.id !== 'number') continue;
      out.set(a.id, typeof a.topic === 'string' && a.topic ? a.topic : null);
    }
  } catch {
    // malformed → no assignments for this batch
  }
  return out;
}

/**
 * Propose topics for un-applied, topic-less corrections (newest first). Never writes.
 * Corrections with no live candidate skip the LLM entirely (topic null).
 */
export async function proposeCorrectionTopics(
  db: RobinDb,
  llm: LLMDispatcher,
  opts: { limit?: number; batchSize?: number } = {},
): Promise<TopicProposal[]> {
  const rows = db
    .prepare(
      `SELECT id, what, correction, context FROM corrections
        WHERE topic IS NULL AND applied = 0 ORDER BY id DESC LIMIT ?`,
    )
    .all(opts.limit ?? 1_000_000) as Array<{
    id: number;
    what: string;
    correction: string;
    context: string | null;
  }>;
  if (rows.length === 0) return [];
  const heads = liveHeads(db);
  const proposals: TopicProposal[] = rows.map((r) => ({
    correctionId: r.id,
    correction: r.correction,
    topic: null,
    candidates: candidatesFor(db, heads, r),
  }));
  const judgeable = proposals.filter((p) => p.candidates.length > 0);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const batchSize = opts.batchSize ?? DEFAULT_BATCH;

  for (let i = 0; i < judgeable.length; i += batchSize) {
    const batch = judgeable.slice(i, i + batchSize);
    const body = batch
      .map((p) => {
        const r = byId.get(p.correctionId);
        const cands = p.candidates.map((c) => `   - ${c.topic}: ${c.claim}`).join('\n');
        return `Correction #${p.correctionId}
  What was wrong: ${(r?.what ?? '').slice(0, CORRECTION_CHARS)}
  Correction: ${p.correction.slice(0, CORRECTION_CHARS)}
  Candidates:
${cands}`;
      })
      .join('\n\n');
    let assignments = new Map<number, string | null>();
    try {
      const res = await llm.invoke('classify', {
        systemPrompt: SYSTEM,
        messages: [{ role: 'user', content: body }],
        temperature: 0,
        maxTokens: 60 * batch.length + 100,
      });
      assignments = parseAssignments(res.text);
    } catch {
      // A failed batch leaves its corrections at null — never guessed.
    }
    for (const p of batch) {
      const t = assignments.get(p.correctionId) ?? null;
      p.topic = t && p.candidates.some((c) => c.topic === t) ? t : null;
    }
  }
  return proposals;
}

/**
 * Write proposed topics. Guarded so a concurrent edit is never clobbered: only rows
 * still topic-less and un-applied are touched. Returns rows updated.
 */
export function applyCorrectionTopics(db: RobinDb, proposals: TopicProposal[]): number {
  const upd = db.prepare(
    `UPDATE corrections SET topic = ? WHERE id = ? AND topic IS NULL AND applied = 0`,
  );
  let n = 0;
  db.transaction(() => {
    for (const p of proposals) {
      if (!p.topic) continue;
      n += upd.run(p.topic, p.correctionId).changes;
    }
  })();
  return n;
}
