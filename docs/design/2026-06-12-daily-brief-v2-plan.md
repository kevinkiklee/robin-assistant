# Daily Brief v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the overnight brief pipeline: deterministic trend engine, five specialist agents replacing the single dream agent, anti-repetition wrapper, photowalk discovery, and the new ☀️/📈/🌶️ front-matter.

**Architecture:** A pure `computeTrends` module feeds both the 4:00am synthesis (specialists interpret, never compute) and the 4:30am skeleton (trend lines render even when synthesis fails). `synthesize.ts` becomes a sequential 5-agent pipeline (health, money, photography, surprise hunter, day planner) with a ledger guard, namespace-scoped belief proposals, token-overlap dedup against yesterday, and a v2 artifact. A new `photowalks` integration ingests NYC photowalk events rendered in the 📸 section.

**Tech Stack:** Node 24 + TypeScript ESM, better-sqlite3, `node:test` + `assert`, `runAgent` (existing), no new dependencies.

**Spec:** `docs/design/2026-06-12-daily-brief-v2-design.md`

**Spec deviations (agreed rationale):**
- `TrendReport` omits `upcomingDates`/`estateBatch` — the (now-fixed) calendar/horizon/linear skeleton sections already carry these deterministically; specialists read them from the skeleton markdown. YAGNI.
- Pipeline ceiling starts at $2.00 with the shakedown note (existing calibration shows Opus ≈ $0.15/turn; caps are initial values recorded per-agent in the artifact for week-one tuning).

---

## ⚠️ Operational constraints (read before dispatching subagents)

1. **`user-data/` is gitignored.** Most files in this plan live there and CANNOT be committed — "commit" steps apply only to tracked paths (none in this plan except docs). Verification is tests + `pnpm build`, not git.
2. **NO worktree isolation for subagents.** A git worktree does not contain `user-data/`. All subagents edit the MAIN tree at `/Users/iser/workspace/robin/robin-assistant-v3`. Tasks are file-disjoint by design; do not let two agents touch the same file.
3. **Parallel lanes:** Lane 1 = Task 1→2, Lane 2 = Task 3→4, Lane 3 = Task 5→6. Lanes 1–3 run in parallel. Lane 4 (Task 7→8) starts after Tasks 1 and 5 land (imports their types). Task 9 runs last, alone.
4. Run tests with `pnpm exec tsx --test <file>` from the repo root. `pnpm build` + daemon restart happen once, in Task 9 — not per task.
5. Interface types are LOCKED as written here. If an implementing agent believes a type must change, stop and report instead of diverging.

---

### Task 1: Trend engine (`computeTrends`)

**Files:**
- Create: `user-data/extensions/jobs/_shared/trends.ts`
- Create: `user-data/extensions/jobs/_shared/trends.test.ts`

- [ ] **Step 1: Verify payload shapes** (already verified 2026-06-12; re-confirm):

```bash
sqlite3 "file:user-data/state/db/robin.sqlite?mode=ro" \
  "SELECT substr(payload,1,200) FROM events WHERE kind='whoop.recovery' ORDER BY id DESC LIMIT 1;"
sqlite3 "file:user-data/state/db/robin.sqlite?mode=ro" \
  "SELECT substr(payload,1,200) FROM events WHERE kind='lunch_money.transaction' ORDER BY id DESC LIMIT 1;"
```

Expected: whoop has `provisional` (bool), `created_at`, `score.recovery_score`; lunch_money has `amount` (positive number), `is_income` (bool), and a `date` field (fall back to event `ts` if absent on some rows).

- [ ] **Step 2: Write failing tests** in `trends.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openTestDb, seedEvent } from './test-db.ts';
import { computeTrends } from './trends.ts';

const NOW = new Date('2026-06-12T08:00:00.000Z');

function seedRecovery(db: ReturnType<typeof openTestDb>, daysAgo: number, score: number, provisional = false) {
  const ts = new Date(NOW.getTime() - daysAgo * 86_400_000).toISOString();
  seedEvent(db, {
    kind: 'whoop.recovery',
    ts,
    payload: { created_at: ts, provisional, score: { recovery_score: score } },
  });
}

test('trends: whoop 7/30d means exclude provisional in-flight cycles', () => {
  const db = openTestDb();
  for (let d = 1; d <= 10; d += 1) seedRecovery(db, d, 60);
  seedRecovery(db, 0, 95, true); // provisional today — must NOT shift the mean
  const t = computeTrends(db, NOW);
  const rec = t.streams.find((s) => s.stream === 'whoop.recovery');
  assert.ok(rec);
  assert.equal(rec?.d7.mean, 60);
  assert.equal(rec?.latest, 60, 'latest is the freshest FINALIZED cycle');
  assert.match(rec?.note ?? '', /provisional/);
});

test('trends: finance spend pace = mean daily outflow, income excluded', () => {
  const db = openTestDb();
  for (let d = 1; d <= 7; d += 1) {
    const ts = new Date(NOW.getTime() - d * 86_400_000).toISOString();
    seedEvent(db, {
      kind: 'lunch_money.transaction',
      ts,
      payload: { amount: 70, is_income: false, date: ts.slice(0, 10) },
    });
    seedEvent(db, {
      kind: 'lunch_money.transaction',
      ts,
      payload: { amount: 5000, is_income: true, date: ts.slice(0, 10) },
    });
  }
  const t = computeTrends(db, NOW);
  const spend = t.streams.find((s) => s.stream === 'finance.spend_per_day');
  assert.equal(spend?.d7.mean, 70);
});

test('trends: photography cadence carries asOf staleness', () => {
  const db = openTestDb();
  const lastFrame = new Date(NOW.getTime() - 9 * 86_400_000).toISOString();
  seedEvent(db, { kind: 'photos.photo', ts: lastFrame, payload: {} });
  const t = computeTrends(db, NOW);
  assert.equal(t.photography.daysSinceLastFrame, 9);
  assert.equal(t.photography.lastIngestAt, lastFrame);
});

test('trends: empty db returns null means, not crashes', () => {
  const db = openTestDb();
  const t = computeTrends(db, NOW);
  for (const s of t.streams) assert.equal(s.d7.mean, null);
  assert.equal(t.photography.daysSinceLastFrame, null);
});
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm exec tsx --test user-data/extensions/jobs/_shared/trends.test.ts`
Expected: FAIL (cannot find module `./trends.ts`).

- [ ] **Step 4: Implement `trends.ts`**

```ts
// Deterministic trend engine for the daily brief (design Component 1).
// Pure function over the events table — NO LLM, NO I/O beyond the db handle.
// Consumed by dream-synthesis (4:00, specialists interpret these numbers) and
// by the skeleton (4:30, deterministic trend lines + live fallback when the
// artifact is missing). Every datum carries an asOf freshness stamp so agents
// can phrase stale-bounded metrics honestly.

import type { RobinDb } from '../../../../system/brain/memory/db.ts';

export interface TrendWindow {
  mean: number | null;
  n: number;
}

export interface StreamTrend {
  stream: 'whoop.recovery' | 'whoop.sleep_efficiency' | 'finance.spend_per_day';
  /** ISO ts of the freshest underlying datum (null when stream is empty). */
  asOf: string | null;
  /** Freshest single value (finalized cycles only for whoop). */
  latest: number | null;
  d7: TrendWindow;
  d30: TrendWindow;
  d90: TrendWindow;
  note?: string;
}

export interface PhotographyTrend {
  /** ts of the most recent ingested frame (null = none ever). */
  lastIngestAt: string | null;
  daysSinceLastFrame: number | null;
  framesPerWeek4w: number;
}

export interface TrendReport {
  generatedAt: string;
  streams: StreamTrend[];
  photography: PhotographyTrend;
}

const DAY_MS = 86_400_000;

interface Row {
  ts: string;
  payload: string;
}

function rows(db: RobinDb, kinds: string[], sinceIso: string): Array<{ ts: string; p: Record<string, unknown> }> {
  const placeholders = kinds.map(() => '?').join(',');
  const out = db
    .prepare(`SELECT ts, payload FROM events WHERE kind IN (${placeholders}) AND ts >= ? ORDER BY ts DESC LIMIT 2000`)
    .all(...kinds, sinceIso) as Row[];
  return out.map((r) => {
    let p: Record<string, unknown> = {};
    try {
      p = JSON.parse(r.payload) as Record<string, unknown>;
    } catch {
      /* unparseable payload → treated as empty */
    }
    return { ts: r.ts, p };
  });
}

function windowOf(points: Array<{ t: number; v: number }>, nowMs: number, days: number): TrendWindow {
  const cut = nowMs - days * DAY_MS;
  const vals = points.filter((pt) => pt.t >= cut).map((pt) => pt.v);
  if (vals.length === 0) return { mean: null, n: 0 };
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  return { mean: Math.round(mean * 100) / 100, n: vals.length };
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Whoop streams: finalized cycles only (payload.provisional !== true), keyed by payload.created_at. */
function whoopStream(
  db: RobinDb,
  nowMs: number,
  stream: 'whoop.recovery' | 'whoop.sleep_efficiency',
): StreamTrend {
  const kind = stream === 'whoop.recovery' ? 'whoop.recovery' : 'whoop.sleep';
  const all = rows(db, [kind], new Date(nowMs - 90 * DAY_MS).toISOString());
  const points: Array<{ t: number; v: number }> = [];
  let excluded = 0;
  for (const { p } of all) {
    if (p.provisional === true) {
      excluded += 1;
      continue;
    }
    const created = typeof p.created_at === 'string' ? Date.parse(p.created_at) : Number.NaN;
    if (Number.isNaN(created)) continue;
    const score = (p.score ?? {}) as Record<string, unknown>;
    const v =
      stream === 'whoop.recovery' ? num(score.recovery_score) : num(score.sleep_efficiency_percentage);
    if (v === null) continue;
    points.push({ t: created, v });
  }
  // Dedup to the freshest row per measurement-day (re-syncs re-stamp ts; created_at is stable).
  const byDay = new Map<string, { t: number; v: number }>();
  for (const pt of points) {
    const day = new Date(pt.t).toISOString().slice(0, 10);
    const cur = byDay.get(day);
    if (!cur || pt.t > cur.t) byDay.set(day, pt);
  }
  const deduped = [...byDay.values()].sort((a, b) => b.t - a.t);
  const freshest = deduped[0] ?? null;
  return {
    stream,
    asOf: freshest ? new Date(freshest.t).toISOString() : null,
    latest: freshest ? freshest.v : null,
    d7: windowOf(deduped, nowMs, 7),
    d30: windowOf(deduped, nowMs, 30),
    d90: windowOf(deduped, nowMs, 90),
    ...(excluded > 0 ? { note: `${excluded} provisional in-flight cycle(s) excluded` } : {}),
  };
}

/** Mean daily outflow (is_income=false), grouped by payload.date (fallback: event ts date). */
function spendStream(db: RobinDb, nowMs: number): StreamTrend {
  const all = rows(db, ['lunch_money.transaction', 'v2.lunch_money'], new Date(nowMs - 90 * DAY_MS).toISOString());
  const byDay = new Map<string, number>();
  let freshest: string | null = null;
  for (const { ts, p } of all) {
    const meta = (p.meta ?? p) as Record<string, unknown>; // v2 rows nest under meta
    if (meta.is_income === true) continue;
    const amount = num(meta.amount);
    if (amount === null || amount <= 0) continue;
    const day = typeof meta.date === 'string' ? meta.date.slice(0, 10) : ts.slice(0, 10);
    byDay.set(day, (byDay.get(day) ?? 0) + amount);
    if (!freshest || ts > freshest) freshest = ts;
  }
  const points = [...byDay.entries()].map(([day, total]) => ({ t: Date.parse(`${day}T12:00:00Z`), v: total }));
  return {
    stream: 'finance.spend_per_day',
    asOf: freshest,
    latest: points.sort((a, b) => b.t - a.t)[0]?.v ?? null,
    d7: windowOf(points, nowMs, 7),
    d30: windowOf(points, nowMs, 30),
    d90: windowOf(points, nowMs, 90),
  };
}

function photographyTrend(db: RobinDb, nowMs: number): PhotographyTrend {
  const all = rows(db, ['photos.photo', 'v2.photos'], new Date(nowMs - 35 * DAY_MS).toISOString());
  const newest = all[0]?.ts ?? null;
  const fourWeeks = all.filter((r) => Date.parse(r.ts) >= nowMs - 28 * DAY_MS).length;
  return {
    lastIngestAt: newest,
    daysSinceLastFrame: newest ? Math.floor((nowMs - Date.parse(newest)) / DAY_MS) : null,
    framesPerWeek4w: Math.round((fourWeeks / 4) * 10) / 10,
  };
}

export function computeTrends(db: RobinDb, now: Date): TrendReport {
  const nowMs = now.getTime();
  return {
    generatedAt: now.toISOString(),
    streams: [
      whoopStream(db, nowMs, 'whoop.recovery'),
      whoopStream(db, nowMs, 'whoop.sleep_efficiency'),
      spendStream(db, nowMs),
    ],
    photography: photographyTrend(db, nowMs),
  };
}

/** One human-readable line per stream, for the skeleton's section trend lines. */
export function trendLine(t: StreamTrend, unit = ''): string | null {
  if (t.d7.mean === null && t.d30.mean === null) return null;
  const f = (w: TrendWindow) => (w.mean === null ? '—' : `${w.mean}${unit}`);
  const asOf = t.asOf ? ` · as of ${t.asOf.slice(0, 10)}` : '';
  const note = t.note ? ` (${t.note})` : '';
  return `7d ${f(t.d7)} · 30d ${f(t.d30)} · 90d ${f(t.d90)}${asOf}${note}`;
}
```

Note: `whoop.sleep` rows nest efficiency under `score.sleep_efficiency_percentage` (verified shape in the 2026-06-12 session). The test for sleep efficiency is optional; recovery covers the shared path.

- [ ] **Step 5: Run tests to verify pass**

Run: `pnpm exec tsx --test user-data/extensions/jobs/_shared/trends.test.ts`
Expected: PASS (4 tests). If `seedEvent` rejects unknown kinds, check `_shared/test-db.ts` — it seeds raw rows and should accept any kind.

---

### Task 2: Skeleton trend lines (depends on Task 1)

**Files:**
- Modify: `user-data/extensions/jobs/daily-brief/skeleton.ts`
- Modify: `user-data/extensions/jobs/daily-brief/skeleton.test.ts`

- [ ] **Step 1: Write the failing test** (append to `skeleton.test.ts`):

```ts
test('skeleton: trend lines render in whoop/financials/photography when trends provided', async () => {
  const db = openTestDb();
  const trends = {
    generatedAt: NOW.toISOString(),
    streams: [
      { stream: 'whoop.recovery', asOf: '2026-05-23T09:00:00.000Z', latest: 64, d7: { mean: 64, n: 6 }, d30: { mean: 60, n: 27 }, d90: { mean: 58, n: 80 } },
      { stream: 'whoop.sleep_efficiency', asOf: null, latest: null, d7: { mean: null, n: 0 }, d30: { mean: null, n: 0 }, d90: { mean: null, n: 0 } },
      { stream: 'finance.spend_per_day', asOf: '2026-05-23T12:00:00.000Z', latest: 80, d7: { mean: 92, n: 7 }, d30: { mean: 71, n: 30 }, d90: { mean: 65, n: 90 } },
    ],
    photography: { lastIngestAt: '2026-05-15T00:00:00.000Z', daysSinceLastFrame: 9, framesPerWeek4w: 2.5 },
  };
  const skel = await renderSkeleton({ db, now, trends });
  assert.match(skel.sections.whoop, /Trend: 7d 64 · 30d 60/);
  assert.match(skel.sections.financials, /Spend pace: 7d \$92 · 30d \$71/);
  assert.match(skel.sections.photography, /no frames ingested since 2026-05-15 \(9d\)/);
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm exec tsx --test user-data/extensions/jobs/daily-brief/skeleton.test.ts` → FAIL (`trends` not a known dep / no trend line).

- [ ] **Step 3: Implement.** In `skeleton.ts`:

(a) Import at top: `import { computeTrends, trendLine, type TrendReport } from '../_shared/trends.ts';`

(b) Add to `SkeletonDeps`:

```ts
  /**
   * Precomputed trend report (from the synthesis artifact, for freshness
   * consistency with the 4:00 reasoning). Omit → computed live via computeTrends.
   */
  trends?: TrendReport;
```

(c) In `renderSkeleton`, before building `renders`: `const trends = deps.trends ?? computeTrends(db, nowDate);`

(d) Thread `trends` into `renderWhoop`, `renderFinancials`, `renderPhotography` (add a `trends: TrendReport` parameter to each; update the `renders` map call sites). In each renderer, append one line before returning a non-quiet body — and ALSO append to the quiet state (a quiet section with a trend line is the design's whole point):

- `renderWhoop`: after existing lines, find `whoop.recovery` in `trends.streams`; if `trendLine(s, '%')` is non-null push `` `- Trend: ${trendLine(s, '%')}` ``.
- `renderFinancials`: find `finance.spend_per_day`; if non-null push `` `- Spend pace: ${trendLine(s, '').replace(/7d /, '7d $').replace(/30d /, '30d $').replace(/90d /, '90d $')}` `` — or cleaner, build inline: `` `- Spend pace: 7d $${s.d7.mean ?? '—'} · 30d $${s.d30.mean ?? '—'} · 90d $${s.d90.mean ?? '—'}/day` ``.
- `renderPhotography`: when `trends.photography.daysSinceLastFrame !== null && daysSinceLastFrame > 0` push `` `- Cadence: no frames ingested since ${lastIngestAt.slice(0,10)} (${daysSinceLastFrame}d) · ${framesPerWeek4w}/wk over 4w` ``. For quiet photography, REPLACE the quiet one-liner with header + this cadence line when available.

For the quiet variants (`quiet('whoop', …)` etc.), change to build `[quiet(...), trendLineIfAny]` joined by newline.

- [ ] **Step 4: Run the full skeleton test file** — all tests must pass, including the empty-db cardinal-rule test (empty db → `computeTrends` returns null means → no trend lines → quiet states unchanged). Expected: PASS.

---

### Task 3: Photowalks integration

**Files:**
- Create: `user-data/extensions/integrations/photowalks/integration.yaml`
- Create: `user-data/extensions/integrations/photowalks/index.ts`
- Create: `user-data/extensions/integrations/photowalks/index.test.ts`
- Create: `user-data/extensions/integrations/photowalks/fixtures/eventbrite-sample.html` (captured during implementation)

- [ ] **Step 1: integration.yaml**

```yaml
name: photowalks
version: 1.0.0
schedule: '0 9 * * *'
permissions:
  memory:
    write: true
    namespaces: ['photowalks']
  secrets: []
  network:
    - 'www.meetup.com'
    - 'meetup.com'
    - 'www.eventbrite.com'
    - 'eventbrite.com'
```

- [ ] **Step 2: Capture a fixture.** Fetch one real source page and check it embeds schema.org Event JSON-LD:

```bash
curl -sL 'https://www.eventbrite.com/d/ny--new-york/photo-walk/' -H 'User-Agent: Mozilla/5.0' \
  | grep -o 'application/ld+json' | head -2
```

Expected: at least one match. Save the full HTML to `fixtures/eventbrite-sample.html`. If Eventbrite returns 403 to curl, use the Meetup group-events page instead (e.g. `https://www.meetup.com/nycphotographers/events/`) — Meetup event pages embed JSON-LD `Event` objects — and name the fixture accordingly. The parser below is source-agnostic (it parses JSON-LD, not page structure).

- [ ] **Step 3: Write failing tests** (`index.test.ts`):

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractJsonLdEvents, filterWalks } from './index.ts';

const HTML = `<html><script type="application/ld+json">
[{"@type":"Event","name":"Greenwich Village Photo Walk","startDate":"2026-06-20T14:00:00-04:00",
  "url":"https://www.meetup.com/x/123","location":{"@type":"Place","name":"Washington Sq",
  "address":{"addressLocality":"New York"}}},
 {"@type":"Event","name":"Tax Seminar","startDate":"2026-06-21T14:00:00-04:00",
  "url":"https://x.example/1","location":{"address":{"addressLocality":"New York"}}}]
</script></html>`;

test('photowalks: extracts schema.org Event objects from JSON-LD', () => {
  const events = extractJsonLdEvents(HTML);
  assert.equal(events.length, 2);
  assert.equal(events[0]?.name, 'Greenwich Village Photo Walk');
  assert.equal(events[0]?.url, 'https://www.meetup.com/x/123');
});

test('photowalks: filterWalks keeps photo events in the next 28 days with a URL', () => {
  const now = new Date('2026-06-12T08:00:00.000Z');
  const events = extractJsonLdEvents(HTML);
  const walks = filterWalks(events, now);
  assert.equal(walks.length, 1, 'non-photo event dropped');
  assert.equal(walks[0]?.title, 'Greenwich Village Photo Walk');
  assert.equal(walks[0]?.date, '2026-06-20');
  assert.ok(walks[0]?.url, 'every walk carries its URL (Kevin requirement)');
});

test('photowalks: events outside the 28-day window are dropped', () => {
  const now = new Date('2026-08-01T08:00:00.000Z');
  const walks = filterWalks(extractJsonLdEvents(HTML), now);
  assert.equal(walks.length, 0);
});
```

- [ ] **Step 4: Run to verify failure** — `pnpm exec tsx --test user-data/extensions/integrations/photowalks/index.test.ts` → FAIL (module not found).

- [ ] **Step 5: Implement `index.ts`**

```ts
// Photowalk discovery (daily-brief v2 design, Component 6). Fetches NYC event
// listing pages, extracts schema.org JSON-LD Event objects (source-agnostic —
// page redesigns break nothing as long as JSON-LD remains), filters to
// photography walks in the next 28 days, and ingests `photowalks.event` rows.
// Every rendered walk MUST carry its URL — a walk without a link is not
// actionable (Kevin, 2026-06-12).

import type { Integration } from '../../../../system/integrations/_runtime/types.ts';

const SOURCES = [
  'https://www.eventbrite.com/d/ny--new-york/photo-walk/',
  'https://www.meetup.com/nycphotographers/events/',
  'https://www.meetup.com/nyc-shutterbugs/events/',
];

const PHOTO_RE = /photo\s*walk|photowalk|photography|photo\s*stroll|street\s*photo/i;
const WINDOW_DAYS = 28;

export interface JsonLdEvent {
  name?: string;
  startDate?: string;
  url?: string;
  location?: { name?: string; address?: { addressLocality?: string } };
}

export interface Walk {
  title: string;
  date: string; // YYYY-MM-DD (event-local)
  time: string | null;
  location: string | null;
  url: string;
  source: string;
}

/** Pull every JSON-LD block and flatten any @type:Event objects (incl. arrays/@graph). */
export function extractJsonLdEvents(html: string): JsonLdEvent[] {
  const out: JsonLdEvent[] = [];
  const re = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  for (const m of html.matchAll(re)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(m[1] ?? '');
    } catch {
      continue; // malformed block — skip, never kill the tick
    }
    const nodes: unknown[] = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === 'object' && Array.isArray((parsed as { '@graph'?: unknown[] })['@graph'])
        ? ((parsed as { '@graph': unknown[] })['@graph'])
        : [parsed];
    for (const n of nodes) {
      if (!n || typeof n !== 'object') continue;
      const o = n as Record<string, unknown>;
      const type = o['@type'];
      const isEvent = type === 'Event' || (Array.isArray(type) && type.includes('Event'));
      if (isEvent) out.push(o as JsonLdEvent);
    }
  }
  return out;
}

/** Photography-related events with a URL, starting within the next WINDOW_DAYS. */
export function filterWalks(events: JsonLdEvent[], now: Date, source = ''): Walk[] {
  const nowMs = now.getTime();
  const endMs = nowMs + WINDOW_DAYS * 86_400_000;
  const walks: Walk[] = [];
  for (const e of events) {
    if (!e.name || !e.startDate || !e.url) continue;
    if (!PHOTO_RE.test(e.name)) continue;
    const startMs = Date.parse(e.startDate);
    if (Number.isNaN(startMs) || startMs < nowMs - 86_400_000 || startMs > endMs) continue;
    // Event-local date: trust the offset embedded in startDate; slice the date part.
    const date = e.startDate.slice(0, 10);
    const time = e.startDate.includes('T') ? (e.startDate.split('T')[1] ?? '').slice(0, 5) : null;
    walks.push({
      title: e.name.trim(),
      date,
      time,
      location: e.location?.name ?? e.location?.address?.addressLocality ?? null,
      url: e.url,
      source,
    });
  }
  return walks;
}

export const integration: Integration = {
  async tick(ctx) {
    let ingested = 0;
    const errors: string[] = [];
    for (const src of SOURCES) {
      let html: string;
      try {
        const res = await fetch(src, { headers: { 'User-Agent': 'Mozilla/5.0 (robin-assistant)' } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        html = await res.text();
      } catch (err) {
        errors.push(`${src}: ${err instanceof Error ? err.message : String(err)}`);
        continue; // per-source isolation — one source breaking never kills the tick
      }
      const walks = filterWalks(extractJsonLdEvents(html), ctx.now(), new URL(src).hostname);
      for (const w of walks) {
        await ctx.ingest({
          kind: 'integration.tick',
          source: 'photowalks',
          content: `[photowalk] ${w.title} · ${w.date}${w.time ? ` ${w.time}` : ''}${w.location ? ` · ${w.location}` : ''}\n${w.url}`,
          payload: {
            external_id: `photowalk:${w.url}`,
            kind: 'event',
            title: w.title,
            date: w.date,
            time: w.time,
            location: w.location,
            url: w.url,
            walk_source: w.source,
          },
        });
        ingested += 1;
      }
    }
    if (ingested === 0 && errors.length === SOURCES.length) {
      return { status: 'error', message: errors.join(' | ') };
    }
    return { status: 'ok', ingested };
  },

  async health(ctx) {
    const last = ctx.state.get('last_sync');
    return { ok: true, message: last ? `last sync: ${last}` : 'never synced' };
  },
};
```

Note: the runtime normalizes `integration.tick` + `payload.kind='event'` → event kind **`photowalks.event`** (same mechanism as NHL's `nhl.game`, see `system/integrations/_runtime/context.ts`). `external_id` dedup makes daily re-ingestion idempotent. Check `types.ts` for whether `tick` ctx exposes `ctx.now()` — if not (some integrations use `new Date()`), match the NHL integration's pattern exactly.

- [ ] **Step 6: Run tests** — expected PASS (3 tests).

- [ ] **Step 7: Live smoke test** (network):

```bash
pnpm build && launchctl kickstart -k gui/$(id -u)/io.robin-assistant.daemon
```

Then queue a tick via MCP `run {type: integration, name: photowalks}` (or wait for the daemon) and verify rows: `sqlite3 "file:user-data/state/db/robin.sqlite?mode=ro" "SELECT count(*) FROM events WHERE kind='photowalks.event';"` — expected > 0. If a live source yields zero (no JSON-LD), record which, and add its page-specific parser as a follow-up rather than blocking this task.

---

### Task 4: Photography section renders photowalks (depends on Task 3)

**Files:**
- Modify: `user-data/extensions/jobs/daily-brief/skeleton.ts` (renderPhotography)
- Modify: `user-data/extensions/jobs/daily-brief/skeleton.test.ts`

- [ ] **Step 1: Failing test** (append to `skeleton.test.ts`):

```ts
test('skeleton: photography lists upcoming photowalks with URLs, windowed by event date', async () => {
  const db = openTestDb();
  seedEvent(db, {
    kind: 'photowalks.event',
    ts: new Date(NOW.getTime() - 3_600_000).toISOString(),
    payload: { title: 'High Line Walk', date: '2026-05-30', time: '11:00', url: 'https://meetup.com/e/1' },
  });
  seedEvent(db, {
    kind: 'photowalks.event',
    ts: new Date(NOW.getTime() - 3_600_000).toISOString(),
    payload: { title: 'Old Walk', date: '2026-05-20', time: '11:00', url: 'https://meetup.com/e/2' },
  });
  const skel = await renderSkeleton({ db, now });
  assert.match(skel.sections.photography, /\[High Line Walk\]\(https:\/\/meetup\.com\/e\/1\)/);
  assert.match(skel.sections.photography, /Sat 2026-05-30 11:00/);
  assert.doesNotMatch(skel.sections.photography, /Old Walk/, 'past walk (before today) dropped');
});
```

(NOW is 2026-05-24; 2026-05-30 is a Saturday.)

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement.** In `renderPhotography`, after the existing frame/critique content (and after the Task 2 cadence line), query and append:

```ts
  // Upcoming photowalks (next 28 days) — windowed by EVENT date (payload.date),
  // not capture ts. Every walk renders with its URL (a walk without a link is
  // not actionable — Kevin, 2026-06-12). Dedup by url, soonest first, max 5.
  const walkRows = queryEvents(db, ['photowalks.event'], { limit: 100 });
  const today = isoDate(new Date(nowMs));
  const horizon = isoDate(new Date(nowMs + 28 * DAY_MS));
  const seenUrls = new Set<string>();
  const walks: Array<{ title: string; date: string; time: string | null; url: string }> = [];
  for (const r of walkRows) {
    const f = field(r.payload);
    const url = str(f.url);
    const date = str(f.date);
    const title = str(f.title);
    if (!url || !date || !title || seenUrls.has(url)) continue;
    seenUrls.add(url);
    if (date < today || date > horizon) continue;
    walks.push({ title, date, time: str(f.time), url });
  }
  if (walks.length > 0) {
    walks.sort((a, b) => a.date.localeCompare(b.date));
    lines.push('- Upcoming photowalks:');
    for (const w of walks.slice(0, 5)) {
      const dow = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'America/New_York' })
        .format(new Date(`${w.date}T12:00:00-04:00`));
      lines.push(`  - [${w.title}](${w.url}) · ${dow} ${w.date}${w.time ? ` ${w.time}` : ''}`);
    }
  }
```

This requires `renderPhotography` to receive `nowMs` (it currently receives `sinceMs` only) — add the parameter and update the call site. The quiet path also appends walks when present (walks exist ⇒ section is not fully quiet: render header + cadence + walks instead of the quiet line).

- [ ] **Step 4: Run the full skeleton test file → PASS.**

---

### Task 5: Compose v2 front-matter + footer

**Files:**
- Modify: `user-data/extensions/jobs/daily-brief/compose.ts`
- Modify: `user-data/extensions/jobs/daily-brief/compose.test.ts`

- [ ] **Step 1: Failing tests** (append to `compose.test.ts`):

```ts
test('compose: v2 synthesis renders ☀️/📈/🌶️ blocks and the compact footer', async () => {
  const db = openTestDb();
  const skel = await renderSkeleton({ db, now });
  const md = compose(skel, {
    version: 2,
    frontMatter: {
      plan: ['Decide Q2 tax (due Mon 6/15) — 20 min tonight. (💰, see ✅)'],
      trajectories: ['🩺 30-day recovery trending +4 vs May; sleep efficiency is the lagging metric.'],
      surprise: 'Your spend dips 30% on weeks with 2+ photowalks.',
    },
    footer: { predictions: ['KL-12 unmoved through 6/14 (0.8)'], beliefUpdates: ['Estate batch is a deliberate push.'] },
    splicesBySection: { whoop: 'Trend interpretation line.' },
  });
  assert.match(md, /☀️ \*\*Today's plan\*\*/);
  assert.match(md, /📈 \*\*Trajectories\*\*/);
  assert.match(md, /🌶️ \*\*One thing I found\*\*/);
  assert.match(md, /🔮 KL-12 unmoved/);
  assert.match(md, /🧠 Estate batch/);
  assert.ok(!md.includes('🔗 **Relationships'), 'v1 blocks not rendered for v2');
  assert.ok(md.indexOf('🔮 KL-12') > md.indexOf('📸'), 'footer renders after sections');
});

test('compose: v2 empty surprise renders the honest line', async () => {
  const db = openTestDb();
  const skel = await renderSkeleton({ db, now });
  const md = compose(skel, {
    version: 2,
    frontMatter: { plan: [], trajectories: [], surprise: null },
    footer: { predictions: [], beliefUpdates: [] },
    splicesBySection: {},
  });
  assert.match(md, /🌶️ \*\*One thing I found\*\*\n- \(nothing cleared the bar tonight\)/);
});

test('compose: v1 synthesis still renders the legacy four blocks', async () => {
  const db = openTestDb();
  const skel = await renderSkeleton({ db, now });
  const md = compose(skel, {
    frontMatter: { relationships: ['r'], decisions: ['d'], predictions: ['p'], beliefUpdates: ['b'] },
    splicesBySection: {},
  });
  assert.match(md, /🔗 \*\*Relationships I noticed\*\*/);
});
```

- [ ] **Step 2: Run → FAIL** (`version` not assignable / no v2 blocks).

- [ ] **Step 3: Implement.** In `compose.ts` add after the `Synthesis` interface:

```ts
/** v2 synthesis (daily-brief v2 design): ☀️ plan / 📈 trajectories / 🌶️ surprise + compact footer. */
export interface SynthesisV2 {
  version: 2;
  frontMatter: {
    /** ☀️ ≤3 prioritized agenda items, each citing analyst + section anchor. */
    plan: string[];
    /** 📈 one interpretation line per specialist (direction, not numbers). */
    trajectories: string[];
    /** 🌶️ the single quality-barred cross-stream find, or null. */
    surprise: string | null;
  };
  /** Compact 🔮/🧠 footer rendered above the closing bar. */
  footer: { predictions: string[]; beliefUpdates: string[] };
  splicesBySection: Partial<Record<SectionId, string>>;
}

export type AnySynthesis = Synthesis | SynthesisV2;

export function isV2(s: AnySynthesis): s is SynthesisV2 {
  return (s as SynthesisV2).version === 2;
}
```

Change `compose` signature to `synthesis: AnySynthesis | null`. In the non-null branch:

```ts
  } else if (isV2(synthesis)) {
    const fm = synthesis.frontMatter;
    lines.push(block('☀️', "Today's plan", fm.plan), '');
    lines.push(block('📈', 'Trajectories', fm.trajectories), '');
    const surprise = fm.surprise?.trim()
      ? `🌶️ **One thing I found**\n- ${fm.surprise.trim()}`
      : '🌶️ **One thing I found**\n- (nothing cleared the bar tonight)';
    lines.push(surprise, '');
  } else {
    // …existing v1 four-block rendering unchanged…
  }
```

After the sections loop and before the footer-bars push, add:

```ts
  if (synthesis && isV2(synthesis)) {
    const foot: string[] = [];
    if (synthesis.footer.predictions.length > 0) foot.push(`🔮 ${synthesis.footer.predictions.join(' · ')}`);
    if (synthesis.footer.beliefUpdates.length > 0) foot.push(`🧠 ${synthesis.footer.beliefUpdates.join(' · ')}`);
    if (foot.length > 0) lines.push(foot.join('\n'), '');
  }
```

- [ ] **Step 4: Run full compose test file → PASS** (legacy tests must stay green).

---

### Task 6: daily-brief accepts artifact v2 (depends on Tasks 2 & 5)

**Files:**
- Modify: `user-data/extensions/jobs/daily-brief/index.ts`
- Modify: `user-data/extensions/jobs/daily-brief/index.test.ts`

- [ ] **Step 1: Failing test** (append to `index.test.ts`, following the file's existing fake-deps pattern):

```ts
test('daily-brief: v2 artifact renders v2 front-matter and pins trends', async () => {
  // Build a v2 artifact via deps.readArtifact returning:
  // { version: 2, date, generatedAt, synthesis: <SynthesisV2 sample>, datapointsUsed: [],
  //   trends: <TrendReport sample>, agents: [{key:'health', status:'success', costUsd:0.2, turns:4}] }
  // Assert the persisted markdown contains '☀️' and the whoop trend line from the
  // pinned TrendReport (not a live-computed one).
});
```

Write it concretely against the existing test helpers in that file (they already fake `readArtifact`/`notify` and use a seeded db — mirror the adjacent test for the v1 artifact).

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement.** In `index.ts`:

(a) Extend the artifact interface:

```ts
import type { AnySynthesis } from './compose.ts';
import type { TrendReport } from '../_shared/trends.ts';

export interface DreamSynthesisArtifact {
  version?: 2;            // absent = v1
  date: string;
  generatedAt: string;
  synthesis: AnySynthesis;
  datapointsUsed: DataPoint[];
  trends?: TrendReport;   // v2 only — pinned for freshness consistency
  agents?: Array<{ key: string; status: string; costUsd: number; turns: number }>;
}
```

(b) `defaultReadArtifact`: keep all existing guards; additionally pass through `version`, `trends`, `agents` when present (no validation beyond `typeof === 'object'` for trends — the renderer treats a malformed trends as absent).

(c) In `runDailyBrief`, pass pinned trends into the skeleton:

```ts
    const skeleton = await renderSkeleton({
      db: ctx.db,
      now: ctx.now,
      pinnedDatapoints: artifact?.datapointsUsed,
      ...(artifact?.trends ? { trends: artifact.trends } : {}),
    });
```

`compose(skeleton, synthesis)` already accepts `AnySynthesis` after Task 5 — no change needed there.

- [ ] **Step 4: Run full index test file → PASS.**

---

### Task 7: Specialist definitions (depends on Tasks 1 & 5 for types)

**Files:**
- Create: `user-data/extensions/jobs/dream-synthesis/specialists.ts`
- Create: `user-data/extensions/jobs/dream-synthesis/specialists.test.ts`

- [ ] **Step 1: Failing tests:**

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  SPECIALISTS, SPECIALIST_OUTPUT_FORMAT, asSpecialistOutput, filterByNamespace, tokenOverlap, dedupeLines,
} from './specialists.ts';

test('specialists: five specs in pipeline order with namespaces', () => {
  assert.deepEqual(SPECIALISTS.map((s) => s.key), ['health', 'money', 'photography', 'surprise', 'planner']);
  const health = SPECIALISTS[0];
  assert.ok(health?.namespaces.includes('whoop-'));
  assert.ok(health?.namespaces.includes('kevin-health-'));
  assert.equal(SPECIALISTS[3]?.namespaces.length, 0, 'surprise hunter is unrestricted');
});

test('specialists: asSpecialistOutput coerces and rejects junk', () => {
  assert.equal(asSpecialistOutput('not json'), null);
  const out = asSpecialistOutput({
    trajectoryLine: 'x', planCandidates: [{ text: 'do y', deadlineDriven: true }],
    sectionSplices: { whoop: 'line' }, proposedBeliefs: [], proposedPredictions: [], citedEventIds: [1],
  });
  assert.equal(out?.planCandidates[0]?.deadlineDriven, true);
});

test('specialists: filterByNamespace drops out-of-lane proposals', () => {
  const kept = filterByNamespace(
    [{ topic: 'whoop.recovery.x', claim: 'c' }, { topic: 'finance.spend', claim: 'c' }],
    ['whoop-', 'kevin-health-'],
  );
  assert.equal(kept.length, 1);
  assert.equal(kept[0]?.topic, 'whoop.recovery.x');
});

test('specialists: tokenOverlap + dedupeLines drop near-identical lines', () => {
  const a = 'The early-June dip closed on 6/8 and stayed closed';
  const b = 'the early June dip closed on 6/8 and stayed closed.';
  assert.ok(tokenOverlap(a, b) >= 0.6);
  assert.deepEqual(dedupeLines([a, 'totally fresh insight about spend'], [b]), ['totally fresh insight about spend']);
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement `specialists.ts`:**

```ts
// Specialist agent definitions for dream-synthesis v2 (design Component 2).
// Each specialist is a bounded READ-ONLY runAgent with its own goal, tool
// allowlist, belief-topic namespace, and budget. The pipeline in synthesize.ts
// runs them SEQUENTIALLY (latency is irrelevant at 4am; the ledger guard needs
// order) and the deterministic wrapper merges/dedups/writes.

import { normalizeTopic } from '../../../../system/brain/memory/belief.ts';
import type { ProposedBelief, ProposedPrediction } from './synthesize.ts';

export interface PlanCandidate {
  text: string;
  /** Deadline-driven items are EXEMPT from new-or-nothing dedup (repeat until resolved). */
  deadlineDriven: boolean;
}

export interface SpecialistOutput {
  trajectoryLine: string;
  planCandidates: PlanCandidate[];
  sectionSplices: Record<string, string>;
  proposedBeliefs: ProposedBelief[];
  proposedPredictions: ProposedPrediction[];
  citedEventIds: number[];
  /** Surprise hunter only. */
  surprise?: string | null;
  reflection?: string;
  contradictions?: string[];
}

export interface SpecialistCtx {
  date: string;
  trendsJson: string;        // JSON.stringify(TrendReport)
  skeletonMarkdown: string;  // the rendered deterministic skeleton
  recentFrontMatter: string; // last 3 briefs' front-matter, labeled by date
  surpriseLedger: string[];  // hunter only — every previously surfaced surprise
}

export interface SpecialistSpec {
  key: 'health' | 'money' | 'photography' | 'surprise' | 'planner';
  emoji: string;
  maxTurns: number;
  maxBudgetUsd: number;
  /** Kebab-normalized topic prefixes this agent may propose beliefs under ([] = any). */
  namespaces: string[];
  allowedTools: string[];
  buildGoal(ctx: SpecialistCtx): string;
}

const MEMORY_READS = [
  'mcp__robin__recall', 'mcp__robin__recall_belief', 'mcp__robin__list',
  'mcp__robin__find_entity', 'mcp__robin__audit', 'mcp__robin__metrics',
];

const COVENANT = `
STYLE COVENANT (all outputs): calibrated, no cheerleading; complete sentences;
"new or nothing" — if the last 3 briefs (below) already said it, return nothing
for that slot. You are READ-ONLY: no write tools; RETURN proposals, a
deterministic wrapper disposes them. Beliefs are DIFFS against the current
recall_belief head, reflecting multi-day patterns — never nightly restatements.
Cite the event ids you used in citedEventIds. DATA TRUST: Plaid balances may be
STALE — never assert a payment failed from a balance; cross-check transactions.
Trend numbers are precomputed and authoritative — interpret them, do not
recompute. Honor each datum's asOf stamp: phrase stale-bounded metrics honestly
("no frames ingested since the 6/9 sync"), never as live facts.`;

function common(ctx: SpecialistCtx): string {
  return [
    `Date: ${ctx.date}`, '',
    '=== PRECOMPUTED TRENDS (authoritative — interpret, never recompute) ===',
    ctx.trendsJson, '',
    '=== LAST 3 BRIEFS FRONT-MATTER (for the new-or-nothing rule) ===',
    ctx.recentFrontMatter, '',
    '=== TODAY\'S DETERMINISTIC SKELETON ===',
    ctx.skeletonMarkdown,
  ].join('\n');
}

export const SPECIALISTS: SpecialistSpec[] = [
  {
    key: 'health', emoji: '🩺', maxTurns: 6, maxBudgetUsd: 0.45,
    namespaces: ['whoop-', 'kevin-health-'],
    allowedTools: MEMORY_READS,
    buildGoal: (ctx) => [
      'You are the HEALTH analyst for Kevin\'s daily brief.', COVENANT, '',
      'Use FINALIZED whoop cycles only (the trends already exclude provisional).',
      'For medication context, Read user-data/content/knowledge/medical/medications.md',
      '(the canonical file — never trust belief snippets for meds).',
      'Return: one trajectoryLine (where health is HEADING over weeks and why —',
      'direction and driver, not numbers), 0-2 planCandidates (training-load or',
      'sleep advice anchored to finalized cycles + trend, marked deadlineDriven',
      'only if a hard date exists), an optional whoop sectionSplice, and belief',
      'proposals ONLY under whoop.* / kevin.health.*.', '',
      common(ctx),
    ].join('\n'),
  },
  {
    key: 'money', emoji: '💰', maxTurns: 6, maxBudgetUsd: 0.45,
    namespaces: ['finance-'],
    allowedTools: [...MEMORY_READS, 'mcp__robin-extension__linear'],
    buildGoal: (ctx) => [
      'You are the MONEY analyst for Kevin\'s daily brief.', COVENANT, '',
      'Spend pace vs norm comes from the trends; the estate/finance batch state',
      'comes from the skeleton\'s ✅ Linear section (follow a thread via the linear',
      'tool only if something needs depth). Return: one trajectoryLine (monthly',
      'arc + estate-batch direction), 0-2 planCandidates (dated items like tax',
      'deadlines are deadlineDriven:true), an optional financials sectionSplice,',
      'and belief proposals ONLY under finance.*.', '',
      common(ctx),
    ].join('\n'),
  },
  {
    key: 'photography', emoji: '📷', maxTurns: 6, maxBudgetUsd: 0.45,
    namespaces: ['kevin-photography-', 'project-'],
    allowedTools: MEMORY_READS,
    buildGoal: (ctx) => [
      'You are the PHOTOGRAPHY analyst for Kevin\'s daily brief.', COVENANT, '',
      'FIRST Read user-data/content/knowledge/photo-baseline-already-doing.md and',
      'treat everything in it as already-mastered ground. Kevin is an advanced',
      'practitioner: mechanism-level insight or NOTHING — if a suggestion would',
      'appear in a beginners\' street-photography article, return empty. Never',
      'push publishing/competitions. His practice is solitary by design: upcoming',
      'photowalks (in the skeleton\'s 📸 section, with URLs) are options to',
      'surface, never obligations. Pair shooting cadence (trends) with the',
      'skeleton\'s weather/light windows and photowalks. Return: one',
      'trajectoryLine, 0-2 planCandidates (e.g. a specific golden-hour outing or',
      'a linked photowalk), an optional photography sectionSplice, and belief',
      'proposals ONLY under kevin.photography.* / project.*.', '',
      common(ctx),
    ].join('\n'),
  },
  {
    key: 'surprise', emoji: '🌶️', maxTurns: 8, maxBudgetUsd: 0.45,
    namespaces: [],
    allowedTools: [...MEMORY_READS, 'mcp__robin__journal', 'mcp__robin__review_beliefs'],
    buildGoal: (ctx) => [
      'You are the SURPRISE HUNTER for Kevin\'s daily brief.', COVENANT, '',
      'Hunt ONE genuinely surprising cross-stream connection via recall. QUALITY',
      'BAR (all required): connects >=2 streams; verifiable from cited event ids;',
      'NOT in the surprise ledger below; Kevin could NOT have seen it in any',
      'single brief section. Returning surprise:null is a GOOD outcome — empty',
      'beats weak. Also write `reflection` (2-4 honest sentences: corrections 7d',
      'via audit, prediction calibration via audit+metrics) and `contradictions`',
      '(enumerate recall_belief no-topic; list real conflicts only).', '',
      '=== SURPRISE LEDGER (everything previously surfaced — never repeat) ===',
      ctx.surpriseLedger.map((s) => `- ${s}`).join('\n') || '(empty)', '',
      common(ctx),
    ].join('\n'),
  },
  {
    key: 'planner', emoji: '☀️', maxTurns: 6, maxBudgetUsd: 0.5,
    namespaces: [],
    allowedTools: ['mcp__robin__recall', 'mcp__robin__list', 'mcp__robin-extension__google_calendar', 'mcp__robin-extension__linear'],
    buildGoal: (ctx) => [
      'You are Kevin\'s CHIEF OF STAFF composing today\'s plan.', COVENANT, '',
      'Below are the specialist outputs (their planCandidates) plus the skeleton',
      '(calendar/inbox/linear/horizon/weather). Pick <=3 items, ordered by',
      'consequence x time-sensitivity. A hard deadline beats a photo outing.',
      'Health items anchor to finalized cycles/trend, never the provisional',
      'morning score. Each item cites its analyst emoji + a section anchor',
      '("(💰, see ✅)"). Put them in planCandidates (deadlineDriven as',
      'appropriate); you may also splice calendar/inbox/linear/horizon/weather.',
      'No belief proposals (namespaces: none).', '',
      common(ctx),
    ].join('\n'),
  },
];

export const SPECIALIST_OUTPUT_FORMAT = {
  type: 'json_schema',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['trajectoryLine', 'planCandidates', 'sectionSplices', 'proposedBeliefs', 'proposedPredictions', 'citedEventIds'],
    properties: {
      trajectoryLine: { type: 'string' },
      planCandidates: {
        type: 'array',
        items: {
          type: 'object', additionalProperties: false, required: ['text', 'deadlineDriven'],
          properties: { text: { type: 'string' }, deadlineDriven: { type: 'boolean' } },
        },
      },
      sectionSplices: { type: 'object', additionalProperties: { type: 'string' } },
      proposedBeliefs: {
        type: 'array',
        items: {
          type: 'object', additionalProperties: false, required: ['topic', 'claim'],
          properties: {
            topic: { type: 'string' }, claim: { type: 'string' },
            confidence: { type: 'number' }, sources: { type: 'array', items: { type: 'number' } },
          },
        },
      },
      proposedPredictions: {
        type: 'array',
        items: {
          type: 'object', additionalProperties: false, required: ['claim', 'confidence'],
          properties: {
            claim: { type: 'string' }, confidence: { type: 'number' },
            deadline: { type: 'string' }, resolutionMethod: { type: 'string' },
          },
        },
      },
      citedEventIds: { type: 'array', items: { type: 'number' } },
      surprise: { type: ['string', 'null'] },
      reflection: { type: 'string' },
      contradictions: { type: 'array', items: { type: 'string' } },
    },
  },
} as const;

/** Coerce an agent result (object or JSON string) into a SpecialistOutput, or null. */
export function asSpecialistOutput(raw: unknown): SpecialistOutput | null {
  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    try { parsed = JSON.parse(raw.trim()); } catch { return null; }
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const s = parsed as Record<string, unknown>;
  const strArr = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  const splices: Record<string, string> = {};
  if (s.sectionSplices && typeof s.sectionSplices === 'object') {
    for (const [k, v] of Object.entries(s.sectionSplices as Record<string, unknown>)) {
      if (typeof v === 'string' && v.trim()) splices[k] = v;
    }
  }
  return {
    trajectoryLine: typeof s.trajectoryLine === 'string' ? s.trajectoryLine : '',
    planCandidates: Array.isArray(s.planCandidates)
      ? (s.planCandidates as unknown[])
          .filter((c): c is Record<string, unknown> => !!c && typeof c === 'object')
          .map((c) => ({
            text: typeof c.text === 'string' ? c.text : '',
            deadlineDriven: c.deadlineDriven === true,
          }))
          .filter((c) => c.text.trim().length > 0)
      : [],
    sectionSplices: splices,
    proposedBeliefs: Array.isArray(s.proposedBeliefs)
      ? (s.proposedBeliefs as unknown[])
          .filter((b): b is Record<string, unknown> => !!b && typeof b === 'object')
          .map((b) => ({
            topic: typeof b.topic === 'string' ? b.topic : '',
            claim: typeof b.claim === 'string' ? b.claim : '',
            ...(typeof b.confidence === 'number' ? { confidence: b.confidence } : {}),
            ...(Array.isArray(b.sources) ? { sources: (b.sources as unknown[]).filter((n): n is number => typeof n === 'number') } : {}),
          }))
          .filter((b) => b.topic && b.claim)
      : [],
    proposedPredictions: Array.isArray(s.proposedPredictions)
      ? (s.proposedPredictions as unknown[])
          .filter((p): p is Record<string, unknown> => !!p && typeof p === 'object')
          .map((p) => ({
            claim: typeof p.claim === 'string' ? p.claim : '',
            confidence: typeof p.confidence === 'number' ? p.confidence : 0.5,
            ...(typeof p.deadline === 'string' ? { deadline: p.deadline } : {}),
            ...(typeof p.resolutionMethod === 'string' ? { resolutionMethod: p.resolutionMethod } : {}),
          }))
          .filter((p) => p.claim)
      : [],
    citedEventIds: Array.isArray(s.citedEventIds)
      ? (s.citedEventIds as unknown[]).filter((n): n is number => typeof n === 'number')
      : [],
    ...(typeof s.surprise === 'string' || s.surprise === null ? { surprise: s.surprise as string | null } : {}),
    ...(typeof s.reflection === 'string' ? { reflection: s.reflection } : {}),
    ...(Array.isArray(s.contradictions) ? { contradictions: strArr(s.contradictions) } : {}),
  };
}

/** Drop belief proposals outside the agent's namespace ([] = unrestricted). */
export function filterByNamespace(proposals: ProposedBelief[], namespaces: string[]): ProposedBelief[] {
  if (namespaces.length === 0) return proposals;
  return proposals.filter((p) => {
    const t = normalizeTopic(p.topic);
    return namespaces.some((ns) => t === ns.slice(0, -1) || t.startsWith(ns));
  });
}

/** |shared tokens| / |smaller token set|, over lowercase word tokens len>=3. */
export function tokenOverlap(a: string, b: string): number {
  const tok = (s: string) => new Set(s.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []);
  const ta = tok(a);
  const tb = tok(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared += 1;
  return shared / Math.min(ta.size, tb.size);
}

/** Keep lines whose overlap with EVERY `against` line is < threshold. */
export function dedupeLines(lines: string[], against: string[], threshold = 0.6): string[] {
  return lines.filter((l) => against.every((a) => tokenOverlap(l, a) < threshold));
}
```

- [ ] **Step 4: Run tests → PASS** (4 tests).

Note: the health/photography goals tell the agent to `Read` knowledge files — the builtin `Read` is available because only WRITE builtins are in `disallowedTools` (existing invariant in `synthesize.ts`).

---

### Task 8: Pipeline rework in `synthesize.ts` (depends on Tasks 1, 5, 7)

**Files:**
- Modify: `user-data/extensions/jobs/dream-synthesis/synthesize.ts`
- Modify: `user-data/extensions/jobs/dream-synthesis/synthesize.test.ts`

- [ ] **Step 1: Failing tests** (append; follow the file's existing fake-runAgent pattern — `synthesize.test.ts` already fakes `runAgent`, `openDeps`, `readStaged`):

```ts
// Test A: pipeline runs 5 agents sequentially; outputs merge into a v2 artifact
//   - fake runAgent returns a canned SpecialistOutput per call (inspect input.goal
//     to tell which specialist; e.g. /HEALTH analyst/ → health output)
//   - assert artifact JSON has version:2, frontMatter.plan from the planner,
//     trajectories in specialist order, agents[] with 5 entries + costUsd
// Test B: ledger guard — fake ledger near cap after 2 agents → agents 3-5 status
//   'skipped-budget', artifact still written with available trajectories,
//   planner ALWAYS runs (protected: it is attempted even when specialists were
//   skipped, using whatever outputs exist)
// Test C: namespace enforcement — health output proposing topic 'finance.x' is
//   dropped before disposeBeliefs (assert beliefsCommitted/staged count excludes it)
// Test D: dedup — fake yesterday's brief file containing a line; a specialist
//   trajectoryLine with >=0.6 overlap is dropped; deadlineDriven planCandidate
//   with overlap is KEPT
// Test E: surprise ledger — hunter's surprise appends to
//   state/runtime/surprise-ledger.json, capped at 90
// Test F: one specialist runAgent throws → its slot is status 'error', pipeline
//   continues, artifact written
```

Write each concretely with the existing fakes (use a temp dir for `userDataDir` as the current tests do).

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement.** Key changes to `synthesize.ts` (keep `disposeBeliefs`, `commitPredictions`, `composeJournal`, `upsertJournal` as-is):

(a) New imports:

```ts
import { computeTrends, type TrendReport } from '../_shared/trends.ts';
import {
  SPECIALISTS, SPECIALIST_OUTPUT_FORMAT, asSpecialistOutput, filterByNamespace, dedupeLines,
  type SpecialistOutput, type SpecialistCtx,
} from './specialists.ts';
import type { SynthesisV2 } from '../daily-brief/compose.ts';
```

(b) Pipeline constants + helpers:

```ts
const PIPELINE_BUDGET_USD = 2.0;     // hard ceiling; per-agent caps live in SPECIALISTS
const PER_AGENT_TIMEOUT_MS = 6 * 60_000; // whole pipeline must land well before 4:30

export interface AgentRecord { key: string; status: string; costUsd: number; turns: number }

/** Front-matter region of a persisted brief: lines between the header bar block and the first ── rule. */
export function extractFrontMatter(briefMarkdown: string): string[] {
  const lines = briefMarkdown.split('\n');
  const ruleIdx = lines.findIndex((l) => l.startsWith('─'.repeat(10)));
  if (ruleIdx < 0) return [];
  return lines.slice(0, ruleIdx).filter((l) => l.startsWith('- ') || /^\d+\./.test(l.trim()));
}

/** Read the last `n` briefs' front-matter, labeled by date. Missing files skip silently. */
export function loadRecentFrontMatter(userDataDir: string, date: string, n = 3): string {
  const out: string[] = [];
  for (let i = 1; i <= n; i += 1) {
    const d = new Date(`${date}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() - i);
    const day = d.toISOString().slice(0, 10);
    try {
      const body = readFileSync(join(userDataDir, 'content', 'briefs', `daily-brief-${day}.md`), 'utf8');
      const fm = extractFrontMatter(body);
      if (fm.length > 0) out.push(`[${day}]`, ...fm);
    } catch { /* missing brief — fine */ }
  }
  return out.join('\n') || '(no recent briefs)';
}

const LEDGER_PATH = (userDataDir: string) => join(userDataDir, 'state', 'runtime', 'surprise-ledger.json');

export function loadSurpriseLedger(userDataDir: string): string[] {
  try {
    const parsed = JSON.parse(readFileSync(LEDGER_PATH(userDataDir), 'utf8')) as unknown;
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch { return []; }
}

export function appendSurpriseLedger(userDataDir: string, text: string): void {
  const all = [...loadSurpriseLedger(userDataDir), text].slice(-90);
  mkdirSync(dirname(LEDGER_PATH(userDataDir)), { recursive: true });
  writeFileSync(LEDGER_PATH(userDataDir), JSON.stringify(all, null, 1), 'utf8');
}
```

(c) Replace the single-agent section of `runSynthesis` with the pipeline (the surrounding staging/db/fail scaffolding stays):

```ts
    const trends = computeTrends(db, now());
    const recentFrontMatter = loadRecentFrontMatter(userDataDir, staged.date);
    const surpriseLedger = loadSurpriseLedger(userDataDir);
    const baseCtx: SpecialistCtx = {
      date: staged.date,
      trendsJson: JSON.stringify(trends),
      skeletonMarkdown: staged.skeleton.markdown,
      recentFrontMatter,
      surpriseLedger,
    };

    const outputs = new Map<string, SpecialistOutput>();
    const agentRecords: AgentRecord[] = [];
    let spent = 0;

    for (const spec of SPECIALISTS) {
      // Planner is protected: always attempted. Specialists skip when the
      // remaining pipeline budget can't cover their cap.
      if (spec.key !== 'planner' && spent + spec.maxBudgetUsd > PIPELINE_BUDGET_USD) {
        agentRecords.push({ key: spec.key, status: 'skipped-budget', costUsd: 0, turns: 0 });
        continue;
      }
      const goal =
        spec.key === 'planner'
          ? `${spec.buildGoal(baseCtx)}\n\n=== SPECIALIST OUTPUTS ===\n${JSON.stringify(
              Object.fromEntries(
                [...outputs.entries()].map(([k, o]) => [k, { trajectoryLine: o.trajectoryLine, planCandidates: o.planCandidates }]),
              ),
            )}`
          : spec.buildGoal(baseCtx);
      let result: RunAgentResult;
      try {
        result = await run(
          {
            surface: 'agentic-autonomous',
            goal,
            cwd: repoRoot,
            allowedTools: spec.allowedTools,
            disallowedTools: ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash', 'KillBash'],
            permissionMode: 'default',
            maxTurns: spec.maxTurns,
            timeoutMs: PER_AGENT_TIMEOUT_MS,
            maxBudgetUsd: spec.maxBudgetUsd,
            mcpServers: mcpServersForRun(spec.allowedTools, { repoRoot, userDataDir }),
            outputFormat: SPECIALIST_OUTPUT_FORMAT,
          },
          { ledger, cap, transcriptDir: join(userDataDir, 'agent-runs'), now },
        );
      } catch (err) {
        result = { status: 'error', summary: String(err), turns: 0, usage: { inputTokens: 0, outputTokens: 0 }, costUsd: 0 };
      }
      spent += result.costUsd;
      const out = result.status === 'success' ? asSpecialistOutput(result.structured ?? result.summary) : null;
      agentRecords.push({ key: spec.key, status: out ? 'success' : result.status === 'success' ? 'unusable-output' : result.status, costUsd: result.costUsd, turns: result.turns });
      if (out) outputs.set(spec.key, out);
    }

    if (outputs.size === 0) {
      log('dream synthesis v2: no agent produced usable output — skeleton-only');
      return fail('no specialist produced usable output', 'skeleton-only');
    }

    // ── Deterministic merge + dedup (no LLM). ──────────────────────────────
    const yesterdayLines = recentFrontMatter.split('\n').filter((l) => l.startsWith('- '));
    const order = ['health', 'money', 'photography', 'surprise'] as const;
    const trajectories = dedupeLines(
      order.map((k) => outputs.get(k)?.trajectoryLine ?? '').filter((l) => l.trim().length > 0),
      yesterdayLines,
    );
    const hunter = outputs.get('surprise');
    const rawSurprise = hunter?.surprise ?? null;
    const surprise =
      rawSurprise && dedupeLines([rawSurprise], [...yesterdayLines, ...surpriseLedger]).length > 0
        ? rawSurprise
        : null;
    const planner = outputs.get('planner');
    const planSource = planner?.planCandidates ?? [...outputs.values()].flatMap((o) => o.planCandidates);
    const plan = planSource
      .filter((c) => c.deadlineDriven || dedupeLines([c.text], yesterdayLines).length > 0)
      .map((c) => c.text)
      .slice(0, 3);

    const splices: Record<string, string> = {};
    for (const o of outputs.values()) {
      for (const [sec, line] of Object.entries(o.sectionSplices)) {
        if (!splices[sec] && dedupeLines([line], yesterdayLines).length > 0) splices[sec] = line;
      }
    }

    const allBeliefs = [...outputs.entries()].flatMap(([key, o]) => {
      const spec = SPECIALISTS.find((s) => s.key === key);
      return filterByNamespace(o.proposedBeliefs, spec?.namespaces ?? []);
    });
    // Same-topic duplicates collapse to highest confidence.
    const byTopic = new Map<string, ProposedBelief>();
    for (const b of allBeliefs) {
      const k = normalizeTopic(b.topic);
      const cur = byTopic.get(k);
      if (!cur || (b.confidence ?? 0) > (cur.confidence ?? 0)) byTopic.set(k, b);
    }
    const allPredictions = [...outputs.values()].flatMap((o) => o.proposedPredictions);

    const beliefs = disposeBeliefs(db, [...byTopic.values()], staged.date);
    const predictionsCommitted = commitPredictions(db, allPredictions, staged.date);
    if (surprise) appendSurpriseLedger(userDataDir, surprise);

    const synthesis: SynthesisV2 = {
      version: 2,
      frontMatter: { plan, trajectories, surprise },
      footer: {
        predictions: allPredictions.map((p) => `${p.claim} (${p.confidence})`).slice(0, 3),
        beliefUpdates: [...byTopic.values()].map((b) => b.claim).slice(0, 3),
      },
      splicesBySection: splices as SynthesisV2['splicesBySection'],
    };

    upsertJournal(db, staged.date, composeJournal(staged.date, {
      synthesis: {
        frontMatter: { relationships: trajectories, decisions: plan, predictions: synthesis.footer.predictions, beliefUpdates: synthesis.footer.beliefUpdates },
        splicesBySection: splices as never,
      },
      proposedBeliefs: [...byTopic.values()],
      proposedPredictions: allPredictions,
      reflection: hunter?.reflection ?? '',
      contradictions: hunter?.contradictions ?? [],
    }));
```

(d) Artifact write — extend `writeArtifactAtomic` with two trailing optional params `trends?: TrendReport, agents?: AgentRecord[]` and include `version: 2` in the JSON body when `trends` is provided. The call site passes `trends` and `agentRecords`. (Datapoint dedup-to-latest logic stays.)

(e) Update the success log + notify message to include per-agent statuses, e.g. `agents: health=success money=success photography=skipped-budget …`.

(f) Delete `buildGoal`, `DREAM_OUTPUT_FORMAT`, `scaleByVolume` and their imports if now unused — but ONLY if `index.ts`/tests don't reference them; otherwise leave with a deprecation comment. Keep `asDreamResult` (tests reference it) with a comment that v1 parsing remains for the legacy tests.

- [ ] **Step 4: Run** `pnpm exec tsx --test user-data/extensions/jobs/dream-synthesis/synthesize.test.ts` — new tests pass; fix/retire legacy single-agent tests that assert the old pipeline (rewrite them against the new flow rather than deleting coverage: the belief-tiering, prediction-idempotency, and artifact-atomicity tests all still apply).

---

### Task 9: Protocol doc, integration pass, build + deploy

**Files:**
- Modify: `user-data/extensions/jobs/dream-synthesis/prompt.md`
- Modify: `user-data/extensions/jobs/daily-brief/index.test.ts` (full-pipeline integration test, if not covered in Task 6)
- Tracked-file commits: none (all user-data) — docs only if spec changed.

- [ ] **Step 1: Rewrite `prompt.md`** as the v2 protocol reference: keep the Operating-loop framing but document the five-specialist pipeline, the shared covenant (it now lives in `specialists.ts` — prompt.md becomes the human-readable description, explicitly noting the code is canonical), belief namespaces + tiering note, the surprise quality bar, and the dedup/deadline-exemption rules. Remove `birding` from the valid splice ids list (the section was removed 2026-06-12); valid ids: watching, learned, calendar, inbox, linear, nhl, financials, markets, whoop, weather, photography, horizon.

- [ ] **Step 2: Full test sweep**

Run: `pnpm exec tsx --test user-data/extensions/jobs/_shared/trends.test.ts user-data/extensions/jobs/daily-brief/*.test.ts user-data/extensions/jobs/dream-synthesis/*.test.ts user-data/extensions/integrations/photowalks/index.test.ts`
Expected: ALL PASS. Then `pnpm typecheck` → clean. Then `pnpm test` → no regressions elsewhere.

- [ ] **Step 3: Build + restart daemon**

```bash
pnpm build
launchctl kickstart -k gui/$(id -u)/io.robin-assistant.daemon
```

(MCP servers stay stale until session restart — verify via daemon, not MCP tools.)

- [ ] **Step 4: Live shakedown.** Manually trigger the dream job (`run {type: 'dream'}` via MCP or wait for 4:00am), then inspect:
- `user-data/state/runtime/dream-synthesis-<date>.json` — `version: 2`, `agents[]` statuses + spend
- next morning's `content/briefs/daily-brief-<date>.md` — ☀️/📈/🌶️ render, trend lines present, photowalks listed with URLs
- Record per-agent actual spend/turns for the week-one cap calibration noted in the spec.

---

## Self-review checklist (done at planning time)

- Spec coverage: trend engine (T1/T2), specialists + namespaces + budget guard (T7/T8), wrapper dedup + surprise ledger + deadline exemption (T7/T8), v2 front-matter + footer (T5), artifact v2 + renderer fallback (T6), photowalks + URL requirement (T3/T4), prompt/protocol + splice ids (T9), shakedown (T9). Deviations declared in header.
- Types consistent across tasks: `TrendReport`/`StreamTrend` (T1) used in T2/T6/T8; `SynthesisV2`/`AnySynthesis` (T5) used in T6/T8; `SpecialistOutput`/`PlanCandidate` (T7) used in T8; `ProposedBelief`/`ProposedPrediction` reused from existing `synthesize.ts`.
- No placeholders: every code step carries real code; Task 6/8 test steps reference concrete existing fakes in the named files.
