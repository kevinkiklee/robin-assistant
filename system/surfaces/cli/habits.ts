import { listHabits } from '../../brain/cognition/behavior/habits-store.ts';
import type { Habit, HabitStatus } from '../../brain/cognition/behavior/types.ts';
import type { RobinDb } from '../../brain/memory/db.ts';
import { closeDb, openDb } from '../../brain/memory/db.ts';
import { allMigrations, applyMigrations } from '../../brain/memory/migrations/index.ts';
import { dbFilePath, resolveUserDataDir } from '../../lib/paths.ts';

/**
 * `robin habits` — a read-only view onto the inferred-habits store (Phase 2). Renders
 * the habits the weekly behavioral synthesis has accumulated, so Kevin can SEE what the
 * engine believes about his tendencies. By default shows `soft` + `graduated` (the
 * live, rendered patterns); `--all` adds `retired`; `--status=<s>` pins one status.
 */

const STATUSES: readonly HabitStatus[] = ['soft', 'graduated', 'retired'];

export interface HabitsCliOptions {
  /** Include `retired` habits (otherwise only soft + graduated). */
  all?: boolean;
  /** Pin to a single lifecycle status (overrides `all`). */
  status?: HabitStatus;
}

/** Compact age string from a SQLite `YYYY-MM-DD HH:MM:SS` (UTC) timestamp. */
function ageOf(ts: string): string {
  // SQLite stores space-separated UTC; append Z so Date parses it as UTC.
  const then = Date.parse(`${ts.replace(' ', 'T')}Z`);
  if (Number.isNaN(then)) return '?';
  const secs = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/**
 * Select the habits to render given the options. `--status` pins one status; otherwise
 * `--all` includes every status and the default keeps soft + graduated. Always sorted
 * by confidence desc (then most-recently-reinforced) so the strongest patterns lead.
 */
export function selectHabits(db: RobinDb, opts: HabitsCliOptions = {}): Habit[] {
  const statuses: HabitStatus[] = opts.status
    ? [opts.status]
    : opts.all
      ? [...STATUSES]
      : ['soft', 'graduated'];
  const habits = statuses.flatMap((s) => listHabits(db, s));
  return habits.sort(
    (a, b) => b.confidence - a.confidence || b.lastReinforced.localeCompare(a.lastReinforced),
  );
}

/**
 * Render the habits view as a readable block: a summary header (counts by status) then
 * one line per habit sorted by confidence desc. Pure — takes a `db`, returns a string.
 */
export function habitsText(db: RobinDb, opts: HabitsCliOptions = {}): string {
  const habits = selectHabits(db, opts);
  if (habits.length === 0) {
    return 'No habits inferred yet — the weekly synthesis runs Sunday 5am.';
  }

  const byStatus = new Map<HabitStatus, number>();
  for (const h of habits) byStatus.set(h.status, (byStatus.get(h.status) ?? 0) + 1);
  const summary = STATUSES.filter((s) => byStatus.has(s))
    .map((s) => `${byStatus.get(s)} ${s}`)
    .join(', ');

  const lines = habits.map((h) => {
    const conf = h.confidence.toFixed(2);
    const support = `${h.supportCount}/${h.supportStreams}str`;
    return `  ${h.status.padEnd(9)} conf=${conf}  support=${support}  [${h.domain}/${h.patternKind}]  ${h.statement}  (reinforced ${ageOf(h.lastReinforced)} ago)`;
  });

  return [`Inferred habits (${habits.length}: ${summary}):`, ...lines].join('\n');
}

/** `robin habits [--all] [--status=<s>]` — IO/exit wrapper over `habitsText`. */
export async function runHabitsCli(argv: string[]): Promise<void> {
  const statusFlag = argv.find((a) => a.startsWith('--status='))?.slice('--status='.length);
  const status =
    statusFlag === 'soft' || statusFlag === 'graduated' || statusFlag === 'retired'
      ? statusFlag
      : undefined;
  if (statusFlag && !status) {
    console.error(`usage: robin habits [--all] [--status=soft|graduated|retired]`);
    process.exit(2);
  }
  const opts: HabitsCliOptions = {
    all: argv.includes('--all'),
    ...(status ? { status } : {}),
  };

  const userData = resolveUserDataDir();
  const db = openDb(dbFilePath(userData));
  applyMigrations(db, allMigrations);
  try {
    console.log(habitsText(db, opts));
  } finally {
    closeDb(db);
  }
}
