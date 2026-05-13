import assert from 'node:assert/strict';
import { mkdirSync as __robinMkdirSync } from 'node:fs';
import { tmpdir as __robinTmpdir } from 'node:os';
import { join as __robinJoin, resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import dailyBriefing, {
  compose,
  renderBirdingSection,
  renderCalendarSection,
  renderFinanceQuoteSection,
  renderFinancialsSection,
  renderInboxSection,
  renderQuarantineSection,
  renderWeatherSection,
  renderWhoopSection,
} from '../../cognition/jobs/internal/daily-briefing.js';
import { writeConfig as __robinWriteConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';

const __robinTestHome = __robinJoin(
  __robinTmpdir(),
  `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`,
);
__robinMkdirSync(__robinTestHome, { recursive: true });
process.env.ROBIN_HOME = __robinTestHome;
await __robinWriteConfig({ embedder_profile: 'mxbai-1024' });

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
  return db;
}

async function seed(db, fields) {
  await db.query(surql`CREATE events CONTENT ${fields}`).collect();
}

test('compose includes frontmatter + section headers with empty DB', async () => {
  const db = await fresh();
  const md = await compose({ db, now: new Date('2026-05-12T07:30:00Z') });
  assert.match(md, /^---\n/);
  assert.match(md, /generated_at:/);
  assert.match(md, /# Daily Briefing — 2026-05-12/);
  assert.match(md, /### Calendar today/);
  assert.match(md, /### Inbox highlights/);
  assert.match(md, /### Markets/);
  assert.match(md, /### Health — Whoop/);
  assert.match(md, /### Weather/);
  assert.match(md, /### Birding/);
  assert.match(md, /### Suggested focus/);
  assert.match(md, /<!-- AWAITING_SYNTHESIS:focus -->/);
  assert.match(md, /<!-- AWAITING_SYNTHESIS:health -->/);
  await close(db);
});

test('renderCalendarSection surfaces today events with paraphrased titles', async () => {
  const db = await fresh();
  // The google_calendar sync writes structured data into `content` as
  // "<title> · <start> – <end> · N attendees"; `ts` is the event start in UTC.
  // Renderer parses content; meta carries location + opaque calendar ids only.
  await seed(db, {
    source: 'google_calendar',
    content: 'Eng standup · 2026-05-12T10:00:00-04:00 – 2026-05-12T10:30:00-04:00 · 2 attendees',
    ts: new Date('2026-05-12T14:00:00Z'),
    meta: { calendar_id: 'primary' },
  });
  await seed(db, {
    source: 'google_calendar',
    content:
      '1:1 with manager · 2026-05-12T15:00:00-04:00 – 2026-05-12T15:30:00-04:00 · 2 attendees',
    ts: new Date('2026-05-12T19:00:00Z'),
    meta: { calendar_id: 'primary' },
  });
  const out = await renderCalendarSection(db, '2026-05-12');
  assert.match(out, /Eng standup/);
  assert.match(out, /1:1 with manager/);
  await close(db);
});

test('renderCalendarSection includes multi-day all-day events on intermediate days', async () => {
  const db = await fresh();
  await seed(db, {
    source: 'google_calendar',
    content: 'Cali trip · 2026-05-14 – 2026-05-23 · 0 attendees',
    ts: new Date('2026-05-14T00:00:00Z'),
    meta: { calendar_id: 'primary' },
  });
  // On 5/16 (mid-trip), the multi-day event should still show.
  const out = await renderCalendarSection(db, '2026-05-16');
  assert.match(out, /Cali trip/);
  assert.match(out, /all-day/);
  // On 5/23 (the exclusive end date), it should NOT show.
  const out2 = await renderCalendarSection(db, '2026-05-23');
  assert.doesNotMatch(out2, /Cali trip/);
  await close(db);
});

test('renderCalendarSection notes when no events found', async () => {
  const db = await fresh();
  const out = await renderCalendarSection(db, '2026-05-12');
  assert.match(out, /no calendar/i);
  await close(db);
});

test('renderInboxSection lists recent unread', async () => {
  const db = await fresh();
  // The gmail sync stores subject + from in the first line of `content`
  // ("Subject: X | From: Y\n..."), and the unread flag lives in
  // `meta.labels` as the string "UNREAD" — there are no flat subject/from
  // fields in meta.
  await seed(db, {
    source: 'gmail',
    content: 'Subject: Project ping | From: colleague@example.com\nHi Kevin, quick check-in...',
    ts: new Date('2026-05-12T13:00:00Z'),
    meta: { labels: ['UNREAD', 'INBOX'] },
  });
  await seed(db, {
    source: 'gmail',
    content: 'Subject: Old read thread | From: noreply@example.com\nReceipt body...',
    ts: new Date('2026-05-12T12:00:00Z'),
    meta: { labels: ['INBOX'] },
  });
  const out = await renderInboxSection(db, new Date('2026-05-12T15:00:00Z'));
  assert.match(out, /Project ping/);
  assert.match(out, /colleague@example\.com/);
  assert.doesNotMatch(out, /Old read thread/);
  await close(db);
});

test('renderFinanceQuoteSection summarises every captured ticker', async () => {
  const db = await fresh();
  await seed(db, {
    source: 'finance_quote',
    content: 'GOOG · $145.23',
    ts: new Date('2026-05-12T20:00:00Z'),
    meta: { ticker: 'GOOG', last: 145.23, prev_close: 143.73, change: 1.5, change_pct: 1.04 },
  });
  await seed(db, {
    source: 'finance_quote',
    content: 'AAPL · $230',
    ts: new Date('2026-05-12T20:00:00Z'),
    meta: { ticker: 'AAPL', last: 230, prev_close: 228, change: 2, change_pct: 0.88 },
  });
  const out = await renderFinanceQuoteSection(db);
  assert.match(out, /GOOG/);
  assert.match(out, /145\.23/);
  assert.match(out, /AAPL/);
  await close(db);
});

test('renderFinancialsSection sums yesterday spend and splits transfers + income', async () => {
  const db = await fresh();
  // Two ordinary spend rows yesterday
  await seed(db, {
    source: 'lunch_money',
    content: 'Bread Financial · -$919.95 · uncategorized',
    ts: new Date('2026-05-12T00:00:00Z'),
    meta: { lm_id: 1, payee: 'Bread Financial', amount: 919.95, is_income: false, date: '2026-05-12', category: null },
  });
  await seed(db, {
    source: 'lunch_money',
    content: 'Netflix · -$38.09 · 🎉 Entertainment',
    ts: new Date('2026-05-12T00:00:00Z'),
    meta: { lm_id: 2, payee: 'Netflix', amount: 38.09, is_income: false, date: '2026-05-12', category: '🎉 Entertainment' },
  });
  // A transfer row that should NOT be counted as spend
  await seed(db, {
    source: 'lunch_money',
    content: 'Payment to Chase card ending in 1427 05/12 · -$2291.64 · uncategorized',
    ts: new Date('2026-05-12T00:00:00Z'),
    meta: { lm_id: 3, payee: 'Payment to Chase card ending in 1427 05/12', amount: 2291.64, is_income: false, date: '2026-05-12', category: null },
  });
  // A refund/income row yesterday
  await seed(db, {
    source: 'lunch_money',
    content: 'Amazon Refund · +$15.00 · 🛍️ Shopping',
    ts: new Date('2026-05-12T00:00:00Z'),
    meta: { lm_id: 4, payee: 'Amazon Refund', amount: 15, is_income: true, date: '2026-05-12', category: '🛍️ Shopping' },
  });
  // Day-before-yesterday spend that must NOT leak into the yesterday total
  await seed(db, {
    source: 'lunch_money',
    content: 'Junkosush · -$22.69 · 🍽️ Restaurants',
    ts: new Date('2026-05-11T00:00:00Z'),
    meta: { lm_id: 5, payee: 'Junkosush', amount: 22.69, is_income: false, date: '2026-05-11', category: '🍽️ Restaurants' },
  });

  const out = await renderFinancialsSection(db, '2026-05-13');
  // Spend total = 919.95 + 38.09 = $958.04, two txns
  assert.match(out, /Yesterday's spend: \*\*\$958\.04\*\* across 2 txns/);
  assert.match(out, /Bread Financial/);
  assert.match(out, /Netflix/);
  // Transfer line is broken out, not folded into spend
  assert.match(out, /Transfers \/ card payments: \$2291\.64/);
  // Income / refunds line is broken out
  assert.match(out, /Income \/ refunds: \$15\.00/);
  // The day-before row must not appear (wrong date bucket)
  assert.doesNotMatch(out, /Junkosush/);
  await close(db);
});

test('renderFinancialsSection notes empty days explicitly', async () => {
  const db = await fresh();
  await seed(db, {
    source: 'lunch_money',
    content: 'Old txn · -$10.00 · uncategorized',
    ts: new Date('2026-05-01T00:00:00Z'),
    meta: { lm_id: 99, payee: 'Old txn', amount: 10, is_income: false, date: '2026-05-01', category: null },
  });
  const out = await renderFinancialsSection(db, '2026-05-13');
  assert.match(out, /No transactions cleared yesterday/);
  await close(db);
});

test('renderWhoopSection includes latest recovery score and synthesis gap', async () => {
  const db = await fresh();
  // Whoop API v2 nests metrics under `meta.score`; v1's flat fields
  // (meta.score scalar, meta.hrv_ms, meta.rhr_bpm) are gone.
  await seed(db, {
    source: 'whoop',
    content: 'recovery: 82% · HRV 48ms · RHR 56',
    ts: new Date('2026-05-12T11:00:00Z'),
    meta: {
      kind: 'recovery',
      score: { recovery_score: 82, hrv_rmssd_milli: 48.2, resting_heart_rate: 56 },
    },
  });
  await seed(db, {
    source: 'whoop',
    content: 'sleep: 7h 30m · efficiency 92%',
    ts: new Date('2026-05-12T10:00:00Z'),
    meta: {
      kind: 'sleep',
      score: { sleep_performance_percentage: 89 },
    },
  });
  const out = await renderWhoopSection(db);
  assert.match(out, /Recovery: \*\*82\*\*/);
  assert.match(out, /HRV 48ms/);
  assert.match(out, /RHR 56bpm/);
  assert.match(out, /Sleep performance: 89%/);
  assert.match(out, /<!-- AWAITING_SYNTHESIS:health -->/);
  await close(db);
});

test('renderWeatherSection surfaces today high/low/conditions', async () => {
  const db = await fresh();
  await seed(db, {
    source: 'weather',
    content: 'NYC · 72°F / 54°F · Mostly clear',
    ts: new Date('2026-05-12T12:00:00Z'),
    meta: {
      location_name: 'NYC',
      today: { high: 72, low: 54, conditions: 'Mostly clear' },
      sunrise: '2026-05-12T05:42',
      sunset: '2026-05-12T19:58',
    },
  });
  const out = await renderWeatherSection(db);
  assert.match(out, /72°F/);
  assert.match(out, /Mostly clear/);
  await close(db);
});

test('renderBirdingSection notes most-recent ebird capture', async () => {
  const db = await fresh();
  await seed(db, {
    source: 'ebird',
    content: 'central park: 12 species, 1 rarity',
    ts: new Date('2026-05-12T10:00:00Z'),
    meta: { species_count: 12, rarities: ['Cerulean Warbler'] },
  });
  const out = await renderBirdingSection(db);
  assert.match(out, /central park/i);
  assert.match(out, /Cerulean Warbler/);
  await close(db);
});

test('renderQuarantineSection only surfaces untrusted events in window', async () => {
  const db = await fresh();
  await seed(db, {
    source: 'discord',
    content: 'random link from stranger',
    ts: new Date('2026-05-12T05:00:00Z'),
    trust: 'untrusted',
    meta: { reason: 'unknown_sender' },
  });
  await seed(db, {
    source: 'discord',
    content: 'normal message',
    ts: new Date('2026-05-12T05:00:00Z'),
    trust: 'trusted',
  });
  const out = await renderQuarantineSection(db, new Date('2026-05-12T07:30:00Z'));
  assert.match(out, /random link/);
  assert.doesNotMatch(out, /normal message/);
  await close(db);
});

test('renderQuarantineSection returns empty string when no untrusted events', async () => {
  const db = await fresh();
  const out = await renderQuarantineSection(db, new Date());
  assert.equal(out, '');
  await close(db);
});

test('default export persists brief via capture and returns markdown', async () => {
  const db = await fresh();
  const captured = [];
  const out = await dailyBriefing({
    db,
    capture: async (rows) => {
      captured.push(...rows);
    },
  });
  assert.equal(typeof out, 'string');
  assert.match(out, /# Daily Briefing/);
  assert.equal(captured.length, 1);
  assert.equal(captured[0].source, 'daily_briefing');
  assert.match(captured[0].external_id, /^daily_briefing_\d{4}-\d{2}-\d{2}_\d{2}$/);
  await close(db);
});
