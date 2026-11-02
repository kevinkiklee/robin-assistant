import { z } from 'zod';
import { clockDate, clockIso } from '../../lib/clock.ts';
import type { LLMDispatcher } from '../llm/dispatcher.ts';
import { canonicalizeTopic, normalizeTopic } from '../memory/belief.ts';
import type { RobinDb } from '../memory/db.ts';
import { ingest } from '../memory/ingest.ts';

/**
 * Topic-key hygiene: collapse belief topics that are different keys for the SAME
 * fact (`bakery-shift-schedule` vs `bakery-weekly-shift-plan` — several keys
 * for one fact are common in a large store). Spec §C1 canonicalization
 * stops modifier-token variants at write time, but legacy pre-C1 heads and
 * distinct-token phrasings of one fact still enumerate as separate topics.
 *
 * Two-stage, per the correction-linker lesson (text auto-matching: 87% of
 * matches were wrong): cheap lexical token overlap only NOMINATES pairs; an LLM
 * judge with both full claims decides. Merges are conservative and reversible —
 * the duplicate's head gets a retracted pointer-claim superseding it (dropping
 * it from enumeration, keeping its history), written via `ingest()` with the
 * EXACT stored slug. Never through `believe()`: its §C1 canonicalization can
 * rewrite the dupe's slug into the survivor's, which would retract the survivor.
 *
 * Pairs judged distinct are recorded as `topic.hygiene` events and never
 * re-judged; merged keys leave the head set — so the nightly pass converges on
 * the backlog instead of re-scanning it.
 */

const BELIEF_KIND = 'belief.update';
const HYGIENE_KIND = 'topic.hygiene';
const HYGIENE_SOURCE = 'topic-hygiene';

/** Pairs sent to the judge per run — bounds LLM spend to one small call. */
const DEFAULT_MAX_PAIRS = 24;
/** Merges applied per run — a bad judge day can only dent, not crater, the store. */
const DEFAULT_MAX_MERGES = 12;
/** Token-set Jaccard floor for nominating a pair. */
const DEFAULT_MIN_JACCARD = 0.5;
/** Heads whose claim embedding is probed for near neighbours per run. The probe
 *  window rotates daily over the whole head set, so the backlog is swept over
 *  ~N/probes nights while each run stays ~probes × 35 ms of KNN. */
const DEFAULT_EMBED_PROBES = 300;
/** Max events_vec distance (int8, L2) for an embedding nomination. Measured:
 *  paraphrases of one fact sit at or under this; related but distinct facts
 *  start just above it. Generous on purpose — the judge decides. */
const DEFAULT_MAX_EMBED_DISTANCE = 165;
/** KNN fan-out per probe. events_vec also holds sessions, mail, notes and the
 *  heads' own history rows, so k must be wide enough to reach other live heads. */
const EMBED_K = 60;
/** Tokens this common across topics pair everything with everything — skip them
 *  during index fan-out (they still count toward Jaccard). */
const TOKEN_FANOUT_CAP = 150;

/** Connectives canonicalizeTopic keeps but which carry no fact identity. */
const EXTRA_STOPWORDS = new Set([
  'the',
  'a',
  'an',
  'of',
  'and',
  'for',
  'with',
  'on',
  'in',
  'to',
  'vs',
  'my',
]);

export interface TopicHygieneReport {
  topics: number;
  pairsConsidered: number;
  pairsJudged: number;
  merged: number;
  markedDistinct: number;
}

export interface TopicHygieneOpts {
  maxPairs?: number;
  maxMerges?: number;
  minJaccard?: number;
  /** Heads probed by embedding this run (0 disables embedding nomination). */
  embedProbes?: number;
  maxEmbedDistance?: number;
  /** Start of the probe window; default rotates with the date. */
  probeOffset?: number;
  now?: Date;
}

interface TopicHead {
  topic: string;
  headId: number;
  updates: number;
  claim: string;
  ts: string;
  /** events_content id — also the claim's events_vec rowid (null = not embedded). */
  contentRef?: number | null;
}

/** Fact-identity tokens of a topic key: §C1 canonical form minus connectives. */
export function topicTokens(topic: string): string[] {
  return canonicalizeTopic(normalizeTopic(topic))
    .split('-')
    .filter((t) => t.length > 1 && !EXTRA_STOPWORDS.has(t));
}

/** Order-independent identity for a pair of topic keys. */
function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

export function loadHeads(db: RobinDb): TopicHead[] {
  const rows = db
    .prepare(
      `WITH latest AS (
         SELECT json_extract(payload,'$.topic') AS topic, MAX(id) AS head_id, COUNT(*) AS updates
           FROM events
          WHERE kind = '${BELIEF_KIND}' AND json_extract(payload,'$.topic') IS NOT NULL
          GROUP BY topic
       )
       SELECT l.topic AS topic, l.head_id AS headId, l.updates AS updates, e.ts AS ts,
              COALESCE(c.body, '') AS claim, e.content_ref AS contentRef,
              json_extract(e.payload,'$.retracted') AS retracted
         FROM latest l
         JOIN events e ON e.id = l.head_id
         LEFT JOIN events_content c ON c.id = e.content_ref`,
    )
    .all() as Array<TopicHead & { retracted: unknown }>;
  // Retracted heads are already out of enumeration; nothing to merge there.
  return rows.filter((r) => !(r.retracted === 1 || r.retracted === true || r.retracted === 'true'));
}

/** Pair keys previously judged distinct — never re-judge them. */
export function loadDistinctPairs(db: RobinDb): Set<string> {
  const rows = db
    .prepare(
      `SELECT json_extract(payload,'$.a') AS a, json_extract(payload,'$.b') AS b
         FROM events
        WHERE kind = '${HYGIENE_KIND}' AND json_extract(payload,'$.verdict') = 'distinct'`,
    )
    .all() as Array<{ a: string | null; b: string | null }>;
  const set = new Set<string>();
  for (const r of rows) if (r.a && r.b) set.add(pairKey(r.a, r.b));
  return set;
}

interface NominatedPair {
  a: number;
  b: number;
  jaccard: number;
  /** Set for embedding nominations: events_vec distance between the two claims. */
  distance?: number;
}

/** Nominate same-fact suspects by token-set overlap: Jaccard ≥ floor, or one key's
 *  tokens (≥2 of them) fully contained in the other's. Lexical only — judgment is
 *  the LLM's job. Exported for tests. */
export function nominatePairs(
  heads: TopicHead[],
  minJaccard: number,
  skip: Set<string>,
): NominatedPair[] {
  const tokens = heads.map((h) => new Set(topicTokens(h.topic)));
  const byToken = new Map<string, number[]>();
  for (let i = 0; i < heads.length; i++) {
    for (const t of tokens[i]) {
      const list = byToken.get(t);
      if (list) list.push(i);
      else byToken.set(t, [i]);
    }
  }
  const seen = new Set<string>();
  const out: NominatedPair[] = [];
  for (const list of byToken.values()) {
    if (list.length < 2 || list.length > TOKEN_FANOUT_CAP) continue;
    for (let x = 0; x < list.length; x++) {
      for (let y = x + 1; y < list.length; y++) {
        const i = list[x];
        const j = list[y];
        const key = pairKey(heads[i].topic, heads[j].topic);
        if (seen.has(key) || skip.has(key)) continue;
        seen.add(key);
        const A = tokens[i];
        const B = tokens[j];
        if (A.size === 0 || B.size === 0) continue;
        let inter = 0;
        for (const t of A) if (B.has(t)) inter++;
        const union = A.size + B.size - inter;
        const jaccard = union === 0 ? 0 : inter / union;
        const small = Math.min(A.size, B.size);
        const subset = small >= 2 && inter === small;
        if (jaccard >= minJaccard || subset) out.push({ a: i, b: j, jaccard });
      }
    }
  }
  return out.sort((p, q) => q.jaccard - p.jaccard);
}

/**
 * Nominate same-fact suspects by claim-embedding proximity. The lexical pass only
 * ever pairs keys that share words, so `stapler-brand` / `office-stapler` /
 * `desk-tools` — one fact under several keys — never met, while the pairs it did
 * nominate were mostly judged distinct. Probes `probes` heads starting at
 * `offset` (wrapping), KNN over events_vec, keeps neighbours that are other LIVE
 * heads within `maxDistance`. Missing vec table / extension → []. Exported for tests.
 */
export function nominateByEmbedding(
  db: RobinDb,
  heads: TopicHead[],
  skip: Set<string>,
  opts: { probes: number; offset: number; maxDistance: number },
): NominatedPair[] {
  if (opts.probes <= 0 || heads.length < 2) return [];
  const byRef = new Map<number, number>();
  for (let i = 0; i < heads.length; i++) {
    const ref = heads[i].contentRef;
    if (typeof ref === 'number') byRef.set(ref, i);
  }
  let knn: ReturnType<RobinDb['prepare']>;
  try {
    knn = db.prepare(
      `SELECT rowid, distance FROM events_vec
        WHERE embedding MATCH (SELECT embedding FROM events_vec WHERE rowid = ?) AND k = ${EMBED_K}`,
    );
  } catch {
    return [];
  }
  const order = [...heads.keys()].sort((x, y) => heads[x].headId - heads[y].headId);
  const n = Math.min(opts.probes, order.length);
  const start = ((opts.offset % order.length) + order.length) % order.length;
  const seen = new Set<string>();
  const out: NominatedPair[] = [];
  for (let step = 0; step < n; step++) {
    const i = order[(start + step) % order.length];
    const ref = heads[i].contentRef;
    if (typeof ref !== 'number') continue;
    let rows: Array<{ rowid: number; distance: number }>;
    try {
      rows = knn.all(ref) as Array<{ rowid: number; distance: number }>;
    } catch {
      continue; // claim not embedded yet
    }
    for (const r of rows) {
      if (r.distance > opts.maxDistance) break; // KNN rows come nearest-first
      const j = byRef.get(r.rowid);
      if (j === undefined || j === i || heads[j].topic === heads[i].topic) continue;
      const key = pairKey(heads[i].topic, heads[j].topic);
      if (seen.has(key) || skip.has(key)) continue;
      seen.add(key);
      out.push({ a: i, b: j, jaccard: 0, distance: r.distance });
    }
  }
  return out.sort((p, q) => (p.distance ?? 0) - (q.distance ?? 0));
}

const VerdictSchema = z.object({
  verdicts: z.array(
    z.object({
      pair: z.number(),
      same_fact: z.boolean(),
      keep: z.enum(['a', 'b']),
    }),
  ),
});

type Verdicts = z.infer<typeof VerdictSchema>['verdicts'];

function parseVerdicts(structured: unknown, text: string): Verdicts {
  const direct = VerdictSchema.safeParse(structured);
  if (direct.success) return direct.data.verdicts;
  // Fallback: first JSON object in the text.
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return [];
  try {
    const parsed = VerdictSchema.safeParse(JSON.parse(m[0]));
    return parsed.success ? parsed.data.verdicts : [];
  } catch {
    return [];
  }
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);

/**
 * Run one bounded hygiene pass. Called nightly from dream (step 6e); safe to run
 * ad hoc. `llm` may be null (e.g. degraded dream) — the pass then no-ops.
 */
export async function runTopicHygiene(
  db: RobinDb,
  llm: LLMDispatcher | null,
  opts: TopicHygieneOpts = {},
): Promise<TopicHygieneReport> {
  const maxPairs = opts.maxPairs ?? DEFAULT_MAX_PAIRS;
  const maxMerges = opts.maxMerges ?? DEFAULT_MAX_MERGES;
  const minJaccard = opts.minJaccard ?? DEFAULT_MIN_JACCARD;
  const date = (opts.now ?? clockDate()).toISOString().slice(0, 10);

  const heads = loadHeads(db);
  const report: TopicHygieneReport = {
    topics: heads.length,
    pairsConsidered: 0,
    pairsJudged: 0,
    merged: 0,
    markedDistinct: 0,
  };
  if (!llm || heads.length < 2) return report;

  const distinct = loadDistinctPairs(db);
  const dayIndex = Math.floor((opts.now ?? clockDate()).getTime() / 86_400_000);
  const probes = opts.embedProbes ?? DEFAULT_EMBED_PROBES;
  // Embedding suspects first — they are the duplicates the lexical pass can't
  // see — then lexical ones; a pair nominated by both is judged once.
  const byEmbedding = nominateByEmbedding(db, heads, distinct, {
    probes,
    offset: opts.probeOffset ?? dayIndex * probes,
    maxDistance: opts.maxEmbedDistance ?? DEFAULT_MAX_EMBED_DISTANCE,
  });
  const nominated: NominatedPair[] = [];
  const queued = new Set<string>();
  for (const p of [...byEmbedding, ...nominatePairs(heads, minJaccard, distinct)]) {
    const key = pairKey(heads[p.a].topic, heads[p.b].topic);
    if (queued.has(key)) continue;
    queued.add(key);
    nominated.push(p);
  }
  report.pairsConsidered = nominated.length;
  const batch = nominated.slice(0, maxPairs);
  if (batch.length === 0) return report;

  const pairLines = batch
    .map((p, n) => {
      const A = heads[p.a];
      const B = heads[p.b];
      return [
        `PAIR ${n}`,
        `  a: '${A.topic}' (${A.updates} update${A.updates === 1 ? '' : 's'}, last ${A.ts.slice(0, 10)}): ${clip(A.claim, 280) || '(no claim text)'}`,
        `  b: '${B.topic}' (${B.updates} update${B.updates === 1 ? '' : 's'}, last ${B.ts.slice(0, 10)}): ${clip(B.claim, 280) || '(no claim text)'}`,
      ].join('\n');
    })
    .join('\n');

  let verdicts: Verdicts;
  try {
    const res = await llm.invoke('reasoning', {
      systemPrompt: [
        'You audit a personal memory store for duplicate belief-topic keys.',
        'Two topics are the SAME fact only when one supersession chain should own both claims — the same real-world thing tracked under two names.',
        'They are DISTINCT when they cover different aspects, instances, sub-details, or time periods of a subject (e.g. a cost topic vs a schedule topic for one trip; -amount/-routing variants; a person vs a collaboration with that person).',
        'Two keys whose claims CONFLICT about one fact (e.g. two different job titles for the same current job) are the SAME fact — one chain must own it; keep the key whose claim is most current/correct.',
        'When unsure, answer distinct — false merges are worse than duplicates.',
        "For same_fact pairs, 'keep' names the topic that should survive: the one with the longer/more current history, or failing that the clearer key.",
        'Return JSON only: {"verdicts":[{"pair":<n>,"same_fact":<bool>,"keep":"a"|"b"}, …]} covering every pair.',
      ].join(' '),
      messages: [{ role: 'user', content: pairLines }],
      outputSchema: VerdictSchema,
      temperature: 0,
      maxTokens: 2048,
    });
    verdicts = parseVerdicts(res.structured, res.text);
  } catch {
    return report; // LLM unavailable — nominate again tomorrow, judge nothing today
  }
  report.pairsJudged = verdicts.length;

  const retiredThisRun = new Set<string>();
  for (const v of verdicts) {
    const pair = batch[v.pair];
    if (!pair) continue;
    const A = heads[pair.a];
    const B = heads[pair.b];
    if (!v.same_fact) {
      // Durable distinct verdict; external_id makes re-runs idempotent.
      ingest(db, null, {
        kind: HYGIENE_KIND,
        source: HYGIENE_SOURCE,
        payload: {
          a: A.topic,
          b: B.topic,
          verdict: 'distinct',
          external_id: `topic-hygiene:${pairKey(A.topic, B.topic)}`,
        },
      });
      report.markedDistinct++;
      continue;
    }
    if (report.merged >= maxMerges) continue;
    const survivor = v.keep === 'a' ? A : B;
    const dupe = v.keep === 'a' ? B : A;
    if (survivor.topic === dupe.topic) continue;
    // No same-run chains (A→B while B→C leaves A pointing at a retired key, seen
    // on the 2026-08-31 initial run). Skip any pair touching a key retired this
    // run; it re-nominates next night against the final survivor. Two dupes
    // folding into one LIVE survivor is fine and stays allowed.
    if (retiredThisRun.has(survivor.topic) || retiredThisRun.has(dupe.topic)) continue;
    // Retracted pointer-head on the dupe, under its EXACT stored slug (see module
    // doc for why believe() must not write this). Supersedes the dupe's head so
    // history stays one chain; external_id keyed like believe's supersede writes.
    retiredThisRun.add(dupe.topic);
    ingest(db, null, {
      kind: BELIEF_KIND,
      source: 'belief',
      content: `Merged into topic '${survivor.topic}' (topic-hygiene ${date}): both keys held the same fact. Current truth lives under '${survivor.topic}'.`, // Robin's own merge note, in memory by design. privacy-scan:allow
      payload: {
        topic: dupe.topic,
        supersedes: dupe.headId,
        confidence: null,
        sources: [],
        retracted: true,
        provenance: 'unknown',
        verified_at: clockIso(),
        merged_into: survivor.topic,
        external_id: `belief:${date}:${dupe.topic}:s${dupe.headId}`,
      },
    });
    report.merged++;
  }
  return report;
}
