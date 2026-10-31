import { z } from 'zod';
import { UNTRUSTED_NOTE, wrapUntrusted } from '../../../lib/discretion/wrap-untrusted.ts';
import { createLogger } from '../../../lib/logging/logger.ts';
import { operatorName } from '../../../lib/operator-profile.ts';
import type { LLMDispatcher } from '../../llm/dispatcher.ts';
import type { RobinDb } from '../../memory/db.ts';
import {
  type EventRow,
  GMAIL_MESSAGE_KIND,
  MENTION_SIGNAL_KINDS,
  normalizeSignal,
  SHIPMENT_KIND,
} from '../behavior/signals.ts';
import { markActed, markContrary } from './linker.ts';
import { distinctiveTokens, firstMentionIndex, looseTokenHit, tokenize } from './match-text.ts';
import {
  expiryMsOf,
  isHoldVerdict,
  listOpenRecommendations,
  resolveRecommendation,
} from './store.ts';
import type { Recommendation } from './types.ts';

/**
 * Recommendation→Action Loop — the LLM MATCHING pass (audit 2026-10-02).
 *
 * The deterministic linker auto-detected only a small share of acted recs; the rest were resolved
 * by hand. Most actions leave evidence no exact rule can read: the operator SAYS "ordered the
 * bread box" or "skipping the bake sale" in a session, or the order email names the item in
 * words the subject doesn't share. This weekly pass (run from the recommendation scan)
 * judges each open rec against the evidence that loosely mentions it — recent
 * behavioral signals (order/shipping/booking emails, calendar, transactions, diary) and
 * the operator's OWN session turns — with a cheap `classify` call, batched.
 *
 * Conservative by construction: recs with no loosely-matching evidence are never sent;
 * only the operator's turns are quoted (Robin restating its advice is not evidence); a verdict
 * resolves a rec only at confidence ≥ MIN_CONFIDENCE; "unclear" leaves it open for the
 * expiry path. The outcome is judged on the THING (did_it / declined_it), then mapped
 * through the rec's stance — doing a thing Robin said to skip is a contrary action.
 */

const log = createLogger({ module: 'recommendations' });

const MS_PER_DAY = 86_400_000;
const DEFAULT_WINDOW_DAYS = 30;
const DEFAULT_BATCH_SIZE = 20;
const DEFAULT_MAX_BATCHES = 6;
const DEFAULT_BUDGET_USD = 0.5;
/** Minimum model confidence to resolve a rec (precision over recall). */
export const MIN_MATCH_CONFIDENCE = 0.8;

const MAX_SIGNALS_PER_REC = 4;
const MAX_SNIPPETS_PER_REC = 3;
const SNIPPET_CHARS = 400;
const SESSION_ROW_CAP = 600;
const SIGNAL_ROW_CAP = 5000;

/** Signal kinds worth showing the judge (objectless health/LRC aggregates are not). */
const EVIDENCE_SIGNAL_KINDS = [
  'lunch_money.transaction',
  'letterboxd.letterboxd_diary',
  'integration.google_calendar.event',
  GMAIL_MESSAGE_KIND,
  SHIPMENT_KIND,
] as const;

const judgmentSchema = z.object({
  judgments: z
    .array(
      z.object({
        rec: z.number(),
        outcome: z.enum(['did_it', 'declined_it', 'unclear']),
        confidence: z.number().default(0),
        evidence: z.string().default(''),
        /** The E-id of the evidence line that settles it (optional). */
        eventId: z.number().optional(),
      }),
    )
    .default([]),
});
type Judgment = z.infer<typeof judgmentSchema>['judgments'][number];

const systemPrompt = (
  name: string,
): string => `You check whether ${name} (the user) followed up on recommendations Robin (their assistant) gave them. Reply ONLY with JSON matching the schema.

For each REC you get the advice and a few EVIDENCE lines dated after it: the user's own chat messages ("user:"), and records of things they did (order/shipping/booking emails, calendar entries, card transactions, film diary).

Judge the THING named in the rec, not the advice:
- did_it: the evidence clearly shows the user bought / ordered / booked / visited / tried / started that SPECIFIC thing (an order or delivery of that item, a booking for that place, the user saying they did it).
- declined_it: the user clearly said they will not do it / decided against it / returned or cancelled it.
- unclear: anything else — the thing only being discussed, the user asking about it, a different model or place, plans not yet carried out, ambiguity.

Be conservative. A mention is not an action. Robin repeating its advice is not evidence. Prefer unclear unless the evidence is explicit. confidence is 0..1 that your outcome is right; when the outcome is did_it or declined_it, set eventId to the E-number of the deciding line and quote it briefly in evidence.

Return {"judgments":[{"rec":<rec id>,"outcome":"did_it"|"declined_it"|"unclear","confidence":<0..1>,"evidence":"<short quote>","eventId":<n>}]} with one entry per REC.

${UNTRUSTED_NOTE}`;

interface Evidence {
  eventId: number;
  ts: string;
  /** One rendered line for the prompt. */
  line: string;
  /** Searchable text. */
  text: string;
  /** Its token set (computed once — evidence is matched against every open rec). */
  words: ReadonlySet<string>;
}

export interface LlmMatchOptions {
  windowDays?: number;
  batchSize?: number;
  maxBatches?: number;
  budgetUsd?: number;
  minConfidence?: number;
  now?: Date;
}

export interface LlmMatchResult {
  /** Open recs that had ≥1 loosely matching evidence line. */
  candidates: number;
  /** Recs sent to the judge. */
  judged: number;
  acted: number;
  /** Resolved `declined` — explicit decline, or a contrary action on a hold stance. */
  declined: number;
  /** Hold-type recs the operator explicitly agreed to skip → `held`. */
  held: number;
  costUsd: number;
  skipped: boolean;
}

function parseTs(ts: string): number {
  const iso = ts.includes('T') || ts.endsWith('Z') ? ts : `${ts.replace(' ', 'T')}Z`;
  return new Date(iso).getTime();
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n).trimEnd()}…` : s);

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** Behavioral-signal evidence in the window (mention kinds carry their body text). */
function loadSignalEvidence(db: RobinDb, windowStartIso: string): Evidence[] {
  const kinds = [...EVIDENCE_SIGNAL_KINDS];
  const mention = [...MENTION_SIGNAL_KINDS];
  const rows = db
    .prepare(
      `SELECT e.id AS id, e.kind AS kind, e.ts AS ts, e.actor AS actor, e.payload AS payload,
              CASE WHEN e.kind IN (${mention.map(() => '?').join(', ')}) THEN c.body END AS content
         FROM events e
         LEFT JOIN events_content c ON c.id = e.content_ref
        WHERE e.kind IN (${kinds.map(() => '?').join(', ')}) AND e.ts >= ?
        ORDER BY e.id DESC
        LIMIT ?`,
    )
    .all(...mention, ...kinds, windowStartIso, SIGNAL_ROW_CAP) as EventRow[];
  const out: Evidence[] = [];
  for (const row of rows) {
    const sig = normalizeSignal(row);
    if (!sig?.object) continue;
    const ctxText = typeof sig.context.text === 'string' ? sig.context.text : '';
    const text = oneLine(ctxText || sig.object);
    out.push({
      eventId: row.id,
      ts: row.ts,
      text,
      words: new Set(tokenize(text)),
      // Integration records carry third-party text (order emails, invites, merchants);
      // the operator's own turns (loadSessionEvidence) stay unfenced.
      line: `${sig.action} [${row.kind}] ${wrapUntrusted(clip(text, 240), { source: row.kind, trust: 'untrusted' })}`,
    });
  }
  return out;
}

/** The operator's own turns from a rendered session transcript (harness scaffolding dropped). */
export function userTurns(body: string): string[] {
  const turns = body.split(/\n\n(?=\[(?:USER|ASSISTANT|TOOL)\]\n)/);
  const out: string[] = [];
  for (const t of turns) {
    if (!t.startsWith('[USER]')) continue;
    const raw = t.slice('[USER]'.length);
    if (/<command-name>|<local-command|<task-notification|<system-reminder/i.test(raw)) continue;
    const text = oneLine(raw.replace(/<[^>]+>/g, ' '));
    if (text.length >= 3) out.push(text);
  }
  return out;
}

/** The operator's session turns in the window (non-dev sessions), one evidence row per turn. */
function loadSessionEvidence(db: RobinDb, windowStartIso: string): Evidence[] {
  const rows = db
    .prepare(
      `SELECT events.id AS id, events.ts AS ts, events_content.body AS body
         FROM events
         JOIN events_content ON events_content.id = events.content_ref
        WHERE events.kind = 'session.captured'
          AND events.ts >= ?
          AND COALESCE(json_extract(events.payload, '$.category'), 'personal') != 'dev'
        ORDER BY events.id DESC
        LIMIT ?`,
    )
    .all(windowStartIso, SESSION_ROW_CAP) as Array<{ id: number; ts: string; body: string | null }>;
  const out: Evidence[] = [];
  for (const r of rows) {
    if (!r.body) continue;
    for (const turn of userTurns(r.body)) {
      out.push({ eventId: r.id, ts: r.ts, text: turn, words: new Set(tokenize(turn)), line: '' });
    }
  }
  return out;
}

/** A session turn rendered around the rec's first mention. */
function snippetFor(rec: Recommendation, turn: string): string {
  const at = Math.max(0, firstMentionIndex(rec.subject, turn));
  const start = Math.max(0, at - SNIPPET_CHARS / 2);
  const piece = turn.slice(start, start + SNIPPET_CHARS);
  return `user: ${start > 0 ? '…' : ''}${piece}${start + SNIPPET_CHARS < turn.length ? '…' : ''}`;
}

interface Candidate {
  rec: Recommendation;
  evidence: Evidence[];
}

function gatherCandidates(
  open: Recommendation[],
  signals: Evidence[],
  turns: Evidence[],
): Candidate[] {
  const out: Candidate[] = [];
  for (const rec of open) {
    const after = parseTs(rec.createdAt);
    const required = distinctiveTokens(rec.subject);
    const ev: Evidence[] = [];
    for (const s of signals) {
      if (ev.length >= MAX_SIGNALS_PER_REC) break;
      if (parseTs(s.ts) >= after && looseTokenHit(required, s.words)) ev.push(s);
    }
    let snippets = 0;
    for (const t of turns) {
      if (snippets >= MAX_SNIPPETS_PER_REC) break;
      if (parseTs(t.ts) >= after && looseTokenHit(required, t.words)) {
        ev.push({ ...t, line: snippetFor(rec, t.text) });
        snippets += 1;
      }
    }
    if (ev.length > 0) out.push({ rec, evidence: ev });
  }
  // Soonest-lapsing first: those are the ones about to resolve on a guess.
  return out.sort(
    (a, b) =>
      (expiryMsOf(a.rec) ?? Number.MAX_SAFE_INTEGER) -
      (expiryMsOf(b.rec) ?? Number.MAX_SAFE_INTEGER),
  );
}

function renderBatch(batch: Candidate[]): string {
  return batch
    .map((c) => {
      const head = `REC ${c.rec.id} (${c.rec.verdict ?? 'other'}, ${c.rec.createdAt.slice(0, 10)}): ${c.rec.subject} — ${clip(oneLine(c.rec.claim), 200)}`;
      const lines = c.evidence.map((e) => `  E${e.eventId} ${e.ts.slice(0, 10)} ${e.line}`);
      return [head, ...lines].join('\n');
    })
    .join('\n\n');
}

function parseJudgments(structured: unknown, text: string): Judgment[] {
  const direct = judgmentSchema.safeParse(structured);
  if (structured != null && direct.success) return direct.data.judgments;
  const m = (text ?? '').match(/\{[\s\S]*\}/);
  if (!m) return [];
  try {
    const parsed = judgmentSchema.safeParse(JSON.parse(m[0]));
    return parsed.success ? parsed.data.judgments : [];
  } catch {
    return [];
  }
}

/**
 * Run one LLM matching pass over the open recs. No-op without an LLM or open recs.
 * Each batch is one `classify` call; the pass stops once `budgetUsd` is spent, and an
 * LLM failure ends the pass without resolving anything from that batch.
 */
export async function runRecommendationLlmMatch(
  db: RobinDb,
  llm: LLMDispatcher | null,
  opts: LlmMatchOptions = {},
): Promise<LlmMatchResult> {
  const result: LlmMatchResult = {
    candidates: 0,
    judged: 0,
    acted: 0,
    declined: 0,
    held: 0,
    costUsd: 0,
    skipped: true,
  };
  if (!llm) return result;
  const open = listOpenRecommendations(db);
  if (open.length === 0) return result;

  const now = opts.now ?? new Date();
  const windowStartIso = new Date(
    now.getTime() - (opts.windowDays ?? DEFAULT_WINDOW_DAYS) * MS_PER_DAY,
  ).toISOString();
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  const maxBatches = opts.maxBatches ?? DEFAULT_MAX_BATCHES;
  const budgetUsd = opts.budgetUsd ?? DEFAULT_BUDGET_USD;
  const minConfidence = opts.minConfidence ?? MIN_MATCH_CONFIDENCE;

  const candidates = gatherCandidates(
    open,
    loadSignalEvidence(db, windowStartIso),
    loadSessionEvidence(db, windowStartIso),
  );
  result.candidates = candidates.length;
  result.skipped = false;

  for (let b = 0; b < maxBatches; b++) {
    const batch = candidates.slice(b * batchSize, (b + 1) * batchSize);
    if (batch.length === 0) break;
    if (result.costUsd >= budgetUsd) {
      log.warn({ costUsd: result.costUsd, budgetUsd }, 'recommendation llm-match: budget spent');
      break;
    }
    let judgments: Judgment[];
    try {
      const res = await llm.invoke('classify', {
        systemPrompt: systemPrompt(operatorName()),
        messages: [{ role: 'user', content: renderBatch(batch) }],
        outputSchema: judgmentSchema,
        temperature: 0,
        maxTokens: 1500,
      });
      result.costUsd += res.costUsd ?? 0;
      judgments = parseJudgments(res.structured, res.text);
    } catch (err) {
      log.warn({ err: String(err) }, 'recommendation llm-match: classify call failed — stopping');
      break;
    }
    result.judged += batch.length;
    applyJudgments(db, batch, judgments, minConfidence, now, result);
  }

  log.info({ ...result }, 'recommendation llm-match complete');
  return result;
}

function applyJudgments(
  db: RobinDb,
  batch: Candidate[],
  judgments: Judgment[],
  minConfidence: number,
  now: Date,
  result: LlmMatchResult,
): void {
  const byId = new Map(batch.map((c) => [c.rec.id, c]));
  const done = new Set<number>();
  for (const j of judgments) {
    const cand = byId.get(j.rec);
    if (!cand || done.has(j.rec)) continue;
    if (j.outcome === 'unclear' || j.confidence < minConfidence) continue;
    // The cited evidence must be one we showed for THIS rec (no invented ids).
    const cited =
      j.eventId != null ? cand.evidence.find((e) => e.eventId === j.eventId) : undefined;
    if (j.eventId != null && !cited) continue;
    done.add(j.rec);
    const rec = cand.rec;
    const quote = clip(oneLine(j.evidence), 160);
    const ref = cited ? ` (event #${cited.eventId})` : '';
    const ts = cited?.ts ?? now.toISOString();
    const hold = isHoldVerdict(rec.verdict);

    if (j.outcome === 'did_it') {
      if (hold) {
        markContrary(db, rec, { ts, evidence: `llm match: contrary action${ref}: ${quote}` });
        result.declined += 1;
      } else {
        markActed(db, rec, { ts, evidence: `llm match${ref}: ${quote}` });
        result.acted += 1;
      }
    } else if (hold) {
      resolveRecommendation(db, rec.id, {
        status: 'held',
        outcome: 'not_acted',
        actedAt: ts,
        evidence: `llm match: held${ref}: ${quote}`,
      });
      result.held += 1;
    } else {
      markContrary(db, rec, { evidence: `llm match: declined${ref}: ${quote}` });
      result.declined += 1;
    }
  }
}
