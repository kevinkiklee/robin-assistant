// daily-briefing.js — hybrid pregen brief. v1's pregen-briefing JS rebuilt
// on top of v2's events table. Hourly fires 5-8am local compose the same
// 9 deterministic sections v1 covered (calendar, inbox, NHL, financials,
// markets, Whoop, weather, birding, quarantine) by querying the latest
// captured events per source. Two LLM synthesis gaps survive untouched
// from v1: `<!-- AWAITING_SYNTHESIS:health -->` (Whoop narrative) and
// `<!-- AWAITING_SYNTHESIS:focus -->` (suggested first action). The
// agent-runtime "briefing" protocol fills those at ask-time.
//
// Output is persisted as an `events` row with source='daily_briefing' and
// external_id keyed by date + hour so every hourly fire writes a fresh
// row that's discoverable via recall.

import { surql } from 'surrealdb';

const TZ = 'America/New_York';

function localDate(date, tz = TZ) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function localHour(date, tz = TZ) {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hour12: false });
  const raw = Number.parseInt(fmt.format(date), 10);
  return raw === 24 ? 0 : raw;
}

async function latestEvent(db, source) {
  const [rows] = await db
    .query(
      surql`SELECT id, content, ts, meta FROM events
            WHERE source = ${source}
            ORDER BY ts DESC LIMIT 1`,
    )
    .collect();
  return rows[0] ?? null;
}

async function eventsBySource(db, source, limit) {
  const [rows] = await db
    .query(
      surql`SELECT id, content, ts, meta FROM events
            WHERE source = ${source}
            ORDER BY ts DESC LIMIT ${limit}`,
    )
    .collect();
  return rows;
}

function bulletOrNote(lines, fallback) {
  return lines.length > 0 ? lines.join('\n') : `_${fallback}_`;
}

// google_calendar sync writes structured data into `content` as
// "<title> · <start> – <end> · N attendees" and uses `ts` as the event start
// in UTC. There are no separate `meta.start` / `meta.title` fields. Parse
// the content string back into structured parts here. Times come in two
// shapes: ISO+offset for timed events ("2026-05-11T21:00:00-04:00") and
// bare YYYY-MM-DD for all-day events (where `end` is exclusive per Google
// Calendar's convention).
function parseCalendarContent(content) {
  if (typeof content !== 'string') return null;
  const parts = content.split(' · ');
  if (parts.length < 2) return null;
  const rangeStr = parts[1];
  const [start, end] = rangeStr.split(' – ');
  if (!start || !end) return null;
  return { title: parts[0], start, end, isTimed: start.includes('T') };
}

function calendarOccursOnDate(parsed, today) {
  if (parsed.isTimed) return localDate(new Date(parsed.start)) === today;
  // All-day: YYYY-MM-DD strings sort lexicographically, end is exclusive.
  return parsed.start <= today && today < parsed.end;
}

function calendarTimeLabel(parsed) {
  if (!parsed.isTimed) return 'all-day';
  const d = new Date(parsed.start);
  return new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(d);
}

export async function renderCalendarSection(db, today) {
  const rows = await eventsBySource(db, 'google_calendar', 100);
  const items = [];
  for (const r of rows) {
    const parsed = parseCalendarContent(r.content);
    if (!parsed) continue;
    if (!calendarOccursOnDate(parsed, today)) continue;
    const time = calendarTimeLabel(parsed);
    const loc = r.meta?.location ? ` · ${r.meta.location}` : '';
    items.push({ time, line: `- ${time} · ${parsed.title}${loc}` });
  }
  items.sort((a, b) => {
    const aAll = a.time === 'all-day';
    const bAll = b.time === 'all-day';
    if (aAll !== bAll) return aAll ? -1 : 1;
    return a.time.localeCompare(b.time);
  });
  return bulletOrNote(
    items.slice(0, 12).map((i) => i.line),
    'No calendar events for today.',
  );
}

// gmail sync writes "Subject: <s> | From: <f>\n<snippet>" into `content`.
// Unread state lives in `meta.labels` (array containing "UNREAD"); there's
// no `meta.from`, `meta.subject`, or `meta.unread` flag.
function parseGmailContent(content) {
  const firstLine = (typeof content === 'string' ? content : '').split('\n')[0] ?? '';
  const m = firstLine.match(/^Subject:\s*(.*?)\s*\|\s*From:\s*(.+)$/);
  if (m) return { subject: m[1], from: m[2] };
  return { subject: firstLine, from: '?' };
}

export async function renderInboxSection(db, now) {
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const [rows] = await db
    .query(
      surql`SELECT id, content, ts, meta FROM events
            WHERE source = 'gmail' AND ts >= ${since}
            ORDER BY ts DESC LIMIT 30`,
    )
    .collect();
  const lines = [];
  for (const r of rows) {
    const labels = Array.isArray(r.meta?.labels) ? r.meta.labels : [];
    if (!labels.includes('UNREAD')) continue;
    const { subject, from } = parseGmailContent(r.content);
    lines.push(`- ${from} — ${subject}`);
    if (lines.length >= 8) break;
  }
  return bulletOrNote(lines, 'No unread mail in the last 24h.');
}

export async function renderNhlSection(db) {
  const latest = await latestEvent(db, 'nhl');
  if (!latest) return '_No NHL data captured._';
  return `- ${latest.content}`;
}

// Shift a local YYYY-MM-DD by N days without DST drift (anchored at noon UTC).
function shiftLocalDate(localYmd, days) {
  const [y, m, d] = localYmd.split('-').map(Number);
  const base = new Date(Date.UTC(y, m - 1, d, 12));
  base.setUTCDate(base.getUTCDate() + days);
  return `${base.getUTCFullYear()}-${String(base.getUTCMonth() + 1).padStart(2, '0')}-${String(base.getUTCDate()).padStart(2, '0')}`;
}

// lunch_money rows: meta.amount is absolute; sign comes from meta.is_income
// (new syncs) or the `· +$` / `· -$` marker in `content` (legacy rows).
function isIncomeRow(r) {
  if (typeof r.meta?.is_income === 'boolean') return r.meta.is_income;
  return /· \+\$/.test(r.content ?? '');
}

function isTransferRow(r) {
  const cat = r.meta?.category ?? '';
  const payee = r.meta?.payee ?? '';
  if (/Payment, ?Transfer/i.test(cat)) return true;
  if (/^Payment to /i.test(payee)) return true;
  return false;
}

export async function renderFinancialsSection(db, today) {
  // Pull a generous window (~2 weeks worth of activity) and bucket by
  // meta.date — Lunch Money's date is already in the user's local calendar.
  const rows = await eventsBySource(db, 'lunch_money', 200);
  if (rows.length === 0) return '_No financials captured._';

  const yesterday = today ? shiftLocalDate(today, -1) : null;
  if (!yesterday) return `- ${rows[0].content}`;

  const ydayRows = rows.filter((r) => r.meta?.date === yesterday);
  if (ydayRows.length === 0) return '_No transactions cleared yesterday._';

  const transfers = ydayRows.filter(isTransferRow);
  const nonTransfers = ydayRows.filter((r) => !isTransferRow(r));
  const spendRows = nonTransfers.filter((r) => !isIncomeRow(r));
  const incomeRows = nonTransfers.filter(isIncomeRow);

  const spendTotal = spendRows.reduce((s, r) => s + (Number(r.meta?.amount) || 0), 0);

  const lines = [];
  const txnLabel = spendRows.length === 1 ? 'txn' : 'txns';
  lines.push(
    `- Yesterday's spend: **$${spendTotal.toFixed(2)}** across ${spendRows.length} ${txnLabel}`,
  );

  const top = [...spendRows]
    .sort((a, b) => (Number(b.meta?.amount) || 0) - (Number(a.meta?.amount) || 0))
    .slice(0, 5);
  for (const r of top) {
    lines.push(`  - ${r.content}`);
  }

  if (incomeRows.length > 0) {
    const inTotal = incomeRows.reduce((s, r) => s + (Number(r.meta?.amount) || 0), 0);
    lines.push(`- Income / refunds: $${inTotal.toFixed(2)} (${incomeRows.length})`);
  }
  if (transfers.length > 0) {
    const txTotal = transfers.reduce((s, r) => s + (Number(r.meta?.amount) || 0), 0);
    lines.push(
      `- Transfers / card payments: $${txTotal.toFixed(2)} across ${transfers.length} (excluded from spend)`,
    );
  }
  return lines.join('\n');
}

export async function renderFinanceQuoteSection(db) {
  const rows = await eventsBySource(db, 'finance_quote', 50);
  if (rows.length === 0) return '_No market quotes captured._';
  const byTicker = new Map();
  for (const r of rows) {
    const t = r.meta?.ticker;
    if (!t || byTicker.has(t)) continue;
    byTicker.set(t, r);
  }
  const lines = [];
  for (const r of byTicker.values()) {
    const m = r.meta ?? {};
    const last = typeof m.last === 'number' ? `$${m.last.toFixed(2)}` : '—';
    const change =
      typeof m.change === 'number' && typeof m.change_pct === 'number'
        ? ` ${m.change >= 0 ? '▲' : '▼'} $${Math.abs(m.change).toFixed(2)} (${m.change_pct.toFixed(2)}%)`
        : '';
    lines.push(`- **${m.ticker}** ${last}${change}`);
  }
  return lines.join('\n');
}

export async function renderWhoopSection(db) {
  const recovery = await db
    .query(
      surql`SELECT id, content, ts, meta FROM events
            WHERE source = 'whoop' AND meta.kind = 'recovery'
            ORDER BY ts DESC LIMIT 1`,
    )
    .collect();
  const sleep = await db
    .query(
      surql`SELECT id, content, ts, meta FROM events
            WHERE source = 'whoop' AND meta.kind = 'sleep'
            ORDER BY ts DESC LIMIT 1`,
    )
    .collect();
  // Whoop API v2 nests metrics under `meta.score`. v1's flat shape
  // (meta.score scalar, meta.hrv_ms, meta.rhr_bpm, meta.perf_pct) is gone.
  const lines = [];
  const rec = recovery[0]?.[0];
  if (rec) {
    const s = rec.meta?.score ?? {};
    const score = s.recovery_score ?? '—';
    const hrv = s.hrv_rmssd_milli != null ? ` · HRV ${Math.round(s.hrv_rmssd_milli)}ms` : '';
    const rhr = s.resting_heart_rate != null ? ` · RHR ${s.resting_heart_rate}bpm` : '';
    lines.push(`- Recovery: **${score}**${hrv}${rhr}`);
  }
  const slp = sleep[0]?.[0];
  if (slp) {
    const perf = slp.meta?.score?.sleep_performance_percentage;
    lines.push(`- Sleep performance: ${perf != null ? `${perf}%` : '—'}`);
  }
  if (lines.length === 0) {
    // Fall back to whatever latest whoop event we do have.
    const latest = await latestEvent(db, 'whoop');
    if (latest) lines.push(`- ${latest.content}`);
  }
  const body = bulletOrNote(lines, 'No Whoop data captured yet today.');
  return `${body}\n\n<!-- AWAITING_SYNTHESIS:health -->`;
}

export async function renderWeatherSection(db) {
  const latest = await latestEvent(db, 'weather');
  if (!latest) return '_No weather captured._';
  return `- ${latest.content}`;
}

export async function renderBirdingSection(db) {
  const latest = await latestEvent(db, 'ebird');
  if (!latest) return '_No birding captured._';
  const m = latest.meta ?? {};
  const lines = [`- ${latest.content}`];
  if (Array.isArray(m.rarities) && m.rarities.length > 0) {
    lines.push(`  - Rarities: ${m.rarities.join(', ')}`);
  }
  return lines.join('\n');
}

export async function renderQuarantineSection(db, now) {
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const [rows] = await db
    .query(
      surql`SELECT id, content, ts, meta, source FROM events
            WHERE trust = 'untrusted' AND ts >= ${since}
            ORDER BY ts DESC LIMIT 10`,
    )
    .collect();
  if (rows.length === 0) return '';
  return rows.map((r) => `- [${r.source}] ${r.content}`).join('\n');
}

export async function compose({ db, now = new Date() }) {
  const today = localDate(now);
  const [calendar, inbox, nhl, financials, markets, whoop, weather, birding, quarantine] =
    await Promise.all([
      renderCalendarSection(db, today),
      renderInboxSection(db, now),
      renderNhlSection(db),
      renderFinancialsSection(db, today),
      renderFinanceQuoteSection(db),
      renderWhoopSection(db),
      renderWeatherSection(db),
      renderBirdingSection(db),
      renderQuarantineSection(db, now),
    ]);

  const lines = [
    '---',
    `generated_at: ${now.toISOString()}`,
    `generated_for: ${today}`,
    'generator: daily-briefing/internal',
    'schema_version: 2',
    '---',
    `# Daily Briefing — ${today}`,
    '',
    '### Calendar today',
    calendar,
    '',
    '### Inbox highlights',
    inbox,
    '',
    '### NHL',
    nhl,
    '',
    '### Financials',
    financials,
    '',
    '### Markets',
    markets,
    '',
    '### Health — Whoop',
    whoop,
    '',
    '### Weather',
    weather,
    '',
    '### Birding',
    birding,
    '',
  ];
  if (quarantine) {
    lines.push('### Memory pre-filter', quarantine, '');
  }
  lines.push('### Suggested focus', '<!-- AWAITING_SYNTHESIS:focus -->', '');
  return lines.join('\n');
}

export default async function dailyBriefing({ db, capture }) {
  const now = new Date();
  const md = await compose({ db, now });
  const today = localDate(now);
  const hour = String(localHour(now)).padStart(2, '0');
  if (typeof capture === 'function') {
    await capture([
      {
        source: 'daily_briefing',
        content: md,
        ts: now,
        // `_` separators stay inside capture.sanitizeIdPart's [a-zA-Z0-9_-]
        // charset, so the row id reads `events:daily_briefing__daily_briefing_<date>_<hour>`
        // rather than the hex-encoded fallback that `:` triggers.
        external_id: `daily_briefing_${today}_${hour}`,
        meta: { date: today, hour, generator: 'internal' },
      },
    ]);
  }
  return md;
}
