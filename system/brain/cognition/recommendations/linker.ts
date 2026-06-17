import type { RobinDb } from '../../memory/db.ts';
import { ingest } from '../../memory/ingest.ts';
import { RECOMMENDATION_ACTED_KIND, selectNewSignals } from '../behavior/signals.ts';
import { getLinkCursor, setLinkCursor } from './cursor.ts';
import {
  expireRecommendation,
  listOpenRecommendations,
  resolveRecommendation,
  subjectMatches,
} from './store.ts';
import type { Recommendation } from './types.ts';

/**
 * Recommendation→Action Loop (Phase 1) — the retroactive linker (`recommendation-link.run`).
 * Design ref: docs/design/2026-06-17-recommendation-loop-design.md §5.
 *
 * A nightly, deterministic (NO LLM) cognition job that closes the loop without requiring
 * Robin to have logged every recommendation perfectly:
 *  1. Load `open` recommendations.
 *  2. Pull recent behavioral signals (Phase 2's BEHAVIORAL_SIGNAL_KINDS + selectNewSignals,
 *     own cursor; linkWindowDays bounds how far back it scans).
 *  3. High-precision subject match (`subjectMatches`): a signal whose `object` canonically
 *     matches a rec's `subject` resolves it → status=acted, outcome=acted, acted_at,
 *     action_event_id, evidence. No fuzzy matching.
 *  4. Expiry: `open` recs past `expires_at` (or older than defaultExpiryDays when no
 *     explicit expiry) → status=expired, outcome=not_acted.
 *  5. Feed Phase 2: each newly-acted rec emits ONE `behavior.recommendation_acted` event
 *     (subject, domain, verdict, lagDays) so the habit engine can generalize.
 */

/** How many behavioral signals to pull per linker pass. The firehose is bounded by the
 * incremental cursor + the BEHAVIORAL_SIGNAL_KINDS allowlist, so a generous batch is
 * cheap; this caps a single pass's working set. */
const SIGNAL_SCAN_LIMIT = 1000;

const DEFAULT_LINK_WINDOW_DAYS = 60;
const DEFAULT_EXPIRY_DAYS = 90;

const MS_PER_DAY = 86_400_000;

/**
 * The linker's OWN output and the recommendation-provenance kind. A
 * `behavior.recommendation_acted` event is Robin recording that Kevin acted — it is NOT a
 * fresh action signal, so re-matching it would let the loop resolve a rec against its own
 * fulfillment record (double-count / self-feed). `memory.recommendation` is where the rec
 * itself was logged (Robin's own output). Neither is a genuine action signal, so both are
 * excluded from the match candidates regardless of the allowlist.
 */
const PROVENANCE_KINDS: ReadonlySet<string> = new Set([
  RECOMMENDATION_ACTED_KIND,
  'memory.recommendation',
]);

export interface RecommendationLinkerOptions {
  /** Resolved `recommendations.enabled` policy (default true). */
  enabled?: boolean;
  /** How far back the linker scans behavioral signals, in days (default 60). */
  linkWindowDays?: number;
  /** Default expiry for recs with no explicit `expires_at`, in days (default 90). */
  defaultExpiryDays?: number;
  /** Injectable reference time for deterministic tests. */
  now?: Date;
}

export interface RecommendationLinkerResult {
  /** Open recommendations resolved to `acted` by a matching signal this pass. */
  linked: number;
  /** Open recommendations resolved to `expired` (past expiry) this pass. */
  expired: number;
  /** `behavior.recommendation_acted` events emitted this pass (one per newly-acted rec). */
  emitted: number;
  /** True when the linker was disabled (recommendations.enabled = false) and did nothing. */
  skipped: boolean;
}

/**
 * Parse a stored timestamp to epoch ms. Event `ts` is an ISO string (`…T…Z`); the
 * `recommendations` columns are SQLite-utc (`YYYY-MM-DD HH:MM:SS`, no zone). Treat the
 * SQLite form as UTC by normalizing the space separator and appending `Z` so both forms
 * compare apples-to-apples; returns NaN for an unparseable value.
 */
function parseTs(ts: string): number {
  const iso = ts.includes('T') || ts.endsWith('Z') ? ts : `${ts.replace(' ', 'T')}Z`;
  return new Date(iso).getTime();
}

/**
 * Run one retroactive-linker pass (§5). Honors the `enabled` kill-switch, then:
 * pulls signals after the persisted cursor, filters to genuine in-window action signals,
 * resolves matching open recs to `acted` (emitting one `behavior.recommendation_acted`
 * event each), expires past-expiry open recs, and advances the cursor.
 *
 * @param opts.enabled           Resolved `recommendations.enabled` policy (default true).
 * @param opts.linkWindowDays    Signal scan window in days (default 60).
 * @param opts.defaultExpiryDays Default rec expiry in days (default 90).
 * @param opts.now               Injectable reference time for deterministic tests.
 */
export async function runRecommendationLinker(
  db: RobinDb,
  opts: RecommendationLinkerOptions = {},
): Promise<RecommendationLinkerResult> {
  const enabled = opts.enabled ?? true;
  if (!enabled) {
    return { linked: 0, expired: 0, emitted: 0, skipped: true };
  }

  const now = opts.now ?? new Date();
  const nowMs = now.getTime();
  const linkWindowDays = opts.linkWindowDays ?? DEFAULT_LINK_WINDOW_DAYS;
  const defaultExpiryDays = opts.defaultExpiryDays ?? DEFAULT_EXPIRY_DAYS;
  const windowStartMs = nowMs - linkWindowDays * MS_PER_DAY;

  // 2. Pull recent behavioral signals after the persisted cursor, then keep only genuine
  // in-window action signals: drop the linker's own provenance kinds (so an emitted
  // `recommendation_acted` event is never re-matched), drop objectless signals, and drop
  // anything older than the link window.
  const cursorBefore = getLinkCursor(db);
  const { signals, cursor } = selectNewSignals(db, cursorBefore, SIGNAL_SCAN_LIMIT);
  const candidates = signals.filter(
    (s) =>
      !PROVENANCE_KINDS.has(s.sourceKind) &&
      s.object.trim().length > 0 &&
      parseTs(s.ts) >= windowStartMs,
  );

  // 3. High-precision subject match. First in-window matching signal wins; an open rec is
  // resolved at most once per pass and removed from the working set so two signals can't
  // double-resolve it.
  let linked = 0;
  let emitted = 0;
  const open = listOpenRecommendations(db);
  const resolved = new Set<number>();

  for (const rec of open) {
    const match = candidates.find((s) => subjectMatches(rec.subject, s.object));
    if (!match) continue;

    const lagDays = Math.max(0, (parseTs(match.ts) - parseTs(rec.createdAt)) / MS_PER_DAY);
    // 5. Feed Phase 2: emit ONE behavior.recommendation_acted event for this rec.
    const { eventId } = ingest(db, null, {
      kind: RECOMMENDATION_ACTED_KIND,
      source: 'recommendation-linker',
      payload: {
        subject: rec.subject,
        domain: rec.domain,
        verdict: rec.verdict,
        lagDays,
      },
    });
    resolveRecommendation(db, rec.id, {
      status: 'acted',
      outcome: 'acted',
      actedAt: match.ts,
      actionEventId: eventId,
      evidence: `matched signal #${match.sourceEventId} "${match.object}"`,
    });
    resolved.add(rec.id);
    linked += 1;
    emitted += 1;
  }

  // 4. Expiry: still-open recs whose effective expiry (`expires_at`, else
  // created_at + defaultExpiryDays) is before `now`.
  let expired = 0;
  for (const rec of open) {
    if (resolved.has(rec.id)) continue;
    const expiryMs = effectiveExpiryMs(rec, defaultExpiryDays);
    if (expiryMs != null && expiryMs < nowMs) {
      expireRecommendation(db, rec.id, now);
      expired += 1;
    }
  }

  // Advance + persist the cursor so the next pass never re-scans these rows. selectNewSignals
  // returns the max event id it scanned (≥ the prior cursor), so this is monotonic; emitted
  // recommendation_acted events sit ABOVE this cursor and are excluded next pass.
  setLinkCursor(db, cursor);

  return { linked, expired, emitted, skipped: false };
}

/**
 * The recommendation's effective expiry as epoch ms: its explicit `expiresAt` if set,
 * else `createdAt + defaultExpiryDays`. Returns null only when neither yields a parseable
 * instant (a malformed row is left open rather than force-expired).
 */
function effectiveExpiryMs(rec: Recommendation, defaultExpiryDays: number): number | null {
  if (rec.expiresAt) {
    const ms = parseTs(rec.expiresAt);
    return Number.isNaN(ms) ? null : ms;
  }
  const created = parseTs(rec.createdAt);
  if (Number.isNaN(created)) return null;
  return created + defaultExpiryDays * MS_PER_DAY;
}
