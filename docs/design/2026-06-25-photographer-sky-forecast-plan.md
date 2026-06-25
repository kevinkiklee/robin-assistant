# Photographer Sky Forecast Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring PhotoSignal-grade directional sky intelligence into Robin — an enriched daily-brief "Weather & light" section plus proactive macOS light-alerts (colourful sunrise/sunset, fog-near-sunrise, rain-clearing).

**Architecture:** A pure `system/lib/sky/` engine (cloud-layer + sun-azimuth directional reasoning), consumed by two thin clients: the re-sourced `weather` integration tick (Open-Meteo fetch → engine → enriched event + alert firing) and the brief skeleton (renders the pre-computed payload, zero network). Mirrors the existing `system/lib/solar.ts` library pattern.

**Tech Stack:** Node.js 24+, ESM, TypeScript, `node:test` + `assert`, better-sqlite3. Data source: Open-Meteo Forecast API (no key). Spec: `docs/design/2026-06-25-photographer-sky-forecast-design.md`.

## Global Constraints

- ESM imports use explicit `.ts` extensions (codebase convention).
- Tests collocated: `foo.ts` → `foo.test.ts`, `node:test` + `assert`. Run one file: `pnpm exec tsx --test <file>`.
- The brief skeleton is a **zero-LLM, zero-network deterministic renderer** — it only reads the event payload; never fetch inside it.
- All `why`/`caution`/notification strings are **templated from structured fields** (no LLM).
- Pure engine modules (`system/lib/sky/*`) must do **no network and no I/O** — they take data in, return values out (network lives only in the tick).
- Open-Meteo request units: `temperature_unit=fahrenheit`, `wind_speed_unit=mph`, `timezone=auto`.
- Display timezone in the brief is fixed `America/New_York` (existing `fmtTime` default).
- Banded color verdicts only — **never** a numeric "shoot quality" score (the fog index stays numeric; that scores a measurable condition).
- Deploy after merge: `pnpm build` → daemon restart → MCP server restart.
- Tunable thresholds live in `system/lib/sky/constants.ts` — no magic numbers inline.

## File Structure

```
system/lib/sky/
  types.ts        CloudLayers, SamplePoint, SkyContext, ColorRead, RecipeMatch, Notification
  constants.ts    SKY config block (origin, distances, thresholds, lead bands)
  geo.ts          destPoint(), samplePoints() — spherical forward-geodesic sampling
  clouds.ts       canvasCover(), layer helpers — pure layer→read
  directional.ts  skyContext() — SamplePoint[] + azimuth → SkyContext (classify)
  color.ts        colorRead() — SkyContext → ColorRead (deterministic templating)
  recipes.ts      matchRecipes() — ColorReads + fog + precip → RecipeMatch[] (+ lead gate, merge)
  deliver.ts      deliver(), fireMatches() — dedup via alert-store, notify, silent-cancel
  + *.test.ts collocated
system/lib/solar.ts            ADD sunBearings()
system/integrations/builtin/weather/
  index.ts          REWRITE tick: Open-Meteo fetch + engine + enriched event + fireMatches()
  integration.yaml  cron "0 4,12,14,16,18,20"; add lat/lng + skyContext/skyAlerts flags
  fog.ts            RE-SOURCE to Open-Meteo hourly arrays (+ wmoText() code→desc map)
user-data/extensions/jobs/daily-brief/skeleton.ts
  renderWeather()   REWRITE to read enriched payload (proportional disclosure, tiered degradation)
```

## Dependency Waves (for parallel subagent dispatch)

Subagents in the same wave edit **disjoint files** — safe to run concurrently. Review each task's gate before starting the next wave.

- **Wave A (foundation):** Task 1 (`types.ts` + `constants.ts`). Blocks all.
- **Wave B (6 parallel):** Task 2 `solar.sunBearings` · Task 3 `geo.ts` · Task 4 `clouds.ts` · Task 6 `color.ts` · Task 7 `recipes.ts` · Task 8 `fog.ts` re-source. (Each depends only on Wave A.)
- **Wave C (2 parallel):** Task 5 `directional.ts` (needs geo+clouds) · Task 9 `deliver.ts` (needs alert-store+notify+recipes types).
- **Wave D:** Task 10 `weather/index.ts` + `integration.yaml` (needs all of A–C; defines the event payload).
- **Wave E:** Task 11 `skeleton.renderWeather` (needs Task 10's payload shape).

---

### Task 1: Shared types + constants (Wave A)

**Files:**
- Create: `system/lib/sky/types.ts`
- Create: `system/lib/sky/constants.ts`

**Interfaces:**
- Produces: every type/constant below — every later task imports from here.

- [ ] **Step 1: Write `types.ts`**

```ts
// system/lib/sky/types.ts
export type Window = 'sunrise' | 'sunset';
export type Verdict = 'blocked' | 'clear' | 'mixed' | 'promising';
export type Band = 'unlikely' | 'plain' | 'mixed' | 'promising';

/** Cloud cover by altitude at one point/time. Percentages 0–100. */
export interface CloudLayers {
  low: number;
  mid: number;
  high: number;
}

/** One directional sample along the sun azimuth. */
export interface SamplePoint {
  distKm: number;
  bearing: number; // degrees from N
  lat: number;
  lng: number;
  layers: CloudLayers;
}

export interface SkyContext {
  window: Window;
  azimuth: number; // sun bearing at the horizon, degrees from N
  horizonGap: boolean;
  gapBearing: number | null;
  canvas: { high: number; mid: number }; // near-field mean %
  verdict: Verdict;
  confidence: number; // 0..1
  samples: SamplePoint[];
}

export interface ColorRead {
  window: Window;
  band: Band;
  why: string;
  caution: string | null;
  confidence: number;
  azimuth: number;
}

export type RecipeId = 'sunrise_color' | 'sunset_color' | 'fog_sunrise' | 'rain_clearing';

export interface RecipeMatch {
  recipe: RecipeId;
  window: Window;
  windowDate: string; // YYYY-MM-DD local
  title: string;
  body: string;
  key: string; // alert dedup key, e.g. "sunset:2026-06-25"
  mergeGroup: string; // recipes sharing this string merge into one notification
}

export interface Notification {
  title: string;
  message: string;
}
```

- [ ] **Step 2: Write `constants.ts`**

```ts
// system/lib/sky/constants.ts
export const SKY = {
  origin: { lat: 40.764, lng: -73.923 }, // Astoria, Queens
  sampleDistancesKm: [0, 25, 50, 90, 120],
  fanDegrees: 12,
  farFieldKm: 90, // samples at/beyond → horizon-gap zone
  nearFieldKm: 50, // samples at/below → canvas zone
  gapLowCloudMaxPct: 25, // far-field min low-cloud below this ⇒ gap
  bankLowCloudMinPct: 60, // far-field min low-cloud above this ⇒ bank
  canvasBandPct: [25, 70] as [number, number], // near-field canvas sweet spot
  canvasEmptyPct: 15, // canvas below this ⇒ "clear, no colour"
  canvasMidWeight: 0.7, // mid cloud counts 0.7× high as a catching canvas
  fogAlertMinIndex: 6, // ≥ "likely"
  sunsetLeadHours: [1.5, 5] as [number, number], // same-day sunset alert gate
  sunriseLeadHours: [6, 14] as [number, number], // night-before sunrise heads-up gate
} as const;
```

- [ ] **Step 3: Verify it compiles**

Run: `pnpm typecheck`
Expected: PASS (no errors in `system/lib/sky/`).

- [ ] **Step 4: Commit**

```bash
git add system/lib/sky/types.ts system/lib/sky/constants.ts
git commit -m "feat(sky): shared types + tunable constants for sky engine"
```

---

### Task 2: `solar.sunBearings()` (Wave B)

**Files:**
- Modify: `system/lib/solar.ts` (append; reuse private `rad`, `eqTimeAndDecl`, `hourAngleDeg`)
- Test: `system/lib/solar.test.ts` (extend if present, else create)

**Interfaces:**
- Produces: `sunBearings(lat:number, lng:number, date:Date) => { sunriseAz: number|null; sunsetAz: number|null }` — compass bearing (deg from N) where the sun meets the horizon. Consumed by Task 10.

- [ ] **Step 1: Write the failing test**

```ts
// system/lib/solar.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sunBearings } from './solar.ts';

const ASTORIA = { lat: 40.764, lng: -73.923 };

test('sunBearings: summer solstice ENE sunrise / WNW sunset from Astoria', () => {
  const b = sunBearings(ASTORIA.lat, ASTORIA.lng, new Date('2026-06-21T12:00:00Z'));
  assert.ok(b.sunriseAz !== null && b.sunsetAz !== null);
  assert.ok(Math.abs((b.sunriseAz as number) - 58) < 4, `sunrise ${b.sunriseAz}`); // ~58° ENE
  assert.ok(Math.abs((b.sunsetAz as number) - 302) < 4, `sunset ${b.sunsetAz}`); // ~302° WNW
});

test('sunBearings: equinox ⇒ ~due-east sunrise, ~due-west sunset', () => {
  const b = sunBearings(ASTORIA.lat, ASTORIA.lng, new Date('2026-03-20T12:00:00Z'));
  assert.ok(Math.abs((b.sunriseAz as number) - 90) < 3);
  assert.ok(Math.abs((b.sunsetAz as number) - 270) < 3);
});
```

- [ ] **Step 2: Run, verify it fails**

Run: `pnpm exec tsx --test system/lib/solar.test.ts`
Expected: FAIL — `sunBearings` not exported.

- [ ] **Step 3: Implement (append to `solar.ts`)**

```ts
export interface SunBearings {
  sunriseAz: number | null;
  sunsetAz: number | null;
}

/** Compass bearing (deg from N) where the sun crosses the horizon (alt −0.833°). */
export function sunBearings(lat: number, lng: number, date: Date): SunBearings {
  const latRad = lat * rad;
  const { declRad } = eqTimeAndDecl(date);
  const ha = hourAngleDeg(-0.833, latRad, declRad);
  if (ha === null) return { sunriseAz: null, sunsetAz: null };
  const altRad = -0.833 * rad;
  const cosAz =
    (Math.sin(declRad) - Math.sin(altRad) * Math.sin(latRad)) /
    (Math.cos(altRad) * Math.cos(latRad));
  const az0 = Math.acos(Math.max(-1, Math.min(1, cosAz))) / rad; // 0..180, east side
  return { sunriseAz: az0, sunsetAz: 360 - az0 };
}
```

- [ ] **Step 4: Run, verify it passes**

Run: `pnpm exec tsx --test system/lib/solar.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add system/lib/solar.ts system/lib/solar.test.ts
git commit -m "feat(solar): sunBearings() — sunrise/sunset azimuth"
```

---

### Task 3: `sky/geo.ts` — geodesic sampling (Wave B)

**Files:**
- Create: `system/lib/sky/geo.ts`
- Test: `system/lib/sky/geo.test.ts`

**Interfaces:**
- Consumes: `SKY` from `constants.ts`.
- Produces:
  - `destPoint(lat:number, lng:number, bearingDeg:number, distKm:number) => {lat:number; lng:number}`
  - `samplePoints(origin:{lat:number;lng:number}, azimuth:number) => Array<{distKm:number; bearing:number; lat:number; lng:number}>` — uses `SKY.sampleDistancesKm`, adds `±SKY.fanDegrees` variants at distances `≥ SKY.farFieldKm`. (The `distKm:0` entry is the origin, bearing = azimuth.)

- [ ] **Step 1: Write the failing test**

```ts
// system/lib/sky/geo.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { destPoint, samplePoints } from './geo.ts';

test('destPoint: 111 km due north ≈ +1° latitude', () => {
  const p = destPoint(40, -74, 0, 111.195);
  assert.ok(Math.abs(p.lat - 41) < 0.05, `lat ${p.lat}`);
  assert.ok(Math.abs(p.lng - -74) < 0.05, `lng ${p.lng}`);
});

test('samplePoints: 5 distances, fan at the far two (90,120) ⇒ 9 points', () => {
  const pts = samplePoints({ lat: 40.764, lng: -73.923 }, 302);
  assert.equal(pts.length, 9); // 5 on-bearing + 2×2 fan
  assert.ok(pts.some((p) => p.distKm === 0));
  const farBearings = pts.filter((p) => p.distKm === 120).map((p) => Math.round(p.bearing));
  assert.deepEqual(farBearings.sort((a, b) => a - b), [290, 302, 314]); // 302 ± 12
});
```

- [ ] **Step 2: Run, verify it fails**

Run: `pnpm exec tsx --test system/lib/sky/geo.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// system/lib/sky/geo.ts
import { SKY } from './constants.ts';

const rad = Math.PI / 180;
const R = 6371; // km

export function destPoint(lat: number, lng: number, bearingDeg: number, distKm: number) {
  const d = distKm / R;
  const t = bearingDeg * rad;
  const p1 = lat * rad;
  const l1 = lng * rad;
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(t));
  const l2 =
    l1 + Math.atan2(Math.sin(t) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return { lat: p2 / rad, lng: (((l2 / rad + 540) % 360) - 180) };
}

export function samplePoints(origin: { lat: number; lng: number }, azimuth: number) {
  const out: Array<{ distKm: number; bearing: number; lat: number; lng: number }> = [];
  for (const distKm of SKY.sampleDistancesKm) {
    const bearings =
      distKm >= SKY.farFieldKm
        ? [azimuth - SKY.fanDegrees, azimuth, azimuth + SKY.fanDegrees]
        : [azimuth];
    for (const b of bearings) {
      const bearing = (b + 360) % 360;
      const { lat, lng } = distKm === 0 ? origin : destPoint(origin.lat, origin.lng, bearing, distKm);
      out.push({ distKm, bearing, lat, lng });
    }
  }
  return out;
}
```

- [ ] **Step 4: Run, verify it passes**

Run: `pnpm exec tsx --test system/lib/sky/geo.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add system/lib/sky/geo.ts system/lib/sky/geo.test.ts
git commit -m "feat(sky): geodesic sample-point generation"
```

---

### Task 4: `sky/clouds.ts` — layer reads (Wave B)

**Files:**
- Create: `system/lib/sky/clouds.ts`
- Test: `system/lib/sky/clouds.test.ts`

**Interfaces:**
- Consumes: `CloudLayers` (types), `SKY` (constants).
- Produces:
  - `canvasCover(layers:CloudLayers) => number` — catching-canvas strength 0–100 = `min(100, high + mid*SKY.canvasMidWeight)`.
  - `canvasMean(samples:CloudLayers[]) => {high:number; mid:number}` — mean high & mean mid over the given layers.

- [ ] **Step 1: Write the failing test**

```ts
// system/lib/sky/clouds.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canvasCover, canvasMean } from './clouds.ts';

test('canvasCover: high cloud counts full, mid weighted', () => {
  assert.equal(canvasCover({ low: 0, mid: 0, high: 50 }), 50);
  assert.equal(canvasCover({ low: 0, mid: 100, high: 0 }), 70); // 100*0.7
  assert.equal(canvasCover({ low: 0, mid: 100, high: 100 }), 100); // clamped
});

test('canvasMean: averages high and mid across samples', () => {
  const m = canvasMean([
    { low: 0, mid: 20, high: 40 },
    { low: 0, mid: 40, high: 60 },
  ]);
  assert.equal(m.high, 50);
  assert.equal(m.mid, 30);
});
```

- [ ] **Step 2: Run, verify it fails**

Run: `pnpm exec tsx --test system/lib/sky/clouds.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// system/lib/sky/clouds.ts
import { SKY } from './constants.ts';
import type { CloudLayers } from './types.ts';

export function canvasCover(layers: CloudLayers): number {
  return Math.min(100, layers.high + layers.mid * SKY.canvasMidWeight);
}

export function canvasMean(samples: CloudLayers[]): { high: number; mid: number } {
  if (samples.length === 0) return { high: 0, mid: 0 };
  const sum = samples.reduce((a, s) => ({ high: a.high + s.high, mid: a.mid + s.mid }), { high: 0, mid: 0 });
  return { high: sum.high / samples.length, mid: sum.mid / samples.length };
}
```

- [ ] **Step 4: Run, verify it passes**

Run: `pnpm exec tsx --test system/lib/sky/clouds.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add system/lib/sky/clouds.ts system/lib/sky/clouds.test.ts
git commit -m "feat(sky): cloud-layer canvas helpers"
```

---

### Task 5: `sky/directional.ts` — Sky Context classifier (Wave C — needs Tasks 3,4)

**Files:**
- Create: `system/lib/sky/directional.ts`
- Test: `system/lib/sky/directional.test.ts`

**Interfaces:**
- Consumes: `SamplePoint, SkyContext, Window, CloudLayers` (types); `canvasMean` (clouds); `SKY` (constants).
- Produces: `skyContext(opts:{ window:Window; azimuth:number; samples:SamplePoint[]; leadHours:number }) => SkyContext`.

**Logic (from spec Component C):** far field = samples with `distKm >= SKY.farFieldKm`; near field = `distKm <= SKY.nearFieldKm`. `horizonGap` = min far-field `low` `< SKY.gapLowCloudMaxPct`; `bank` = min far-field `low` `> SKY.bankLowCloudMinPct`. `canvas` = `canvasMean(near-field layers)`; `canvasInBand` = `canvasBandPct[0] ≤ (high+mid*midWeight) ≤ canvasBandPct[1]`. Verdict: `promising` = gap ∧ canvasInBand; `blocked` = bank (no gap); `clear` = gap ∧ canvas `< canvasEmptyPct`; else `mixed`. Confidence: `clamp01(leadConf × marginConf)` where `leadConf` = 1 at ≤2 h falling to 0.4 at ≥16 h, `marginConf` lowered when the gap/canvas numbers sit within 10 pts of a threshold.

- [ ] **Step 1: Write the failing tests (canonical cases)**

```ts
// system/lib/sky/directional.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { skyContext } from './directional.ts';
import type { SamplePoint } from './types.ts';

const near = (high: number, mid: number, low: number): SamplePoint =>
  ({ distKm: 0, bearing: 302, lat: 0, lng: 0, layers: { low, mid, high } });
const far = (low: number): SamplePoint =>
  ({ distKm: 120, bearing: 302, lat: 0, lng: 0, layers: { low, mid: 0, high: 0 } });

test('promising: 100% high cloud overhead + clear far horizon gap', () => {
  const ctx = skyContext({ window: 'sunset', azimuth: 302, leadHours: 2,
    samples: [near(100, 0, 0), far(5), far(10)] });
  assert.equal(ctx.verdict, 'promising');
  assert.equal(ctx.horizonGap, true);
});

test('blocked: clear overhead but a low-cloud bank at the horizon', () => {
  const ctx = skyContext({ window: 'sunset', azimuth: 302, leadHours: 2,
    samples: [near(0, 0, 0), far(85), far(90)] });
  assert.equal(ctx.verdict, 'blocked');
  assert.equal(ctx.horizonGap, false);
});

test('clear: gap but empty canvas ⇒ light, no colour', () => {
  const ctx = skyContext({ window: 'sunset', azimuth: 302, leadHours: 2,
    samples: [near(0, 0, 0), far(5)] });
  assert.equal(ctx.verdict, 'clear');
});

test('confidence drops with lead time', () => {
  const a = skyContext({ window: 'sunrise', azimuth: 58, leadHours: 2, samples: [near(50, 0, 0), far(5)] });
  const b = skyContext({ window: 'sunrise', azimuth: 58, leadHours: 16, samples: [near(50, 0, 0), far(5)] });
  assert.ok(a.confidence > b.confidence);
});
```

- [ ] **Step 2: Run, verify it fails**

Run: `pnpm exec tsx --test system/lib/sky/directional.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// system/lib/sky/directional.ts
import { canvasMean } from './clouds.ts';
import { SKY } from './constants.ts';
import type { SamplePoint, SkyContext, Verdict, Window } from './types.ts';

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

export function skyContext(opts: {
  window: Window;
  azimuth: number;
  samples: SamplePoint[];
  leadHours: number;
}): SkyContext {
  const { window, azimuth, samples, leadHours } = opts;
  const farField = samples.filter((s) => s.distKm >= SKY.farFieldKm);
  const nearField = samples.filter((s) => s.distKm <= SKY.nearFieldKm);

  const minFarLow = farField.length ? Math.min(...farField.map((s) => s.layers.low)) : 100;
  const horizonGap = minFarLow < SKY.gapLowCloudMaxPct;
  const bank = minFarLow > SKY.bankLowCloudMinPct;
  const gapSample = farField.find((s) => s.layers.low === minFarLow) ?? null;

  const canvas = canvasMean(nearField.map((s) => s.layers));
  const canvasStrength = Math.min(100, canvas.high + canvas.mid * SKY.canvasMidWeight);
  const [bandLo, bandHi] = SKY.canvasBandPct;
  const canvasInBand = canvasStrength >= bandLo && canvasStrength <= bandHi;

  let verdict: Verdict;
  if (horizonGap && canvasInBand) verdict = 'promising';
  else if (bank) verdict = 'blocked';
  else if (horizonGap && canvasStrength < SKY.canvasEmptyPct) verdict = 'clear';
  else verdict = 'mixed';

  // Confidence: lead-time × threshold-marginality.
  const leadConf = clamp01(1 - (Math.max(0, leadHours - 2) / 14) * 0.6); // 1 @2h → 0.4 @16h
  const gapMargin = Math.min(
    Math.abs(minFarLow - SKY.gapLowCloudMaxPct),
    Math.abs(minFarLow - SKY.bankLowCloudMinPct),
  );
  const canvasMargin = Math.min(Math.abs(canvasStrength - bandLo), Math.abs(canvasStrength - bandHi));
  const marginConf = clamp01(0.6 + Math.min(gapMargin, canvasMargin) / 25); // edge cases → ~0.6
  const confidence = clamp01(leadConf * marginConf);

  return {
    window,
    azimuth,
    horizonGap,
    gapBearing: horizonGap && gapSample ? gapSample.bearing : null,
    canvas,
    verdict,
    confidence,
    samples,
  };
}
```

- [ ] **Step 4: Run, verify it passes**

Run: `pnpm exec tsx --test system/lib/sky/directional.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add system/lib/sky/directional.ts system/lib/sky/directional.test.ts
git commit -m "feat(sky): directional Sky Context classifier"
```

---

### Task 6: `sky/color.ts` — deterministic color read (Wave B)

**Files:**
- Create: `system/lib/sky/color.ts`
- Test: `system/lib/sky/color.test.ts`

**Interfaces:**
- Consumes: `SkyContext, ColorRead, Band` (types).
- Produces: `colorRead(ctx:SkyContext) => ColorRead` and `bearingLabel(deg:number) => string` (16-point compass, e.g. `302 → "WNW"`).

**Mapping:** verdict→band: `promising→promising`, `mixed→mixed`, `clear→plain`, `blocked→unlikely`. `why`/`caution` templated from fields; `caution` non-null only for promising/mixed (the bank distance + bearing if `!horizonGap`, else low confidence note).

- [ ] **Step 1: Write the failing test**

```ts
// system/lib/sky/color.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { colorRead, bearingLabel } from './color.ts';
import type { SkyContext } from './types.ts';

const base: SkyContext = {
  window: 'sunset', azimuth: 302, horizonGap: true, gapBearing: 302,
  canvas: { high: 55, mid: 10 }, verdict: 'promising', confidence: 0.7, samples: [],
};

test('bearingLabel maps degrees to compass point', () => {
  assert.equal(bearingLabel(302), 'WNW');
  assert.equal(bearingLabel(58), 'ENE');
});

test('promising ⇒ band promising, why mentions high cloud + horizon', () => {
  const r = colorRead(base);
  assert.equal(r.band, 'promising');
  assert.match(r.why, /high cloud/i);
  assert.match(r.why, /WNW/);
});

test('blocked ⇒ band unlikely, terse, caution null', () => {
  const r = colorRead({ ...base, verdict: 'blocked', horizonGap: false, gapBearing: null });
  assert.equal(r.band, 'unlikely');
  assert.equal(r.caution, null);
});
```

- [ ] **Step 2: Run, verify it fails**

Run: `pnpm exec tsx --test system/lib/sky/color.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// system/lib/sky/color.ts
import type { Band, ColorRead, SkyContext } from './types.ts';

const POINTS = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
export function bearingLabel(deg: number): string {
  return POINTS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
}

const BAND: Record<SkyContext['verdict'], Band> = {
  promising: 'promising', mixed: 'mixed', clear: 'plain', blocked: 'unlikely',
};

export function colorRead(ctx: SkyContext): ColorRead {
  const dir = bearingLabel(ctx.azimuth);
  const band = BAND[ctx.verdict];
  let why: string;
  let caution: string | null = null;

  if (band === 'promising') {
    why = `high cloud overhead + clear ${dir} horizon`;
  } else if (band === 'mixed') {
    why = ctx.horizonGap ? `some high cloud, partial ${dir} gap` : `thin cloud, ${dir} horizon uncertain`;
  } else if (band === 'plain') {
    why = `clear ${dir} horizon, low colour potential`;
  } else {
    why = `low-cloud bank toward the ${dir} sun`;
  }

  if (band === 'promising' || band === 'mixed') {
    if (!ctx.horizonGap) caution = `low cloud toward ${dir} may block the light`;
    else if (ctx.confidence < 0.5) caution = `forecast still uncertain`;
  }
  return { window: ctx.window, band, why, caution, confidence: ctx.confidence, azimuth: ctx.azimuth };
}
```

- [ ] **Step 4: Run, verify it passes**

Run: `pnpm exec tsx --test system/lib/sky/color.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add system/lib/sky/color.ts system/lib/sky/color.test.ts
git commit -m "feat(sky): deterministic color read + compass labels"
```

---

### Task 7: `sky/recipes.ts` — matchers, lead gate, merge (Wave B)

**Files:**
- Create: `system/lib/sky/recipes.ts`
- Test: `system/lib/sky/recipes.test.ts`

**Interfaces:**
- Consumes: `ColorRead, RecipeMatch, RecipeId, Window` (types); `SKY` (constants).
- Produces:
  - `matchRecipes(input:{ sunrise?:ColorRead|null; sunset?:ColorRead|null; sunriseLeadH?:number; sunsetLeadH?:number; fogIndex?:number; fogCoversSunrise?:boolean; rainClearing?:boolean; dates:{sunrise:string; sunset:string} }) => RecipeMatch[]` — applies the per-window lead gate (`SKY.sunriseLeadHours`/`sunsetLeadHours`); colour fires when `band==='promising'` or (`band==='mixed'` and `confidence>=0.6`); fog fires when `fogIndex>=SKY.fogAlertMinIndex && fogCoversSunrise`.
  - `mergeMatches(matches:RecipeMatch[]) => Notification[]` — one `Notification` per `mergeGroup`; title from the highest-priority recipe, message joins the bodies with ` · `.

- [ ] **Step 1: Write the failing test**

```ts
// system/lib/sky/recipes.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchRecipes, mergeMatches } from './recipes.ts';
import type { ColorRead } from './types.ts';

const promising = (window: 'sunrise' | 'sunset'): ColorRead =>
  ({ window, band: 'promising', why: 'high cloud + clear horizon', caution: null, confidence: 0.8, azimuth: window === 'sunrise' ? 58 : 302 });

test('sunset colour fires inside the 1.5–5h lead window', () => {
  const m = matchRecipes({ sunset: promising('sunset'), sunsetLeadH: 3, dates: { sunrise: '2026-06-26', sunset: '2026-06-25' } });
  assert.equal(m.length, 1);
  assert.equal(m[0].recipe, 'sunset_color');
  assert.equal(m[0].key, 'sunset:2026-06-25');
});

test('sunset colour suppressed when too soon (<1.5h)', () => {
  const m = matchRecipes({ sunset: promising('sunset'), sunsetLeadH: 0.5, dates: { sunrise: '2026-06-26', sunset: '2026-06-25' } });
  assert.equal(m.length, 0);
});

test('sunrise colour + fog merge into one notification', () => {
  const m = matchRecipes({
    sunrise: promising('sunrise'), sunriseLeadH: 9, fogIndex: 7, fogCoversSunrise: true,
    dates: { sunrise: '2026-06-26', sunset: '2026-06-25' },
  });
  assert.equal(m.length, 2);
  const notes = mergeMatches(m);
  assert.equal(notes.length, 1);
  assert.match(notes[0].message, /·/); // bodies joined
});
```

- [ ] **Step 2: Run, verify it fails**

Run: `pnpm exec tsx --test system/lib/sky/recipes.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// system/lib/sky/recipes.ts
import { SKY } from './constants.ts';
import type { ColorRead, Notification, RecipeMatch, Window } from './types.ts';

const inRange = (h: number | undefined, [lo, hi]: readonly [number, number]) =>
  h !== undefined && h >= lo && h <= hi;
const colourFires = (r: ColorRead) => r.band === 'promising' || (r.band === 'mixed' && r.confidence >= 0.6);

const PRIORITY: Record<RecipeMatch['recipe'], number> = {
  sunset_color: 3, sunrise_color: 3, fog_sunrise: 2, rain_clearing: 1,
};

export function matchRecipes(input: {
  sunrise?: ColorRead | null;
  sunset?: ColorRead | null;
  sunriseLeadH?: number;
  sunsetLeadH?: number;
  fogIndex?: number;
  fogCoversSunrise?: boolean;
  rainClearing?: boolean;
  dates: { sunrise: string; sunset: string };
}): RecipeMatch[] {
  const out: RecipeMatch[] = [];
  const mergeFor = (w: Window) => `${w}:${input.dates[w]}`;

  if (input.sunrise && colourFires(input.sunrise) && inRange(input.sunriseLeadH, SKY.sunriseLeadHours)) {
    out.push({
      recipe: 'sunrise_color', window: 'sunrise', windowDate: input.dates.sunrise,
      title: '🌅 Sunrise may be colorful — worth an alarm',
      body: input.sunrise.why, key: mergeFor('sunrise'), mergeGroup: mergeFor('sunrise'),
    });
  }
  if (input.fogIndex !== undefined && input.fogIndex >= SKY.fogAlertMinIndex && input.fogCoversSunrise && inRange(input.sunriseLeadH, SKY.sunriseLeadHours)) {
    out.push({
      recipe: 'fog_sunrise', window: 'sunrise', windowDate: input.dates.sunrise,
      title: '🌫️ River fog near sunrise', body: `fog index ${input.fogIndex}/10`,
      key: `fog:${input.dates.sunrise}`, mergeGroup: mergeFor('sunrise'),
    });
  }
  if (input.sunset && colourFires(input.sunset) && inRange(input.sunsetLeadH, SKY.sunsetLeadHours)) {
    out.push({
      recipe: 'sunset_color', window: 'sunset', windowDate: input.dates.sunset,
      title: '🌇 Sunset may be colorful — head out',
      body: input.sunset.why, key: mergeFor('sunset'), mergeGroup: mergeFor('sunset'),
    });
  }
  if (input.rainClearing && inRange(input.sunsetLeadH, SKY.sunsetLeadHours)) {
    out.push({
      recipe: 'rain_clearing', window: 'sunset', windowDate: input.dates.sunset,
      title: '⛈️→☀️ Rain clearing into golden hour', body: 'storm breaking before sunset',
      key: `clearing:${input.dates.sunset}`, mergeGroup: mergeFor('sunset'),
    });
  }
  return out;
}

export function mergeMatches(matches: RecipeMatch[]): Notification[] {
  const groups = new Map<string, RecipeMatch[]>();
  for (const m of matches) (groups.get(m.mergeGroup) ?? groups.set(m.mergeGroup, []).get(m.mergeGroup)!).push(m);
  const notes: Notification[] = [];
  for (const group of groups.values()) {
    const lead = [...group].sort((a, b) => PRIORITY[b.recipe] - PRIORITY[a.recipe])[0];
    notes.push({ title: lead.title, message: group.map((g) => g.body).join(' · ') });
  }
  return notes;
}
```

- [ ] **Step 4: Run, verify it passes**

Run: `pnpm exec tsx --test system/lib/sky/recipes.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add system/lib/sky/recipes.ts system/lib/sky/recipes.test.ts
git commit -m "feat(sky): recipe matchers + lead gate + notification merge"
```

---

### Task 8: Re-source `weather/fog.ts` to Open-Meteo (Wave B)

**Files:**
- Modify: `system/integrations/builtin/weather/fog.ts`
- Test: `system/integrations/builtin/weather/fog.test.ts` (extend/replace fixtures)

**Interfaces:**
- Consumes: an Open-Meteo hourly object (parallel arrays).
- Produces (keep names so Task 10 + the brief are stable):
  - `OmHourly` type `{ time:string[]; temperature_2m:number[]; dew_point_2m:number[]; relative_humidity_2m:number[]; wind_speed_10m:number[]; weather_code:number[]; visibility:number[] }`.
  - `fogNights(hourly:OmHourly, todayIso:string) => FogNight[]` — same `FogNight` shape as today (`date,index,band,peak_window,factors`); selects local hours 21/00/03/06; replaces the dropped `chanceoffog` MAX-term with `weather_code ∈ {45,48}` (→ score 10) and low `visibility` (<1000 m → bonus). `band`, `rampUp`, `rampDown`, `scoreSlot` math unchanged otherwise.
  - `wmoText(code:number) => string` — WMO weather_code → short description (e.g. `0→"clear"`, `2→"partly cloudy"`, `3→"overcast"`, `45/48→"fog"`, `61/63/65→"rain"`, …). Used by Task 10 for `desc`.

**Note:** Open-Meteo `time[]` are local ISO (`timezone=auto`), e.g. `"2026-06-25T21:00"`. Select a night's slots by matching the hour substring; a night starting on `date` uses `${date}T21:00` then `${date+1}T00:00/03:00/06:00`.

- [ ] **Step 1: Write the failing test**

```ts
// system/integrations/builtin/weather/fog.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fogNights, wmoText, type OmHourly } from './fog.ts';

// Build a 2-day hourly series; saturate the night of 2026-06-25.
function series(): OmHourly {
  const time: string[] = [];
  const at = (d: string, h: number) => `${d}T${String(h).padStart(2, '0')}:00`;
  for (const d of ['2026-06-25', '2026-06-26']) for (let h = 0; h < 24; h++) time.push(at(d, h));
  const n = time.length;
  const fill = (v: number) => Array(n).fill(v);
  const h: OmHourly = {
    time, temperature_2m: fill(60), dew_point_2m: fill(59), relative_humidity_2m: fill(96),
    wind_speed_10m: fill(3), weather_code: fill(2), visibility: fill(20000),
  };
  return h;
}

test('fogNights: saturated calm night ⇒ high index, likely band', () => {
  const nights = fogNights(series(), '2026-06-25');
  const tonight = nights.find((x) => x.date === '2026-06-25');
  assert.ok(tonight);
  assert.ok((tonight as { index: number }).index >= 6, `index ${tonight?.index}`);
});

test('wmoText maps codes', () => {
  assert.equal(wmoText(0), 'clear');
  assert.equal(wmoText(45), 'fog');
  assert.equal(wmoText(3), 'overcast');
});
```

- [ ] **Step 2: Run, verify it fails**

Run: `pnpm exec tsx --test system/integrations/builtin/weather/fog.test.ts`
Expected: FAIL — `OmHourly`/`wmoText` not exported; `fogNights` signature changed.

- [ ] **Step 3: Implement** — replace the `WttrHour`/`WttrDay` input plumbing (keep `FogNight`, `band`, `rampUp`, `rampDown`, and the composite weights). Key new pieces:

```ts
export interface OmHourly {
  time: string[];
  temperature_2m: number[];
  dew_point_2m: number[];
  relative_humidity_2m: number[];
  wind_speed_10m: number[];
  weather_code: number[];
  visibility: number[];
}

const WMO: Record<number, string> = {
  0: 'clear', 1: 'mainly clear', 2: 'partly cloudy', 3: 'overcast',
  45: 'fog', 48: 'fog', 51: 'drizzle', 53: 'drizzle', 55: 'drizzle',
  61: 'rain', 63: 'rain', 65: 'heavy rain', 71: 'snow', 73: 'snow', 75: 'snow',
  80: 'showers', 81: 'showers', 82: 'heavy showers', 95: 'thunderstorm',
};
export function wmoText(code: number): string {
  return WMO[code] ?? 'cloudy';
}

const NIGHT_HOURS = [21, 0, 3, 6]; // 21:00 of date d, then 00/03/06 of d+1

function scoreNightSlot(h: OmHourly, idx: number, label: string) {
  const temp = h.temperature_2m[idx], dew = h.dew_point_2m[idx];
  const rh = h.relative_humidity_2m[idx], wind = h.wind_speed_10m[idx];
  const code = h.weather_code[idx], vis = h.visibility[idx];
  const spread = temp - dew;
  const spreadScore = rampDown(spread, 2, 8);
  const rhScore = rampUp(rh, 85, 98);
  const windScore = rampDown(wind, 2, 14);
  const composite = 0.45 * spreadScore + 0.3 * rhScore + 0.25 * windScore;
  const providerFog = code === 45 || code === 48 ? 10 : vis < 1000 ? 8 : vis < 4000 ? 4 : 0;
  return {
    label,
    score: Math.max(providerFog, composite),
    factors: `spread ${Math.round(spread)}°F · RH ${Math.round(rh)}% · wind ${Math.round(wind)} mph`,
  };
}
```

`fogNights(hourly, todayIso)` walks dates present in `time[]`; for each date `d`, finds the indices for `${d}T21:00` and `${d+1}T{00,03,06}:00` (string match against `time[]`), scores them with `scoreNightSlot`, and builds the `FogNight` exactly as the current `fogNights` does (max → index, peak run within 1 pt, `band(index)`). Require ≥2 scorable slots. (`addDay(d)` = `new Date(`${d}T00:00Z`)` +1 day → ISO date.)

- [ ] **Step 4: Run, verify it passes**

Run: `pnpm exec tsx --test system/integrations/builtin/weather/fog.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add system/integrations/builtin/weather/fog.ts system/integrations/builtin/weather/fog.test.ts
git commit -m "feat(weather): re-source fog index to Open-Meteo (+ wmoText, visibility/wcode fog signal)"
```

---

### Task 9: `sky/deliver.ts` — fire, dedup, cancel (Wave C — needs alert-store + notify + recipes types)

**Files:**
- Create: `system/lib/sky/deliver.ts`
- Test: `system/lib/sky/deliver.test.ts`

**Interfaces:**
- Consumes: `RecipeMatch, Notification` (types); `recordAlert, resolveAlert` (`system/kernel/runtime/alert-store.ts`); `notifyMacOSAction` (`system/integrations/builtin/notify/index.ts`); `RobinDb`.
- Produces: `fireMatches(opts:{ db:RobinDb; matches:RecipeMatch[]; openKeys:string[]; deliver?:(n:Notification)=>Promise<void> }) => Promise<{ fired:string[]; resolved:string[] }>`. Default `deliver` calls `notifyMacOSAction`; **tests inject a stub so no osascript runs.** New matches → `recordAlert(source:'sky')` + one merged notification per group; `openKeys` present this run but **not** in `matches` → `resolveAlert` (silent cancel, no notification).

- [ ] **Step 1: Write the failing test**

```ts
// system/lib/sky/deliver.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fireMatches } from './deliver.ts';
import type { Notification, RecipeMatch } from './types.ts';

const fakeDb = () => {
  const calls: string[] = [];
  return {
    calls,
    prepare: () => ({ get: () => undefined, run: (...a: unknown[]) => { calls.push(a.join(',')); return { changes: 1, lastInsertRowid: 1 }; }, all: () => [] }),
  } as any;
};

test('new match fires a notification and records an alert', async () => {
  const db = fakeDb();
  const sent: Notification[] = [];
  const m: RecipeMatch = { recipe: 'sunset_color', window: 'sunset', windowDate: '2026-06-25',
    title: '🌇 t', body: 'high cloud', key: 'sunset:2026-06-25', mergeGroup: 'sunset:2026-06-25' };
  const r = await fireMatches({ db, matches: [m], openKeys: [], deliver: async (n) => { sent.push(n); } });
  assert.deepEqual(r.fired, ['sunset:2026-06-25']);
  assert.equal(sent.length, 1);
});

test('open key absent from matches ⇒ silently resolved, no notification', async () => {
  const db = fakeDb();
  const sent: Notification[] = [];
  const r = await fireMatches({ db, matches: [], openKeys: ['sunset:2026-06-25'], deliver: async (n) => { sent.push(n); } });
  assert.deepEqual(r.resolved, ['sunset:2026-06-25']);
  assert.equal(sent.length, 0);
});
```

- [ ] **Step 2: Run, verify it fails**

Run: `pnpm exec tsx --test system/lib/sky/deliver.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// system/lib/sky/deliver.ts
import type { RobinDb } from '../../brain/memory/db.ts';
import { recordAlert, resolveAlert } from '../../kernel/runtime/alert-store.ts';
import { notifyMacOSAction } from '../../integrations/builtin/notify/index.ts';
import { mergeMatches } from './recipes.ts';
import type { Notification, RecipeMatch } from './types.ts';

const defaultDeliver = async (n: Notification) => {
  await notifyMacOSAction({ title: n.title, message: n.message });
};

export async function fireMatches(opts: {
  db: RobinDb;
  matches: RecipeMatch[];
  openKeys: string[];
  deliver?: (n: Notification) => Promise<void>;
}): Promise<{ fired: string[]; resolved: string[] }> {
  const deliver = opts.deliver ?? defaultDeliver;
  const matchedKeys = new Set(opts.matches.map((m) => m.key));

  // Silent-cancel: previously-open sky alerts no longer matching.
  const resolved: string[] = [];
  for (const key of opts.openKeys) {
    if (!matchedKeys.has(key)) {
      resolveAlert(opts.db, 'sky', key);
      resolved.push(key);
    }
  }

  // Record each new match; one merged notification per group.
  const fired: string[] = [];
  for (const m of opts.matches) {
    recordAlert(opts.db, { severity: 'info', source: 'sky', key: m.key, message: `${m.title} — ${m.body}`, context: { recipe: m.recipe, window: m.window, date: m.windowDate } });
    fired.push(m.key);
  }
  for (const note of mergeMatches(opts.matches)) await deliver(note);

  return { fired, resolved };
}
```

- [ ] **Step 4: Run, verify it passes**

Run: `pnpm exec tsx --test system/lib/sky/deliver.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add system/lib/sky/deliver.ts system/lib/sky/deliver.test.ts
git commit -m "feat(sky): alert firing — dedup record, merged notify, silent cancel"
```

---

### Task 10: Re-source the weather tick to Open-Meteo + wire the engine (Wave D)

**Files:**
- Modify: `system/integrations/builtin/weather/index.ts` (rewrite `tick`)
- Modify: `system/integrations/builtin/weather/integration.yaml`
- Test: `system/integrations/builtin/weather/index.test.ts` (create — fixture-driven)

**Interfaces:**
- Consumes: `solarTimes`, `sunBearings` (solar); `samplePoints` (geo); `skyContext` (directional); `colorRead` (color); `matchRecipes` (recipes); `fireMatches` (deliver); `fogNights`, `wmoText`, `OmHourly` (fog); `SKY` (constants).
- Produces: enriched `weather.current` event payload (Task 11 reads it):
  ```ts
  payload = {
    kind: 'current', location, temp_f, desc, wind_mph, cloud_cover,
    fog_nights, sunrise, sunset,
    golden_hour_morning_end, golden_hour_evening_start, blue_hour_morning_start, blue_hour_evening_end,
    sky: { asOf: ISO, sunrise: ColorRead | null, sunset: ColorRead | null },
  }
  ```

- [ ] **Step 1: integration.yaml** — set cron, location, flags:

```yaml
name: weather
version: 1.0.0
# 4am keeps the 4:30am brief fresh; afternoon ticks (12–20, every 2h) give the
# 1.5–5h sunset-alert lead gate a candidate in every season; 8pm doubles as the
# tomorrow-sunrise heads-up.
schedule: "0 4,12,14,16,18,20 * * *"
tz: America/New_York
config:
  lat: 40.764
  lng: -73.923
  skyContext_enabled: true   # enriched brief section
  skyAlerts_enabled: true    # proactive notifications
permissions:
  memory: { read: true, write: true, namespaces: ["weather"] }
  network: ["api.open-meteo.com"]
```

- [ ] **Step 2: Write the failing test** (fixture: a small Open-Meteo multi-coord array; assert the enriched payload). Mock `ctx.fetch` to return the fixture, `ctx.ingest` to capture the payload, `ctx.db`/`recordAlert` harmless.

```ts
// system/integrations/builtin/weather/index.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { integration } from './index.ts';
import fixture from './fixtures/open-meteo.json' with { type: 'json' };

function ctx(captured: { payload?: any }) {
  return {
    state: new Map<string, string>([['_noop', '']]) as any, // get/set below
    fetch: async () => ({ ok: true, json: async () => fixture }) as any,
    now: () => new Date('2026-06-25T20:00:00-04:00'),
    ingest: async (input: any) => { captured.payload = input.payload; return {}; },
    db: { prepare: () => ({ get: () => undefined, run: () => ({ changes: 0, lastInsertRowid: 1 }), all: () => [] }) } as any,
    log: { info() {}, warn() {}, error() {} },
    llm: null, checkOutbound: () => ({ allow: true }) as any,
  } as any;
}

test('tick ingests an enriched weather.current payload with sky reads', async () => {
  const cap: { payload?: any } = {};
  const c = ctx(cap);
  // minimal KvStore
  const kv = new Map<string, string>();
  c.state = { get: (k: string) => kv.get(k) ?? null, set: (k: string, v: string) => void kv.set(k, v), delete: (k: string) => void kv.delete(k) };
  const r = await integration.tick!(c);
  assert.equal(r.status, 'ok');
  assert.ok(cap.payload.sky, 'sky block present');
  assert.ok('sunset' in cap.payload.sky);
  assert.ok(typeof cap.payload.temp_f !== 'undefined');
});
```

(Create `fixtures/open-meteo.json` — an array of ≥2 location objects, each with `hourly` arrays spanning 2026-06-25→26 incl. the sunset/sunrise hours, plus `current` and `daily.sunrise/sunset`. Hand-author minimal but valid; the origin `[0]` carries the full hourly series for fog + canvas, far entries carry `cloud_cover_low` for the gap test.)

- [ ] **Step 3: Run, verify it fails**

Run: `pnpm exec tsx --test system/integrations/builtin/weather/index.test.ts`
Expected: FAIL — tick still calls wttr.in / no `sky` block.

- [ ] **Step 4: Implement the rewrite.** Structure:

```ts
import { solarTimes, sunBearings } from '../../../lib/solar.ts';
import { samplePoints } from '../../../lib/sky/geo.ts';
import { skyContext } from '../../../lib/sky/directional.ts';
import { colorRead } from '../../../lib/sky/color.ts';
import { matchRecipes } from '../../../lib/sky/recipes.ts';
import { fireMatches } from '../../../lib/sky/deliver.ts';
import { fogNights, wmoText, type OmHourly } from './fog.ts';
import { SKY } from '../../../lib/sky/constants.ts';
import { listAlerts } from '../../../kernel/runtime/alert-store.ts';
import type { CloudLayers } from '../../../lib/sky/types.ts';
```

`tick(ctx)`:
1. Read `lat/lng` from `ctx.state` (seeded from yaml config; fall back to `SKY.origin`).
2. Build sample coord lists for **both** windows: `sunBearings(lat,lng,now)` → `samplePoints(origin, sunriseAz)` and `samplePoints(origin, sunsetAz)`. Concatenate origin-first, dedupe identical coords, cap order so `[0]` is the origin.
3. Build one Open-Meteo URL: `https://api.open-meteo.com/v1/forecast?latitude=<csv>&longitude=<csv>&timezone=auto&temperature_unit=fahrenheit&wind_speed_unit=mph&forecast_days=2&current=temperature_2m,weather_code,wind_speed_10m,cloud_cover&hourly=cloud_cover,cloud_cover_low,cloud_cover_mid,cloud_cover_high,temperature_2m,dew_point_2m,relative_humidity_2m,wind_speed_10m,weather_code,visibility,precipitation,precipitation_probability&daily=sunrise,sunset`. `fetch`; on `!ok` return `{status:'error'}`.
4. `data` is an array (multi-coord). `origin = data[0]`. Helper `layersAt(loc, hourIso): CloudLayers` finds `loc.hourly.time.indexOf(hourIso)` and reads `cloud_cover_{low,mid,high}[idx]`.
5. For each window: target hour = the local hour of `daily.sunrise[0]` / `sunset[0]` (round to nearest hour). Build `SamplePoint[]` from that window's coord list (each coord's `data[i]` `layersAt` at the target hour). `leadHours` = `(targetTime - now)/3.6e6` (for sunrise, use *tomorrow's* sunrise when now is evening). `skyContext(...)` → `colorRead(...)`.
6. `desc = wmoText(origin.current.weather_code)`; `temp_f = origin.current.temperature_2m`; `wind_mph = origin.current.wind_speed_10m`; `cloud_cover = origin.current.cloud_cover`.
7. `fog = fogNights(origin.hourly as OmHourly, isoDateLocal(now))`. `sun = solarTimes(lat,lng,now)` (ISO strings as today).
8. `ingest` the enriched payload (shape in Interfaces).
9. **Alerts** (only if `skyAlerts_enabled`): compute `fogCoversSunrise` (tonight's fog peak window overlaps the sunrise hour), `rainClearing` (precip in the 3 h before the sunset golden-hour window dropping to `precipitation_probability < 20` inside it), and lead hours per window. `matchRecipes(...)`. `openKeys` = `listAlerts(ctx.db,{}).filter(a=>a.source==='sky').map(a=>a.key)`. `await fireMatches({ db: ctx.db, matches, openKeys })`.
10. `ctx.state.set('last_sync', now.toISOString())`; return `{status:'ok', ingested:1}`.

Keep `health` as-is. Gate the whole sky/alert block on the config flags; if `skyContext_enabled` is false, still ingest the base temp/desc/fog/sun payload (so the brief degrades cleanly).

- [ ] **Step 5: Run, verify it passes**

Run: `pnpm exec tsx --test system/integrations/builtin/weather/index.test.ts`
Expected: PASS. Then `pnpm typecheck`.

- [ ] **Step 6: Commit**

```bash
git add system/integrations/builtin/weather/index.ts system/integrations/builtin/weather/integration.yaml system/integrations/builtin/weather/index.test.ts system/integrations/builtin/weather/fixtures/open-meteo.json
git commit -m "feat(weather): Open-Meteo tick — directional sky reads + light alerts"
```

---

### Task 11: Enriched brief `renderWeather()` (Wave E)

**Files:**
- Modify: `user-data/extensions/jobs/daily-brief/skeleton.ts` (`renderWeather`, ~L987–1031)
- Test: `user-data/extensions/jobs/daily-brief/skeleton.test.ts` (extend)

**Interfaces:**
- Consumes: the enriched `weather.current` payload (`f.sky.{sunrise,sunset}` = `ColorRead`, plus existing `temp_f,desc,sunrise,sunset,golden_*,blue_*,fog_nights`, new `wind_mph`).
- Produces: same `SectionRender` (`{body}`). **Removes** the `fetchLive('weather')` branch.

**Render rules (spec Component D):** proportional disclosure — `promising`/`mixed` get the full `why` (+ `caution` line + confidence note); `plain`/`unlikely` get a one-line `— {why}`. Show today's sunrise + today's sunset reads, golden AM/PM + blue AM/PM on one `Light:` line, then fog. Degradation: no `f.sky` → render temp/sun/golden/blue/fog only + `sky context unavailable today`; no `f` at all → existing quiet state.

- [ ] **Step 1: Write the failing test**

```ts
// in skeleton.test.ts — add cases
test('renderWeather: promising sunset shows why + caution', async () => {
  const db = seedWeatherEvent({
    temp_f: '72', desc: 'partly cloudy', wind_mph: 7,
    sunrise: '2026-06-25T09:25:00Z', sunset: '2026-06-26T00:30:00Z',
    sky: { asOf: '...', sunset: { window: 'sunset', band: 'promising', why: 'high cloud overhead + clear WNW horizon', caution: 'low cloud toward WNW may block the light', confidence: 0.7, azimuth: 302 }, sunrise: { window: 'sunrise', band: 'plain', why: 'clear ENE horizon, low colour potential', caution: null, confidence: 0.6, azimuth: 58 } },
    fog_nights: [],
  });
  const out = await renderWeatherForTest(db);
  assert.match(out, /Sunset .* Promising/i);
  assert.match(out, /high cloud overhead/);
  assert.match(out, /low cloud toward WNW/);
  assert.match(out, /Sunrise .* clear ENE horizon/); // terse, no caution
});

test('renderWeather: missing sky block ⇒ degraded note, no crash', async () => {
  const db = seedWeatherEvent({ temp_f: '69', desc: 'clear', sunrise: '...', sunset: '...', fog_nights: [] });
  const out = await renderWeatherForTest(db);
  assert.match(out, /sky context unavailable today/);
});
```

(Reuse the file's existing seeding helper pattern; `renderWeatherForTest` wraps `renderWeather(db, nowMs)` with a fixed `nowMs`.)

- [ ] **Step 2: Run, verify it fails**

Run: `pnpm exec tsx --test user-data/extensions/jobs/daily-brief/skeleton.test.ts`
Expected: FAIL — old renderer, no sky lines / no degraded note.

- [ ] **Step 3: Implement** — replace the body of `renderWeather` (drop the `fetchLive` branch):

```ts
async function renderWeather(db: RobinDb, nowMs: number): Promise<SectionRender> {
  const rows = queryEvents(db, ['weather.current', 'v2.weather'], { limit: 5 });
  const freshest = rows[0];
  if (!freshest) return { body: quiet('weather', 'No current weather captured.') };
  const f = field(freshest.payload);
  const lines = [header('weather')];

  const parts: string[] = [];
  const temp = num(f.temp_f); if (temp !== null) parts.push(`${temp}°F`);
  const desc = str(f.desc); if (desc) parts.push(desc);
  const wind = num(f.wind_mph); if (wind !== null) parts.push(`wind ${wind} mph`);
  lines.push(`- ${parts.join(' · ') || 'conditions unknown'}`);

  const sky = (f.sky && typeof f.sky === 'object') ? (f.sky as Record<string, any>) : null;
  const renderRead = (emoji: string, label: string, timeIso: string | null, r: any) => {
    const t = timeIso ? ` ${fmtTime(timeIso)}` : '';
    if (!r) return;
    const az = typeof r.azimuth === 'number' ? ` (az ${Math.round(r.azimuth)}° ${bearingLabel(r.azimuth)})` : '';
    if (r.band === 'promising' || r.band === 'mixed') {
      const cap = r.band === 'promising' ? 'Promising' : 'Mixed';
      lines.push(`- ${emoji} ${label}${t}${az} — ${cap}: ${r.why}.`);
      const tail = [r.caution ? `⚠ ${r.caution}` : null, `confidence ${confWord(r.confidence)} (morning forecast)`].filter(Boolean).join(' · ');
      if (tail) lines.push(`     ${tail}`);
    } else {
      lines.push(`- ${emoji} ${label}${t}${az} — ${r.why}.`);
    }
  };
  if (sky) {
    renderRead('🌅', 'Sunrise', str(f.sunrise), sky.sunrise);
    renderRead('🌇', 'Sunset', str(f.sunset), sky.sunset);
  } else if (str(f.sunrise) && str(f.sunset)) {
    lines.push(`- Sunrise ${fmtTime(str(f.sunrise)!)} · sunset ${fmtTime(str(f.sunset)!)}`);
    lines.push('- _sky context unavailable today_');
  }

  const gm = str(f.golden_hour_morning_end), ge = str(f.golden_hour_evening_start);
  const bm = str(f.blue_hour_morning_start), be = str(f.blue_hour_evening_end);
  const sr = str(f.sunrise), ss = str(f.sunset);
  const light: string[] = [];
  if (sr && gm) light.push(`golden AM ${fmtTime(sr)}–${fmtTime(gm)}`);
  if (ge && ss) light.push(`PM ${fmtTime(ge)}–${fmtTime(ss)}`);
  if (bm && sr) light.push(`blue AM ${fmtTime(bm)}–${fmtTime(sr)}`);
  if (ss && be) light.push(`PM ${fmtTime(ss)}–${fmtTime(be)}`);
  if (light.length) lines.push(`- Light: ${light.join(' · ')}`);

  const fog = fogTonight(f.fog_nights, nowMs);
  if (fog) {
    const fp = [`Fog index tonight: ${fog.index}/10 (${fog.band})`];
    if (fog.peakWindow) fp.push(`peak ${fog.peakWindow}`);
    if (fog.factors) fp.push(fog.factors);
    lines.push(`- 🌫️ ${fp.join(' · ')}`);
  }
  return { body: lines.join('\n') };
}
```

Add small helpers near the top of the file: import `bearingLabel` from `../../../../system/lib/sky/color.ts` (verify the relative depth from `user-data/extensions/jobs/daily-brief/`), and `function confWord(c:number){ return c>=0.66?'high':c>=0.4?'moderate':'low'; }`. Update the `renderWeather` call site (~L1318) to drop the `fetchLive` arg. If removing the param breaks `LiveFetcher`/`fetchLive` usage for other sections, leave those intact — only weather stops using it.

- [ ] **Step 4: Run, verify it passes**

Run: `pnpm exec tsx --test user-data/extensions/jobs/daily-brief/skeleton.test.ts`
Expected: PASS. Then `pnpm typecheck` and `pnpm build`.

- [ ] **Step 5: Commit**

```bash
git add user-data/extensions/jobs/daily-brief/skeleton.ts user-data/extensions/jobs/daily-brief/skeleton.test.ts
git commit -m "feat(brief): enriched Weather & light section (directional sky reads, proportional disclosure)"
```

---

## Self-Review

**Spec coverage:**
- Component A (Open-Meteo, units, batching, fog re-source, wmoText, location) → Tasks 8, 10. ✅
- Component B (sun azimuth) → Task 2. ✅
- Component C (directional engine, sampling, classify, confidence) → Tasks 3, 4, 5. ✅
- Component D (color read, proportional disclosure, brief render, tiered degradation) → Tasks 6, 11. ✅
- Component E (recipes, fire-by-window lead gate, merge/cap/silent-cancel, deliver seam, dedup) → Tasks 7, 9, 10. ✅
- Data shapes (payload, SkyContext, ColorRead, RecipeMatch) → Task 1 + Task 10 payload. ✅
- Config (constants, two kill-switches) → Tasks 1, 10. ✅
- Error/degradation matrix → Task 11 (render tiers), Task 10 (`!ok` + partial-sample via directional confidence). ✅

**Placeholder scan:** No "TBD/handle errors/similar to". The two intentional "build the fixture" / "walk dates as current `fogNights` does" notes carry the exact shape + algorithm to reproduce. ✅

**Type consistency:** `CloudLayers/SkyContext/ColorRead/RecipeMatch/Notification` defined in Task 1, imported unchanged everywhere. `fogNights` renamed-signature is consumed only by Task 10 (matches). `sunBearings` return `{sunriseAz,sunsetAz}` consumed by Task 10. `fireMatches`/`matchRecipes`/`mergeMatches`/`colorRead`/`skyContext`/`samplePoints` signatures match across producer/consumer tasks. ✅

**Known follow-ups (carry into execution, not blockers):**
- Verify the exact relative import depth from the brief to `system/lib/sky/color.ts` at Task 11 (cross-tree import; the eBird design notes user-data↔system imports work, but confirm the `../` count).
- `precipitation_probability` units/availability for the rain-clearing gate — confirm against the live response when authoring the Task 10 fixture; if absent, fall back to `precipitation` amount crossing to 0.
