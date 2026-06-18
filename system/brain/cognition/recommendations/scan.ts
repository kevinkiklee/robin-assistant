import { z } from 'zod';
import { createLogger } from '../../../lib/logging/logger.ts';
import type { LLMDispatcher } from '../../llm/dispatcher.ts';
import type { RobinDb } from '../../memory/db.ts';
import { isPersonalDomain, type PersonalDomain } from '../../memory/domains.ts';
import { preprocessForExtraction } from '../biographer.ts';
import { getScanCursor, setScanCursor } from './cursor.ts';
import { insertRecommendation, listRecommendations, subjectMatches } from './store.ts';
import type { Verdict } from './types.ts';

/**
 * Recommendation→Action Loop (Phase 1.1) — the session-scan BACKFILL.
 * Design ref: docs/design/2026-06-17-recommendation-loop-design.md §2 (the deferred LLM
 * safety net), §3 (the data model), §5 (subject = the linker's match key).
 *
 * The explicit `recommend` MCP path (§4.1) + the deterministic linker (§5) deliver the core
 * loop, but BOTH depend on Robin having remembered to log a recommendation. This bounded
 * weekly LLM job is the safety net: it re-reads recent captured sessions and discovers
 * substantive recommendations Robin actually MADE to Kevin but never logged, recording each
 * as an `open` recommendation so the deterministic linker can later detect whether Kevin
 * acted. It makes the loop work WITHOUT relying on Robin's discipline.
 *
 * It mirrors Tier B's bounded-budget single-StructuredOutput-call discipline (behavior/
 * tier-b.ts): ONE `reasoning` invoke with an outputSchema + maxTokens, a per-run cost
 * budget verified post-call (discard + don't advance the cursor on overspend), and
 * skip-on-no-LLM / skip-on-empty. Extraction is deliberately HIGH-PRECISION: a missed
 * recommendation is fine (the explicit path may have caught it; the next run re-reads), a
 * FABRICATED one pollutes the ledger and mis-calibrates Goal C — so the prompt insists on
 * recommendations Robin actually made, never options merely discussed or hypotheticals.
 */

const log = createLogger({ module: 'recommendations' });

/**
 * Per-run cost budget (USD). One StructuredOutput call; bounded pre-call by `maxTokens` and
 * verified post-call against this cap. Modeled on Tier B's `SYNTHESIS_BUDGET_USD` (a fixed
 * per-run cap that sits ABOVE one Opus-4.8 turn's cost so the turn isn't aborted
 * post-output). $1.0 is ample for one extraction call over a capped session batch.
 */
const SCAN_BUDGET_USD = 1.0;

/** Generation cap for the single extraction call — bounds cost pre-flight. */
const SCAN_MAX_TOKENS = 2048;

/** How many days back the scan considers a session "recent" (default; overridable by policy). */
const DEFAULT_WINDOW_DAYS = 14;

/**
 * Per-run session cap. Bounds the StructuredOutput prompt so one weekly call never blows its
 * budget/context. When more sessions are staged, the cursor advances only past the consumed
 * rows so the remainder is processed (deferred, not dropped) on the next run.
 */
const SESSION_CAP = 40;

/**
 * Per-session body slice fed to the prompt. Sessions are turn-rendered transcripts that can
 * run hundreds of KB; a recommendation, if present, is a short stance Robin states in prose,
 * so a bounded slice of the cleaned body keeps the batch prompt under budget. Preprocessing
 * (biographer's `preprocessForExtraction`) already strips tool/code/scaffolding noise.
 */
const PER_SESSION_CHARS = 6000;

const MS_PER_DAY = 86_400_000;

/** The allowed verdict set (mirrors `Verdict` in ./types.ts) — used to validate model output. */
const VERDICTS: ReadonlySet<string> = new Set<Verdict>([
  'buy',
  'skip',
  'wait',
  'try',
  'avoid',
  'other',
]);

/** StructuredOutput schema — the one LLM call's contract. */
const scanSchema = z.object({
  recommendations: z
    .array(
      z.object({
        subject: z.string(),
        claim: z.string(),
        verdict: z.string().default('other'),
        domain: z.string().default('preferences'),
        confidence: z.number().default(0.5),
      }),
    )
    .default([]),
});

type ScanResult = z.infer<typeof scanSchema>;

const SCAN_SYSTEM_PROMPT = `You are auditing Robin's recent conversation sessions to recover SUBSTANTIVE RECOMMENDATIONS Robin (the assistant) made to Kevin (the user) but may have forgotten to log. Reply ONLY with JSON matching the schema.

A qualifying recommendation is a CLEAR STANCE Robin took, advising Kevin to take (or not take) a specific action on a SPECIFIC NAMED thing — a buy / skip / try / wait / avoid judgment. Example: Robin advising "buy the Nikon Z TC-1.4x for Z50II birding reach".

Extract a recommendation ONLY when ALL of these hold:
- It is advice Robin gave TO Kevin (the assistant recommending), NOT Kevin's own statement, plan, or decision.
- It names a SPECIFIC thing (a product, place, lens, restaurant, service, title) — not a vague category.
- Robin took an actual stance (buy/skip/try/wait/avoid), not a neutral list of options.

Do NOT extract:
- options Robin merely DISCUSSED, compared, or laid out without endorsing one,
- hypotheticals ("if you wanted X, you could…"),
- Kevin's own statements, plans, or things he already did,
- engineering/code advice (refactors, configs, libraries, Robin's own internals) — those are NOT personal recommendations,
- anything you are not confident Robin actually recommended.

PRECISION OVER RECALL: a missed recommendation is fine; a fabricated one is NOT. When in doubt, omit it.

For each recommendation:
- subject: the short canonical name of the recommended thing ("Nikon Z TC-1.4x"). This is the match key — keep it tight and specific.
- claim: one sentence stating the advice.
- verdict: one of buy, skip, wait, try, avoid, other.
- domain: one of health, finance, career, relationships, preferences, creative, travel, home, life_events, identity, directives.
- confidence: 0..1, how strongly Robin endorsed it.

If no session contains a substantive recommendation, return {"recommendations":[]}.`;

/** Outcome of one session-scan backfill pass. */
export interface RecommendationScanResult {
  /** Sessions read + fed to the extraction call this pass. */
  scanned: number;
  /** New `open` recommendations recorded (survivors after dedup + validation). */
  recorded: number;
  /** Extracted recommendations dropped because the subject already exists in the ledger. */
  deduped: number;
  /** True when the pass skipped (disabled OR no LLM OR no recent sessions OR over budget). */
  skipped: boolean;
}

const ZERO: RecommendationScanResult = { scanned: 0, recorded: 0, deduped: 0, skipped: true };

/**
 * Parse a stored event `ts` (ISO `…T…Z`) to epoch ms; NaN for an unparseable value.
 * Session events are written with `new Date().toISOString()`, so they always carry the T/Z
 * form — but normalize the SQLite space form defensively too (mirrors linker.ts `parseTs`).
 */
function parseTs(ts: string): number {
  const iso = ts.includes('T') || ts.endsWith('Z') ? ts : `${ts.replace(' ', 'T')}Z`;
  return new Date(iso).getTime();
}

interface SessionRow {
  id: number;
  ts: string;
  body: string;
}

/**
 * Pull `session.captured` events after `cursor`, oldest-first, bounded by `SESSION_CAP`.
 * We select ALL session rows (not pre-filtered by category) and advance the cursor past
 * every scanned row, then skip `category='dev'` / out-of-window / empty-body rows in the
 * loop. Advancing past dev rows here (rather than excluding them in SQL) keeps the cursor
 * monotonic, so a dev-heavy week is consumed once and never re-scanned. The dev filter
 * matches the biographer's (a pure-dev session never holds a personal recommendation).
 */
function selectRecentSessions(
  db: RobinDb,
  cursor: number,
  windowStartMs: number,
): { rows: SessionRow[]; cursor: number } {
  const raw = db
    .prepare(
      `SELECT events.id AS id, events.ts AS ts,
              COALESCE(json_extract(events.payload, '$.category'), 'personal') AS category,
              events_content.body AS body
         FROM events
         JOIN events_content ON events_content.id = events.content_ref
        WHERE events.id > ?
          AND events.kind = 'session.captured'
        ORDER BY events.id ASC
        LIMIT ?`,
    )
    .all(cursor, SESSION_CAP) as Array<{
    id: number;
    ts: string;
    category: string;
    body: string | null;
  }>;

  let newCursor = cursor;
  const rows: SessionRow[] = [];
  for (const r of raw) {
    // Advance the cursor past every scanned row, even a dev / out-of-window / empty-body
    // one — they are genuinely consumed and must never be re-scanned.
    newCursor = Math.max(newCursor, r.id);
    if (r.category === 'dev') continue;
    if (!r.body) continue;
    if (parseTs(r.ts) < windowStartMs) continue;
    rows.push({ id: r.id, ts: r.ts, body: r.body });
  }
  return { rows, cursor: newCursor };
}

/** Render one session compactly for the prompt — id-tagged, preprocessed + length-bounded. */
function renderSession(row: SessionRow): string {
  const cleaned = preprocessForExtraction(row.body).slice(0, PER_SESSION_CHARS);
  return `--- SESSION #${row.id} ---\n${cleaned}`;
}

/**
 * Run one session-scan backfill pass (Phase 1.1). Honors the `enabled` kill-switch and skips
 * when no LLM is available OR no recent sessions are staged. Otherwise makes ONE bounded
 * StructuredOutput call to extract substantive recommendations Robin made, dedups them
 * against the ledger, validates domain/verdict, inserts survivors as `open` recommendations,
 * and advances the scan cursor.
 *
 * @param opts.enabled     Resolved `recommendationScan.enabled` policy (default true).
 * @param opts.windowDays  How many days back a session counts as recent (default 14).
 * @param opts.budgetUsd   Per-run cost budget (default $1.0).
 * @param opts.now         Injectable reference time for deterministic tests.
 */
export async function runRecommendationScan(
  db: RobinDb,
  llm: LLMDispatcher | null,
  opts: {
    enabled?: boolean;
    windowDays?: number;
    budgetUsd?: number;
    now?: Date;
  } = {},
): Promise<RecommendationScanResult> {
  const enabled = opts.enabled ?? true;
  if (!enabled || !llm) {
    log.info({ enabled, hasLlm: llm != null }, 'recommendation scan skipped (disabled or no LLM)');
    return { ...ZERO };
  }

  const now = opts.now ?? new Date();
  const windowDays = opts.windowDays ?? DEFAULT_WINDOW_DAYS;
  const budgetUsd = opts.budgetUsd ?? SCAN_BUDGET_USD;
  const windowStartMs = now.getTime() - windowDays * MS_PER_DAY;

  // 1. Pull recent in-window sessions after the persisted cursor. Skip when none.
  const cursorBefore = getScanCursor(db);
  const { rows, cursor } = selectRecentSessions(db, cursorBefore, windowStartMs);
  if (rows.length === 0) {
    // The cursor may still have advanced past dev/out-of-window/empty rows we genuinely
    // consumed — persist that so they're never re-scanned. There is no LLM call to make.
    if (cursor > cursorBefore) setScanCursor(db, cursor);
    log.info('recommendation scan: no recent sessions to scan — skipping');
    return { ...ZERO };
  }

  // 2. ONE StructuredOutput call. Bound generation pre-call (maxTokens), verify cost after.
  let parsed: ScanResult;
  try {
    const res = await llm.invoke('reasoning', {
      systemPrompt: SCAN_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: rows.map(renderSession).join('\n\n') }],
      outputSchema: scanSchema,
      temperature: 0,
      maxTokens: SCAN_MAX_TOKENS,
    });

    if ((res.costUsd ?? 0) > budgetUsd) {
      log.warn(
        { costUsd: res.costUsd, budget: budgetUsd },
        'recommendation scan: call exceeded per-run budget — discarding output, not advancing cursor',
      );
      return { ...ZERO, skipped: false };
    }

    parsed = parseScan(res.structured, res.text);
  } catch (err) {
    // Outage / bad output: don't advance the cursor so the sessions are re-scanned next run
    // (mirrors Tier B's "don't lose work on an LLM failure" discipline).
    log.warn({ err: String(err) }, 'recommendation scan: extraction call failed — deferring');
    return { ...ZERO, skipped: false };
  }

  // 3. Dedup + validate + insert. Build the existing-subject set ONCE (case-insensitive
  // exact match), then also apply `subjectMatches` for the conservative multi-token rule.
  const existing = listRecommendations(db);
  const existingSubjects = new Set(existing.map((r) => r.subject.trim().toLowerCase()));

  let recorded = 0;
  let deduped = 0;
  for (const rec of parsed.recommendations) {
    const subject = rec.subject?.trim();
    const claim = rec.claim?.trim();
    if (!subject || !claim) continue;

    // Dedup: case-insensitive exact subject match, OR the linker's conservative multi-token
    // whole-word match against any existing subject (so a re-stated "Nikon Z TC-1.4x" isn't
    // recorded twice). Counted, not silently dropped.
    const isDup =
      existingSubjects.has(subject.toLowerCase()) ||
      existing.some(
        (e) => subjectMatches(e.subject, subject) || subjectMatches(subject, e.subject),
      );
    if (isDup) {
      deduped += 1;
      continue;
    }

    // Validate domain (fallback to `preferences` — the benign default for an unrecognized
    // or absent domain) and verdict (fallback to `other`).
    const domain: PersonalDomain = isPersonalDomain(rec.domain) ? rec.domain : 'preferences';
    const verdict: Verdict = VERDICTS.has(rec.verdict) ? (rec.verdict as Verdict) : 'other';

    insertRecommendation(db, {
      subject,
      claim,
      verdict,
      domain,
      confidence: rec.confidence,
      // Mark this rec's provenance in `reasoning` — it was RECOVERED by the backfill, not
      // logged via the explicit `recommend` tool. (insertRecommendation has no `evidence`
      // arg; that durable audit field is written only when the linker resolves the rec.)
      reasoning: 'recovered by recommendation-scan backfill (Robin recommended; never logged)',
      // Tag the most recent scanned session as the source (best-effort provenance — the
      // backfill reads a batch, so this is the newest session in the window, not the exact
      // turn). The column is ON DELETE SET NULL, so a dangling id is harmless.
      sourceEventId: rows[rows.length - 1].id,
    });
    // De-dup within THIS batch too: a later extracted rec with the same subject is a dup.
    existingSubjects.add(subject.toLowerCase());
    recorded += 1;
  }

  // 4. Advance + persist the scan cursor (only past the consumed rows).
  setScanCursor(db, cursor);

  const result: RecommendationScanResult = {
    scanned: rows.length,
    recorded,
    deduped,
    skipped: false,
  };
  log.info({ ...result, cursor }, 'recommendation scan complete');
  return result;
}

/**
 * Validate the model's output into the scan schema. Prefers the native StructuredOutput
 * object (`res.structured`); falls back to parsing `res.text` as JSON (the biographer's
 * manual-parse path) so the engine works with providers that don't return structured output.
 * A parse/schema failure yields an empty result (no recordings; the cursor still advances —
 * the sessions were genuinely seen and an empty extraction is a valid outcome).
 */
function parseScan(structured: unknown, text: string): ScanResult {
  if (structured !== undefined && structured !== null) {
    const r = scanSchema.safeParse(structured);
    if (r.success) return r.data;
  }
  const jsonText = (text ?? '')
    .trim()
    .replace(/^```(?:json)?/, '')
    .replace(/```$/, '')
    .trim();
  if (jsonText) {
    try {
      const r = scanSchema.safeParse(JSON.parse(jsonText));
      if (r.success) return r.data;
    } catch {
      // fall through to empty
    }
  }
  return { recommendations: [] };
}
