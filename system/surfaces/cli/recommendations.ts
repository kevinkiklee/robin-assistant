import {
  isHoldVerdict,
  listOpenRecommendations,
  listRecommendations,
  subjectsOverlap,
  supersedeRecommendation,
} from '../../brain/cognition/recommendations/store.ts';
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
 * plus the acted-rate calibration, so the operator can SEE which of Robin's advice lands. By
 * default lists every rec; `--status=<s>` filters.
 *
 * `robin recommendations dedupe [--apply]` — one-time cleanup: supersede duplicate OPEN
 * recs (overlapping subjects), keeping the newest of each group. Dry-run by default.
 */

const STATUSES: readonly RecommendationStatus[] = [
  'open',
  'acted',
  'declined',
  'expired',
  'superseded',
  'held',
  'suppressed',
];

export interface RecommendationsCliOptions {
  /** Pin to a single lifecycle status (default: all). */
  status?: RecommendationStatus;
}

/**
 * The calibration summary over a ledger. The acted-rate covers ACT-type advice only
 * (buy/try/other/no verdict): resolved = acted + expired + declined; `actedRate` =
 * acted / resolved (null when none resolved); `byDomain` carries per-domain
 * acted-vs-resolved counts, sorted by resolved desc then domain name.
 *
 * Hold-type advice (skip/avoid/wait) is excluded from that denominator (audit
 * 2026-10-02): following it means NOT acting, so counting it there made good "don't buy"
 * advice read as advice that didn't land. It gets its own tally — `held` (window passed,
 * nothing contrary), `contrary` (declined: the operator did it anyway), `lapsed` (expired under
 * the pre-2026-10 rule, before `held` existed). `superseded`/`suppressed` are in neither.
 *
 * NOTE: dream.ts §e1 still computes the old all-verdict rate; the two diverge by the
 * hold-type recs until dream adopts this function.
 */
export interface RecommendationsCalibration {
  /** Every open rec (act- and hold-type). */
  open: number;
  acted: number;
  expired: number;
  declined: number;
  /** acted / (acted + expired + declined) over act-type recs; null when none resolved. */
  actedRate: number | null;
  byDomain: Array<{ domain: string; acted: number; resolved: number }>;
  /** Hold-type (skip/avoid/wait) outcomes — never in the acted-rate. */
  hold: { held: number; contrary: number; lapsed: number; open: number };
  /** Recs logged past the per-session daily cap. */
  suppressed: number;
}

/** Compute the calibration over a list of recommendations. */
export function calibrate(recs: Recommendation[]): RecommendationsCalibration {
  let open = 0;
  let acted = 0;
  let expired = 0;
  let declined = 0;
  let suppressed = 0;
  const hold = { held: 0, contrary: 0, lapsed: 0, open: 0 };
  // Per-domain acted-vs-resolved tally (only domains with ≥1 resolved rec are emitted).
  const domainTally = new Map<string, { acted: number; resolved: number }>();
  for (const r of recs) {
    if (r.status === 'open') open += 1;
    if (r.status === 'suppressed') suppressed += 1;
    if (isHoldVerdict(r.verdict)) {
      if (r.status === 'held') hold.held += 1;
      else if (r.status === 'declined') hold.contrary += 1;
      else if (r.status === 'expired') hold.lapsed += 1;
      else if (r.status === 'open') hold.open += 1;
      continue;
    }
    if (r.status === 'acted') acted += 1;
    else if (r.status === 'expired') expired += 1;
    else if (r.status === 'declined') declined += 1;
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
    hold,
    suppressed,
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
  const h = cal.hold;
  if (h.held + h.contrary + h.lapsed + h.open > 0) {
    lines.push(
      `  skip/avoid/wait (not in acted-rate): held ${h.held}, contrary ${h.contrary}, lapsed ${h.lapsed}, open ${h.open}`,
    );
  }
  if (cal.suppressed > 0) lines.push(`  suppressed (over session cap): ${cal.suppressed}`);

  return lines.join('\n');
}

/** One duplicate group: the newest open rec survives, the rest get superseded. */
export interface DedupeGroup {
  keep: Recommendation;
  supersede: Recommendation[];
}

/**
 * Group OPEN recs whose subjects overlap (`subjectsOverlap`: normalized-equal, or one
 * contains the other as a ≥2-token run) — transitively, via union-find — and pick the
 * newest of each group as the survivor. Pure over the given list.
 */
export function planDedupe(open: Recommendation[]): DedupeGroup[] {
  // Newest first, so the group root (first member seen) is the survivor.
  const recs = [...open].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id - a.id);
  const parent = recs.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  for (let i = 0; i < recs.length; i++) {
    for (let j = i + 1; j < recs.length; j++) {
      if (!subjectsOverlap(recs[i].subject, recs[j].subject)) continue;
      const a = find(i);
      const b = find(j);
      if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
    }
  }
  const groups = new Map<number, Recommendation[]>();
  recs.forEach((r, i) => {
    const root = find(i);
    const g = groups.get(root) ?? [];
    g.push(r);
    groups.set(root, g);
  });
  return [...groups.values()]
    .filter((g) => g.length > 1)
    .map(([keep, ...rest]) => ({ keep, supersede: rest }));
}

/**
 * `recommendations dedupe` — plan (and with `apply`, execute) the open-rec dedupe.
 * Returns the report text. Applying supersedes each duplicate with the group's newest rec.
 */
export function dedupeText(db: RobinDb, opts: { apply?: boolean } = {}): string {
  const groups = planDedupe(listOpenRecommendations(db));
  if (groups.length === 0) return 'No duplicate open recommendations.';
  const total = groups.reduce((n, g) => n + g.supersede.length, 0);
  const lines: string[] = [
    `${groups.length} duplicate group(s); ${total} open rec(s) ${opts.apply ? 'superseded' : 'would be superseded'}:`,
  ];
  for (const g of groups) {
    lines.push(`  keep #${g.keep.id} ${g.keep.verdict ?? '—'} "${g.keep.subject}"`);
    for (const r of g.supersede) {
      lines.push(
        `    ${opts.apply ? '-' : '~'} #${r.id} ${r.verdict ?? '—'} "${r.subject}" (${dateOf(r.createdAt)})`,
      );
      if (opts.apply) supersedeRecommendation(db, r.id, g.keep.id, 'dedupe: overlapping subject');
    }
  }
  if (!opts.apply) lines.push('', 'Dry run — re-run with --apply to supersede.');
  return lines.join('\n');
}

/** `robin recommendations [--status=<s>] | dedupe [--apply]` — IO/exit wrapper. */
export async function runRecommendationsCli(argv: string[]): Promise<void> {
  if (argv[0] === 'dedupe') {
    const apply = argv.includes('--apply');
    const userData = resolveUserDataDir();
    const db = openDb(dbFilePath(userData));
    applyMigrations(db, allMigrations);
    try {
      console.log(dedupeText(db, { apply }));
    } finally {
      closeDb(db);
    }
    return;
  }
  const statusFlag = argv.find((a) => a.startsWith('--status='))?.slice('--status='.length);
  const status = STATUSES.includes(statusFlag as RecommendationStatus)
    ? (statusFlag as RecommendationStatus)
    : undefined;
  if (statusFlag && !status) {
    console.error(
      `usage: robin recommendations [--status=${STATUSES.join('|')}] | dedupe [--apply]`,
    );
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
