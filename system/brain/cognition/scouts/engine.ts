import { z } from 'zod';
import { UNTRUSTED_NOTE, wrapUntrusted } from '../../../lib/discretion/wrap-untrusted.ts';
import { createLogger } from '../../../lib/logging/logger.ts';
import { operatorName } from '../../../lib/operator-profile.ts';
import type { LLMDispatcher } from '../../llm/dispatcher.ts';
import type { RobinDb } from '../../memory/db.ts';
import { applyRecommendGate, MIN_SCAN_CONFIDENCE } from '../recommendations/gate.ts';
import type { ScoutConfig, ScoutRunResult } from './types.ts';

/**
 * Domain Scouts (value-loops W4) — the generic scout engine.
 * Design ref: docs/design/2026-08-10-value-loops-plan-3-scouts.md (Task 1);
 * spec docs/design/2026-08-10-value-loops-redesign.md §6.
 *
 * One weekly pass per domain: verify each configured source is FRESH (never scout
 * dead data), run the config's deterministic SQL digest over the fresh sources,
 * make ONE bounded `'reasoning'` StructuredOutput call over the digest (the
 * tier-b idiom: zod `outputSchema` + `maxTokens` pre-flight + a post-call budget
 * verify), then route every surviving candidate through `applyRecommendGate` —
 * the same creation gate as the MCP `recommend` path and the scan backfill, so
 * dedup / supersede / verdict-default expiry apply automatically (no side doors).
 */

const log = createLogger({ module: 'scouts' });

/**
 * Per-run cost budget (USD). One StructuredOutput call over a compact digest;
 * bounded pre-call by `maxTokens` and verified post-call against this cap
 * (the scan's `SCAN_BUDGET_USD` discipline — discard the output and log on
 * overspend, never silently overspend). Scouts keep no cursor, so a discarded
 * pass simply retries at the next weekly slot.
 */
const SCOUT_BUDGET_USD = 1.0;

/** Generation cap for the single scout call — ≤3 short candidates need little room. */
const SCOUT_MAX_TOKENS = 2048;

const MS_PER_DAY = 86_400_000;

/** StructuredOutput schema — the one LLM call's contract (≤3 candidates, hard cap). */
const SCOUT_OUTPUT = z.object({
  candidates: z
    .array(
      z.object({
        subject: z.string(),
        claim: z.string(),
        reasoning: z.string(),
        verdict: z.enum(['buy', 'skip', 'wait', 'try', 'avoid', 'other']),
        confidence: z.number().min(0).max(1),
        expiresAt: z.string().nullable(),
      }),
    )
    .max(3),
});

type ScoutOutput = z.infer<typeof SCOUT_OUTPUT>;

/** The shared prompt frame; `config.guidance` is appended per domain. */
function scoutSystemPrompt(config: ScoutConfig): string {
  return [
    `You are Robin's ${config.id} scout. From the digest below, propose 0–3 recommendations ${operatorName()} might ACT on — their next action, specific and named. No observations, no guide prose, no restating the data. Seasonal or time-windowed items MUST set expiresAt (ISO). Fewer, better candidates beat volume.`,
    config.guidance,
    UNTRUSTED_NOTE,
  ].join('\n\n');
}

/**
 * Parse a stored event `ts` to epoch ms; NaN for an unparseable value. Events are
 * written with `new Date().toISOString()` (T/Z form), but normalize the SQLite
 * space form defensively too (mirrors scan.ts / linker.ts `parseTs`).
 */
function parseTs(ts: string): number {
  const iso = ts.includes('T') || ts.endsWith('Z') ? ts : `${ts.replace(' ', 'T')}Z`;
  return new Date(iso).getTime();
}

/**
 * Partition the config's sources into fresh vs stale: a source is fresh when its
 * newest event (`MAX(ts)`) falls within its `maxAgeDays` window; no events at all
 * (or an unparseable ts) is stale. The freshness rule is engine-enforced so no
 * scout can scout dead data.
 */
function partitionSources(
  db: RobinDb,
  config: ScoutConfig,
  now: Date,
): { fresh: string[]; stale: string[] } {
  const fresh: string[] = [];
  const stale: string[] = [];
  const stmt = db.prepare(`SELECT MAX(ts) AS maxTs FROM events WHERE source = ?`);
  for (const { source, maxAgeDays } of config.sources) {
    const row = stmt.get(source) as { maxTs: string | null } | undefined;
    const maxMs = row?.maxTs ? parseTs(row.maxTs) : Number.NaN;
    if (Number.isNaN(maxMs) || maxMs < now.getTime() - maxAgeDays * MS_PER_DAY) {
      stale.push(source);
    } else {
      fresh.push(source);
    }
  }
  return { fresh, stale };
}

function zeroResult(
  scout: string,
  skipped: ScoutRunResult['skipped'],
  staleSources: string[] = [],
): ScoutRunResult {
  return {
    scout,
    skipped,
    staleSources,
    candidates: 0,
    dropped: 0,
    inserted: 0,
    duplicates: 0,
    superseded: 0,
  };
}

/**
 * Run one scout pass. Honors the per-domain kill-switch (`opts.enabled`) and skips
 * honestly — disabled, no LLM, all sources stale, or an empty digest — logging why.
 * Otherwise makes ONE bounded StructuredOutput call and routes every candidate at
 * or above `MIN_SCAN_CONFIDENCE` through the recommendation creation gate. Parse
 * failures and invoke throws yield a zero-candidate pass; this function never throws.
 *
 * @param opts.now      Injectable reference time for deterministic tests.
 * @param opts.enabled  Resolved `scouts.enabled && scouts.<id>` policy (default true).
 */
export async function runScout(
  db: RobinDb,
  llm: LLMDispatcher | null,
  config: ScoutConfig,
  opts?: { now?: Date; enabled?: boolean },
): Promise<ScoutRunResult> {
  const enabled = opts?.enabled ?? true;
  if (enabled === false) {
    log.info({ scout: config.id }, 'scout skipped (disabled by policy)');
    return zeroResult(config.id, 'disabled');
  }
  if (llm == null) {
    log.info({ scout: config.id }, 'scout skipped (no LLM available)');
    return zeroResult(config.id, 'no-llm');
  }

  const now = opts?.now ?? new Date();

  // 1. Freshness rule: partition sources; ALL stale → skip the pass entirely.
  const { fresh, stale } = partitionSources(db, config, now);
  if (fresh.length === 0) {
    log.info({ scout: config.id, staleSources: stale }, 'scout skipped (all sources stale)');
    return zeroResult(config.id, 'all-stale', stale);
  }

  // 2. Deterministic digest over the fresh sources only; null → nothing to scan.
  const digest = config.digest(db, now, fresh);
  if (digest == null) {
    log.info({ scout: config.id, staleSources: stale }, 'scout skipped (empty digest)');
    return zeroResult(config.id, 'empty-digest', stale);
  }

  // 3. ONE StructuredOutput call. Bound generation pre-call (maxTokens), verify
  //    cost after; a parse failure or an invoke throw is a zero-candidate pass.
  let parsed: ScoutOutput = { candidates: [] };
  try {
    const res = await llm.invoke('reasoning', {
      systemPrompt: scoutSystemPrompt(config),
      // The digest renders integration data (email subjects, merchants, invites).
      messages: [
        {
          role: 'user',
          content: `DIGEST:\n${wrapUntrusted(digest, { source: `scout:${config.id}`, trust: 'untrusted' })}`,
        },
      ],
      outputSchema: SCOUT_OUTPUT,
      temperature: 0,
      maxTokens: SCOUT_MAX_TOKENS,
    });
    if ((res.costUsd ?? 0) > SCOUT_BUDGET_USD) {
      log.warn(
        { scout: config.id, costUsd: res.costUsd, budget: SCOUT_BUDGET_USD },
        'scout: call exceeded per-run budget — discarding output',
      );
    } else {
      parsed = parseScout(config.id, res.structured, res.text);
    }
  } catch (err) {
    log.warn({ scout: config.id, err: String(err) }, 'scout: LLM call failed — zero candidates');
  }

  const result: ScoutRunResult = {
    scout: config.id,
    skipped: null,
    staleSources: stale,
    candidates: parsed.candidates.length,
    dropped: 0,
    inserted: 0,
    duplicates: 0,
    superseded: 0,
  };

  // 4. Confidence floor, then route every survivor through the creation gate —
  //    dedup / supersede / verdict-default expiry apply automatically.
  for (const c of parsed.candidates) {
    const subject = c.subject?.trim();
    const claim = c.claim?.trim();
    if (!subject || !claim) continue; // insertRecommendation would throw — never let it
    if (c.confidence < MIN_SCAN_CONFIDENCE) {
      result.dropped += 1;
      continue;
    }
    const gated = applyRecommendGate(db, {
      subject,
      claim,
      reasoning: `[scout:${config.id}] ${c.reasoning}`,
      verdict: c.verdict,
      domain: config.domain,
      confidence: c.confidence,
      expiresAt: c.expiresAt,
      now,
    });
    if (gated.action === 'inserted') result.inserted += 1;
    else if (gated.action === 'duplicate') result.duplicates += 1;
    else result.superseded += 1;
  }

  log.info({ ...result }, 'scout pass complete');
  return result;
}

/**
 * Validate the model's output into the scout schema. Prefers the native
 * StructuredOutput object (`res.structured`); falls back to parsing `res.text` as
 * JSON (the tier-b / scan manual-parse path). A parse/schema failure yields zero
 * candidates — logged, never thrown.
 */
function parseScout(scout: string, structured: unknown, text: string): ScoutOutput {
  if (structured !== undefined && structured !== null) {
    const r = SCOUT_OUTPUT.safeParse(structured);
    if (r.success) return r.data;
  }
  const jsonText = (text ?? '')
    .trim()
    .replace(/^```(?:json)?/, '')
    .replace(/```$/, '')
    .trim();
  if (jsonText) {
    try {
      const r = SCOUT_OUTPUT.safeParse(JSON.parse(jsonText));
      if (r.success) return r.data;
    } catch {
      // fall through to empty
    }
  }
  log.warn({ scout }, 'scout: unparseable LLM output — zero candidates');
  return { candidates: [] };
}
