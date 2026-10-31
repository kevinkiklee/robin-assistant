import { clockDate } from '../../lib/clock.ts';
import type { LLMDispatcher } from '../llm/dispatcher.ts';
import type { RobinDb } from '../memory/db.ts';
import { keptCount, parseKept } from '../memory/recall-outcome.ts';

/**
 * Monthly recall audit (value-loops plan 2, T5): sample recent auto-recall rows
 * that recorded their true kept set (`recall_log.kept_json`, written by the
 * auto-recall composer), judge each row ONCE with the classify role — were the
 * injected excerpts relevant, and did they visibly influence the session's
 * assistant answer — and roll the verdicts up into two `metrics_daily` steering
 * numbers: `recall_precision` (Σrelevant/Σkept over judged rows) and
 * `recall_utilization` (influenced-share over rows that had a captured answer).
 */

export interface RecallAuditResult {
  sampled: number;
  judgedItems: number;
  precision: number | null;
  utilization: number | null;
  skipped: boolean;
  /** Share of auto-recall turns in the window that injected anything (null: no rows). */
  injectionRate: number | null;
  /** Auto-recall turns in the window the injection rate is computed over. */
  autoTurns: number;
}

export interface InjectionStats {
  total: number;
  injected: number;
  rate: number | null;
}

/**
 * The honest auto-recall hit rate: of the auto-recall turns in the window, how many
 * actually injected something. Derived from the kept set, NOT `outcome` — recall()
 * logs 'answered' for any non-empty candidate pool (99.6% of rows), while only ~59%
 * of turns injected anything. A row is injected when its kept_json lists ≥1 doc,
 * snippet, correction, habit or loop, or (rows written after the composer began
 * deriving outcomes) its outcome is 'injected'. Before that change the composer
 * skipped the kept_json write on turns that injected nothing, so a NULL kept_json on
 * an auto row means nothing reached the turn (kept_json exists since 2026-08-10,
 * older than the 35-day window).
 */
export function computeInjectionStats(db: RobinDb, sinceIso: string): InjectionStats {
  const rows = db
    .prepare(`SELECT kept_json, outcome FROM recall_log WHERE source = 'auto' AND ts >= ?`)
    .all(sinceIso) as Array<{ kept_json: string | null; outcome: string }>;
  let injected = 0;
  for (const r of rows) {
    const kept = parseKept(r.kept_json);
    if ((kept && keptCount(kept) > 0) || r.outcome === 'injected') injected++;
  }
  return {
    total: rows.length,
    injected,
    rate: rows.length > 0 ? injected / rows.length : null,
  };
}

/** Rows sampled per run — one classify call each, so this bounds the LLM spend. */
const DEFAULT_SAMPLE_SIZE = 30;
/** Sampling window (days). 35 covers a full month between runs with slack. */
const WINDOW_DAYS = 35;
/** Chars of each kept snippet body shown to the judge (recall-replay's excerpt idiom). */
const EXCERPT_CHARS = 500;
/** Chars of the assistant answer shown to the judge. */
const ANSWER_EXCERPT_CHARS = 1200;

const AUDIT_JUDGE_SYSTEM = `You audit a personal assistant's automatic memory injection. You are given the memory excerpts that were auto-injected for a user turn, the leading excerpt of that turn, and — when one was captured — the assistant's eventual answer. Decide (1) how many of the injected excerpts were actually relevant to the turn (topical adjacency alone is not relevance) and (2) whether the injected material visibly influenced the answer. When no answer is provided, judge relevance only and return "influenced": false. Respond with strict JSON only: {"relevantCount": <0..N>, "influenced": true|false}. No prose.`;

/**
 * recall_log stores only `query_hash` — but the hash is the base64 of the query
 * truncated to 64 chars (16 clean base64 quanta = the query's first 48 bytes), so
 * the leading prompt excerpt is recoverable for judge context. Best-effort: any
 * decode failure yields ''.
 */
function decodeQueryPrefix(queryHash: string): string {
  try {
    return Buffer.from(queryHash, 'base64').toString('utf8').replace(/�/g, '').trim();
  } catch {
    return '';
  }
}

/**
 * Last `[ASSISTANT]` block of a `session.captured` body (capture.ts renders
 * `[ROLE]\n…` marker blocks joined by blank lines) — the session's concluding
 * answer. Null when the body has no assistant block.
 */
function extractAssistantAnswer(body: string): string | null {
  const blocks: string[] = [];
  let current: string[] | null = null;
  for (const line of body.split('\n')) {
    if (/^\[(?:USER|ASSISTANT|TOOL)\]$/.test(line)) {
      if (current) blocks.push(current.join('\n').trim());
      current = line === '[ASSISTANT]' ? [] : null;
      continue;
    }
    if (current) current.push(line);
  }
  if (current) blocks.push(current.join('\n').trim());
  const nonEmpty = blocks.filter((b) => b.length > 0);
  return nonEmpty.length > 0 ? nonEmpty[nonEmpty.length - 1] : null;
}

/**
 * The session's assistant answer for a recall_log row: the nearest captured
 * session event with the same `payload.sessionId` at/after the row's ts (the
 * recall fires at prompt time; the session is captured at end). Null when the
 * session was never captured or has no assistant block.
 */
function findSessionAnswer(db: RobinDb, sessionId: string, ts: string): string | null {
  try {
    const row = db
      .prepare(
        `SELECT events_content.body AS body
           FROM events
           JOIN events_content ON events_content.id = events.content_ref
          WHERE events.kind IN ('session.captured', 'conversation.claude-code')
            AND json_extract(events.payload, '$.sessionId') = ?
            AND events.ts >= ?
          ORDER BY events.ts ASC, events.id ASC
          LIMIT 1`,
      )
      .get(sessionId, ts) as { body: string } | undefined;
    return row ? extractAssistantAnswer(row.body) : null;
  } catch {
    return null;
  }
}

interface AuditVerdict {
  relevantCount: number;
  influenced: boolean;
}

/** Defensive parse of the judge's output. Malformed → null (row is skipped, never thrown). */
function parseVerdict(text: string, keptCount: number): AuditVerdict | null {
  try {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]) as { relevantCount?: unknown; influenced?: unknown };
    if (!Number.isInteger(parsed.relevantCount) || (parsed.relevantCount as number) < 0)
      return null;
    if (typeof parsed.influenced !== 'boolean') return null;
    return {
      relevantCount: Math.min(parsed.relevantCount as number, keptCount),
      influenced: parsed.influenced,
    };
  } catch {
    return null;
  }
}

/** One classify call per row: kept excerpts + prompt prefix + (optional) answer in, verdict out. */
async function judgeRow(
  llm: LLMDispatcher,
  promptPrefix: string,
  excerpts: Array<{ id: number; body: string }>,
  answer: string | null,
): Promise<AuditVerdict | null> {
  const numbered = excerpts
    .map((e, i) => `${i + 1}. ${e.body.slice(0, EXCERPT_CHARS)}`)
    .join('\n\n');
  const answerBlock = answer
    ? `Assistant answer (excerpt):\n${answer.slice(0, ANSWER_EXCERPT_CHARS)}`
    : 'Assistant answer: (not captured — judge relevance only)';
  try {
    const res = await llm.invoke('classify', {
      systemPrompt: AUDIT_JUDGE_SYSTEM,
      messages: [
        {
          role: 'user',
          content: `User turn (leading excerpt):\n${promptPrefix || '(unavailable)'}\n\nInjected memory excerpts:\n${numbered}\n\n${answerBlock}\n\nReturn strict JSON: {"relevantCount": <0..${excerpts.length}>, "influenced": true|false}`,
        },
      ],
      temperature: 0,
      maxTokens: 200,
    });
    return parseVerdict(res.text, excerpts.length);
  } catch {
    return null;
  }
}

/**
 * Run the monthly audit. `llm === null` → `{ skipped: true }` no-op (mirrors the
 * other LLM cognition jobs). Metrics are written with INSERT OR REPLACE keyed on
 * (day, metric), day = run date, n = judged rows; a null metric (no data) skips
 * its write entirely.
 */
export async function runRecallAudit(
  db: RobinDb,
  llm: LLMDispatcher | null,
  opts: { sampleSize?: number; now?: Date } = {},
): Promise<RecallAuditResult> {
  const sampleSize = opts.sampleSize ?? DEFAULT_SAMPLE_SIZE;
  const now = opts.now ?? clockDate();
  const cutoff = new Date(now.getTime() - WINDOW_DAYS * 86_400_000).toISOString();
  const day = now.toISOString().slice(0, 10);
  const upsert = db.prepare(
    `INSERT OR REPLACE INTO metrics_daily (day, metric, value, n) VALUES (?, ?, ?, ?)`,
  );

  // Deterministic, no LLM: always computed, even when the judge is unavailable.
  const inj = computeInjectionStats(db, cutoff);
  if (inj.rate !== null) upsert.run(day, 'recall_injection_rate', inj.rate, inj.total);
  const injFields = { injectionRate: inj.rate, autoTurns: inj.total };

  if (llm === null) {
    return {
      sampled: 0,
      judgedItems: 0,
      precision: null,
      utilization: null,
      skipped: true,
      ...injFields,
    };
  }
  const rows = db
    .prepare(
      `SELECT id, ts, query_hash, session_id, kept_json
         FROM recall_log
        WHERE source = 'auto' AND kept_json IS NOT NULL AND ts >= ?
          -- kept_json is now written on every auto turn, empty ones included; sample
          -- only rows with snippets to judge so empties can't crowd the sample out.
          AND json_valid(kept_json)
          AND json_array_length(json_extract(kept_json, '$.snippets')) > 0
        ORDER BY ts DESC, id DESC
        LIMIT ?`,
    )
    .all(cutoff, sampleSize) as Array<{
    id: number;
    ts: string;
    query_hash: string;
    session_id: string | null;
    kept_json: string;
  }>;
  if (rows.length === 0) {
    return {
      sampled: 0,
      judgedItems: 0,
      precision: null,
      utilization: null,
      skipped: false,
      ...injFields,
    };
  }

  let judgedRows = 0;
  let judgedItems = 0;
  let totalRelevant = 0;
  let answeredRows = 0;
  let influencedRows = 0;

  for (const row of rows) {
    // Kept snippet contentIds from the kept_json auto-recall recorded (T4 shape:
    // { docs, snippets, habits, loops }). Malformed or snippet-less rows have
    // nothing judgeable and are skipped.
    let snippetIds: number[] = [];
    try {
      const kept = JSON.parse(row.kept_json) as { snippets?: unknown };
      if (Array.isArray(kept.snippets)) {
        snippetIds = kept.snippets.filter((n): n is number => typeof n === 'number');
      }
    } catch {
      continue;
    }
    if (snippetIds.length === 0) continue;

    const placeholders = snippetIds.map(() => '?').join(',');
    const excerpts = db
      .prepare(`SELECT id, body FROM events_content WHERE id IN (${placeholders})`)
      .all(...snippetIds) as Array<{ id: number; body: string }>;
    if (excerpts.length === 0) continue;

    const answer = row.session_id ? findSessionAnswer(db, row.session_id, row.ts) : null;
    const verdict = await judgeRow(llm, decodeQueryPrefix(row.query_hash), excerpts, answer);
    if (verdict === null) continue; // malformed judge output — skipped, counted by sampled−judged

    judgedRows++;
    judgedItems += excerpts.length;
    totalRelevant += verdict.relevantCount;
    if (answer !== null) {
      answeredRows++;
      if (verdict.influenced) influencedRows++;
    }
  }

  const precision = judgedItems > 0 ? totalRelevant / judgedItems : null;
  const utilization = answeredRows > 0 ? influencedRows / answeredRows : null;

  if (precision !== null) upsert.run(day, 'recall_precision', precision, judgedRows);
  if (utilization !== null) upsert.run(day, 'recall_utilization', utilization, judgedRows);

  return {
    sampled: rows.length,
    judgedItems,
    precision,
    utilization,
    skipped: false,
    ...injFields,
  };
}
