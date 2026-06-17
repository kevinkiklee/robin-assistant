import type { RobinDb } from '../../memory/db.ts';
import { isPersonalDomain, type PersonalDomain } from '../../memory/domains.ts';
import type { BehavioralSignal } from './types.ts';

/**
 * Behavioral Habit Inference (Phase 2) — signal allowlist + read-time normalizer + cursor.
 * Design ref: docs/design/2026-06-17-behavioral-habit-inference-design.md §3.
 *
 * The event stream is ~1.5–4k captured sessions/day plus all integration ticks — the
 * engine must NEVER scan the whole firehose. Selection is by (1) this closed
 * BEHAVIORAL_SIGNAL_KINDS allowlist and (2) an incremental cursor (event-id based,
 * mirroring the biographer's resume cursor).
 *
 * Kind strings were confirmed against the live integrations
 * (user-data/extensions/integrations/<name>/index.ts) and the integration runtime's
 * `<integration>.<payload.kind>` normalization (system/integrations/_runtime/context.ts).
 */

/**
 * The closed allowlist of event `kind` strings that count as behavioral signals.
 * Anything outside this set is ignored — a novel dev/transient kind is excluded by
 * absence (same allowlist discipline as PERSONAL_DOMAINS).
 *
 * Spotify is intentionally ABSENT: the spotify integration writes reference flatfiles
 * under content/knowledge/music/, NOT `events` rows, so there is no spotify.* kind to
 * allowlist. If Spotify ever begins emitting events, add its kind here.
 */
export const BEHAVIORAL_SIGNAL_KINDS = [
  // Financial transactions / purchases (lunch_money integration).
  'lunch_money.transaction',
  // Lightroom Classic photography cadence (lrc integration — only emits this kind).
  'lrc.catalog_summary',
  // Letterboxd film diary (letterboxd integration).
  'letterboxd.letterboxd_diary',
  // Whoop health aggregates (whoop integration).
  'whoop.recovery',
  'whoop.sleep',
  'whoop.workout',
  'whoop.cycle',
  // Recommendation→Action Loop (Phase 1): emitted by the recommendation-link.run linker
  // when an open recommendation is detected as acted-on. This is KEVIN ACTING on Robin's
  // advice (not Robin's own output — see the design self-capture note), so it feeds the
  // habit engine as a first-class behavioral datum ("acts fast on gear recs").
  'behavior.recommendation_acted',
] as const;

export type BehavioralSignalKind = (typeof BEHAVIORAL_SIGNAL_KINDS)[number];

const SIGNAL_KIND_SET: ReadonlySet<string> = new Set(BEHAVIORAL_SIGNAL_KINDS);

/** True for an exact member of the behavioral-signal allowlist. */
export function isBehavioralSignalKind(kind: string): kind is BehavioralSignalKind {
  return SIGNAL_KIND_SET.has(kind);
}

/**
 * Biographer-extracted session decisions are NOT a separate event kind — they live in
 * the `session.captured` event's `payload.summary.decisions[]` (written in place by
 * the biographer's summary pass). They are still a behavioral signal (an explicit
 * choice Kevin made), so `selectNewSignals` additionally scans summarized sessions and
 * `normalizeSignal` knows how to lift decisions out of that payload.
 *
 * TODO confirm kind: if a future biographer change emits a first-class
 * `biographer.decision` / `session.decision` event, allowlist it above and drop the
 * special-case path.
 */
export const DECISION_SOURCE_KIND = 'session.captured';

/**
 * The event kind the Recommendation→Action Loop linker emits when an open recommendation
 * is detected as acted-on (Phase 1). It IS allowlisted in BEHAVIORAL_SIGNAL_KINDS, but it
 * is normalized specially (its domain is carried in the payload, not a fixed per-kind
 * domain), so `normalizeSignal` branches on this constant before the generic path.
 */
export const RECOMMENDATION_ACTED_KIND = 'behavior.recommendation_acted';

/** Map each allowlisted stream kind to its primary PERSONAL_DOMAIN + action verb. */
const KIND_DOMAIN: Record<string, { domain: PersonalDomain; action: string }> = {
  'lunch_money.transaction': { domain: 'finance', action: 'purchase' },
  'lrc.catalog_summary': { domain: 'creative', action: 'shoot' },
  'letterboxd.letterboxd_diary': { domain: 'creative', action: 'watch' },
  'whoop.recovery': { domain: 'health', action: 'recovery' },
  'whoop.sleep': { domain: 'health', action: 'sleep' },
  'whoop.workout': { domain: 'health', action: 'workout' },
  'whoop.cycle': { domain: 'health', action: 'cycle' },
};

/** The raw event-row shape `normalizeSignal` consumes (a subset of the `events` row). */
export interface EventRow {
  id: number;
  kind: string;
  ts: string;
  actor: string | null;
  /** The `events.payload` column — a JSON string, or already-parsed object. */
  payload: string | Record<string, unknown> | null;
}

/** The actor we attribute behavioral signals to. Robin's own outputs are excluded (§11). */
const USER_ACTOR = 'user';

function parsePayload(payload: EventRow['payload']): Record<string, unknown> {
  if (payload == null) return {};
  if (typeof payload === 'object') return payload as Record<string, unknown>;
  try {
    const parsed = JSON.parse(payload);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Best-effort string lift of a likely "object" field (merchant/title/subject). */
function pickObject(payload: Record<string, unknown>): string {
  for (const key of ['merchant', 'payee', 'title', 'name', 'subject', 'object']) {
    const v = payload[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

/**
 * Map an event row to a normalized BehavioralSignal, or `null` if it is not a
 * behavioral signal (kind not allowlisted and not a decision-bearing session). For a
 * `session.captured` row this returns the FIRST extracted decision as a signal; callers
 * that need every decision should expand `payload.summary.decisions[]` themselves —
 * `selectNewSignals` already does, emitting one signal per decision.
 */
export function normalizeSignal(row: EventRow): BehavioralSignal | null {
  const payload = parsePayload(row.payload);

  // Recommendation→Action Loop (Phase 1): the linker emits this with an explicit
  // {subject, domain, verdict, lagDays} payload, so its domain is carried per-event (not
  // a fixed per-kind domain like the integration streams). object = the recommendation's
  // subject; the habit engine treats this as Kevin acting on a recommendation.
  if (row.kind === RECOMMENDATION_ACTED_KIND) {
    const domain = typeof payload.domain === 'string' ? payload.domain : undefined;
    return {
      actor: USER_ACTOR,
      action: 'act_on_recommendation',
      object: typeof payload.subject === 'string' ? payload.subject.trim() : '',
      domain: isPersonalDomain(domain) ? domain : 'preferences',
      ts: row.ts,
      context: payload,
      sourceEventId: row.id,
      sourceKind: row.kind,
    };
  }

  // Allowlisted integration stream.
  if (isBehavioralSignalKind(row.kind)) {
    const meta = KIND_DOMAIN[row.kind];
    return {
      actor: USER_ACTOR,
      action: meta.action,
      object: pickObject(payload),
      domain: meta.domain,
      ts: row.ts,
      context: payload,
      sourceEventId: row.id,
      sourceKind: row.kind,
    };
  }

  // Biographer-extracted session decision (lives in the session payload).
  if (row.kind === DECISION_SOURCE_KIND) {
    const decisions = extractDecisions(payload);
    const first = decisions[0];
    if (!first) return null;
    return decisionToSignal(row, first);
  }

  return null;
}

interface SessionDecision {
  choice: string;
  reasoning: string;
}

/** Lift `payload.summary.decisions[]` (the biographer's session-summary output). */
function extractDecisions(payload: Record<string, unknown>): SessionDecision[] {
  const summary = payload.summary;
  if (!summary || typeof summary !== 'object') return [];
  const decisions = (summary as Record<string, unknown>).decisions;
  if (!Array.isArray(decisions)) return [];
  const out: SessionDecision[] = [];
  for (const d of decisions) {
    if (d && typeof d === 'object') {
      const choice = (d as Record<string, unknown>).choice;
      const reasoning = (d as Record<string, unknown>).reasoning;
      if (typeof choice === 'string' && choice.trim()) {
        out.push({
          choice: choice.trim(),
          reasoning: typeof reasoning === 'string' ? reasoning : '',
        });
      }
    }
  }
  return out;
}

function decisionToSignal(row: EventRow, decision: SessionDecision): BehavioralSignal {
  // Session decisions land in `preferences` — they describe how/what Kevin chooses.
  const domain: PersonalDomain = isPersonalDomain('preferences') ? 'preferences' : 'directives';
  return {
    actor: USER_ACTOR,
    action: 'decide',
    object: decision.choice,
    domain,
    ts: row.ts,
    context: { reasoning: decision.reasoning },
    sourceEventId: row.id,
    sourceKind: row.kind,
  };
}

/**
 * Pull new behavioral signals after `cursor` (an event id; pass 0 for cold start),
 * up to `limit` signals. Mirrors the biographer's event-id cursor: rows are selected
 * `WHERE id > cursor` and returned oldest-first so the caller advances the cursor
 * monotonically to the highest event id seen.
 *
 * Returns the normalized signals AND the new cursor (the max event id scanned, so the
 * caller never re-scans). A `session.captured` row may yield MULTIPLE signals (one per
 * extracted decision); the `limit` bounds the number of returned *signals*, but the
 * cursor still advances past the fully-consumed source rows.
 */
export function selectNewSignals(
  db: RobinDb,
  cursor: number,
  limit: number,
): { signals: BehavioralSignal[]; cursor: number } {
  // Allowlisted stream kinds + decision-bearing summarized sessions. We over-select
  // source ROWS (limit*2, capped) because one session row can expand to several
  // decision signals, then bound the emitted signals to `limit`.
  const kinds = [...BEHAVIORAL_SIGNAL_KINDS, DECISION_SOURCE_KIND];
  const placeholders = kinds.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `SELECT id, kind, ts, actor, payload
         FROM events
        WHERE id > ? AND kind IN (${placeholders})
        ORDER BY id ASC
        LIMIT ?`,
    )
    .all(cursor, ...kinds, Math.max(1, limit) * 2) as EventRow[];

  const signals: BehavioralSignal[] = [];
  let newCursor = cursor;
  for (const row of rows) {
    if (signals.length >= limit) break;
    newCursor = Math.max(newCursor, row.id);
    const payload = parsePayload(row.payload);
    if (row.kind === DECISION_SOURCE_KIND) {
      for (const decision of extractDecisions(payload)) {
        if (signals.length >= limit) break;
        signals.push(decisionToSignal(row, decision));
      }
    } else {
      const sig = normalizeSignal(row);
      if (sig) signals.push(sig);
    }
  }
  return { signals, cursor: newCursor };
}
