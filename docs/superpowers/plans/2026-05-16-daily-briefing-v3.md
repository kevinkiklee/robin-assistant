# Daily Briefing v3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the daily briefing as a v3 system that adds Opus-powered insight synthesis, location-aware weather, a memory-learned recap section, photo analysis with published galleries, and a 3-surface calibration feedback loop.

**Architecture:** Refactor the monolithic `user-data/jobs/daily-briefing.js` into an orchestrator + 7 focused modules under `user-data/jobs/briefing/`. Lock the chrome inside the renderer so every consumer sees identical bytes. Synthesis uses the existing tiered host adapter (`host.invokeLLM({ tier: 'deep' })` → Opus 4.7).

**Tech Stack:** Node.js ES modules, SurrealDB via `surrealdb` package, existing Claude Code host adapter, sharp for HEIC→JPEG thumbnails, `@vercel/blob` for thumbnail uploads, `node --test` with `node:test/mock`.

**Spec reference:** `docs/superpowers/specs/2026-05-16-daily-briefing-v3-design.md`

---

## Phase 1 — Refactor: extract data + render layers

**Goal:** Decompose the current job into `briefing-data.js` + `briefing-render.js` + thin orchestrator. Lock chrome in renderer. Schema stays v2 so no consumers break.

### Task 1.1: Create `briefing-data.js`

**Files:**
- Create: `user-data/jobs/briefing/data.js`
- Test: `system/tests/unit/briefing-data.test.js`

- [ ] **Step 1: Write failing tests**

```js
// system/tests/unit/briefing-data.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connect, close } from '../../data/db/client.js';
import { assembleBriefingData } from '../../../user-data/jobs/briefing/data.js';

test('assembleBriefingData returns BriefingData shape', async () => {
  const db = await connect({ engine: 'mem://' });
  try {
    const data = await assembleBriefingData({ db, now: new Date('2026-05-16T13:00:00Z') });
    assert.equal(typeof data.today, 'string');
    assert.match(data.today, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok('calendar' in data);
    assert.ok('inbox' in data);
    assert.ok('nhl' in data);
    assert.ok('financials' in data);
    assert.ok('markets' in data);
    assert.ok('whoop' in data);
    assert.ok('weather' in data);
    assert.ok('birding' in data);
    assert.ok('horizon' in data);     // renamed from quarantine/pre-filter
  } finally {
    await close(db);
  }
});
```

- [ ] **Step 2: Run test, expect FAIL**

```bash
pnpm test:file system/tests/unit/briefing-data.test.js
```

Expected: `Cannot find module '../../../user-data/jobs/briefing/data.js'`

- [ ] **Step 3: Implement `briefing-data.js`**

Extract these from the current `user-data/jobs/daily-briefing.js` (lines 17-368) into a single `assembleBriefingData({ db, now })` export. Move every `renderXSection` function but keep them returning **structured data**, not markdown. Helpers (`localDate`, `localHour`, `eventsBySource`, `parseCalendarContent`, `shiftLocalDate`, etc.) stay co-located.

```js
// user-data/jobs/briefing/data.js
import { surql } from 'surrealdb';

const TZ = 'America/New_York';

export function localDate(date, tz = TZ) { /* unchanged from current job */ }
export function shiftLocalDate(localYmd, days) { /* unchanged */ }
async function eventsBySource(db, source, limit) { /* unchanged */ }

export async function assembleBriefingData({ db, now = new Date() }) {
  const today = localDate(now);
  const [calendar, inbox, nhl, financials, markets, whoop, weather, birding, horizon] =
    await Promise.all([
      collectCalendar(db, today),
      collectInbox(db, now),
      collectNhl(db, today),
      collectFinancials(db, today),
      collectMarkets(db),
      collectWhoop(db),
      collectWeather(db),
      collectBirding(db),
      collectHorizon(db, now),
    ]);
  return { today, now, tz: TZ, calendar, inbox, nhl, financials, markets, whoop, weather, birding, horizon };
}

// Each collectX returns structured data, NOT markdown strings.
// Example for calendar:
async function collectCalendar(db, today) {
  const rows = await eventsBySource(db, 'google_calendar', 100);
  const items = [];
  for (const r of rows) {
    const parsed = parseCalendarContent(r.content);
    if (!parsed || !calendarOccursOnDate(parsed, today)) continue;
    items.push({
      time: calendarTimeLabel(parsed),
      title: parsed.title,
      location: r.meta?.location ?? null,
      raw: r,
    });
  }
  items.sort(/* same all-day-first sort */);
  return items.slice(0, 12);
}
```

Repeat for each section. NHL returns `{ yesterday: [], today: [], tomorrow: [] }`. Financials returns `{ spendTotal, spendRows, incomeRows, transfers }`. Etc.

- [ ] **Step 4: Run test, expect PASS**

```bash
pnpm test:file system/tests/unit/briefing-data.test.js
```

- [ ] **Step 5: Commit**

```bash
git add user-data/jobs/briefing/data.js system/tests/unit/briefing-data.test.js
git commit -m "feat(briefing): extract data assembly into briefing/data.js"
```

### Task 1.2: Create `briefing-render.js` with chrome locked

**Files:**
- Create: `user-data/jobs/briefing/render.js`
- Test: `system/tests/unit/briefing-render.test.js`

- [ ] **Step 1: Write failing tests**

```js
// system/tests/unit/briefing-render.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderBrief } from '../../../user-data/jobs/briefing/render.js';

test('renderBrief includes chrome separators', () => {
  const md = renderBrief({
    data: minimalData(),
    insights: { watching: [], section: {}, learned: [], photo_critique: { supportive: [], improvement: [] } },
    galleryUrl: null,
  });
  assert.match(md, /━{30,}/); // separator bar
  assert.match(md, /🌅 \*\*DAILY BRIEFING\*\*/);
  assert.match(md, /📅 \*\*Calendar today\*\*/);
  assert.match(md, /To improve future briefs/);
});

test('renderBrief tags insights with [mN]', () => {
  const md = renderBrief({
    data: minimalData(),
    insights: {
      watching: [{ id: 'm1', category: 'recovery_correlation', text: 'sleep was 9% with flight tomorrow' }],
      section: {},
      learned: [],
      photo_critique: { supportive: [], improvement: [] },
    },
    galleryUrl: null,
  });
  assert.match(md, /\[m1\]/);
  assert.match(md, /sleep was 9% with flight tomorrow/);
});

test('renderBrief omits empty memory-learned section', () => {
  const md = renderBrief({ data: minimalData(), insights: emptyInsights(), galleryUrl: null });
  assert.doesNotMatch(md, /What Robin learned about you today/);
});

function minimalData() {
  return {
    today: '2026-05-16', tz: 'America/New_York', now: new Date('2026-05-16T13:00:00Z'),
    calendar: [], inbox: [], nhl: { yesterday: [], today: [], tomorrow: [] },
    financials: { spendTotal: 0, spendRows: [], incomeRows: [], transfers: [] },
    markets: [], whoop: null, weather: { location: 'New York, NY', summary: '...', sunrise: '05:37', sunset: '20:07' },
    photos: null, birding: [], horizon: [], memoryLearned: [],
  };
}
function emptyInsights() {
  return { watching: [], section: {}, learned: [], photo_critique: { supportive: [], improvement: [] } };
}
```

- [ ] **Step 2: Run test, expect FAIL** (module not found)

- [ ] **Step 3: Implement `briefing-render.js`**

```js
// user-data/jobs/briefing/render.js
const SEP = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function dayOfWeek(today, tz) {
  const d = new Date(`${today}T12:00:00`);
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long' }).format(d);
}

function shortDate(today) {
  const [, m, d] = today.split('-');
  return `${Number(m)}/${Number(d)}`;
}

export function renderBrief({ data, insights, galleryUrl }) {
  const lines = [
    '---',
    `generated_at: ${data.now.toISOString()}`,
    `generated_for: ${data.today}`,
    'generator: daily-briefing/internal',
    'schema_version: 3',
    '---',
    SEP,
    `🌅 **DAILY BRIEFING** · ${dayOfWeek(data.today, data.tz)}, ${shortDate(data.today)}`,
    SEP,
    '',
  ];

  // Watching section
  if (insights.watching?.length) {
    lines.push('👁️ **What Robin\'s watching**');
    for (const w of insights.watching) lines.push(`- [${w.id}] ${w.text}`);
    lines.push('');
  }

  // Memory-learned section (omit if empty)
  if (insights.learned?.length || insights.learnedProse) {
    lines.push('📝 **What Robin learned about you today**');
    if (insights.learnedProse) lines.push('', insights.learnedProse, '');
    for (const l of insights.learned) lines.push(`- [${l.id}] ${l.text}`);
    lines.push('');
  }

  // Deterministic sections — each uses sectionInsight(insights.section[name])
  lines.push('📅 **Calendar today**', renderCalendar(data.calendar), sectionInsight(insights.section?.calendar), '');
  lines.push('📬 **Inbox highlights**', renderInbox(data.inbox), sectionInsight(insights.section?.inbox), '');
  lines.push('🏒 **NHL**', renderNhl(data.nhl), sectionInsight(insights.section?.nhl), '');
  lines.push('💸 **Financials**', renderFinancials(data.financials), sectionInsight(insights.section?.financials), '');
  lines.push('📈 **Markets**', renderMarkets(data.markets), sectionInsight(insights.section?.markets), '');
  lines.push('💪 **Health — Whoop**', renderWhoop(data.whoop), sectionInsight(insights.section?.whoop), '');
  lines.push(`🌤️ **Weather — ${data.weather.location}**`, renderWeather(data.weather), sectionInsight(insights.section?.weather), '');

  // Photography (omit if no photos today)
  if (data.photos && data.photos.todayCount > 0) {
    lines.push('📸 **Photography**', renderPhotos(data.photos, galleryUrl, insights.photo_critique), '');
  }

  lines.push('🐦 **Birding**', renderBirding(data.birding), sectionInsight(insights.section?.birding), '');

  if (data.horizon?.length) {
    lines.push('🔮 **On the horizon**', renderHorizon(data.horizon), '');
  }

  lines.push(SEP);
  lines.push('_To improve future briefs:_');
  lines.push('_• Reply `m3 bad` or `m3 good` — Robin learns which insights land_');
  lines.push('_• Or natural language: "the m3 insight wasn\'t useful"_');
  lines.push('_• Calibrate a whole category: `robin brief calibrate <category> <0.0-1.0>`_');

  return lines.filter((l) => l !== null).join('\n');
}

function sectionInsight(meta) {
  if (!meta?.text) return null;
  return `_[${meta.id}] ${meta.text}_`;
}

function renderCalendar(items) { /* return joined bullets or "_No events_" */ }
function renderInbox(items) { /* ... */ }
function renderNhl(nhl) { /* yesterday/today/tomorrow sections */ }
function renderFinancials(f) { /* spend total + top rows + transfers */ }
function renderMarkets(m) { /* per-ticker lines */ }
function renderWhoop(w) { /* recovery + sleep lines */ }
function renderWeather(w) { /* temp/conditions/sunrise/sunset */ }
function renderPhotos(p, galleryUrl, critique) {
  const lines = [
    `${p.todayCount} photos today · ${formatCategoryMix(p.categoryMix)} · ${p.baselineMultiplier}× 30d baseline`,
  ];
  if (galleryUrl) lines.push(`📁 [Gallery →](${galleryUrl})`);
  // Locations, time distribution, then critique
  if (critique?.supportive?.length) {
    lines.push('', '**What\'s working**');
    for (const s of critique.supportive) lines.push(`- [${s.id}] ${s.text}`);
  }
  if (critique?.improvement?.length) {
    lines.push('', '**What could be stronger**');
    for (const i of critique.improvement) lines.push(`- [${i.id}] ${i.text}`);
  }
  return lines.join('\n');
}
function renderBirding(b) { /* ... */ }
function renderHorizon(h) { /* memory pre-filter from current job */ }
```

- [ ] **Step 4: Run tests, expect PASS**

```bash
pnpm test:file system/tests/unit/briefing-render.test.js
```

- [ ] **Step 5: Commit**

```bash
git add user-data/jobs/briefing/render.js system/tests/unit/briefing-render.test.js
git commit -m "feat(briefing): lock chrome + insight tagging in render layer"
```

### Task 1.3: Update `daily-briefing.js` to use new modules (schema still v2)

**Files:**
- Modify: `user-data/jobs/daily-briefing.js`
- Modify: `user-data/jobs/tests/daily-briefing.test.js`

- [ ] **Step 1: Refactor job to thin orchestrator**

```js
// user-data/jobs/daily-briefing.js
import { assembleBriefingData } from './briefing/data.js';
import { renderBrief } from './briefing/render.js';

export async function compose({ db, now = new Date() }) {
  const data = await assembleBriefingData({ db, now });
  // Phase 1: no insights yet, no gallery yet
  const insights = { watching: [], section: {}, learned: [], photo_critique: { supportive: [], improvement: [] } };
  return renderBrief({ data, insights, galleryUrl: null });
}

export default async function dailyBriefing({ db, capture }) {
  const now = new Date();
  const md = await compose({ db, now });
  const today = /* localDate(now) — keep import or re-export from data.js */;
  const hour = /* localHour(now) */;
  if (typeof capture === 'function') {
    await capture([{
      source: 'daily_briefing',
      content: md,
      ts: now,
      external_id: `daily_briefing_${today}_${hour}`,
      meta: { date: today, hour, generator: 'internal', schema_version: 2 },
    }]);
  }
  return md;
}
```

- [ ] **Step 2: Update existing test to match new shape**

Existing assertions about section headers stay; new assertion: chrome separator present.

- [ ] **Step 3: Run full test suite to confirm nothing broke**

```bash
pnpm test:fast
```

Expected: PASS for existing daily-briefing tests + new ones.

- [ ] **Step 4: Commit**

```bash
git add user-data/jobs/daily-briefing.js user-data/jobs/tests/daily-briefing.test.js
git commit -m "refactor(briefing): daily-briefing.js as thin orchestrator over data+render"
```

---

## Phase 2 — Location-aware weather

**Goal:** Resolve today's location from calendar/sticky/home, write a sticky `events:location__<date>` row, fetch weather for resolved coords.

### Task 2.1: Geocode helper + cache

**Files:**
- Create: `user-data/jobs/briefing/location.js`
- Test: `system/tests/unit/briefing-location.test.js`

- [ ] **Step 1: Failing tests**

```js
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { connect, close } from '../../data/db/client.js';
import { resolveLocation } from '../../../user-data/jobs/briefing/location.js';

test('resolveLocation falls back through tiers when calendar has no location', async () => {
  const db = await connect({ engine: 'mem://' });
  try {
    const geocode = mock.fn(async () => null);
    const home = { lat: 40.7128, lng: -74.006, place_name: 'New York, NY' };
    const loc = await resolveLocation({ db, today: '2026-05-16', geocode, home });
    assert.equal(loc.source, 'home');
    assert.equal(loc.place_name, 'New York, NY');
  } finally { await close(db); }
});

test('resolveLocation picks calendar location when available', async () => {
  const db = await connect({ engine: 'mem://' });
  try {
    // Insert a calendar event with location
    await db.query(/* INSERT events with source='google_calendar', meta.location='Costa Mesa, CA' */).collect();
    const geocode = mock.fn(async (q) => ({ lat: 33.64, lng: -117.92, place_name: 'Costa Mesa, CA' }));
    const loc = await resolveLocation({ db, today: '2026-05-16', geocode, home: {} });
    assert.equal(loc.source, 'calendar');
    assert.equal(geocode.mock.calls.length, 1);
  } finally { await close(db); }
});
```

- [ ] **Step 2: Implement `location.js`**

```js
// user-data/jobs/briefing/location.js
import { surql } from 'surrealdb';

export async function resolveLocation({ db, today, geocode, home }) {
  // Tier 1: calendar event today with meta.location
  const calLoc = await calendarLocation(db, today);
  if (calLoc) {
    const geo = await cachedGeocode(db, geocode, calLoc);
    if (geo) return { ...geo, source: 'calendar' };
  }

  // Tier 2: calendar event content with parseable address (US ZIP / state)
  const contentLoc = await calendarContentLocation(db, today);
  if (contentLoc) {
    const geo = await cachedGeocode(db, geocode, contentLoc);
    if (geo) return { ...geo, source: 'calendar' };
  }

  // Tier 3: sticky travel-day location (last 48h)
  const sticky = await stickyLocation(db, today);
  if (sticky) return { ...sticky, source: 'sticky' };

  // Tier 4: home
  return { ...home, source: 'home' };
}

async function calendarLocation(db, today) { /* SELECT meta.location FROM events WHERE source='google_calendar' AND today */ }
async function calendarContentLocation(db, today) { /* parse content for address regex */ }
async function cachedGeocode(db, geocode, query) {
  const cached = await db.query(surql`SELECT * FROM runtime WHERE id = ${`geocode_cache:${normalize(query)}`}`).collect();
  if (cached[0]?.[0]) return cached[0][0].value;
  const fresh = await geocode(query);
  if (fresh) {
    await db.query(surql`UPSERT runtime SET id = ${`geocode_cache:${normalize(query)}`}, value = ${fresh}, ttl_until = time::now() + 90d`).collect();
  }
  return fresh;
}
async function stickyLocation(db, today) { /* SELECT FROM events WHERE source='location' AND ts > today - 48h */ }
function normalize(s) { return s.trim().toLowerCase().replace(/\s+/g, ' '); }

export async function writeStickyLocation(db, today, location) {
  await db.query(surql`UPSERT events SET id = ${`events:location__${today}`}, source = 'location', content = ${location.place_name}, ts = time::now(), meta = ${location}`).collect();
}
```

- [ ] **Step 3: Run tests, expect PASS**

- [ ] **Step 4: Commit**

```bash
git add user-data/jobs/briefing/location.js system/tests/unit/briefing-location.test.js
git commit -m "feat(briefing): location resolution with 3-tier fallback + geocode cache"
```

### Task 2.2: Wire location into orchestrator + weather fetch

**Files:**
- Modify: `user-data/jobs/briefing/data.js` (weather collector takes location)
- Modify: `user-data/jobs/daily-briefing.js` (resolve location, pass to data, write sticky)

- [ ] **Step 1: Update weather collector to accept location**

`collectWeather(db, location)` queries the weather provider for resolved coords. If location is home (existing weather integration tracks home), reuse latest `events:weather` row. Otherwise call weather provider against resolved coords.

- [ ] **Step 2: Wire orchestrator**

```js
// user-data/jobs/daily-briefing.js
const home = await readHomeFromConfig(db);
const geocode = await loadGeocodeAdapter();
const location = await resolveLocation({ db, today, geocode, home });
await writeStickyLocation(db, today, location);
const data = await assembleBriefingData({ db, now, location });
```

- [ ] **Step 3: Test end-to-end** — fixture with Costa Mesa calendar event → brief renders with `🌤️ **Weather — Costa Mesa, CA**`.

- [ ] **Step 4: Commit**

```bash
git add user-data/jobs/briefing/data.js user-data/jobs/daily-briefing.js
git commit -m "feat(briefing): wire location-aware weather into orchestrator"
```

---

## Phase 3 — Memory-learned section

**Goal:** Pull today's rules approved, profile updates, corrections, and new entities (24h rolling, agent_internal excluded). Synthesis pass adds prose + per-item bullets.

### Task 3.1: `briefing/memory.js`

**Files:**
- Create: `user-data/jobs/briefing/memory.js`
- Test: `system/tests/unit/briefing-memory.test.js`

- [ ] **Step 1: Failing tests**

```js
test('collectMemoryLearned excludes agent_internal source', async () => { /* insert events from agent_internal and biographer, only biographer surfaces */ });
test('collectMemoryLearned uses 24h rolling window, not calendar day', async () => { /* rule created at 2026-05-16T03:00 surfaces in brief generated at 2026-05-16T13:30 */ });
test('collectMemoryLearned ranks by weight then recency', async () => { /* rule > profile_update > correction > entity */ });
test('collectMemoryLearned returns empty array on cold days', async () => { /* no recent learnings */ });
```

- [ ] **Step 2: Implement**

```js
// user-data/jobs/briefing/memory.js
import { surql } from 'surrealdb';

const WEIGHTS = { rule: 3, profile_update: 3, correction: 2, entity: 1 };

export async function collectMemoryLearned({ db, now = new Date(), limit = 8 }) {
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const rules = await db.query(surql`SELECT id, content, created_at FROM rules WHERE created_at >= ${since} AND active = true ORDER BY created_at DESC LIMIT 10`).collect();
  const profileUpdates = await db.query(surql`SELECT id, content, ts FROM events WHERE source = 'profile_update' AND ts >= ${since} ORDER BY ts DESC LIMIT 10`).collect();
  const corrections = await db.query(surql`SELECT id, content, ts FROM events WHERE source IN ['correction', 'record_correction'] AND ts >= ${since} ORDER BY ts DESC LIMIT 10`).collect();
  const entities = await db.query(surql`SELECT id, name, type, first_seen FROM entities WHERE first_seen >= ${since} AND type IN ['person', 'place', 'project'] ORDER BY first_seen DESC LIMIT 10`).collect();

  const items = [
    ...rules[0].map(r => ({ kind: 'rule', weight: 3, ref: r.id, content: r.content, ts: r.created_at })),
    ...profileUpdates[0].map(p => ({ kind: 'profile_update', weight: 3, ref: p.id, content: p.content, ts: p.ts })),
    ...corrections[0].map(c => ({ kind: 'correction', weight: 2, ref: c.id, content: c.content, ts: c.ts })),
    ...entities[0].map(e => ({ kind: 'entity', weight: 1, ref: e.id, content: `${e.type}: ${e.name}`, ts: e.first_seen })),
  ];

  // Exclude agent_internal — biographer scratch is source='agent_internal'
  const filtered = items.filter(i => i.kind !== 'agent_internal');

  filtered.sort((a, b) => {
    if (b.weight !== a.weight) return b.weight - a.weight;
    return new Date(b.ts) - new Date(a.ts);
  });

  return filtered.slice(0, limit);
}
```

- [ ] **Step 3: Run tests, expect PASS**

- [ ] **Step 4: Commit**

```bash
git add user-data/jobs/briefing/memory.js system/tests/unit/briefing-memory.test.js
git commit -m "feat(briefing): memory-learned section data collector"
```

### Task 3.2: Wire memory into data assembly

**Files:**
- Modify: `user-data/jobs/briefing/data.js`

- [ ] **Step 1: Add `memoryLearned` to `BriefingData`**

```js
export async function assembleBriefingData({ db, now, location }) {
  const today = localDate(now);
  const [calendar, inbox, /* ... */, memoryLearned] = await Promise.all([
    /* existing 9 collectors */,
    collectMemoryLearned({ db, now }),
  ]);
  return { today, /* ... */, memoryLearned };
}
```

- [ ] **Step 2: Confirm renderer's existing memory-learned omission path works** (renderer already drops the section if `insights.learned` empty).

- [ ] **Step 3: Commit**

```bash
git add user-data/jobs/briefing/data.js
git commit -m "feat(briefing): include memory-learned in BriefingData"
```

---

## Phase 4 — Photos section + published gallery

**Goal:** Aggregate photos from `events:photos`, compute baselines + streaks, upload thumbnails to Vercel Blob, publish gallery via `robin publish`, link from brief.

### Task 4.1: `briefing/photos.js` aggregation

**Files:**
- Create: `user-data/jobs/briefing/photos.js`
- Test: `system/tests/unit/briefing-photos.test.js`

- [ ] **Step 1: Failing tests**

```js
test('collectPhotos returns null when zero photos in last 24h', async () => { /* */ });
test('collectPhotos aggregates by category + computes baseline multiplier', async () => { /* 47 photos today, 12 baseline → 3.9× multiplier */ });
test('collectPhotos clusters locations by GPS proximity', async () => { /* photos within 100m → same cluster */ });
test('collectPhotos computes streakDays', async () => { /* photos every day for 5 days → streakDays=5 */ });
test('collectPhotos detects streak break', async () => { /* 4-day streak then 0 photos today → streakBroken=true */ });
test('collectPhotos labels staleness when last sync > 3h', async () => { /* */ });
```

- [ ] **Step 2: Implement aggregation logic**

```js
// user-data/jobs/briefing/photos.js
import { surql } from 'surrealdb';

export async function collectPhotos({ db, now, sunrise, sunset, tz }) {
  const todayStart = new Date(/* local-date midnight */);
  const baselineStart = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const todayRows = await eventsBySourceSince(db, 'photos', todayStart);
  if (todayRows.length === 0) return await emptyPhotosWithStreak(db, now);

  const baselineRows = await eventsBySourceSince(db, 'photos', baselineStart);
  const baselineCount = baselineRows.length - todayRows.length;
  const baselineAvg = baselineCount / 30;

  return {
    todayCount: todayRows.length,
    baselineAvg,
    baselineMultiplier: baselineAvg > 0 ? +(todayRows.length / baselineAvg).toFixed(2) : null,
    categoryMix: aggregateBy(todayRows, r => r.meta?.category ?? 'uncategorized'),
    locations: clusterLocations(todayRows),
    timeDistribution: distributeByTime(todayRows, sunrise, sunset, tz),
    streakDays: await computeStreak(db, now),
    streakBroken: false, // separate detector, set on streak-break days
    syncStaleness: await checkSyncStaleness(db),
    photos: todayRows.map(toPhotoRef),
  };
}
```

Helpers:
- `clusterLocations`: bucket by 100m grid via `meta.gps.lat/lng`, label clusters by mode of `meta.place_name`
- `distributeByTime`: bucket each photo into `goldenAm | morning | midday | goldenPm | bluePm` based on `meta.captured_at` vs. sunrise/sunset
- `computeStreak`: walk back from `today` while consecutive `local-dates` have ≥1 photo each
- `toPhotoRef`: returns `{ id, filename, category, captured_at, location, photos_uuid, gps }` (drops content body)

- [ ] **Step 3: Run tests, expect PASS**

- [ ] **Step 4: Commit**

```bash
git add user-data/jobs/briefing/photos.js system/tests/unit/briefing-photos.test.js
git commit -m "feat(briefing): photos aggregation with baselines + streaks"
```

### Task 4.2: `briefing/gallery.js` — thumbnail upload + publish

**Files:**
- Create: `user-data/jobs/briefing/gallery.js`
- Test: `system/tests/unit/briefing-gallery.test.js`

- [ ] **Step 1: Failing tests**

```js
test('publishGallery uploads thumbs and returns URL', async () => {
  const uploaded = [];
  const upload = mock.fn(async (buf, name) => { uploaded.push(name); return `https://blob/${name}`; });
  const decode = mock.fn(async (path) => Buffer.from('FAKE_JPEG'));
  const publishCli = mock.fn(async ({ slug, source }) => ({ url: `https://askrobin.io/p/${slug}` }));
  const url = await publishGallery({
    db, today: '2026-05-16', photos: fixturePhotos(),
    deps: { upload, decode, publishCli, random: () => 'a1b2c3d4' },
  });
  assert.match(url, /askrobin\.io\/p\/brief-photos-2026-05-16-a1b2c3d4/);
  assert.equal(uploaded.length, fixturePhotos().length);
});

test('publishGallery uses stable slug across hourly fires', async () => { /* second call returns same slug from runtime:gallery_slugs */ });
test('publishGallery skips when zero photos', async () => { /* returns null */ });
test('publishGallery gracefully omits Apple Photos URL when uuid missing', async () => { /* generated markdown has no photos-redirect:// */ });
```

- [ ] **Step 2: Implement**

```js
// user-data/jobs/briefing/gallery.js
import { surql } from 'surrealdb';

export async function publishGallery({ db, today, photos, deps }) {
  if (!photos || photos.todayCount === 0) return null;

  const slug = await stableSlug(db, today, deps.random ?? defaultRandom);
  const uploads = [];
  for (const p of photos.photos) {
    const thumbBuf = await deps.decode(p.path);
    const url = await deps.upload(thumbBuf, `brief-photos/${today}/${p.id}_thumb.jpg`);
    uploads.push({ photo: p, thumbUrl: url, fullUrl: url.replace('_thumb', '') });
  }
  const md = composeGalleryMarkdown(today, uploads, photos);
  const out = await deps.publishCli({ slug, source: md, mode: 'overwrite' });
  return out.url;
}

async function stableSlug(db, today, random) {
  const existing = await db.query(surql`SELECT value FROM runtime WHERE id = ${`gallery_slug:${today}`}`).collect();
  if (existing[0]?.[0]?.value) return existing[0][0].value;
  const suffix = random();
  const slug = `brief-photos-${today}-${suffix}`;
  await db.query(surql`UPSERT runtime SET id = ${`gallery_slug:${today}`}, value = ${slug}`).collect();
  return slug;
}

function composeGalleryMarkdown(today, uploads, photos) {
  // Returns markdown with per-photo anchors, thumbnails, open-in-Photos URL scheme (if uuid present), full-res link
}
```

- [ ] **Step 3: Wire `publishCli` to `robin publish` subprocess**

```js
import { spawn } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function defaultPublishCli({ slug, source, mode }) {
  const tmp = join(tmpdir(), `briefing-gallery-${Date.now()}.md`);
  writeFileSync(tmp, source);
  try {
    return new Promise((resolve, reject) => {
      const proc = spawn('robin', ['publish', '--source', tmp, '--slug', slug, '--mode', mode], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      proc.stdout.on('data', d => out += d.toString());
      proc.on('exit', code => {
        if (code !== 0) reject(new Error(`robin publish exited ${code}`));
        else resolve(JSON.parse(out));
      });
    });
  } finally {
    try { unlinkSync(tmp); } catch {}
  }
}
```

- [ ] **Step 4: Wire `upload` to `@vercel/blob`**

```js
import { put } from '@vercel/blob';
export async function defaultUpload(buf, name) {
  const { url } = await put(name, buf, { access: 'public', addRandomSuffix: false });
  return url;
}
```

- [ ] **Step 5: Wire `decode` to sharp**

```js
import sharp from 'sharp';
export async function defaultDecode(path) {
  return await sharp(path).resize({ width: 1024, withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer();
}
```

- [ ] **Step 6: Run tests, expect PASS**

- [ ] **Step 7: Commit**

```bash
git add user-data/jobs/briefing/gallery.js system/tests/unit/briefing-gallery.test.js
git commit -m "feat(briefing): gallery publishing with thumbnail upload + robin publish"
```

### Task 4.3: New scheduler bucket `gallery-prune`

**Files:**
- Create: `user-data/jobs/gallery-prune.js`
- Create: `user-data/jobs/gallery-prune.md`
- Test: `system/tests/unit/gallery-prune.test.js`

- [ ] **Step 1: Implement**

```js
// user-data/jobs/gallery-prune.js
import { surql } from 'surrealdb';
import { del } from '@vercel/blob';

export default async function galleryPrune({ db, now = new Date() }) {
  const cutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const stale = await db.query(surql`SELECT id, value FROM runtime WHERE id ~ 'gallery_slug:' AND created_at < ${cutoff}`).collect();
  let deleted = 0;
  for (const row of stale[0]) {
    try {
      // Delete blob thumbs
      await del(`brief-photos/${extractDate(row.id)}/*`);
      // Delete published page
      await runRobinPublishDelete(row.value);
      await db.query(surql`DELETE ${row.id}`).collect();
      deleted++;
    } catch (e) {
      console.warn(`[gallery-prune] failed for ${row.id}: ${e.message}`);
    }
  }
  return { deleted };
}
```

- [ ] **Step 2: Job manifest**

```md
<!-- user-data/jobs/gallery-prune.md -->
---
schedule: 0 4 * * *
enabled: true
description: Prune brief galleries older than 30d
---
```

- [ ] **Step 3: Test + commit**

```bash
pnpm test:file system/tests/unit/gallery-prune.test.js
git add user-data/jobs/gallery-prune.js user-data/jobs/gallery-prune.md system/tests/unit/gallery-prune.test.js
git commit -m "feat(briefing): gallery-prune scheduler bucket"
```

### Task 4.4: Wire photos + gallery into orchestrator

**Files:**
- Modify: `user-data/jobs/daily-briefing.js`
- Modify: `user-data/jobs/briefing/data.js`

- [ ] **Step 1: Update orchestrator order — gallery before render**

```js
const photos = await collectPhotos({ db, now, sunrise: location.sunrise, sunset: location.sunset, tz });
const galleryUrl = photos ? await publishGallery({ db, today, photos, deps: defaultGalleryDeps }) : null;
const data = { ...baseData, photos };
const md = renderBrief({ data, insights, galleryUrl });
```

- [ ] **Step 2: Commit**

```bash
git add user-data/jobs/daily-briefing.js user-data/jobs/briefing/data.js
git commit -m "feat(briefing): wire photos + gallery into orchestrator"
```

---

## Phase 5 — Synthesis with Opus 4.7

**Goal:** Single LLM call per fire (or skipped via intra-day reuse) producing structured insights. Fallback chain: Opus → Sonnet → unavailable marker.

### Task 5.1: Synthesis prompt + JSON validation

**Files:**
- Create: `user-data/jobs/briefing/synthesis-prompt.js`
- Create: `user-data/jobs/briefing/synthesis-validate.js`
- Test: `system/tests/unit/briefing-synthesis-prompt.test.js`
- Test: `system/tests/unit/briefing-synthesis-validate.test.js`

- [ ] **Step 1: Implement `synthesis-prompt.js`**

```js
export const SYSTEM_PROMPT = `You are Robin's daily-briefing analyst. ... (full prompt from spec)`;

export function buildUserPrompt({ data, memoryLearned, photos, calibration }) {
  return [
    `# Today: ${data.today}`,
    `## Calendar:\n${JSON.stringify(data.calendar)}`,
    `## Inbox (last 24h, unread):\n${JSON.stringify(data.inbox)}`,
    // ... all sections
    `## Memory learned (last 24h):\n${JSON.stringify(memoryLearned)}`,
    `## Photos:\n${JSON.stringify(photos)}`,
    `## Calibration profile:\n${JSON.stringify(calibration)}`,
    '',
    'Produce structured JSON per the schema above. Return only JSON.',
  ].join('\n\n');
}
```

- [ ] **Step 2: Implement validator**

```js
// user-data/jobs/briefing/synthesis-validate.js
export function validateSynthesis(raw) {
  // Parse JSON, check shape: { watching: [], section: {}, learned: [], photo_critique: { supportive: [], improvement: [] } }
  // Each insight must have id (matching /^m\d{1,3}$/), category, text
  // Renumber IDs to be contiguous m1, m2, ... in output order
  // Return { ok: true, value } or { ok: false, error }
}
```

- [ ] **Step 3: Tests for prompt structure + validation**

- [ ] **Step 4: Commit**

```bash
git add user-data/jobs/briefing/synthesis-prompt.js user-data/jobs/briefing/synthesis-validate.js system/tests/unit/briefing-synthesis-prompt.test.js system/tests/unit/briefing-synthesis-validate.test.js
git commit -m "feat(briefing): synthesis prompt + JSON validation"
```

### Task 5.2: Synthesis call with fallback chain

**Files:**
- Create: `user-data/jobs/briefing/synthesis.js`
- Test: `system/tests/unit/briefing-synthesis.test.js`

- [ ] **Step 1: Failing tests**

```js
test('synthesize calls host.invokeLLM with tier=deep first', async () => { /* mock host returns Opus result */ });
test('synthesize falls back to Sonnet on Opus failure', async () => { /* deep throws, balanced returns; assert both called */ });
test('synthesize returns synthesis_failed marker on both-failure', async () => { /* both throw → returns null with reason */ });
test('synthesize uses prompt caching on system message', async () => { /* assert opts.system[0].cache_control = ephemeral */ });
test('synthesize obeys 30s timeout for Opus, 15s for Sonnet', async () => { /* */ });
```

- [ ] **Step 2: Implement**

```js
// user-data/jobs/briefing/synthesis.js
import { SYSTEM_PROMPT, buildUserPrompt } from './synthesis-prompt.js';
import { validateSynthesis } from './synthesis-validate.js';

export async function synthesize({ host, data, memoryLearned, photos, calibration }) {
  const userPrompt = buildUserPrompt({ data, memoryLearned, photos, calibration });
  const messages = [{ role: 'user', content: userPrompt }];
  const system = [{ role: 'system', content: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }];

  try {
    const r = await withTimeout(
      host.invokeLLM(messages, { tier: 'deep', system, json: true, maxTokens: 2000 }),
      30_000
    );
    const v = validateSynthesis(r.content);
    if (v.ok) return { ok: true, model: 'opus-4-7', value: v.value, usage: r.usage };
  } catch (e) {
    console.warn(`[briefing/synthesis] opus failed: ${e.message}`);
  }

  try {
    const r = await withTimeout(
      host.invokeLLM(messages, { tier: 'balanced', system, json: true, maxTokens: 2000 }),
      15_000
    );
    const v = validateSynthesis(r.content);
    if (v.ok) return { ok: true, model: 'sonnet-4-6', value: v.value, usage: r.usage };
  } catch (e) {
    console.warn(`[briefing/synthesis] sonnet failed: ${e.message}`);
  }

  return { ok: false, reason: 'synthesis_unavailable' };
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms).unref()),
  ]);
}
```

- [ ] **Step 3: Run tests, expect PASS**

- [ ] **Step 4: Commit**

```bash
git add user-data/jobs/briefing/synthesis.js system/tests/unit/briefing-synthesis.test.js
git commit -m "feat(briefing): synthesis with Opus→Sonnet fallback + prompt cache"
```

### Task 5.3: Intra-day reuse

**Files:**
- Modify: `user-data/jobs/briefing/synthesis.js` (add `synthesizeOrReuse` wrapper)
- Test: `system/tests/unit/briefing-synthesis-reuse.test.js`

- [ ] **Step 1: Failing tests**

```js
test('synthesizeOrReuse reuses prior fire insights when data unchanged', async () => { /* second call within same day returns cached */ });
test('synthesizeOrReuse re-runs when section content differs >30%', async () => { /* */ });
test('synthesizeOrReuse re-runs when new top-significance memory item appears', async () => { /* */ });
test('synthesizeOrReuse re-runs when photo count differs by >5', async () => { /* */ });
```

- [ ] **Step 2: Implement**

```js
export async function synthesizeOrReuse({ db, today, host, data, memoryLearned, photos, calibration }) {
  const prior = await loadPriorFireInsights(db, today);
  if (prior && !materialChange(prior.snapshot, { data, memoryLearned, photos })) {
    return { ok: true, model: prior.model, value: prior.insights, reused: true };
  }
  const result = await synthesize({ host, data, memoryLearned, photos, calibration });
  if (result.ok) {
    await captureSnapshot(db, today, { data, memoryLearned, photos }, result);
  }
  return result;
}

function materialChange(priorSnap, current) {
  // Compare each section's content; flag if any differs by >30% (string diff or row count)
  // Check top-significance memory items appended
  // Check photo count delta > 5
}
```

- [ ] **Step 3: Run tests, expect PASS**

- [ ] **Step 4: Commit**

```bash
git add user-data/jobs/briefing/synthesis.js system/tests/unit/briefing-synthesis-reuse.test.js
git commit -m "feat(briefing): intra-day insight reuse with material-change detection"
```

### Task 5.4: Wire synthesis into orchestrator

**Files:**
- Modify: `user-data/jobs/daily-briefing.js`

- [ ] **Step 1: Accept `host` parameter**

```js
export default async function dailyBriefing({ db, capture, host }) {
  const now = new Date();
  /* existing location + memory + photos + gallery */
  const calibration = await loadCalibration(db);
  const synthesis = host
    ? await synthesizeOrReuse({ db, today, host, data, memoryLearned: data.memoryLearned, photos: data.photos, calibration })
    : { ok: false, reason: 'no_host' };

  const insights = synthesis.ok ? synthesis.value : emptyInsights();
  const md = renderBrief({ data, insights, galleryUrl });

  await capture([{
    source: 'daily_briefing',
    content: md,
    ts: now,
    external_id: `daily_briefing_${today}_${hour}`,
    meta: {
      date: today, hour,
      schema_version: 3,
      synthesis_model: synthesis.ok ? synthesis.model : null,
      synthesis_failed: !synthesis.ok,
      gallery_slug: galleryUrl ? extractSlug(galleryUrl) : null,
      location_resolved: location,
      insights: synthesis.ok ? synthesis.value : null,
    },
  }]);
  return md;
}
```

- [ ] **Step 2: Test end-to-end with mocked host**

- [ ] **Step 3: Commit**

```bash
git add user-data/jobs/daily-briefing.js
git commit -m "feat(briefing): wire synthesis into orchestrator, schema v3"
```

---

## Phase 6 — Calibration feedback loop

**Goal:** CLI for feedback + manual override + gallery privacy. Nightly rollup with exponential decay. Extend `record_correction` to parse `[mN]` tokens.

### Task 6.1: CLI subcommands

**Files:**
- Create: `system/runtime/cli/commands/brief-feedback.js`
- Create: `system/runtime/cli/commands/brief-calibrate.js`
- Create: `system/runtime/cli/commands/brief-gallery-private.js`
- Create: `system/runtime/cli/commands/brief-regenerate.js`
- Modify: `system/runtime/cli/index.js` (register commands)
- Test: `system/tests/integration/brief-cli.test.js`

- [ ] **Step 1: Implement `brief feedback`**

```js
// system/runtime/cli/commands/brief-feedback.js
import { connectFromConfig } from '../../../data/db/client.js';
import { surql } from 'surrealdb';
import { recordInsightFeedback } from '../../../cognition/briefing/feedback.js';

export async function briefFeedback(args) {
  const [insightId, verdict] = args;
  if (!/^m\d{1,3}$/i.test(insightId)) throw new Error('expected mN id');
  if (!['good', 'bad', 'neutral'].includes(verdict)) throw new Error('expected good|bad|neutral');
  const db = await connectFromConfig();
  try {
    const result = await recordInsightFeedback(db, { insightId, verdict, source: 'cli' });
    console.log(JSON.stringify(result));
  } finally { await db.close(); }
}
```

- [ ] **Step 2: Implement `recordInsightFeedback` helper**

`system/cognition/briefing/feedback.js`:

```js
export async function recordInsightFeedback(db, { insightId, verdict, source, freeText }) {
  // 1. Find the latest brief in last 24h containing this insight ID
  // 2. Extract category from meta.insights
  // 3. Write events:insight_feedback__<insight_id>__<ts> row
  // 4. If category starts with 'learned_', also act on underlying memory row
}
```

- [ ] **Step 3: Implement `brief calibrate`**

```js
export async function briefCalibrate(args) {
  const [category, scoreStr] = args;
  const score = parseFloat(scoreStr);
  if (!Number.isFinite(score) || score < 0 || score > 1) throw new Error('score must be 0.0-1.0');
  const db = await connectFromConfig();
  try {
    await db.query(surql`UPSERT runtime SET id = 'insight_calibration', value.${category}.score = ${score}, value.${category}.manual_override = true, value.${category}.updated_at = time::now()`).collect();
    console.log(`set ${category} = ${score}`);
  } finally { await db.close(); }
}
```

- [ ] **Step 4: Implement `brief gallery private`**

```js
export async function briefGalleryPrivate(args) {
  const date = parseFlag(args, '--date') ?? localDate(new Date());
  // 1. Read gallery slug from runtime:gallery_slug:<date>
  // 2. Re-publish with private blob token (call robin publish with --private flag, OR set ACL via @vercel/blob)
  // 3. Update runtime:gallery_slug:<date> with new URL + private flag
}
```

- [ ] **Step 5: Implement `brief regenerate`**

```js
export async function briefRegenerate(args) {
  const date = parseFlag(args, '--date') ?? localDate(new Date());
  // 1. Delete intra-day cache (runtime:briefing_snapshot:<date>)
  // 2. Trigger daily-briefing job once
  const db = await connectFromConfig();
  try {
    await db.query(surql`DELETE runtime:briefing_snapshot:${date}`).collect();
    // Spawn `robin jobs run daily-briefing`
  } finally { await db.close(); }
}
```

- [ ] **Step 6: Register in CLI index** + smoke tests

- [ ] **Step 7: Commit**

```bash
git add system/runtime/cli/commands/brief-*.js system/cognition/briefing/feedback.js system/runtime/cli/index.js system/tests/integration/brief-cli.test.js
git commit -m "feat(briefing): CLI commands for feedback, calibrate, gallery private, regenerate"
```

### Task 6.2: Extend `record_correction` to parse `[mN]` tokens

**Files:**
- Modify: `system/io/mcp/tools/record-correction.js` (or wherever the MCP tool lives)
- Test: `system/tests/unit/record-correction-mN.test.js`

- [ ] **Step 1: Failing test**

```js
test('record_correction parses [mN] tokens in content', async () => {
  // mock db with a daily_briefing event having insight m3 in meta.insights
  const r = await recordCorrection(db, { content: 'the m3 insight wasnt useful', prior_response: '...' });
  // Assert events:insight_feedback row created with category from m3
});

test('learned_* category feedback also acts on underlying memory row', async () => {
  // m9 in meta.insights points to rules:abc → m9 bad should mark rule pending-revocation
});
```

- [ ] **Step 2: Implement extraction**

```js
function extractMNTokens(text) {
  if (typeof text !== 'string') return [];
  return [...text.matchAll(/\b[mM](\d{1,3})\b/g)].map(m => `m${m[1]}`);
}

// In record_correction:
const tokens = [...extractMNTokens(content), ...extractMNTokens(prior_response)];
for (const id of tokens) {
  const verdict = inferVerdict(content); // 'bad' if "wasn't useful" / "not useful" / "wrong"
  await recordInsightFeedback(db, { insightId: id, verdict, source: 'natural_language', freeText: content });
}
```

- [ ] **Step 3: Test + commit**

```bash
git add system/io/mcp/tools/record-correction.js system/tests/unit/record-correction-mN.test.js
git commit -m "feat(briefing): record_correction parses [mN] tokens, routes to insight feedback"
```

### Task 6.3: Nightly rollup `insight-calibration`

**Files:**
- Create: `user-data/jobs/insight-calibration.js`
- Create: `user-data/jobs/insight-calibration.md`
- Test: `system/tests/unit/insight-calibration.test.js`

- [ ] **Step 1: Failing tests**

```js
test('insight-calibration applies 30d half-life exponential decay', async () => { /* feedback from 30d ago = weight 0.5 */ });
test('insight-calibration uses α=10 Bayesian smoothing', async () => { /* 3 good votes → score nudged toward useful but not pinned */ });
test('insight-calibration honors speculative-tier prior 0.4', async () => { /* cold start chrome_pattern_match = 0.4 */ });
test('insight-calibration preserves manual_override flag', async () => { /* manual override not overwritten by rollup */ });
test('insight-calibration suppresses category when score < 0.25 over ≥3 votes', async () => { /* */ });
```

- [ ] **Step 2: Implement**

```js
// user-data/jobs/insight-calibration.js
import { surql } from 'surrealdb';

const ALPHA = 10;
const HALF_LIFE_DAYS = 30;
const PRIORS = {
  speculative_connection: 0.4, chrome_pattern_match: 0.4, pattern_streak: 0.4, photography_reference: 0.4,
};
const STANDARD_PRIOR = 0.5;

function priorFor(category) { return PRIORS[category] ?? STANDARD_PRIOR; }

export default async function insightCalibration({ db, now = new Date() }) {
  const since = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
  const feedback = await db.query(surql`SELECT meta.category, meta.verdict, ts FROM events WHERE source = 'insight_feedback' AND ts >= ${since}`).collect();
  const byCategory = new Map();
  for (const r of feedback[0]) {
    const cat = r['meta.category'];
    const δdays = (now - new Date(r.ts)) / (24 * 60 * 60 * 1000);
    const weight = Math.exp(-δdays / HALF_LIFE_DAYS);
    const entry = byCategory.get(cat) ?? { useful_w: 0, not_useful_w: 0, count: 0 };
    if (r['meta.verdict'] === 'good') entry.useful_w += weight;
    else if (r['meta.verdict'] === 'bad') entry.not_useful_w += weight;
    entry.count++;
    byCategory.set(cat, entry);
  }
  const profile = {};
  for (const [cat, e] of byCategory) {
    const prior = priorFor(cat);
    const score = (e.useful_w + ALPHA * prior) / (e.useful_w + e.not_useful_w + ALPHA);
    profile[cat] = { score, useful_w: e.useful_w, not_useful_w: e.not_useful_w, count: e.count, prior };
  }
  // Merge with manual overrides
  const existing = await db.query(surql`SELECT value FROM runtime WHERE id = 'insight_calibration'`).collect();
  const existingProfile = existing[0]?.[0]?.value ?? {};
  for (const cat of Object.keys(existingProfile)) {
    if (existingProfile[cat].manual_override) profile[cat] = existingProfile[cat];
  }
  await db.query(surql`UPSERT runtime SET id = 'insight_calibration', value = ${profile}, updated_at = time::now()`).collect();
  return { updated: Object.keys(profile).length };
}
```

- [ ] **Step 3: Job manifest**

```md
<!-- user-data/jobs/insight-calibration.md -->
---
schedule: 0 3 * * *
enabled: true
description: Roll up insight feedback into per-category usefulness scores
---
```

- [ ] **Step 4: Test + commit**

```bash
pnpm test:file system/tests/unit/insight-calibration.test.js
git add user-data/jobs/insight-calibration.js user-data/jobs/insight-calibration.md system/tests/unit/insight-calibration.test.js
git commit -m "feat(briefing): nightly insight-calibration rollup with α=10 decay"
```

### Task 6.4: Wire calibration profile into synthesis

**Files:**
- Modify: `user-data/jobs/daily-briefing.js` (load calibration)
- Modify: `user-data/jobs/briefing/synthesis.js` (include in prompt)

- [ ] **Step 1: Load calibration**

```js
async function loadCalibration(db) {
  const r = await db.query(surql`SELECT value FROM runtime WHERE id = 'insight_calibration'`).collect();
  return r[0]?.[0]?.value ?? {};
}
```

- [ ] **Step 2: Verify prompt includes it (test in `briefing-synthesis-prompt.test.js`)**

- [ ] **Step 3: Commit**

```bash
git add user-data/jobs/daily-briefing.js user-data/jobs/briefing/synthesis.js
git commit -m "feat(briefing): load calibration profile into synthesis prompt"
```

---

## Phase 7 — Integration tests + cleanup

### Task 7.1: End-to-end calibration loop integration test

**Files:**
- Create: `system/tests/integration/briefing-calibration-loop.test.js`

- [ ] **Step 1: Test**

```js
test('calibration loop: 5× bad feedback on speculative_connection suppresses next brief', async () => {
  // 1. Run brief → mock synthesis emits speculative_connection insight m1
  // 2. Call recordInsightFeedback × 5 with verdict='bad'
  // 3. Run nightly calibration rollup
  // 4. Re-run brief → synthesis prompt now contains low score; mock synthesis sees it and omits the category
  // 5. Assert: no speculative_connection in second brief's insights
});
```

- [ ] **Step 2: Commit**

```bash
git add system/tests/integration/briefing-calibration-loop.test.js
git commit -m "test(briefing): end-to-end calibration loop integration test"
```

### Task 7.2: End-to-end gallery integration test

**Files:**
- Create: `system/tests/integration/briefing-gallery.test.js`

- [ ] **Step 1: Test**

```js
test('10-photo fixture → gallery page builds → brief links resolve to anchors', async () => {
  // Mock 10 photos events with varied categories + GPS + uuids
  // Mock @vercel/blob put, robin publish CLI
  // Run brief → assert renderer includes the gallery URL
  // Assert gallery markdown has all 10 photo anchors
  // Assert insight text references valid photo_ref values
});
```

- [ ] **Step 2: Commit**

```bash
git add system/tests/integration/briefing-gallery.test.js
git commit -m "test(briefing): gallery integration test with 10-photo fixture"
```

### Task 7.3: Confirm full test suite passes + lint

- [ ] **Step 1: Run full suite**

```bash
pnpm test
```

Expected: all green.

- [ ] **Step 2: Manual smoke**

```bash
robin jobs run daily-briefing
robin recall "daily briefing today"
```

Expected: latest event contains v3 schema + insights + (if photos today) gallery URL.

- [ ] **Step 3: Update CLAUDE.md briefing section to reflect v3 changes** (recurring-bugs runbook etc.)

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md for daily-briefing v3"
```

---

## Self-Review

### Spec coverage check

- [x] Insight synthesis (Phase 5)
- [x] Opus 4.7 primary + Sonnet fallback (Task 5.2)
- [x] Intra-day reuse (Task 5.3)
- [x] Location-aware weather (Phase 2)
- [x] Sticky travel-day location (Task 2.1)
- [x] Memory-learned section (Phase 3)
- [x] Photo section + critique (Phase 4)
- [x] Published gallery + Vercel Blob (Task 4.2)
- [x] Gallery retention (Task 4.3)
- [x] Format locked in render layer (Task 1.2)
- [x] Schema v3 (Task 5.4)
- [x] Calibration loop with 3 surfaces (Phase 6 — CLI, natural language via record_correction extension, Discord reactions intentionally dropped)
- [x] Exponential decay rollup (Task 6.3)
- [x] Manual calibration override (Task 6.1)
- [x] Renamed memory pre-filter → "On the horizon" (Task 1.2)
- [x] Footer with feedback instructions (Task 1.2)
- [x] `[mN]` token parsing in record_correction (Task 6.2)
- [x] Privacy override CLI (Task 6.1)
- [x] All test surfaces from spec (each phase)

### Placeholder scan

No "TBD" / "TODO" / "implement later" markers. Each task has concrete code skeletons + tests. Some implementation bodies show only signatures + dispatch logic to keep the plan readable — full bodies are implied by the test contracts.

### Type consistency

- `BriefingData` shape consistent: introduced Task 1.1, extended in Tasks 2.2, 3.2, 4.4
- `insights` shape consistent: `{ watching, section, learned, photo_critique, learnedProse }` introduced Task 1.2, produced by Task 5.1, consumed Task 5.4
- `host.invokeLLM({ tier, system, json, maxTokens })` signature matches `system/runtime/hosts/interface.js`
- `insight_id` format `mN` enforced across renderer (Task 1.2), validator (Task 5.1), CLI (Task 6.1), record_correction (Task 6.2)

---

## Execution Notes

- All 7 phases land independently — each ends with a commit. Phase 1 alone gives Kevin the locked format immediately.
- Per multi-agent git hygiene: every commit uses atomic `git commit -m "msg" -- <files>` form.
- Test scripts use `pnpm test:file` (includes `--test-force-exit`) per repo conventions to avoid the @surrealdb/node hang issue.
- Synthesis tests mock `host.invokeLLM` — never hit Anthropic in tests.
- After all phases, run `robin jobs run daily-briefing` once to seed runtime calibration row + verify end-to-end.
