# Photographer Sky Forecast — Directional Sky Context + Light Alerts

**Date:** 2026-06-25
**Status:** Approved design, pending implementation plan
**Owner files:** `system/lib/sky/` (new), `system/lib/solar.ts`, `system/integrations/builtin/weather/{index.ts,integration.yaml,fog.ts}`, `user-data/extensions/jobs/daily-brief/skeleton.ts`

## Motivation

The daily brief's `🌤️ Weather & light` section already does more than it shows — a
NOAA solar engine (`system/lib/solar.ts`) computes sunrise/sunset + golden/blue
hour (morning *and* evening), and a real radiation-fog index
(`weather/fog.ts`) scores dew-point spread / RH / wind. But it pulls from
**wttr.in**, *discards* cloud cover, humidity, wind, and visibility, and surfaces
only temperature, description, sunrise/sunset, evening golden hour, and fog.

Kevin is a street + Manhattan-skyline + birding photographer in Astoria who
wants the brief to answer the question a normal weather app can't: **will the
sunrise/sunset have colour, and is it worth heading out?** This is the explicit
ask — "rip the features" from PhotoSignal (photosignal.app), whose differentiator
is *Sky Context*: reading the sky **around** you (directional cloud + horizon
gaps), not just **above** you, and alerting on photographic windows with an
explainable Matched / Window / Caution structure rather than a black-box score.

Two surfaces:
1. **Enriched brief section** — a photographer-grade sky read every morning
   (deterministic, zero-network at render).
2. **Proactive light alerts** — a macOS notification when a colourful
   sunrise/sunset, fog-near-sunrise, or rain-clearing window becomes likely.

## Current state

- `weather/index.ts` `tick()` — fetches `https://wttr.in/{location}?format=j1`,
  defaults `location='New+York'` (geocodes to NYC *center*, not Astoria), parses
  current temp/desc + the 3-day hourly forecast for fog, derives solar windows
  from the response's `nearest_area` lat/lng, and ingests one
  `integration.tick` event normalized to kind `weather.current`. Cron
  `"0 4,16 * * *"` (4am keeps the 4:30am brief fresh; 4pm for evening planning).
- `weather/fog.ts` — radiation-fog composite (0–10): dew-point spread 45% / RH
  30% / wind 25%, then `MAX(composite, chanceoffog)` from wttr.in's own field;
  night = 21:00→06:00 in 3h slots. Emits `FogNight[]` (index, band, peak_window,
  factors).
- `system/lib/solar.ts` — NOAA solar position; returns sunrise/sunset (−0.833°),
  golden-hour (±6°), blue-hour (−6°) times. Computes **times only — no azimuth.**
- `daily-brief/skeleton.ts` `renderWeather()` (~L987–1030) — reads the latest
  `weather.current` event; if >6h stale, falls back to a bounded **live fetch**
  (`fetchLive('weather')`); renders temp · desc · sunrise/sunset · evening golden
  hour · fog. Brief is a deterministic, **zero-LLM** renderer (dream-synthesis
  adds reasoning in a separate layer).
- **Notify:** `system/integrations/builtin/notify/index.ts` →
  `notifyMacOSAction({title,message})` (osascript `display notification`). macOS
  only — no phone/push/email/Discord. The health monitor is the sole current
  caller.
- **Alerts:** `system/kernel/runtime/alert-store.ts` — `recordAlert/resolveAlert/
  ackAlert`; table from migration `024-alerts.ts` with unique index
  `alerts(source,key) WHERE resolved_at IS NULL` (one open alert per key).
  Surfaced via `robin alerts` + MCP `alerts`; **not** pushed except health-monitor
  CRITICAL.
- **Scheduling:** internal daemon cron (not launchd); any cron string in
  `integration.yaml`, multiple times/day supported. `IntegrationContext`
  (`_runtime/types.ts`) exposes `db, fetch, state, log, now, ingest,
  checkOutbound` — no notify helper, but a tick can `import { notifyMacOSAction }`
  and `recordAlert(ctx.db, …)` directly. Ticks run inside a 120s `withTimeout`.

## Design decisions (settled in brainstorming)

| Axis | Choice |
|---|---|
| Surfaces | Enriched brief **+** proactive alerts |
| Alert delivery | macOS desktop notification (existing `notifyMacOSAction`); **desktop-only** by Kevin's choice |
| Sky Context depth | **Full directional** — sample along the sun azimuth to ~120 km, classify blocked/clear/mixed/promising |
| Data source | **Open-Meteo** (free, no key) replacing wttr.in |
| Code organization | Shared pure `system/lib/sky/` engine + thin consumers (weather tick + brief), mirroring `solar.ts` |
| v1 recipes | 🌅 colourful sunrise · 🌇 colourful sunset · 🌫️ fog near sunrise · ⛈️→☀️ rain clearing into golden hour |
| Deferred (phase 2) | 🌕 moon timing · 🌊 tide window · phone channel · ensemble-spread confidence |

## Architecture

```
weather tick (cron 0 4,12,14,16,18,20)
  ├─ fetch Open-Meteo @ Astoria: current + hourly (cloud layers, dewpoint, precip, vis, wcode)
  │   + multi-point along sun azimuth — ONE batched request (comma-separated coords)
  ├─ solar.sunPosition() → sunrise/sunset times + azimuths (per date; NE↔SE seasonal swing)
  ├─ sky engine [pure]:  clouds→color read · directional→blocked/clear/mixed/promising · fog (re-sourced)
  ├─ recipes.match(upcoming window) → alert candidates (Matched/Window/Caution)
  ├─ ctx.ingest('weather.current') — ADDITIVE payload: old fields kept, sky read added
  └─ if matched & not already fired this window:  recordAlert(ctx.db) → deliver() → notifyMacOSAction()

daily brief (4:30am) ──reads latest weather.current payload (no network)──> renderWeather() → enriched section
```

The defining seam: **the tick computes everything and stores it in the event
payload; the brief only renders.** This preserves the brief's zero-network
determinism (the 4am tick keeps the payload fresh for the 4:30am render) and is
why the engine must be a pure, separately-callable lib — both the tick (network)
and the brief (no network) call the same functions. All changes reuse the
existing `weather` integration shell, the `weather.current` event kind, and the
brief's render path; only `system/lib/sky/` is net-new.

**Two surfaces, two freshnesses:** the brief is the *morning forecast* (4am
payload); the afternoon/evening ticks are the *fresh re-checks* that actually
fire alerts.

## Component A — Data source: wttr.in → Open-Meteo

Endpoint `https://api.open-meteo.com/v1/forecast`, no API key. One request per
tick carrying **all** sample coordinates (verified: `latitude=a,b,c&longitude=
…` returns an array of per-location structures — the directional sample is a
single HTTP call, not N).

- **Params:** `temperature_unit=fahrenheit`, `wind_speed_unit=mph`,
  `timezone=auto`, `forecast_days=2` (today + tomorrow, for the night-before
  sunrise look-ahead), `current=…`, `hourly=…`, `daily=sunrise,sunset`.
- **Hourly variables** (verified present): `cloud_cover`, `cloud_cover_low`,
  `cloud_cover_mid`, `cloud_cover_high`, `temperature_2m`, `dew_point_2m`,
  `relative_humidity_2m`, `wind_speed_10m`, `precipitation`,
  `precipitation_probability`, `visibility`, `weather_code`. (Low/mid/high cloud
  ≈ below 3 km / 3–8 km / above 8 km.)
- **Location** becomes explicit config — Astoria `40.764, -73.923` (a
  `weather/integration.yaml` field, read into `ctx.state`), no longer geocoded.
  The directional ray's *origin* must be correct or "120 km WNW" points at the
  wrong sky.
- **Description text:** wttr.in's `weatherDesc` string has no Open-Meteo
  equivalent — Open-Meteo returns only a numeric `weather_code`. The `desc`
  field (and the brief's "partly cloudy") derives from a small `weather_code`
  (WMO) → text lookup added alongside `fog.ts`.

**Fog re-sourcing is not 1:1** (`fog.ts` keeps its scoring; only inputs change):
wttr.in's Fahrenheit/mph come from unit params above; wttr.in's `chanceoffog`
has **no Open-Meteo equivalent**, so the `MAX(composite, chanceoffog)` term is
replaced by two stronger native signals — `weather_code ∈ {45,48}` (fog / rime
fog) and low `visibility` in the night hours. Net: fog detection likely
*improves*, but expect re-tuning (the fog threshold is the #1 tuning candidate
regardless).

## Component B — Solar geometry: add azimuth

`solar.ts` gains `sunPosition(lat, lng, date) → {azimuth, altitude}` using the
hour-angle / declination it already computes (azimuth from the standard
`atan2` solar-azimuth formula). At sunrise/sunset we take the **azimuth** — the
compass bearing where the sun meets the horizon — which swings seasonally (≈58°
ENE late June from Astoria → ≈120° SE in December). Existing `solarTimes()` is
untouched; this is purely additive.

## Component C — Directional Sky Context engine (`sky/directional.ts`)

The novel core. Given the origin, the sun azimuth, and a cloud-layer fetcher:

1. **Cast the ray.** From Astoria, walk *toward* the azimuth (forward-geodesic)
   and sample at **0, 25, 50, 90, 120 km**, plus a **±12° fan** at the far two
   points — ~7–9 points, all in the one batched Open-Meteo request. (A ground
   proxy for the low-angle light path — good enough to *locate a bank*, which is
   the job; not radiative transfer.)
2. **Measure, in two zones:**
   - **Horizon gap** ← `cloud_cover_low` over the **far field** (90/120 km +
     fan). Gap = *min* low-cloud `< 25%`; bank = *min* still `> 60%`.
   - **Canvas** ← `cloud_cover_high + cloud_cover_mid`, *mean* over the **near
     field** (0–50 km incl. overhead). Must clear a **lower bound (≥25%)** —
     there is **no upper cap**: high/mid cloud, even thick cirrus, is a catching
     canvas. The colour-killing *flat overcast* is **low** cloud, already handled
     by the horizon-gap/bank path — so a thick high/mid deck with an open horizon
     still reads `promising`. (The `70` in `canvasBandPct` is retained as
     documentation of the original "sweet spot" intent but is not enforced.)
3. **Classify (verdict):** `Promising` = gap ∧ canvas-in-band · `Blocked` = no
   gap (low-cloud bank toward the sun) · `Clear` = gap ∧ canvas `<15%` (light
   gets through, nothing to colour) · `Mixed` = everything marginal.
4. **Confidence** ← `f(lead-time, threshold-marginality)`: low at ~16 h lead,
   higher at ~2 h, knocked down when values sit on a boundary. (Phase-2: replace
   with Open-Meteo *ensemble* Mean+Spread for a data-driven uncertainty.)

The core insight: **a colourful sunrise/sunset needs the sky clear *where the
sun is* (a low-cloud horizon gap so low-angle light escapes) and cloudy *where
you look* (high/mid cloud overhead as a canvas to redden).** The killer is not
"overcast above me" — it's a low-cloud bank ~90 km out toward the sun, the one
thing a single-point forecast cannot see.

Output `SkyContext { window, horizonGap, gapBearing, canvas:{high,mid}, verdict,
confidence, perSample[] }`. Thresholds (`25` gap / `60` bank / `15` empty-canvas;
canvas enforces only the `≥25%` lower bound) live in one `sky/constants.ts`,
tuned after real results. Confidence also scales by **sample coverage** (the
fraction of directional samples Open-Meteo actually returned), so a partial
response yields lower confidence rather than a confident wrong read. **v1 scope:**
sun-direction only — anti-solar afterglow (eastern sky after a sunset) deferred.

## Component D — Color read + brief rendering

`sky/color.ts → ColorRead { window, band, why, caution|null, confidence }`,
band ∈ {unlikely, plain, mixed, promising}, derived from `SkyContext` + cloud
layers. **Deterministic templating, no LLM** — the `why`/`caution` strings are
built from the structured fields (`verdict=Promising, canvas.high=55,
horizonGap=true, gapBearing=WNW` → `"Promising: high cloud overhead + clear WNW
horizon."`), identical every render and fully testable. (The skeleton is
zero-LLM; reasoning is dream-synthesis's job.)

**Proportional disclosure** (anti-noise): promising/mixed get full why + caution;
plain/unlikely collapse to one terse line. The brief renders today's **sunrise**
(imminent at 4:30am) + today's **sunset** (forecast); tomorrow's sunrise is the
8pm alert's job, not the brief's.

Rendered section (the faithful preview *is* the markdown):
```
🌤️ Weather & light
- 72°F · partly cloudy · wind 7 mph
- 🌇 Sunset 8:30 PM (az 302° WNW) — Promising: high cloud overhead + clear WNW horizon.
     ⚠ low-cloud bank ~90 km WNW may close the gap · confidence moderate (morning forecast — re-checks 4pm)
- 🌅 Sunrise 5:25 AM (az 58° ENE) — clear, low colour potential.
- Light: golden AM 5:25–6:08 · PM 7:49–8:30 · blue AM 4:54–5:25 · PM 8:30–9:01
- 🌫️ Fog tonight: 3/10 (possible) · peak 3am–6am · spread 7°F · RH 81% · wind 5 mph
```

**Tiered degradation** (brief never blanks, never fetches — the existing
`fetchLive('weather')` fallback is *removed* in favour of this):
- *Open-Meteo partial* (obs ok, cloud layers missing): keep temp · sun/golden/
  blue · fog; drop 🌅/🌇 reads; note `sky context unavailable today`.
- *Open-Meteo fully down*: solar lines still render from the hardcoded Astoria
  coords + pure math; note `weather data unavailable — light times only`.
- *Pre-rollout / first brief after deploy*: the latest event still has the old
  payload → renders the partial-degradation state until the next tick
  repopulates (self-heals within hours).

## Component E — Alert recipes + firing & scheduling (`sky/recipes.ts`)

**Firing model — by window, not by clock** (decouples *when we tick* from *when
we alert*, so seasonal sunrise/sunset drift doesn't matter):

| Window | Recipes | Fires | Lead | Rationale |
|---|---|---|---|---|
| **Tomorrow's sunrise** | 🌅 colour · 🌫️ fog | **8pm prior evening** | ~9 h | Awake to decide + set an alarm; never a 4am ding |
| **Today's sunset** | 🌇 colour · ⛈️→☀️ clearing | afternoon, **lead-gated 1.5–5 h** | 1.5–5 h | Same-day, time to act |
| *(4am)* | — none — | data refresh only | — | Sunrise nudge already went out at 8pm |

Cron `"0 4,12,14,16,18,20 * * *"` — afternoon ticks every 2 h so the 1.5–5 h gate
*always* has a candidate whether sunset is 4:30pm (winter) or 8:30pm (summer).
The tick hour is irrelevant; the per-window lead gate does the work.

**Recipe matchers:**

| Recipe | Fires when |
|---|---|
| 🌅 Colourful sunrise | `ColorRead(sunrise).band = promising` (or `mixed` + high confidence) |
| 🌇 Colourful sunset | `ColorRead(sunset).band = promising` (or `mixed` + high confidence) |
| 🌫️ Fog near sunrise | fog index **≥ 6 (*likely*)** *and* the fog window covers the sunrise hour |
| ⛈️→☀️ Rain clearing | precip in pre-window hours → clearing (`precipitation_probability` drop + low-cloud break) *inside* a golden-hour window — **lowest-confidence recipe**, gated tighter (clearing imminent + high prob), labelled as such |

**Load control:**
- **Merge** co-firing recipes for the *same window* into one banner
  (`🌅 Tomorrow's sunrise: colour + river fog — worth an alarm`). Net **≤ ~2 sky
  notifications/day**.
- **Cancellation** when a fired window later worsens: **silently
  `resolveAlert()` the row** (reflected in `robin alerts` + the next brief) —
  **no cancellation banner**, to avoid notification churn.

**Notification format** — terse Matched / Window / Caution (osascript banners
truncate hard: ~1 title + ~2 short lines, no rich formatting):
```
🌇 Sunset may be colorful — head out
7:49–8:30pm · high cloud + clear WNW horizon · ⚠ bank 90km W may close it
```
The banner is the *nudge*; the **full read persists** in the `alerts` table
(`robin alerts`) and the next brief.

**Delivery seam:** every alert routes through a single `deliver(notification)`
(today → `notifyMacOSAction`). A phase-2 phone channel (ntfy/Pushover) drops in
*here* without touching recipe logic.

**Dedup:** `recordAlert(ctx.db, {source:'sky', key:'sunset:2026-06-25',
severity:'info', message, context})`. The `(source,key) WHERE resolved_at IS
NULL` unique index gives one alert per window per day; the tick checks for an
open row before firing; a daily sweep resolves stale sky alerts.

## Data shapes

- **`weather.current` payload (additive):** existing fields (`location, temp_f,
  desc, fog_nights, sunrise, sunset, golden_hour_*, blue_hour_*`) **kept**, plus
  `sky: { sunrise: ColorRead, sunset: ColorRead, asOf }` and `current:
  { wind_mph, cloud_cover }`. Old consumers unaffected; brief reads the new
  block when present.
- **`SkyContext`** `{ window:'sunrise'|'sunset', horizonGap:boolean, gapBearing,
  canvas:{high,mid}, verdict:'blocked'|'clear'|'mixed'|'promising', confidence,
  perSample:[{distKm,bearing,low,mid,high}] }`.
- **`ColorRead`** `{ window, band:'unlikely'|'plain'|'mixed'|'promising', why,
  caution|null, confidence }`.
- **`RecipeMatch`** `{ recipe, window, fireAt, title, body, key, mergeGroup }`.

## Error handling / degradation matrix

| Failure | Result |
|---|---|
| Open-Meteo non-200 / timeout | tick returns `{status:'error'}`; brief renders last good payload, else tiered degradation |
| Some directional sample points missing | verdict computed from returned points; **confidence lowered**, not aborted |
| Cloud layers absent but current obs ok | brief = partial degradation (`sky context unavailable today`) |
| Open-Meteo fully unreachable at render | brief = solar-only (`weather data unavailable — light times only`) |
| `weather.current` payload pre-rollout shape | brief = partial degradation until next tick repopulates |
| `notifyMacOSAction` throws / non-darwin | swallowed (logged); alert row still recorded — visible in `robin alerts` |
| Fired window later worsens | `resolveAlert()` silently; no cancellation banner |
| `skyContext`/`skyAlerts` kill-switch off | engine still runs for the brief / alerts suppressed, respectively |

## Testing (collocated, node:test)

- `sky/clouds.test.ts` — layer arrays → color-potential read.
- `sky/directional.test.ts` — fixture sample-sets → verdict, incl. canonical
  cases: **"100% cloud overhead + far horizon gap = promising"** and **"clear
  overhead + low-cloud bank at 90 km = blocked"**; partial-sample → lowered
  confidence; ±12° fan picks up an off-bearing gap.
- `sky/color.test.ts` — deterministic templating (same fields → same string);
  proportional disclosure (plain → one line, promising → why+caution).
- `sky/recipes.test.ts` — each matcher; lead-gate (1.5–5 h); dedup against an
  open alert row; **merge** of co-firing same-window recipes; **`deliver()` is
  injected** so tests assert candidates and never shell out to osascript.
- `solar.test.ts` (extend) — `sunPosition` azimuth against known
  sunrise/sunset bearings for Astoria at solstices/equinox.
- `weather/index.test.ts` (extend) — Open-Meteo fixture parse; fog re-sourcing
  (units + `weather_code`/`visibility` replacing `chanceoffog`); additive
  payload shape.
- `daily-brief/skeleton.test.ts` (extend) — enriched render from a seeded
  payload; all three degradation tiers; proportional disclosure.

**Honest limit:** unit tests prove *logic*, not *predictive accuracy* — "did
promising actually predict colour" has no automatic ground truth. v1 validates
via the manual "save and tune" loop; phase-2 could log a `predict` when an alert
fires for later calibration.

## Config & tunability

`system/lib/sky/constants.ts` — directional thresholds `25/60/15/70`, canvas
band `25–70%`, fog threshold `≥6`, lead band `1.5–5 h`, sample distances
`[0,25,50,90,120]` + `±12°` fan, Astoria coords. **Two decoupled kill-switches**
(following the `behavior.enabled` / `biographer.domainGating` pattern):
`weather.skyContext.enabled` (brief enrichment) and `weather.skyAlerts.enabled`
(notifications) — "rich brief, no pings" is a valid state.

## Rollout

Additive payload → brief backward-compatible. wttr.in→Open-Meteo swap +
`fog.ts` re-sourcing land together. Deploy = `pnpm build` → daemon restart →
**MCP server restart** (separate processes). First brief post-deploy may show
the partial-degradation state until the next weather tick repopulates the
enriched payload.

## Decisions

- **Shared pure `sky/` lib, not in-tick logic** — the directional + color
  reasoning is the novel, complex, fixture-testable part; keeping it pure (no
  network) is what lets both the network-bound tick and the zero-network brief
  call it. *(Approach 2 of 3; approved 2026-06-25.)*
- **Reuse the `weather` integration + `weather.current` event** rather than a new
  `sky` integration — smallest blast radius; no consumer migration. The single
  `integration.yaml` cron handles all eval times via a multi-hour string.
- **Banded verdict, never a numeric "shoot score"** — matches PhotoSignal's
  explicit no-score stance; the fog index stays numeric (it scores a measurable
  condition, not an aesthetic). *(Approved 2026-06-25.)*
- **Desktop-only delivery** — Kevin's choice; the `deliver()` seam keeps a phone
  channel a clean phase-2 add. Honest tradeoff: afternoon weekday sunset alerts
  may land on an asleep home Mac — most reliable on weekends / when home.
- **Sunrise alerts fire the night before (8pm), not at 4am** — resolves both the
  lead-time gate and the quiet-hours problem; you're awake to set an alarm.

## Out of scope (phase 2+)

- 🌕 Moon timing (moonrise aligned over the Manhattan skyline — needs a lunar
  ephemeris) and 🌊 tide windows for Jamaica Bay (needs a NOAA Tides & Currents
  feed).
- Phone / push delivery channel (ntfy, Pushover) behind the `deliver()` seam.
- Ensemble Mean+Spread confidence (replacing the lead-time heuristic).
- Anti-solar afterglow (eastern sky colour after a western sunset).
- `predict`-based accuracy calibration of the color thresholds.

## Sources

- Open-Meteo Forecast API — https://open-meteo.com/en/docs (verified 2026-06-25
  via Context7: `cloud_cover_low/mid/high`, `dew_point_2m`, `visibility`,
  `weather_code`, daily `sunrise`/`sunset`, comma-separated multi-coordinate
  batching, `temperature_unit=fahrenheit`, `wind_speed_unit=mph`).
- PhotoSignal — https://photosignal.app/ , /sky-context ,
  /how-to-create-colourful-sunrise-sunset-alert (Sky Context model; colourful-sky
  cloud-layer logic; Matched/Window/Caution; explicit no-score stance).
