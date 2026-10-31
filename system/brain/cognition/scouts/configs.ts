import type { RobinDb } from '../../memory/db.ts';
import type { ScoutConfig } from './types.ts';

/**
 * Domain Scouts (value-loops W4) — the five shipped configs.
 * Design ref: docs/design/2026-08-10-value-loops-plan-3-scouts.md (Task 4);
 * spec docs/design/2026-08-10-value-loops-redesign.md §6.
 *
 * Each digest is bounded, deterministic SQL over `events` (payload shapes verified
 * against the live corpus 2026-08-10): raw rows are capped, output is compact
 * per-line text, and `null` means "nothing worth scanning" (the engine skips the
 * pass — and the LLM spend — entirely). Digests receive `freshSources` from the
 * engine's freshness rule and must render ONLY those sources' sections.
 *
 * Domain notes (PERSONAL_DOMAINS is a closed set — never extended from here):
 * - career → `career` (a real member; the plan's "professional" guess resolved here).
 * - social → `relationships` (no `social` member exists; relationships is the
 *   nearest — social plans, occasions, and group outings are relationship upkeep).
 */

/** Max grouped payee lines in the finance digest. */
const MAX_PAYEE_LINES = 40;
/** Max account-balance lines in the finance digest. */
const MAX_ACCOUNT_LINES = 30;
/** Max sender-domain groups in the career digest. */
const MAX_SENDER_DOMAINS = 15;
/** Max distinct subjects rendered per sender-domain in the career digest. */
const MAX_SUBJECTS_PER_DOMAIN = 5;
/** Max rendered length of one gmail subject. */
const MAX_SUBJECT_CHARS = 80;
/** Raw gmail rows scanned per pass (~600 msgs flow per 14d window live). */
const MAX_GMAIL_ROWS = 800;
/** Max upcoming calendar lines rendered (travel + social). */
const MAX_CALENDAR_LINES = 30;
/** Max upcoming photowalk lines rendered (social). */
const MAX_PHOTOWALK_LINES = 20;
/** Max per-sport workout lines in the health digest. */
const MAX_SPORT_LINES = 10;

function iso(now: Date): string {
  return now.toISOString();
}

// ---------------------------------------------------------------------------
// finance
// ---------------------------------------------------------------------------

interface PayeeRow {
  payee: string | null;
  category: string | null;
  n: number;
  total: number | null;
}

interface SnapshotRow {
  name: string | null;
  type: string | null;
  balance: number | null;
  snapDate: string | null;
}

function financeDigest(db: RobinDb, now: Date, freshSources: string[]): string | null {
  const sections: string[] = [];

  if (freshSources.includes('lunch_money')) {
    // Spend only (is_income excluded): the guidance targets charges and purchases.
    const rows = db
      .prepare(
        `SELECT json_extract(payload, '$.payee') AS payee,
                MAX(json_extract(payload, '$.category')) AS category,
                COUNT(*) AS n,
                ROUND(SUM(json_extract(payload, '$.amount')), 2) AS total
           FROM events
          WHERE source = 'lunch_money' AND kind = 'lunch_money.transaction'
            AND COALESCE(json_extract(payload, '$.deleted'), 0) = 0
            AND COALESCE(json_extract(payload, '$.is_income'), 0) = 0
            AND json_extract(payload, '$.date') >= date(?, '-14 days')
          GROUP BY payee
          ORDER BY total DESC
          LIMIT ?`,
      )
      .all(iso(now), MAX_PAYEE_LINES) as PayeeRow[];
    if (rows.length > 0) {
      const lines = rows.map(
        (r) =>
          `- ${r.payee ?? 'unknown'} ×${r.n} $${(r.total ?? 0).toFixed(2)}` +
          (r.category ? ` (${r.category})` : ''),
      );
      sections.push(`Transactions, last 14d, grouped by payee:\n${lines.join('\n')}`);
    }
  }

  if (freshSources.includes('lunch_money_account_snapshot')) {
    // ~35d of snapshots per account: first row ≈ the 30d-ago balance, last = latest.
    const rows = db
      .prepare(
        `SELECT json_extract(payload, '$.display_name') AS name,
                json_extract(payload, '$.type') AS type,
                json_extract(payload, '$.balance') AS balance,
                json_extract(payload, '$.snapshot_date') AS snapDate
           FROM events
          WHERE source = 'lunch_money_account_snapshot'
            AND kind = 'lunch_money.account_snapshot'
            AND json_extract(payload, '$.snapshot_date') >= date(?, '-35 days')
          ORDER BY snapDate ASC
          LIMIT 2000`,
      )
      .all(iso(now)) as SnapshotRow[];
    const byAccount = new Map<string, { first: SnapshotRow; last: SnapshotRow }>();
    for (const r of rows) {
      if (!r.name) continue;
      const cur = byAccount.get(r.name);
      if (!cur) byAccount.set(r.name, { first: r, last: r });
      else cur.last = r;
    }
    if (byAccount.size > 0) {
      const lines = [...byAccount.entries()].slice(0, MAX_ACCOUNT_LINES).map(([name, s]) => {
        const latest = `$${s.last.balance ?? 0}`;
        const drift =
          s.first.snapDate !== s.last.snapDate
            ? ` (was $${s.first.balance ?? 0} on ${s.first.snapDate})`
            : '';
        return `- ${name}${s.last.type ? ` [${s.last.type}]` : ''}: ${latest}${drift}`;
      });
      sections.push(`Account balances, latest vs ~30d ago:\n${lines.join('\n')}`);
    }
  }

  return sections.length > 0 ? sections.join('\n\n') : null;
}

export const financeScout: ScoutConfig & { id: 'finance' } = {
  id: 'finance',
  domain: 'finance',
  sources: [
    { source: 'lunch_money', maxAgeDays: 7 },
    { source: 'lunch_money_account_snapshot', maxAgeDays: 7 },
  ],
  digest: financeDigest,
  guidance:
    'Look for: subscription creep (new or grown recurring charges), recurring-charge drift, category spend spikes vs the usual, and follow-through on planned purchases. Anchor every candidate to a named payee or account.',
};

// ---------------------------------------------------------------------------
// health
// ---------------------------------------------------------------------------

function healthDigest(db: RobinDb, now: Date, _freshSources: string[]): string | null {
  const cutoff = new Date(now.getTime() - 14 * 86_400_000).toISOString();
  const sections: string[] = [];

  const recovery = db
    .prepare(
      `SELECT COUNT(*) AS n,
              ROUND(AVG(json_extract(payload, '$.score.recovery_score')), 0) AS mean,
              SUM(CASE WHEN json_extract(payload, '$.score.recovery_score') < 50 THEN 1 ELSE 0 END) AS below50
         FROM events
        WHERE source = 'whoop' AND kind = 'whoop.recovery' AND ts >= ?`,
    )
    .get(cutoff) as { n: number; mean: number | null; below50: number | null };
  if (recovery.n > 0) {
    const streakRow = db
      .prepare(
        `SELECT json_extract(payload, '$.streak.metric') AS metric,
                json_extract(payload, '$.streak.days') AS days
           FROM events
          WHERE source = 'whoop' AND kind = 'whoop.recovery' AND ts >= ?
            AND json_extract(payload, '$.streak.metric') IS NOT NULL
          ORDER BY id DESC LIMIT 1`,
      )
      .get(cutoff) as { metric: string; days: number } | undefined;
    sections.push(
      `Recovery, last 14d: ${recovery.n} scored, mean ${recovery.mean}, days below 50: ${recovery.below50 ?? 0}` +
        (streakRow ? `, active streak: ${streakRow.metric} ×${streakRow.days}d` : ''),
    );
  }

  const sleep = db
    .prepare(
      `SELECT COUNT(*) AS n,
              ROUND(AVG(json_extract(payload, '$.score.sleep_performance_percentage')), 0) AS perf,
              AVG(json_extract(payload, '$.score.stage_summary.total_in_bed_time_milli')) AS bedMs
         FROM events
        WHERE source = 'whoop' AND kind = 'whoop.sleep' AND ts >= ?
          AND COALESCE(json_extract(payload, '$.nap'), 0) = 0`,
    )
    .get(cutoff) as { n: number; perf: number | null; bedMs: number | null };
  if (sleep.n > 0) {
    const hours = sleep.bedMs != null ? `${(sleep.bedMs / 3_600_000).toFixed(1)}h` : 'n/a';
    sections.push(
      `Sleep, last 14d: ${sleep.n} nights, mean performance ${sleep.perf}%, mean time in bed ${hours}`,
    );
  }

  const workouts = db
    .prepare(
      `SELECT json_extract(payload, '$.sport_name') AS sport,
              COUNT(*) AS n,
              ROUND(AVG(json_extract(payload, '$.score.strain')), 1) AS strain
         FROM events
        WHERE source = 'whoop' AND kind = 'whoop.workout' AND ts >= ?
        GROUP BY sport ORDER BY n DESC LIMIT ?`,
    )
    .all(cutoff, MAX_SPORT_LINES) as Array<{ sport: string | null; n: number; strain: number }>;
  if (workouts.length > 0) {
    const lines = workouts.map((w) => `- ${w.sport ?? 'unknown'} ×${w.n}, mean strain ${w.strain}`);
    sections.push(`Workouts, last 14d:\n${lines.join('\n')}`);
  }

  return sections.length > 0 ? sections.join('\n\n') : null;
}

export const healthScout: ScoutConfig & { id: 'health' } = {
  id: 'health',
  domain: 'health',
  // Whoop is the only health stream; when it's stale the engine skips the pass —
  // that is correct behavior, not a bug (never scout dead data).
  sources: [{ source: 'whoop', maxAgeDays: 7 }],
  digest: healthDigest,
  guidance:
    'Look for: streaks held or broken, training load vs recovery mismatch (strain climbing while recovery sinks), and lapsed routines (workout kinds that vanished). Anchor every candidate to a concrete next action, not a lecture.',
};

// ---------------------------------------------------------------------------
// shared: upcoming calendar items (travel + social read the same stream)
// ---------------------------------------------------------------------------

interface CalendarItem {
  summary: string | null;
  start: string | null;
  location: string | null;
  attendees: number | null;
}

/**
 * Next-30d calendar items from `integration.google_calendar.event` (the kind the
 * behavioral-signal allowlist and the brief's calendarItems read). The integration
 * re-emits an event row whenever a calendar entry CHANGES, so rows are deduped by
 * payload.id with the newest emission winning; cancelled items are dropped.
 */
function upcomingCalendarItems(db: RobinDb, now: Date): CalendarItem[] {
  const rows = db
    .prepare(
      `SELECT json_extract(payload, '$.id') AS eid,
              json_extract(payload, '$.summary') AS summary,
              json_extract(payload, '$.start') AS start,
              json_extract(payload, '$.location') AS location,
              json_extract(payload, '$.attendees') AS attendees,
              json_extract(payload, '$.status') AS status
         FROM events
        WHERE source = 'google_calendar' AND kind = 'integration.google_calendar.event'
          AND datetime(json_extract(payload, '$.start')) >= datetime(?)
          AND datetime(json_extract(payload, '$.start')) < datetime(?, '+30 days')
        ORDER BY id ASC
        LIMIT 200`,
    )
    .all(iso(now), iso(now)) as Array<CalendarItem & { eid: string | null; status: string | null }>;
  const byId = new Map<string, CalendarItem & { status: string | null }>();
  for (const r of rows) byId.set(r.eid ?? `row-${byId.size}`, r); // newest emission wins
  return [...byId.values()]
    .filter((r) => r.status !== 'cancelled')
    .sort((a, b) => (a.start ?? '').localeCompare(b.start ?? ''))
    .slice(0, MAX_CALENDAR_LINES);
}

function calendarLine(item: CalendarItem, withAttendees: boolean): string {
  const when = (item.start ?? '').slice(0, 16).replace('T', ' ');
  const bits = [item.location ? `@ ${item.location}` : null];
  if (withAttendees && (item.attendees ?? 0) > 0) bits.push(`${item.attendees} attendees`);
  const suffix = bits.filter(Boolean).join('; ');
  return `- ${when} ${item.summary ?? '(untitled)'}${suffix ? ` (${suffix})` : ''}`;
}

// ---------------------------------------------------------------------------
// travel
// ---------------------------------------------------------------------------

const SEASONS = [
  'winter',
  'winter',
  'spring',
  'spring',
  'spring',
  'summer',
  'summer',
  'summer',
  'fall',
  'fall',
  'fall',
  'winter',
] as const;

function travelDigest(db: RobinDb, now: Date, freshSources: string[]): string | null {
  // Calendar items are the travel signal; weather is context only — without at
  // least one upcoming item there is nothing to scout, so the pass skips.
  if (!freshSources.includes('google_calendar')) return null;
  const items = upcomingCalendarItems(db, now);
  if (items.length === 0) return null;

  const sections = [`Calendar, next 30d:\n${items.map((i) => calendarLine(i, false)).join('\n')}`];

  if (freshSources.includes('weather')) {
    const w = db
      .prepare(
        `SELECT json_extract(payload, '$.location') AS location,
                json_extract(payload, '$.temp_f') AS tempF,
                json_extract(payload, '$.desc') AS desc
           FROM events
          WHERE source = 'weather' AND kind = 'weather.current'
          ORDER BY id DESC LIMIT 1`,
      )
      .get() as { location: string | null; tempF: number | null; desc: string | null } | undefined;
    const season = SEASONS[now.getUTCMonth()];
    if (w) {
      sections.push(
        `Now in ${w.location ?? 'town'}: ${w.tempF ?? '?'}°F, ${w.desc ?? '?'}. Season: ${season}.`,
      );
    }
  }

  return sections.join('\n\n');
}

export const travelScout: ScoutConfig & { id: 'travel' } = {
  id: 'travel',
  domain: 'travel',
  sources: [
    { source: 'google_calendar', maxAgeDays: 14 },
    { source: 'weather', maxAgeDays: 7 },
  ],
  digest: travelDigest,
  guidance:
    'Look for: prep windows opening before booked trips (gear, permits, reservations), booking/permit deadlines approaching, and seasonal windows worth acting on. Every candidate here is time-windowed — ALWAYS set an explicit expiresAt.',
};

// ---------------------------------------------------------------------------
// career — privacy hard rule: render SUBJECTS and sender-domains with counts,
// NEVER body text. The SQL selects only $.from and $.subject; no other payload
// field ever reaches the render.
// ---------------------------------------------------------------------------

function senderDomain(from: string): string | null {
  const m = /@([A-Za-z0-9][A-Za-z0-9.-]*)/.exec(from);
  return m ? m[1].toLowerCase().replace(/\.+$/, '') : null;
}

function careerDigest(db: RobinDb, now: Date, _freshSources: string[]): string | null {
  const cutoff = new Date(now.getTime() - 14 * 86_400_000).toISOString();
  const rows = db
    .prepare(
      `SELECT json_extract(payload, '$.from') AS sender,
              json_extract(payload, '$.subject') AS subject
         FROM events
        WHERE source = 'gmail' AND kind = 'integration.gmail.message' AND ts >= ?
        ORDER BY id DESC
        LIMIT ?`,
    )
    .all(cutoff, MAX_GMAIL_ROWS) as Array<{ sender: string | null; subject: string | null }>;
  if (rows.length === 0) return null;

  const byDomain = new Map<string, { count: number; subjects: string[] }>();
  for (const r of rows) {
    const domain = r.sender ? senderDomain(r.sender) : null;
    if (!domain) continue;
    const entry = byDomain.get(domain) ?? { count: 0, subjects: [] };
    entry.count += 1;
    const subject = (r.subject ?? '').trim().slice(0, MAX_SUBJECT_CHARS);
    if (
      subject &&
      entry.subjects.length < MAX_SUBJECTS_PER_DOMAIN &&
      !entry.subjects.includes(subject)
    ) {
      entry.subjects.push(subject);
    }
    byDomain.set(domain, entry);
  }
  if (byDomain.size === 0) return null;

  const lines = [...byDomain.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, MAX_SENDER_DOMAINS)
    .map(([domain, e]) => `- ${domain} ×${e.count}: ${e.subjects.map((s) => `"${s}"`).join('; ')}`);
  return `Inbox, last 14d — subjects grouped by sender-domain (counts only, no bodies):\n${lines.join('\n')}`;
}

export const careerScout: ScoutConfig & { id: 'career' } = {
  id: 'career',
  // `career` IS a PERSONAL_DOMAINS member — used directly (the plan's
  // "professional" placeholder resolved to the real member).
  domain: 'career',
  sources: [{ source: 'gmail', maxAgeDays: 7 }],
  digest: careerDigest,
  guidance:
    'Look for: stalled commitments (threads that went quiet after the user owed a reply), follow-ups owed, and cadence slips with regular correspondents. You see ONLY subjects and sender-domains — never invent thread content beyond them.',
};

// ---------------------------------------------------------------------------
// social
// ---------------------------------------------------------------------------

function socialDigest(db: RobinDb, now: Date, freshSources: string[]): string | null {
  const sections: string[] = [];

  if (freshSources.includes('google_calendar')) {
    const items = upcomingCalendarItems(db, now);
    if (items.length > 0) {
      sections.push(`Calendar, next 30d:\n${items.map((i) => calendarLine(i, true)).join('\n')}`);
    }
  }

  if (freshSources.includes('photowalks')) {
    // Photowalks is DISCOVERY data (other organizers' upcoming events) — excluded
    // from behavioral signals for that reason, but a legitimate scout INPUT here:
    // context for group-outing / occasion-window candidates.
    const rows = db
      .prepare(
        `SELECT json_extract(payload, '$.title') AS title,
                json_extract(payload, '$.date') AS date,
                json_extract(payload, '$.time') AS time,
                json_extract(payload, '$.location') AS location,
                json_extract(payload, '$.price') AS price
           FROM events
          WHERE source = 'photowalks' AND kind = 'photowalks.event'
            AND json_extract(payload, '$.date') >= date(?)
            AND json_extract(payload, '$.date') <= date(?, '+30 days')
          ORDER BY date ASC, time ASC
          LIMIT ?`,
      )
      .all(iso(now), iso(now), MAX_PHOTOWALK_LINES) as Array<{
      title: string | null;
      date: string | null;
      time: string | null;
      location: string | null;
      price: number | null;
    }>;
    if (rows.length > 0) {
      const lines = rows.map((r) => {
        const bits = [r.location, r.price != null ? `$${r.price}` : null].filter(Boolean);
        return `- ${r.date} ${r.time ?? ''} ${r.title ?? '(untitled)'}${bits.length ? ` (${bits.join('; ')})` : ''}`;
      });
      sections.push(`Upcoming photowalk / photo events, next 30d:\n${lines.join('\n')}`);
    }
  }

  return sections.length > 0 ? sections.join('\n\n') : null;
}

export const socialScout: ScoutConfig & { id: 'social' } = {
  id: 'social',
  // PERSONAL_DOMAINS has no `social` member; `relationships` is the nearest
  // existing domain (social plans / occasions / group outings are relationship
  // upkeep). Do NOT extend PERSONAL_DOMAINS to add one.
  domain: 'relationships',
  sources: [
    { source: 'google_calendar', maxAgeDays: 14 },
    { source: 'photowalks', maxAgeDays: 14 },
  ],
  digest: socialDigest,
  guidance:
    'Look for: plans mentioned but never scheduled, occasion windows (birthdays, visits, meetups) approaching, and group outings worth joining — photowalk listings are candidate outings, not commitments. Time-windowed candidates MUST set expiresAt.',
};

/** Scout ids double as the per-domain policy keys (`policies.scouts.<id>`). */
export type ScoutId = 'finance' | 'health' | 'travel' | 'career' | 'social';

/** All five shipped scouts, in weekly cron order (Mon finance … Fri social). */
export const SCOUT_CONFIGS: ReadonlyArray<ScoutConfig & { id: ScoutId }> = [
  financeScout,
  travelScout,
  healthScout,
  careerScout,
  socialScout,
];
