import { clockNow } from '../../lib/clock.ts';
import type { LLMDispatcher } from '../llm/dispatcher.ts';
import type { RobinDb } from './db.ts';
import { MAX_EMBED_QUERY_CHARS, recall } from './recall.ts';

/**
 * Offline recall-replay harness (value-loops plan 2, T3): replay real captured
 * prompts through vec recall with a WIDE distance floor, judge each candidate
 * hit ONCE with the classify role, then sweep candidate thresholds as free math
 * over the judged pairs. Feeds the Wave C decision on AUTO_RECALL_MAX_DISTANCE
 * with evidence instead of the 2026-05-31 hand calibration.
 */

export interface ReplayPromptSample {
  eventId: number;
  ts: string;
  prompt: string;
}

/** Minimum prompt length worth replaying — shorter turns are acks/noise. */
const MIN_PROMPT_CHARS = 40;

/** Wide candidate floor for the replay recall pass; thresholds are swept below it. */
const REPLAY_CANDIDATE_MAX_DISTANCE = 0.95;
/** Candidate pool size per prompt for the replay recall pass. */
const REPLAY_CANDIDATE_LIMIT = 50;

/** Candidate thresholds swept by runReplay: 0.72, 0.74, … 0.94. */
export const REPLAY_THRESHOLDS: number[] = Array.from({ length: 12 }, (_, i) =>
  Number((0.72 + i * 0.02).toFixed(2)),
);

/** Same idiom as recall's queryHash — base64-truncated so repeat prompts collide intentionally. */
function promptHash(prompt: string): string {
  return Buffer.from(prompt).toString('base64').slice(0, 64);
}

/**
 * Split a `session.captured` body (capture.ts renders `[USER]\n…` / `[ASSISTANT]\n…`
 * blocks joined by blank lines) into its user-side turn texts. Returns null when the
 * body has no `[USER]` marker at all — i.e. turns are not separable (v2-imported
 * `conversation.claude-code` bodies are raw text).
 */
function extractUserTurns(body: string): string[] | null {
  if (!/^\[USER\]$/m.test(body)) return null;
  const turns: string[] = [];
  let current: string[] | null = null;
  for (const line of body.split('\n')) {
    if (/^\[(?:USER|ASSISTANT|TOOL)\]$/.test(line)) {
      if (current) turns.push(current.join('\n').trim());
      current = line === '[USER]' ? [] : null;
      continue;
    }
    if (current) current.push(line);
  }
  if (current) turns.push(current.join('\n').trim());
  return turns.filter((t) => t.length > 0);
}

/**
 * Recent user-side prompt texts from captured Claude Code conversations
 * (`session.captured` from capture.ts, plus v2-imported `conversation.claude-code`).
 * User turns are extracted from the rendered `[USER]` blocks; when turns are not
 * separable the leading 2000 chars of the body stand in — recall truncates its embed
 * input identically. Newest first, ≥40 chars, deduped by query hash.
 */
export function samplePrompts(
  db: RobinDb,
  opts: { limit?: number; sinceDays?: number } = {},
): ReplayPromptSample[] {
  const limit = opts.limit ?? 25;
  const sinceDays = opts.sinceDays ?? 30;
  const cutoff = new Date(clockNow() - sinceDays * 86_400_000).toISOString();
  const rows = db
    .prepare(
      `SELECT events.id AS eventId, events.ts AS ts, events_content.body AS body
         FROM events
         JOIN events_content ON events_content.id = events.content_ref
        WHERE events.kind IN ('session.captured', 'conversation.claude-code')
          AND events.ts >= ?
        ORDER BY events.ts DESC, events.id DESC`,
    )
    .all(cutoff) as Array<{ eventId: number; ts: string; body: string }>;

  const samples: ReplayPromptSample[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const candidates = extractUserTurns(row.body) ?? [row.body.slice(0, MAX_EMBED_QUERY_CHARS)];
    for (const candidate of candidates) {
      const prompt = candidate.slice(0, MAX_EMBED_QUERY_CHARS).trim();
      if (prompt.length < MIN_PROMPT_CHARS) continue;
      const hash = promptHash(prompt);
      if (seen.has(hash)) continue;
      seen.add(hash);
      samples.push({ eventId: row.eventId, ts: row.ts, prompt });
      if (samples.length >= limit) return samples;
    }
  }
  return samples;
}

export interface JudgedHit {
  contentId: number;
  distance: number;
  kind?: string;
  relevant: boolean;
}

const JUDGE_SYSTEM = `You judge memory retrieval quality for a personal assistant. Given a user's prompt and numbered memory excerpts that were retrieved for it, decide which excerpts are actually relevant — i.e. would materially help answer or contextualize THIS prompt. Topical adjacency alone is not relevance. Respond with strict JSON only: {"relevant":[<numbers>]} — an empty array when none apply. No prose.`;

/** Chars of each hit body shown to the judge. */
const JUDGE_EXCERPT_CHARS = 500;

/** Defensive parse of the judge's output → set of relevant excerpt numbers. Malformed → empty. */
function parseRelevantNumbers(text: string): Set<number> {
  try {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return new Set();
    const parsed = JSON.parse(match[0]) as { relevant?: unknown };
    if (!Array.isArray(parsed.relevant)) return new Set();
    return new Set(
      parsed.relevant.filter((n): n is number => typeof n === 'number' && Number.isInteger(n)),
    );
  } catch {
    return new Set();
  }
}

/**
 * ONE classify call per prompt: numbered hit excerpts in, per-number booleans out
 * (strict JSON `{"relevant":[1,3]}`). Never throws — a malformed judgement or a
 * dispatcher failure degrades to all-false for that prompt.
 */
export async function judgeHits(
  llm: LLMDispatcher,
  prompt: string,
  hits: Array<{ contentId: number; distance: number; kind?: string; body: string }>,
  opts: { onError?: (err: unknown) => void } = {},
): Promise<JudgedHit[]> {
  if (hits.length === 0) return [];
  const numbered = hits
    .map(
      (h, i) => `${i + 1}. ${h.kind ? `[${h.kind}] ` : ''}${h.body.slice(0, JUDGE_EXCERPT_CHARS)}`,
    )
    .join('\n\n');
  let relevant = new Set<number>();
  try {
    const res = await llm.invoke('classify', {
      systemPrompt: JUDGE_SYSTEM,
      messages: [
        {
          role: 'user',
          content: `User prompt:\n${prompt}\n\nRetrieved excerpts:\n${numbered}\n\nReturn strict JSON: {"relevant":[<numbers of relevant excerpts>]}`,
        },
      ],
      temperature: 0,
      maxTokens: 400,
    });
    relevant = parseRelevantNumbers(res.text);
  } catch (err) {
    // Degrade to all-false for THIS prompt, but surface the failure to the caller —
    // a wholesale-failing judge (e.g. an unassigned dispatcher role, 2026-08-10)
    // otherwise produces a plausible-looking all-zero sweep with no LLM call ever made.
    if (opts.onError) {
      try {
        opts.onError(err);
      } catch {
        // observer bugs never affect judging
      }
    }
    relevant = new Set();
  }
  return hits.map((h, i) => ({
    contentId: h.contentId,
    distance: h.distance,
    kind: h.kind,
    relevant: relevant.has(i + 1),
  }));
}

export interface ThresholdRow {
  maxDistance: number;
  kept: number;
  keptRelevant: number;
  precision: number;
  recallOfRelevant: number;
}

/**
 * PURE: sweep candidate distance floors over already-judged (prompt, hit) pairs.
 * The relevant-set denominator is ALL judged-relevant pairs (what the wide candidate
 * pass surfaced), so recallOfRelevant reads "of the relevant material available,
 * how much survives this floor". Zero-keep / zero-relevant denominators yield 0.
 */
export function sweepThresholds(
  judged: Array<{ prompt: string; hits: JudgedHit[] }>,
  thresholds: number[],
): ThresholdRow[] {
  const all = judged.flatMap((j) => j.hits);
  const totalRelevant = all.filter((h) => h.relevant).length;
  return thresholds.map((maxDistance) => {
    const kept = all.filter((h) => h.distance <= maxDistance);
    const keptRelevant = kept.filter((h) => h.relevant).length;
    return {
      maxDistance,
      kept: kept.length,
      keptRelevant,
      precision: kept.length > 0 ? keptRelevant / kept.length : 0,
      recallOfRelevant: totalRelevant > 0 ? keptRelevant / totalRelevant : 0,
    };
  });
}

export interface ReplayReport {
  samples: number;
  judgedPairs: number;
  /** Prompts whose judge call threw (degraded to all-false). samples-many = the sweep is garbage. */
  judgeFailures: number;
  sweep: ThresholdRow[];
}

/**
 * Full replay: sample prompts → wide vec recall per prompt (distance recovered as
 * `1 - score`, since vec hits score `1 - distance`) → judge each prompt's candidate
 * set ONCE → sweep REPLAY_THRESHOLDS as free math. Note: recall() logs each replay
 * query to recall_log tagged source='manual' — accepted noise, documented in the plan.
 */
export async function runReplay(
  db: RobinDb,
  llm: LLMDispatcher,
  opts: { promptLimit?: number } = {},
): Promise<ReplayReport> {
  const samples = samplePrompts(db, { limit: opts.promptLimit ?? 25 });
  const judged: Array<{ prompt: string; hits: JudgedHit[] }> = [];
  let judgeFailures = 0;
  for (const sample of samples) {
    const hits = await recall(db, llm, sample.prompt, {
      mode: 'vec',
      limit: REPLAY_CANDIDATE_LIMIT,
      maxDistance: REPLAY_CANDIDATE_MAX_DISTANCE,
      source: 'manual',
    });
    const candidates = hits.map((h) => ({
      contentId: h.contentId,
      distance: 1 - h.score,
      kind: h.kind,
      body: h.body,
    }));
    const judgedHits = await judgeHits(llm, sample.prompt, candidates, {
      onError: () => {
        judgeFailures += 1;
      },
    });
    judged.push({ prompt: sample.prompt, hits: judgedHits });
  }
  return {
    samples: samples.length,
    judgedPairs: judged.reduce((n, j) => n + j.hits.length, 0),
    judgeFailures,
    sweep: sweepThresholds(judged, REPLAY_THRESHOLDS),
  };
}
