import { listRecommendations } from '../../brain/cognition/recommendations/store.ts';
import type {
  Recommendation,
  RecommendationStatus,
} from '../../brain/cognition/recommendations/types.ts';
import type { RobinDb } from '../../brain/memory/db.ts';
import { closeDb, openDb } from '../../brain/memory/db.ts';
import { allMigrations, applyMigrations } from '../../brain/memory/migrations/index.ts';
import { dbFilePath, resolveUserDataDir } from '../../lib/paths.ts';

/**
 * `robin recommendations` — a read-only view onto the recommendation ledger (Phase 1)
 * plus the same acted-rate calibration the learning-digest renders, so Kevin can SEE
 * which of Robin's advice lands. By default lists every rec; `--status=<s>` filters.
 */

const STATUSES: readonly RecommendationStatus[] = [
  'open',
  'acted',
  'declined',
  'expired',
  'superseded',
];

export interface RecommendationsCliOptions {
  /** Pin to a single lifecycle status (default: all). */
  status?: RecommendationStatus;
}

/**
 * The calibration summary over a ledger, computed IDENTICALLY to dream.ts §e1 (the
 * learning-digest's recommendation block) so the CLI and the digest always agree:
 * resolved = acted + expired + declined; `actedRate` = acted / resolved (null when none
 * resolved); `byDomain` carries per-domain acted-vs-resolved counts, sorted by resolved
 * count desc then domain name. `superseded` is neither open nor resolved — excluded.
 */
export interface RecommendationsCalibration {
  open: number;
  acted: number;
  expired: number;
  declined: number;
  /** acted / (acted + expired + declined); null when none resolved. */
  actedRate: number | null;
  byDomain: Array<{ domain: string; acted: number; resolved: number }>;
}

/** Compute the acted-rate calibration over a list of recommendations (digest §e1 logic). */
export function calibrate(recs: Recommendation[]): RecommendationsCalibration {
  let open = 0;
  let acted = 0;
  let expired = 0;
  let declined = 0;
  // Per-domain acted-vs-resolved tally (only domains with ≥1 resolved rec are emitted).
  const domainTally = new Map<string, { acted: number; resolved: number }>();
  for (const r of recs) {
    switch (r.status) {
      case 'open':
        open += 1;
        break;
      case 'acted':
        acted += 1;
        break;
      case 'expired':
        expired += 1;
        break;
      case 'declined':
        declined += 1;
        break;
      // 'superseded' is neither open nor a resolved outcome — excluded from rates.
    }
    // Resolved = a terminal acted/expired/declined outcome (the calibration denominator).
    const isActed = r.status === 'acted';
    const isResolved = isActed || r.status === 'expired' || r.status === 'declined';
    if (isResolved) {
      const slot = domainTally.get(r.domain) ?? { acted: 0, resolved: 0 };
      slot.resolved += 1;
      if (isActed) slot.acted += 1;
      domainTally.set(r.domain, slot);
    }
  }
  const resolvedTotal = acted + expired + declined;
  const byDomain = [...domainTally.entries()]
    .map(([domain, t]) => ({ domain, acted: t.acted, resolved: t.resolved }))
    .sort((a, b) => b.resolved - a.resolved || a.domain.localeCompare(b.domain));
  return {
    open,
    acted,
    expired,
    declined,
    actedRate: resolvedTotal > 0 ? acted / resolvedTotal : null,
    byDomain,
  };
}

/** Just the date portion of a SQLite/ISO timestamp, or '—' when null. */
function dateOf(ts: string | null): string {
  if (!ts) return '—';
  return ts.replace('T', ' ').slice(0, 10);
}

/**
 * Render the recommendations view: one line per rec (status, outcome, verdict, domain,
 * confidence, subject, created/acted dates), then the calibration summary (overall
 * acted-rate + by-domain). Pure — takes a `db`, returns a string.
 */
export function recommendationsText(db: RobinDb, opts: RecommendationsCliOptions = {}): string {
  // The ledger view honors --status; calibration always reflects the WHOLE ledger so the
  // acted-rate matches the digest (which never filters) regardless of the listing filter.
  const filtered = listRecommendations(db, opts.status ? { status: opts.status } : {});
  const all = opts.status ? listRecommendations(db) : filtered;

  if (all.length === 0) {
    return 'No recommendations recorded yet — Robin logs them as it advises you.';
  }

  const lines: string[] = [];
  if (filtered.length === 0) {
    lines.push(`No ${opts.status} recommendations.`);
  } else {
    const header = opts.status
      ? `${opts.status} recommendations (${filtered.length}):`
      : `Recommendations (${filtered.length}):`;
    lines.push(header);
    for (const r of filtered) {
      const conf = r.confidence.toFixed(2);
      const outcome = r.outcome ?? '—';
      const verdict = r.verdict ?? '—';
      const dates = `created ${dateOf(r.createdAt)}${r.actedAt ? `, acted ${dateOf(r.actedAt)}` : ''}`;
      lines.push(
        `  #${r.id}  ${r.status.padEnd(10)} outcome=${outcome.padEnd(9)} verdict=${verdict.padEnd(5)} [${r.domain}] conf=${conf}  ${r.subject}  (${dates})`,
      );
    }
  }

  // Calibration summary (digest §e1) — overall acted-rate then top domains by resolved.
  const cal = calibrate(all);
  const resolved = cal.acted + cal.expired + cal.declined;
  const pctStr = cal.actedRate != null ? ` (${Math.round(cal.actedRate * 100)}%)` : '';
  lines.push('', 'Calibration:');
  lines.push(
    `  ${cal.acted}/${resolved} acted${pctStr}  (open ${cal.open}, expired ${cal.expired}, declined ${cal.declined})`,
  );
  if (cal.byDomain.length > 0) {
    const topDomains = cal.byDomain
      .slice(0, 3)
      .map((d) => `${d.domain} ${d.acted}/${d.resolved}`)
      .join(', ');
    lines.push(`  top domains: ${topDomains}`);
  }

  return lines.join('\n');
}

/** `robin recommendations [--status=<s>]` — IO/exit wrapper over `recommendationsText`. */
export async function runRecommendationsCli(argv: string[]): Promise<void> {
  const statusFlag = argv.find((a) => a.startsWith('--status='))?.slice('--status='.length);
  const status = STATUSES.includes(statusFlag as RecommendationStatus)
    ? (statusFlag as RecommendationStatus)
    : undefined;
  if (statusFlag && !status) {
    console.error(`usage: robin recommendations [--status=${STATUSES.join('|')}]`);
    process.exit(2);
  }
  const opts: RecommendationsCliOptions = { ...(status ? { status } : {}) };

  const userData = resolveUserDataDir();
  const db = openDb(dbFilePath(userData));
  applyMigrations(db, allMigrations);
  try {
    console.log(recommendationsText(db, opts));
  } finally {
    closeDb(db);
  }
}
