import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { buildDoctorInvariants } from '../../kernel/invariants/doctor-set.ts';
import { readBootEntries } from '../../kernel/runtime/boot-classification.ts';
import { currentSha, isRepairBroken } from '../../kernel/runtime/repair-breaker.ts';
import { getNextRunAt, isCronPayload } from '../../kernel/scheduler/cron.ts';
import type { LandLogEntry } from '../../lib/land-log.ts';
import { resolveUserDataDir } from '../../lib/paths.ts';
import type { RobinDb } from '../memory/db.ts';

/**
 * Nightly reliability audit (reliability spec step 4): judges whether the
 * self-healing shipped in steps 1-3 — the alerts incident ladder (migration
 * 036, health-monitor.ts), the repair breaker (repair-breaker.ts), the
 * doctor-set fix map (doctor-set.ts) — actually worked over the trailing
 * day/week, and writes one date-stamped artifact the morning brief renders.
 *
 * Read-only except for the ONE mutation the contract calls for: stamping
 * outcome='recurred' on an alert row this run discovers reopened shortly
 * after being credited 'repaired'.
 */
export interface ReliabilityArtifact {
  date: string; // 'YYYY-MM-DD' local — renderer accepts only date === today
  generatedAt: string; // ISO
  healed: Array<{ key: string; source: string; closedAt: string; via: 'repair' | 'unknown' }>;
  recurred: Array<{ key: string; source: string; firstClosedAt: string; reopenedAt: string }>;
  needsHuman: Array<{ key: string; source: string; since: string; ageDays: number; fix: string }>;
  silent: {
    missedCrons: Array<{ name: string; expected: number; actual: number }>;
    staleIntegrations: Array<{ name: string; lastOkAt: string | null; ageHours: number }>;
    agentRunsWithoutOutcome: number;
    /** Autonomous runs in the trailing 24h where the SDK auto-compacted the
     *  conversation (agent_usage.compactions > 0, migration 037). The run
     *  reports success, but its output was written from a summary. */
    agentRunsCompacted: number;
  };
  trends: {
    perKey: Array<{
      key: string;
      opened7d: number;
      repaired7d: number;
      recurred7d: number;
      escalated7d: number;
      needsHuman7d: number;
    }>;
    circuitBroken: string[]; // invariant names currently tripped in repair-breaker.json
    flags: string[]; // human-readable degradation flags; empty = quiet
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
/** Iteration cap for walking getNextRunAt across the trailing 24h window — a
 *  malformed sub-minute cron must not spin forever. */
const MAX_CRON_ITERATIONS = 2000;
/** 10% slack applied to a cron's `expected` count when a daemon boot fell
 *  inside the trailing 24h window (spec Q2: keep downtime awareness simple). */
const BOOT_SLACK = 0.9;
/**
 * Grace period trimmed off the END of the missed-cron expected-walk. Without
 * it, a cron whose occurrence just fired (e.g. this very audit's own 4:00am
 * row, still 'pending'/'leased' the instant this handler reads the jobs
 * table) gets demanded to already show a terminal state — a phantom
 * self-flag. 5 minutes comfortably covers normal claim/dispatch latency.
 */
const CRON_GRACE_MS = 5 * 60 * 1000;
/** JSON.stringify(Infinity) → null, which would silently corrupt the on-disk
 *  artifact's `ageHours` field for an integration with no `last_ok_at` ever
 *  recorded. Cap to a large finite sentinel (one year of hours) instead, so
 *  the contract's `ageHours: number` always round-trips through JSON. */
const NEVER_OK_AGE_HOURS = 24 * 365;

/**
 * Local calendar date (YYYY-MM-DD), in the SAME timezone convention the daily
 * brief's own `isoDate()` uses (user-data/extensions/jobs/daily-brief/skeleton.ts:
 * `Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' })`). Deliberately
 * hardcoded — NOT `resolveTz()`/`ROBIN_TZ` — so this artifact's `date` field lines
 * up with the renderer's `date === today` check regardless of the daemon host's
 * configured TZ. Same precedent as `isoDateLocal` in
 * system/integrations/builtin/weather/index.ts.
 */
function localDate(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

/**
 * Format a Date exactly the way SQLite's `datetime('now')` does: space-
 * separated, UTC, no fractional seconds. Alerts/jobs.created_at columns are
 * written with that DB-side function, never `.toISOString()`. Formatting a
 * JS-computed window boundary this way lets it compare directly (as TEXT)
 * against those columns without the T/Z-vs-space mismatch the step-3 gotcha
 * warns about — and keeps every boundary driven by the injected `now`, not
 * SQLite's own (untestable) real clock.
 */
function sqlNow(d: Date): string {
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * Parse a `datetime('now')`-format string (space-separated, UTC, unmarked) as
 * epoch ms. `Date.parse` on an unmarked datetime string reads it as LOCAL
 * time — the same gotcha health-monitor.ts documents for `escalated_at`.
 */
function parseSqlDatetime(s: string): number {
  return Date.parse(`${s.replace(' ', 'T')}Z`);
}

interface RepairedAlertRow {
  id: number;
  source: string;
  key: string;
  resolved_at: string;
  repair_attempted_at: string | null;
}

/**
 * Q1: resolved-in-last-24h rows credited outcome='repaired'. For each, look
 * for a LATER row (open or resolved) sharing (source,key) whose
 * first_seen_at falls in (resolved_at, resolved_at+24h] — a reopen shortly
 * after the repair — and emit it as `recurred` (stamping the original row
 * outcome='recurred', the one write this audit makes). Rows with no such
 * reopen are `healed`. `ORDER BY resolved_at DESC` makes both output arrays
 * deterministic (most-recently-resolved incident first) — healed[0] and
 * recurred[0] are what a renderer would show as "most recent."
 */
function computePrimaryHealedAndRecurred(
  db: RobinDb,
  now: Date,
): { healed: ReliabilityArtifact['healed']; recurred: ReliabilityArtifact['recurred'] } {
  const windowStart = sqlNow(new Date(now.getTime() - DAY_MS));
  const repairedRows = db
    .prepare(
      `SELECT id, source, key, resolved_at, repair_attempted_at
         FROM alerts
        WHERE outcome = 'repaired' AND resolved_at IS NOT NULL AND resolved_at >= ?
        ORDER BY resolved_at DESC`,
    )
    .all(windowStart) as RepairedAlertRow[];

  const healed: ReliabilityArtifact['healed'] = [];
  const recurred: ReliabilityArtifact['recurred'] = [];
  const markRecurred = db.prepare(`UPDATE alerts SET outcome = 'recurred' WHERE id = ?`);

  for (const row of repairedRows) {
    const reopenBy = sqlNow(new Date(parseSqlDatetime(row.resolved_at) + DAY_MS));
    const later = db
      .prepare(
        `SELECT first_seen_at FROM alerts
          WHERE source = ? AND key = ? AND id != ?
            AND first_seen_at > ? AND first_seen_at <= ?
          ORDER BY first_seen_at ASC LIMIT 1`,
      )
      .get(row.source, row.key, row.id, row.resolved_at, reopenBy) as
      | { first_seen_at: string }
      | undefined;

    if (later) {
      recurred.push({
        key: row.key,
        source: row.source,
        firstClosedAt: row.resolved_at,
        reopenedAt: later.first_seen_at,
      });
      markRecurred.run(row.id);
    } else {
      // By construction (resolveAlert's CASE) outcome='repaired' always has
      // repair_attempted_at set — 'unknown' guards a future direct setOutcome
      // caller that skips the ladder.
      healed.push({
        key: row.key,
        source: row.source,
        closedAt: row.resolved_at,
        via: row.repair_attempted_at ? 'repair' : 'unknown',
      });
    }
  }

  return { healed, recurred };
}

/**
 * Q1 continued — mature-window late-recurrence pass (reliability-audit
 * review, 2026-08-11, finding 1). The primary pass above only ever looks at
 * resolves in [now-24h, now], and its reopen search is implicitly bounded by
 * `now`: a reopen that hasn't happened yet at read time simply isn't a row
 * in the DB. Once a row's `resolved_at` ages past the trailing-24h window it
 * is NEVER reconsidered by the primary pass again — even though its
 * 24h-after-resolve reopen window may not have fully elapsed as of the last
 * run that looked at it. Doctor heals land at 4:15, 15 minutes after the
 * 4:00 audit read, so a doctor-cadence recurrence (reopened at *tomorrow's*
 * 4:15 doctor run) falls exactly in that 15-minute gap and was permanently
 * invisible: by the time the row's resolved_at is old enough for its full
 * reopen window to have elapsed, it has already aged out of the primary
 * pass's [now-24h, now] filter.
 *
 * Fix: a second pass over resolves in [now-48h, now-24h) — a window that is
 * always fully matured by `now` (every row in it has `resolved_at + 24h <=
 * now`, so the reopen search below is never racing a read that's too
 * early). Still-'repaired' rows here get one more look; a reopen found
 * within 24h of the ORIGINAL resolved_at is a "late recurrence" — same
 * `recurred[]` shape, same stamp, contract-safe. `outcome = 'repaired'` in
 * the WHERE clause is the idempotency guard: a row already stamped
 * 'recurred' — by the primary pass, or by this pass on a prior day — no
 * longer matches and is never re-examined or double-emitted.
 *
 * A row with no reopen found here is deliberately NOT retried again later:
 * once its mature window closes without a hit, it ages out of
 * [now-48h, now-24h) on the very next run and is gone for good. That's a
 * closed design choice, not a bug — the alternative (an unbounded
 * look-forward) would let a single audit run stamp 'recurred' onto an
 * incident from months ago.
 */
function computeLateRecurrences(db: RobinDb, now: Date): ReliabilityArtifact['recurred'] {
  const matureWindowStart = sqlNow(new Date(now.getTime() - 2 * DAY_MS));
  const matureWindowEnd = sqlNow(new Date(now.getTime() - DAY_MS));
  const repairedRows = db
    .prepare(
      `SELECT id, source, key, resolved_at
         FROM alerts
        WHERE outcome = 'repaired' AND resolved_at IS NOT NULL
          AND resolved_at >= ? AND resolved_at < ?
        ORDER BY resolved_at DESC`,
    )
    .all(matureWindowStart, matureWindowEnd) as Array<{
    id: number;
    source: string;
    key: string;
    resolved_at: string;
  }>;

  const late: ReliabilityArtifact['recurred'] = [];
  const markRecurred = db.prepare(`UPDATE alerts SET outcome = 'recurred' WHERE id = ?`);

  for (const row of repairedRows) {
    const reopenBy = sqlNow(new Date(parseSqlDatetime(row.resolved_at) + DAY_MS));
    const later = db
      .prepare(
        `SELECT first_seen_at FROM alerts
          WHERE source = ? AND key = ? AND id != ?
            AND first_seen_at > ? AND first_seen_at <= ?
          ORDER BY first_seen_at ASC LIMIT 1`,
      )
      .get(row.source, row.key, row.id, row.resolved_at, reopenBy) as
      | { first_seen_at: string }
      | undefined;

    if (later) {
      late.push({
        key: row.key,
        source: row.source,
        firstClosedAt: row.resolved_at,
        reopenedAt: later.first_seen_at,
      });
      markRecurred.run(row.id);
    }
    // No reopen found: leave outcome='repaired' untouched. See doc comment —
    // this row's window is closed for good once it ages out of the mature
    // range on the next run.
  }

  return late;
}

/**
 * Combines the primary (0-24h) and mature (24-48h) recurrence passes. The
 * two source windows are disjoint (`>= now-24h` vs `< now-24h`), so no row
 * can ever be examined by both in the same run; merging is a plain
 * concatenation followed by a re-sort so the combined array keeps the
 * documented "most-recently-resolved first" invariant across both passes.
 */
function computeHealedAndRecurred(
  db: RobinDb,
  now: Date,
): { healed: ReliabilityArtifact['healed']; recurred: ReliabilityArtifact['recurred'] } {
  const { healed, recurred } = computePrimaryHealedAndRecurred(db, now);
  const lateRecurred = computeLateRecurrences(db, now);
  const merged = [...recurred, ...lateRecurred].sort((a, b) =>
    a.firstClosedAt < b.firstClosedAt ? 1 : a.firstClosedAt > b.firstClosedAt ? -1 : 0,
  );
  return { healed, recurred: merged };
}

interface CronSpec {
  cron: string;
  tz?: string;
}

/** True when at least one boots.json entry's `at` falls inside [now-24h, now]. */
function bootFellInWindow(bootsPath: string, now: Date): boolean {
  const windowStartMs = now.getTime() - DAY_MS;
  return readBootEntries(bootsPath).some((entry) => {
    const at = typeof entry === 'string' ? entry : entry.at;
    const ms = Date.parse(at);
    return Number.isFinite(ms) && ms >= windowStartMs && ms <= now.getTime();
  });
}

/**
 * Q2a: for every cron-triggered job name seen in the last 7d, recover its
 * cron expression from any recent row's payload, walk `getNextRunAt` to get
 * `expected`, count completed+errored+LEASED rows in the same window for
 * `actual`, apply the boot-in-window slack, and flag per the contract's
 * missed-cron rule. Only flagged names are returned.
 *
 * Two corrections keep this honest (reliability-audit review, 2026-08-11):
 *  - `actual` counts 'leased' rows too — a job the scheduler has claimed and
 *    is still running (including THIS audit's own row, or a detached
 *    cognition child like dream.run still owning its row past its cadence)
 *    is not a missed job. Without this, the audit could self-flag every
 *    night at 4:00am.
 *  - the expected-walk's END is clamped to `now - CRON_GRACE_MS`, not `now`
 *    — an occurrence that fired moments ago may not even be claimed
 *    ('pending') yet purely from ordinary scheduler latency; it must not be
 *    demanded to already show a terminal/in-flight state.
 *  - the expected-walk's START is clamped to the name's earliest in-window
 *    row, not a blind `now - 24h` — a cron registered a few hours ago (first
 *    ever row inside the lookback) is only expected from that point forward,
 *    not for the full trailing day.
 */
function computeMissedCrons(
  db: RobinDb,
  now: Date,
  hasBootInWindow: boolean,
): ReliabilityArtifact['silent']['missedCrons'] {
  const dayAgo = new Date(now.getTime() - DAY_MS);
  const windowStartIso = dayAgo.toISOString();
  const nowIso = now.toISOString();
  const sevenDaysAgoIso = new Date(now.getTime() - WEEK_MS).toISOString();
  const walkEndMs = now.getTime() - CRON_GRACE_MS;

  const names = db
    .prepare(
      `SELECT DISTINCT name FROM jobs
        WHERE trigger_kind = 'cron' AND scheduled_at >= ? AND scheduled_at <= ?`,
    )
    .all(sevenDaysAgoIso, nowIso) as Array<{ name: string }>;

  const missed: ReliabilityArtifact['silent']['missedCrons'] = [];
  for (const { name } of names) {
    const payloadRows = db
      .prepare(
        `SELECT payload FROM jobs
          WHERE name = ? AND trigger_kind = 'cron' AND payload IS NOT NULL
          ORDER BY id DESC LIMIT 10`,
      )
      .all(name) as Array<{ payload: string }>;

    let cronSpec: CronSpec | undefined;
    for (const { payload } of payloadRows) {
      try {
        const parsed: unknown = JSON.parse(payload);
        if (isCronPayload(parsed)) {
          cronSpec = parsed;
          break;
        }
      } catch {
        // malformed payload on this row — try the next one
      }
    }
    if (!cronSpec) continue; // no recoverable cron expression — nothing to judge

    // Mid-window registration clamp: don't demand a name that first appeared
    // inside the lookback to have been firing since `now - 24h`.
    const earliestRow = db
      .prepare(
        `SELECT MIN(scheduled_at) AS earliest FROM jobs
          WHERE name = ? AND trigger_kind = 'cron' AND scheduled_at >= ? AND scheduled_at <= ?`,
      )
      .get(name, sevenDaysAgoIso, nowIso) as { earliest: string | null };
    let walkStart = dayAgo;
    if (earliestRow.earliest) {
      const earliestMs = Date.parse(earliestRow.earliest);
      if (Number.isFinite(earliestMs) && earliestMs > walkStart.getTime()) {
        walkStart = new Date(earliestMs);
      }
    }

    let expected = 0;
    let cursor = walkStart;
    for (let i = 0; i < MAX_CRON_ITERATIONS; i++) {
      const next = getNextRunAt(cronSpec.cron, cursor, cronSpec.tz);
      if (next.getTime() > walkEndMs) break;
      expected++;
      cursor = next;
    }
    if (hasBootInWindow) expected = Math.floor(expected * BOOT_SLACK);

    const actualRow = db
      .prepare(
        `SELECT COUNT(*) AS c FROM jobs
          WHERE name = ? AND trigger_kind = 'cron' AND state IN ('completed', 'errored', 'leased')
            AND scheduled_at >= ? AND scheduled_at <= ?`,
      )
      .get(name, windowStartIso, nowIso) as { c: number };
    const actual = actualRow.c;

    const flagged = (actual === 0 && expected > 0) || (expected >= 10 && actual < expected * 0.5);
    if (flagged) missed.push({ name, expected, actual });
  }
  return missed;
}

/**
 * Q2b: enabled+scheduled integrations with no successful tick in 24h.
 * "Enabled+scheduled" proxy: an integration only writes `last_attempt_at`
 * when the scheduler actually ticks it (tickWithRetryAndHeartbeat,
 * scheduler-glue.ts), so an attempt inside the trailing 24h IS evidence it is
 * currently enabled+scheduled — without re-reading every integration.yaml
 * manifest (that enumeration is doctor-set.ts's private
 * listScheduledIntegrations, not exported and out of this task's file list).
 * `last_ok_at` accessor mirrors integration-staleness.ts's `readKv`: one row
 * per (integration_name, key) in `integration_state`, value is ISO
 * (`.toISOString()`, scheduler-glue.ts's `writeHeartbeat`).
 */
function computeStaleIntegrations(
  db: RobinDb,
  now: Date,
): ReliabilityArtifact['silent']['staleIntegrations'] {
  const windowStartIso = new Date(now.getTime() - DAY_MS).toISOString();
  const attempted = db
    .prepare(
      `SELECT DISTINCT integration_name FROM integration_state
        WHERE key = 'last_attempt_at' AND value >= ?`,
    )
    .all(windowStartIso) as Array<{ integration_name: string }>;

  const stale: ReliabilityArtifact['silent']['staleIntegrations'] = [];
  for (const { integration_name: name } of attempted) {
    const row = db
      .prepare(
        `SELECT value FROM integration_state WHERE integration_name = ? AND key = 'last_ok_at'`,
      )
      .get(name) as { value: string } | undefined;
    const lastOkAt = row?.value ?? null;
    const ageHours = lastOkAt
      ? (now.getTime() - Date.parse(lastOkAt)) / 3_600_000
      : NEVER_OK_AGE_HOURS;
    if (ageHours > 24) {
      stale.push({ name, lastOkAt, ageHours: Math.round(ageHours * 10) / 10 });
    }
  }
  return stale;
}

/**
 * Q2c: agent_usage rows in the trailing 24h that completed real work but
 * never got a structured outcome. Status values actually written by
 * usage-ledger.ts (verified against live `agent_usage` rows, 2026-08-11):
 * 'success' | 'capped' | 'timeout' | 'error' — never NULL in practice.
 * capped/timeout/error already explain the missing outcome (the run didn't
 * finish real work), so only a 'success' row with outcome still NULL is a
 * genuine silent miss. `status NOT IN (...)` also naturally excludes any
 * (hypothetical, pre-check-skip) NULL-status row on its own: SQL's
 * three-valued logic makes `NULL NOT IN (...)` evaluate to unknown, which
 * WHERE treats as false — no separate `AND status IS NOT NULL` needed.
 *
 * Scope: `label GLOB '[A-Z]'` restricts the count to the fleet handler path
 * (runner-entry.ts labels each run `def.id` — a single uppercase letter A–L),
 * which is the ONLY path that calls `ledger.recordOutcome`. Other
 * agentic-autonomous runs — dream-synthesis (`dream:<topic>`) and the nightly
 * critique (`critique`) — label themselves but structurally never record an
 * outcome (they have no did-work/no-op/blocked distinction to emit), so
 * counting them was a permanent false positive that fired in every brief's
 * Reliability section (confirmed on live data 2026-10-10). Scoping to the
 * labeled fleet path positively, rather than excluding the known non-outcome
 * labels, keeps the counter correct as new cognition agents are added.
 */
function countAgentRunsWithoutOutcome(db: RobinDb, now: Date): number {
  const windowStartIso = new Date(now.getTime() - DAY_MS).toISOString();
  const row = db
    .prepare(
      `SELECT COUNT(*) AS c FROM agent_usage
        WHERE surface = 'agentic-autonomous' AND ts >= ?
          AND label GLOB '[A-Z]'
          AND status NOT IN ('capped', 'timeout', 'error')
          AND outcome IS NULL`,
    )
    .get(windowStartIso) as { c: number };
  return row.c;
}

function countAgentRunsCompacted(db: RobinDb, now: Date): number {
  const windowStartIso = new Date(now.getTime() - DAY_MS).toISOString();
  const row = db
    .prepare(
      `SELECT COUNT(*) AS c FROM agent_usage
        WHERE surface = 'agentic-autonomous' AND ts >= ? AND compactions > 0`,
    )
    .get(windowStartIso) as { c: number };
  return row.c;
}

/** Currently-open invariant incidents escalated to outcome='needs-human'.
 *  `ORDER BY first_seen_at ASC` makes the array deterministic and puts the
 *  longest-outstanding (most overdue) incident first. */
function computeNeedsHuman(
  db: RobinDb,
  now: Date,
  fixByName: Map<string, string>,
): ReliabilityArtifact['needsHuman'] {
  const rows = db
    .prepare(
      `SELECT source, key, first_seen_at FROM alerts
        WHERE source = 'invariant' AND resolved_at IS NULL AND outcome = 'needs-human'
        ORDER BY first_seen_at ASC`,
    )
    .all() as Array<{ source: string; key: string; first_seen_at: string }>;
  return rows.map((row) => ({
    key: row.key,
    source: row.source,
    since: row.first_seen_at,
    ageDays: Math.floor((now.getTime() - parseSqlDatetime(row.first_seen_at)) / DAY_MS),
    fix: fixByName.get(row.key) ?? 'no runbook entry for this invariant — investigate manually',
  }));
}

/**
 * Cap a list of flag lines at `cap` entries; beyond that, replace the
 * overflow with one summary line instead of dropping it. The visible-and-
 * inert error doctrine (CLAUDE.md: "a missing/stale artifact must become a
 * visible brief line, never a silent skip") forbids a plain truncation —
 * losing the count of additional misses/staleness past the cap would itself
 * be a silent failure.
 */
function capWithOverflow(lines: string[], cap: number, label: string): string[] {
  if (lines.length <= cap) return lines;
  const overflow = lines.length - cap;
  return [...lines.slice(0, cap), `silent: …and ${overflow} more ${label}`];
}

/**
 * Q2 flags (reliability-audit review, 2026-08-11, finding 2): the artifact's
 * `silent` section (missed crons, stale integrations, agent runs without an
 * outcome) was computed but never turned into a flag string — the daily
 * brief renderer only surfaces `trends.flags`, so Q2 findings never reached
 * a human even though the data was sitting right there in the artifact.
 * These rules translate each Q2 finding into the same opaque `flags: string[]`
 * shape Q3 already uses, so the existing renderer picks them up with zero
 * changes on the brief side.
 */
function computeSilentFlags(silent: ReliabilityArtifact['silent']): string[] {
  const flags: string[] = [];

  const cronLines = silent.missedCrons.map(
    (c) => `silent: cron ${c.name} missed (expected ${c.expected}, ran ${c.actual})`,
  );
  flags.push(...capWithOverflow(cronLines, 3, 'missed cron(s)'));

  const integrationLines = silent.staleIntegrations.map(
    (i) => `silent: integration ${i.name} stale ${i.ageHours}h`,
  );
  flags.push(...capWithOverflow(integrationLines, 3, 'stale integration(s)'));

  if (silent.agentRunsWithoutOutcome > 0) {
    flags.push(
      `silent: ${silent.agentRunsWithoutOutcome} agent run(s) completed without an outcome record`,
    );
  }
  if (silent.agentRunsCompacted > 0) {
    flags.push(
      `silent: ${silent.agentRunsCompacted} agent run(s) hit context compaction — output written from a summary, not the prompt`,
    );
  }

  return flags;
}

/**
 * Q3: 7d per-key trend rollup over source='invariant' alerts, the
 * circuit-broken invariant list (repair-breaker.json, reused via
 * isRepairBroken against the canonical doctor-set name list rather than
 * re-implementing the SHA-keyed trip logic), and the flag rules from the
 * contract. `flags` is seeded with the Q2 silent-failure flags (finding 2)
 * before the Q3 rules append their own — both land in the one opaque
 * `trends.flags: string[]` the artifact contract defines.
 */
function computeTrends(
  db: RobinDb,
  now: Date,
  userDataDir: string,
  invariantNames: string[],
  needsHumanCount: number,
  silent: ReliabilityArtifact['silent'],
): ReliabilityArtifact['trends'] {
  const sevenDaysAgo = sqlNow(new Date(now.getTime() - WEEK_MS));
  const perKey = db
    .prepare(
      `SELECT key,
              COUNT(*) AS opened7d,
              SUM(CASE WHEN outcome = 'repaired' THEN 1 ELSE 0 END) AS repaired7d,
              SUM(CASE WHEN outcome = 'recurred' THEN 1 ELSE 0 END) AS recurred7d,
              SUM(CASE WHEN escalated_at IS NOT NULL THEN 1 ELSE 0 END) AS escalated7d,
              SUM(CASE WHEN outcome = 'needs-human' THEN 1 ELSE 0 END) AS needsHuman7d
         FROM alerts
        WHERE source = 'invariant' AND first_seen_at >= ?
        GROUP BY key
        ORDER BY key`,
    )
    .all(sevenDaysAgo) as ReliabilityArtifact['trends']['perKey'];

  const sha = currentSha();
  const circuitBroken = invariantNames.filter((name) => isRepairBroken(userDataDir, name, sha));

  const flags: string[] = [...computeSilentFlags(silent)];
  for (const row of perKey) {
    if (row.opened7d >= 5) {
      flags.push(`${row.key}: opened ${row.opened7d}x in the last 7 days`);
    }
    // Gate on total repair ATTEMPTS (repaired + recurred), not repaired7d alone:
    // Q1 rewrites a reopened incident's outcome from 'repaired' to 'recurred',
    // so a key whose repairs ALL recurred would have repaired7d=0 and never
    // trip a `repaired7d >= 3` gate — exactly the palliative-repair case this
    // flag exists to catch.
    const repairAttempts = row.repaired7d + row.recurred7d;
    if (repairAttempts >= 3 && row.recurred7d / repairAttempts > 0.5) {
      flags.push(
        `${row.key}: palliative repair — ${row.recurred7d}/${repairAttempts} repairs recurred`,
      );
    }
  }
  if (needsHumanCount > 0) {
    flags.push(`${needsHumanCount} incident(s) escalated to needs-human`);
  }
  if (circuitBroken.length > 0) {
    flags.push(`repair circuit broken: ${circuitBroken.join(', ')}`);
  }

  return { perKey, circuitBroken, flags };
}

/** Artifact path convention (mirrors dream-synthesis's artifactPath). */
export function artifactPath(userDataDir: string, date: string): string {
  return join(userDataDir, 'state', 'runtime', `reliability-audit-${date}.json`);
}

/** Atomic artifact write (temp file + rename) so a brief read never catches a
 *  partial write — same discipline as dream-synthesis's writeArtifactAtomic. */
function writeArtifactAtomic(userDataDir: string, artifact: ReliabilityArtifact): string {
  const finalPath = artifactPath(userDataDir, artifact.date);
  mkdirSync(dirname(finalPath), { recursive: true });
  const tmp = `${finalPath}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(artifact), 'utf8');
  renameSync(tmp, finalPath);
  return finalPath;
}

/**
 * Run the nightly reliability audit: read-only over alerts/jobs/
 * integration_state/agent_usage/repair-breaker.json/boots.json EXCEPT the one
 * `outcome='recurred'` mark, write the artifact atomically, and return it.
 */
/**
 * The audit's findings as a remediation brief for K, or null when there is
 * nothing to fix (no needs-human, no recurrence, no silent failure, no flag).
 * Recurrences are de-duplicated by key; the list order is the fix priority.
 */
export function remediationGoal(
  a: ReliabilityArtifact,
  recentLands: LandLogEntry[] = [],
): string | null {
  const lines: string[] = [];
  for (const n of a.needsHuman)
    lines.push(`- NEEDS FIX: ${n.key} (open ${n.ageDays}d). Runbook: ${n.fix}`);
  for (const key of [...new Set(a.recurred.map((r) => r.key))]) {
    lines.push(
      `- RECURRING: ${key} keeps reopening after its repair — fix the root cause, not the symptom.`,
    );
  }
  for (const name of a.trends.circuitBroken)
    lines.push(`- CIRCUIT-BROKEN: ${name} (its repair is disabled).`);
  for (const c of a.silent.missedCrons)
    lines.push(`- MISSED CRON: ${c.name} ran ${c.actual}/${c.expected}.`);
  for (const i of a.silent.staleIntegrations)
    lines.push(`- STALE: integration ${i.name} (${i.ageHours}h).`);
  const covered = lines.join('\n');
  for (const f of a.trends.flags)
    if (!covered.includes(f.split(':')[0] ?? f)) lines.push(`- FLAG: ${f}`);
  if (lines.length === 0) return null;
  // What auto-fix already tried this week, so K builds on a fix that held and
  // doesn't re-land one that didn't (the same key still being listed above
  // after a landed fix means that fix didn't work).
  const history = recentLands.slice(-8).map((e) => {
    const what = e.landed ? 'landed' : 'held';
    const files = e.files.length > 0 ? ` [${e.files.join(', ')}]` : '';
    return `- ${(e.ts ?? '').slice(0, 10)} ${what} ${e.branch}: ${e.reason}${files}`;
  });
  return [
    `The ${a.date} reliability audit found these problems. Fix the highest-priority one you can fix at its root, in code under system/, with a test that fails without the fix:`,
    ...lines,
    'Confirm the cause in logs (user-data/observability/logs/) and with the robin health tool before editing. If the top item lives outside system/ (a user-data extension or config), say so in notes and move to the next item.',
    ...(history.length > 0
      ? [
          '',
          'Auto-fix history, last 7 days (a listed problem that a landed fix targeted means that fix did not hold):',
          ...history,
        ]
      : []),
  ].join('\n');
}

export function runReliabilityAudit(
  db: RobinDb,
  opts: { userDataDir?: string; now?: () => Date } = {},
): ReliabilityArtifact {
  const userDataDir = opts.userDataDir ?? resolveUserDataDir();
  const now = (opts.now ?? (() => new Date()))();

  const { healed, recurred } = computeHealedAndRecurred(db, now);

  const bootsPath = join(userDataDir, 'state', 'runtime', 'boots.json');
  const hasBootInWindow = bootFellInWindow(bootsPath, now);
  const missedCrons = computeMissedCrons(db, now, hasBootInWindow);
  const staleIntegrations = computeStaleIntegrations(db, now);
  const agentRunsWithoutOutcome = countAgentRunsWithoutOutcome(db, now);
  const agentRunsCompacted = countAgentRunsCompacted(db, now);

  const invariants = buildDoctorInvariants(db, userDataDir);
  const fixByName = new Map(invariants.map((inv) => [inv.name, inv.fix]));
  const needsHuman = computeNeedsHuman(db, now, fixByName);
  const trends = computeTrends(
    db,
    now,
    userDataDir,
    invariants.map((inv) => inv.name),
    needsHuman.length,
    { missedCrons, staleIntegrations, agentRunsWithoutOutcome, agentRunsCompacted },
  );

  const artifact: ReliabilityArtifact = {
    date: localDate(now),
    generatedAt: now.toISOString(),
    healed,
    recurred,
    needsHuman,
    silent: { missedCrons, staleIntegrations, agentRunsWithoutOutcome, agentRunsCompacted },
    trends,
  };

  writeArtifactAtomic(userDataDir, artifact);
  return artifact;
}
