# Daily Briefing v3 — Insights, Photo Analysis, Calibration

**Status:** approved by Kevin 2026-05-16 (autonomous-resolution authority)
**Owner:** Robin core
**Schema bump:** `daily_briefing` events → `schema_version: 3`

## Motivation

The v2 daily briefing assembles 9 deterministic data sections (calendar, inbox, NHL, financials, markets, Whoop, weather, birding, quarantine) and ships two stale LLM-synthesis placeholders (`<!-- AWAITING_SYNTHESIS:health -->`, `<!-- AWAITING_SYNTHESIS:focus -->`) that have never been filled. The brief gives Kevin data, not analysis. Kevin's ask:

1. Include analysis and insights in each section, not just data
2. Proactively surface things Kevin isn't already thinking about
3. Make weather location-aware (currently pinned home → wrong on travel days)
4. Lock the decorative format inside the job so every consumer sees identical bytes
5. Add a section recapping what Robin learned about Kevin and committed to memory each day
6. Include photo analysis (what's working / what could be stronger) with photos linked for easy access
7. Use Opus 4.7 for synthesis to maximize insight depth

The brief is also Kevin's exception to his terse-by-default communication preference — descriptive, friendly prose is welcome here, but insights matter most.

## Architecture

```
daily-briefing.js          (orchestrator)
  ├─ briefing-data.js      (BriefingData assembly — deterministic sections)
  ├─ briefing-location.js  (3-tier resolution + geocode cache + sticky travel-day location)
  ├─ briefing-memory.js    (24h rolling learned items, agent_internal excluded)
  ├─ briefing-photos.js    (aggregation, baselines, streaks, locations)
  ├─ briefing-gallery.js   (thumb upload → robin publish, runs BEFORE render)
  ├─ briefing-synthesis.js (Opus 4.7 primary, Sonnet 4.6 fallback, prompt-cached)
  └─ briefing-render.js    (chrome, emoji sections, [mN] insight tagging, footer)
```

Order in `compose()`:
1. Assemble `BriefingData` from all sources (parallel)
2. Resolve today's location → write sticky location event
3. Pull memory-learned items (24h rolling)
4. Aggregate photos + publish gallery (returns slug)
5. Run synthesis (or reuse cached intra-day insights)
6. Render final markdown with chrome + insight tags
7. Capture event with `schema_version: 3`

Gallery publishes BEFORE render — render needs the slug. Synthesis runs AFTER gallery so insights can reference specific photos.

## Sections (final order)

```
🌅 chrome (separator + "DAILY BRIEFING · <day>, <m/d>" + separator)
👁️ What Robin's watching
📝 What Robin learned about you today
📅 Calendar
📬 Inbox
🏒 NHL
💸 Financials
📈 Markets
💪 Health — Whoop
🌤️ Weather — <resolved place>
📸 Photography (+ critique + gallery link)
🐦 Birding
🔮 On the horizon (renamed from "Memory pre-filter")
chrome footer with feedback instructions
```

## Synthesis — Opus 4.7

Single LLM call per fire (or skipped via intra-day reuse). Inputs:
- Full `BriefingData`
- Today's memory-learned items (top 8 by significance)
- Today's photos data + baselines
- Calibration profile (per-category usefulness)

Output: structured JSON.

```json
{
  "watching":   [{"id":"m1","category":"recovery_correlation","strength":"high","text":"..."}],
  "section":    {"calendar":{"id":"m4","category":"travel_logistics","text":"..."}},
  "learned":    [{"id":"m9","ref":"rules:abc...","category":"learned_preference","text":"..."}],
  "photo_critique": {
    "supportive": [{"id":"m12","text":"...","photo_ref":"photo1"}],
    "improvement": [{"id":"m13","text":"...","photo_ref":"photo2"}]
  },
  "insights_empty_ok": true
}
```

Unified `[m1], [m2], ...` insight ID namespace per brief — enables terse feedback like `m3 bad` or natural language `the m3 insight wasn't useful`.

### Insight categories

| Category | Prior | Notes |
|---|---|---|
| `recovery_narrative` | 0.5 | Whoop interpretation |
| `recovery_correlation` | 0.5 | Cross-domain (sleep × travel) |
| `sleep_debt` | 0.5 | Multi-day pattern |
| `spend_pattern` | 0.5 | Lunch Money pattern |
| `spend_anomaly` | 0.5 | Outlier transaction |
| `subscription_drift` | 0.5 | Recurring charges accumulating |
| `inbox_buried` | 0.5 | Real person under newsletter noise |
| `inbox_urgency` | 0.5 | Time-sensitive mail |
| `travel_logistics` | 0.5 | Flights + recovery + packing |
| `travel_packing` | 0.5 | Weather vs. destination mismatch |
| `learned_preference` | 0.5 | New rule from biographer |
| `learned_pattern` | 0.5 | Pattern noticed in user behavior |
| `learned_correction` | 0.5 | Correction recorded today |
| `photography_volume` | 0.5 | Shoot count vs. baseline |
| `photography_genre` | 0.5 | Genre mix read |
| `photography_critique_supportive` | 0.5 | What's working |
| `photography_critique_improvement` | 0.5 | What could be stronger |
| `photography_streak_break` | 0.5 | Active streak ended |
| `chrome_pattern_match` | 0.4 | Speculative — Chrome × inbox/calendar |
| `pattern_streak` | 0.4 | Speculative — multi-day pattern reads |
| `speculative_connection` | 0.4 | Speculative — cross-domain |
| `photography_reference` | 0.4 | Speculative — influence list cross-ref |

Speculative categories start at prior 0.4 (Opus's lower hallucination rate vs. Sonnet earns the higher prior); standard at 0.5.

### Synthesis prompt (system, prompt-cached)

```
You are Robin's daily-briefing analyst. You receive structured data for a
single day (calendar, inbox, NHL, financials, markets, Whoop, weather, photos,
birding, on-the-horizon) plus today's memory-learned items and today's photo
aggregations.

Your job:
1. Find genuine cross-domain patterns Kevin isn't already thinking about
2. Surface what's working and what could be stronger in his photo work
3. Recap what Robin learned about him today in a warm, plain prose paragraph

Tone: friendly, descriptive, plain. No superlatives ("brilliant", "stunning").
No flattery. Two-sided photography critique — name the technique, the frame,
the time window. Don't argue Kevin into a higher self-rating; honest critique
isn't flattery. Use the influence list (Moriyama, Leiter, Becher, Frank,
Eggleston) only when the subject genuinely matches.

When surfacing speculative or cross-domain connections, show the reasoning
chain in the insight text — "You searched X 3 days ago, then Y showed up in
inbox today — possibly related" beats "Y might relate to your X interest."

Each insight is tagged with a unique [m<N>] id (numbered sequentially across
the whole brief). Each photo critique insight references a photo anchor
([photoN]).

You receive a calibration profile mapping category → smoothed-usefulness score
(0.0–1.0). Categories with score < 0.25 over ≥3 votes should be suppressed
entirely unless the signal is exceptionally strong.

If no genuine signal exists in a category, emit nothing — do not fill slots.
Setting `insights_empty_ok: true` in your output confirms you considered each
section.
```

### Intra-day reuse

First fire of the day runs full Opus synthesis. Subsequent same-day fires reuse cached insights from the latest event unless:
- Any section's content differs >30% from cached
- Any new top-significance memory-learned item appeared
- Photo count differs by >5

If material change detected, re-run Opus. Otherwise reuse cached insights, only refresh deterministic data + timestamps.

### Fallback chain

1. Try Opus 4.7 (`claude-opus-4-7`, timeout 30s)
2. On 5xx/timeout: Sonnet 4.6 (`claude-sonnet-4-6`, timeout 15s)
3. On further failure: emit deterministic sections with `<!-- synthesis unavailable -->` marker, capture event with `meta.synthesis_failed: true`

Deterministic data sections never block on synthesis.

### Cost

- Opus 4.7 per call: ~2.5K dynamic + 1.5K cached input + 1.5K output ≈ $0.15/call
- Hourly 5–8 AM with intra-day reuse: ~30 actual calls/month
- **Total: ~$4.50/month synthesis**

Plus negligible Vercel Blob storage + bandwidth + `robin publish` Blob writes.

## Location-aware weather

`briefing-location.js` resolution order:
1. Today's calendar event with `meta.location` → geocode via google-maps MCP → `(lat, lng, place_name)`
2. Today's calendar event content with parseable address (e.g. hotel string) → same
3. **Sticky travel-day location**: latest `events:location__<date>` row from prior 48h
4. Pinned home: `runtime:config.location.home`

Geocode results cached in `runtime:geocode_cache` keyed by normalized location string (TTL 90 days).

After resolution, the job writes a sticky `events:location__<date>` row tagged `source='location'` so subsequent fires (and future briefs spanning travel) inherit the same location. New events table source: `location`.

Weather fetched live at compose time against resolved coords via the existing weather provider. Section header: `🌤️ **Weather — <place_name>**`.

When location ≠ home and weather diverges meaningfully (>10°F delta, different precipitation regime, sun-time delta >30min), synthesis can flag it as `travel_packing`.

## Memory-learned section

`briefing-memory.js` queries:

| Source | Filter | Weight |
|---|---|---|
| `rules` table | `created_at >= now-24h AND status='active'` | 3 |
| `events` source=`profile_update` | `ts >= now-24h` | 3 |
| `events` source=`correction` (or source=`record_correction`) | `ts >= now-24h` | 2 |
| `entities` table | `first_seen >= now-24h AND type IN (person, place, project)` | 1 |

Excludes `agent_internal` source (per commit `1a4f288` — biographer scratch, not user-facing).

24h rolling window, not local-calendar-day: brief fires at 5:30 AM local, by which time today's calendar-day has barely started. 24h rolling captures the overnight/previous-day learnings Kevin actually wants recapped.

Top 8 by weight × recency fed to synthesis. Synthesis returns:
- A warm prose paragraph recapping what Robin learned
- Per-item insight bullets tagged `[mN]`

**Empty-day handling:** section omitted entirely (no "Robin didn't learn anything" noise).

**Richer feedback semantics on this section:** feedback on a `[mN]` learned bullet does two things:
1. Records `insight_feedback` event (calibration loop)
2. Acts on the underlying memory row — `m9 bad` → marks `rules:abc...` for pending-revocation; `m9 wrong, it's actually X` → triggers a fresh `record_correction` against the rule

## Photo section

`briefing-photos.js` aggregates from `events` source=`photos`, 24h rolling + 30d baseline:

```js
{
  todayCount: number,
  baselineAvg: number,
  categoryMix: { birds: 12, cityscape: 47, street: 15 },
  locations: [{ place: "Costa Mesa hotel grounds", count: 28, photoRefs: [...] }],
  timeDistribution: {
    morning: 8,      // < 10am local
    goldenAm: 4,     // 1hr around sunrise (from location-resolved sun times)
    midday: 35,
    goldenPm: 0,
    bluePm: 0
  },
  streakDays: number,                // consecutive shooting days incl. today
  syncStaleness: { lastSyncMs, label: '4h ago' | null }
}
```

Sunrise/sunset come from the location-resolved weather section — reuse, don't re-fetch.

**Streak definition:** ≥1 photo per local-date for ≥3 consecutive days. Streak-break = first day with 0 photos after an active streak ends; surfaced as `photography_streak_break`.

**Sync-staleness label:** if photos integration's `last_sync_at` is >3h old, brief shows "📸 Photography (last sync 4h ago)" — avoids the silent "today shows yesterday's shot count" trap.

**Apple Photos UUID dependency:** photos integration must capture `meta.photos_uuid` for the open-in-Photos URL scheme link. If absent, the open-in-Photos link is omitted and only the full-res Blob link is shown. Scope: verify integration captures it; extend if not.

## Gallery — published per day

`briefing-gallery.js`:

1. **Slug computation**: `brief-photos-<YYYY-MM-DD>-<random8>`. Random 8-char suffix computed once per day, stored in `runtime:gallery_slugs` keyed by date. Stable across hourly fires within the day.

2. **Thumbnail generation**: 1024px longest edge, ~80KB each (HEIC → JPEG via sharp). Uploaded to Vercel Blob as public objects.

3. **Gallery markdown** (composed in-memory):
```markdown
# Photos — 2026-05-16
**47 photos · cityscape (32), street (15) · 1.2× baseline**

## Costa Mesa hotel grounds · 28 photos

<a id="photo1"></a>
![](https://blob.vercel-storage.com/.../IMG_1234_thumb.jpg)
**[photo1]** · 5:42 AM · cityscape · IMG_1234.heic
[Open in Apple Photos](photos-redirect://library?uuid=<uuid>) · [Full-res](https://blob.vercel-storage.com/.../IMG_1234.jpg)
```

4. **Publish**: `robin publish --source <gallery.md> --slug brief-photos-<date>-<random8> --mode overwrite` (explicit overwrite — slug collision behavior in `default` mode is mode-sensitive, so be explicit per CLAUDE.md publish notes).

Returns `https://askrobin.io/p/brief-photos-<date>-<random8>` — embedded in brief.

5. **Privacy override** (new CLI subcommand): `robin brief gallery private --date <date>` flips a brief day's gallery to a private token-gated blob. Default is public for ease-of-access.

6. **Retention**: new scheduler bucket `gallery-prune` runs daily at 04:00 local. Deletes brief galleries + thumbnail blobs older than 30 days. Pattern matches `log-rotate`.

## Format locked in `briefing-render.js`

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🌅 **DAILY BRIEFING** · <day-of-week>, <m/d>
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

👁️ **What Robin's watching**
- [m1] ...
- [m2] ...

📝 **What Robin learned about you today**
<prose>
- [m9] ...

📅 **Calendar today**
- ...
_<m4 section insight italicized>_

(remaining sections, see above)

📸 **Photography**

47 photos today · cityscape (32), street (15) · 1.2× 30d baseline
📁 [Gallery →](https://askrobin.io/p/...)

Locations: Costa Mesa hotel grounds (28), Avenue of the Arts (19)
5:42a–10:18a · golden hour used

**What's working** [m12]
- ...

**What could be stronger** [m13]
- ...

🐦 **Birding**
- ...

🔮 **On the horizon**
- ...

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
_To improve future briefs:_
_• Reply `m3 bad` or `m3 good` — Robin learns which insights land_
_• Or natural language: "the m3 insight wasn't useful"_
_• Calibrate a whole category: `robin brief calibrate <category> <0.0-1.0>`_
```

Schema bumps to v3. Event content IS the final delivery format — recall and Discord see identical bytes.

Discord chunking: brief will run ~3–4K chars. `formatter.splitMessage` is code-fence-aware; emoji section headers are natural chunk boundaries.

## Calibration loop

### Capture surfaces

| Surface | Trigger | Stored as |
|---|---|---|
| CLI | `robin brief feedback m3 bad|good|neutral` | `events:insight_feedback__<insight_id>` |
| Natural language | `record_correction` content/prior_response contains `\b[mM]\d{1,3}\b` | Same |
| ~~Discord reactions~~ | Dropped — coarse signal drags too many categories | — |

Insight rows: `{ source: 'insight_feedback', meta: { insight_id, category, verdict, brief_event_id } }`.

For `learned_*` category insights, feedback additionally acts on the underlying memory row (rule revocation, fresh correction).

### Rollup — new scheduler bucket `insight-calibration`

Runs daily at 03:00 local. Aggregates last 90 days of `insight_feedback` events (capped for I/O), applies exponential decay with 30-day half-life:

```
weight(t) = exp(-Δdays / 30)
useful_w = Σ weight(t) for verdict='good'
not_useful_w = Σ weight(t) for verdict='bad'
score = (useful_w + α·prior) / (useful_w + not_useful_w + α)
where α = 10
prior = 0.4 for speculative_*, photography_reference, chrome_pattern_match, pattern_streak
        0.5 otherwise
```

α=10 (bumped from initial 5) — needs more evidence before moving off prior, fits "calibrate over time" framing.

Writes per-category scores to `runtime:insight_calibration` row. Next synthesis pass reads this in its system prompt.

**Manual override:** `robin brief calibrate <category> <0.0–1.0>` directly sets a category's usefulness score (skipping the smoothing math). Useful for hard suppressing or boosting.

### Suppression behavior

Synthesis prompt is told: "Categories with score < 0.25 over ≥3 votes should be suppressed entirely unless signal is exceptionally strong." Opus enforces.

Cold start: zero feedback → all categories at prior. New categories also start at prior.

## CLI surface additions

| Command | Effect |
|---|---|
| `robin brief feedback <m_id> <good|bad|neutral>` | Record feedback on a specific insight |
| `robin brief calibrate <category> <0.0-1.0>` | Manual override for a category's usefulness |
| `robin brief gallery private --date <date>` | Flip a day's gallery to private blob |
| `robin brief regenerate [--date <date>]` | Force re-synthesis (skips intra-day cache) |

## record_correction extension

Extend `record_correction` to:
1. Detect `\b[mM]\d{1,3}\b` tokens in `content` and `prior_response`
2. Look up the insight in `events:daily_briefing__*` from the last 24h (search the JSON insight blob)
3. Attach correction to insight's category via `events:insight_feedback__*`
4. For `learned_*` categories, also act on the underlying memory row

If multiple `mN` tokens are present, attach correction to each.

## Schema v3

`daily_briefing` events bump `schema_version: 2 → 3`. New `meta` fields:
- `meta.insights`: JSON of structured insight output
- `meta.gallery_slug`: slug for that day's gallery (null if no photos)
- `meta.synthesis_model`: `'opus-4-7' | 'sonnet-4-6' | null`
- `meta.synthesis_failed`: bool
- `meta.location_resolved`: `{ lat, lng, place_name, source: 'calendar'|'sticky'|'home' }`

v2 events stay as-is — recall surfaces both schemas transparently.

## New SurrealDB tables / runtime rows

- `runtime:insight_calibration` — single row, JSON map of category → score
- `runtime:geocode_cache` — keyed by normalized location string, TTL 90d
- `runtime:gallery_slugs` — keyed by date, holds random suffix
- `events:location__<date>` — sticky daily location row (source='location')
- `events:insight_feedback__<insight_id>` — per-feedback row (source='insight_feedback')

No new tables; new event sources + runtime singleton rows.

## Test surface

- `briefing-render.test.js` — chrome snapshot, insight ID injection, empty-section omission, footer rendering
- `briefing-location.test.js` — 3-tier fallback, geocode cache hit/miss, sticky travel-day location
- `briefing-memory.test.js` — `agent_internal` exclusion, 24h rolling window, significance weighting, empty-day omission
- `briefing-photos.test.js` — aggregation, baseline math, GPS clustering, streak definition, streak-break detection, sync-staleness label
- `briefing-gallery.test.js` — thumbnail generation (mocked sharp/heic), upload idempotency on hourly fires, retention pruning, missing-UUID graceful degradation
- `briefing-synthesis.test.js` — fixture-fixture (mocked Anthropic), intra-day reuse, material-change re-run, Opus→Sonnet fallback, calibration suppression with α=10
- `briefing-calibration-rollup.test.js` — exponential decay math, smoothing, manual override
- `briefing-feedback-cli.test.js` — `robin brief feedback`, `robin brief calibrate` end-to-end
- `record-correction-mN-parsing.test.js` — `\b[mM]\d{1,3}\b` tokenization, lookup, dual-action on `learned_*`
- **Integration: end-to-end calibration loop** — mock synthesis emits `speculative_connection` → 5× `robin brief feedback bad` → next compose has category suppressed
- **Integration: 10-photo fixture** → gallery page builds → brief links resolve to anchors

## Out of scope (follow-ups)

- Location-aware cron delivery window (brief fires at user's *current* local 5–8 AM, not home time)
- Per-bullet Discord reactions (Discord API is message-level only)
- Web UI for calibration overrides
- Pre-emptive insight push notifications (briefs stay pull-based)
- v2 → v3 migration of past briefings (recall handles both)
- ML-based insight ranking (current calibration is statistical only)

## Decisions log

- **Synthesis model:** Opus 4.7. Reason: Kevin corrected initial Sonnet pick — frontier-model-only rule overrides cost optimization for analysis work.
- **Calibration α:** 10. Reason: 5 was too aggressive; needs more evidence before suppression.
- **Window:** 30-day exponential decay (90-day cap). Reason: faster adaptation than 90-day flat, smoother than 30-day cutoff.
- **Discord reactions:** dropped from calibration. Reason: coarse signal across multi-insight briefs drags categories down wrongly.
- **Intra-day reuse over exact-hash short-circuit:** Reason: cleaner architecture; only re-runs on material change.
- **Critique tone:** two-sided, plain. Reason: Kevin corrected initial "never rate" instruction — wants what's-working AND what-could-be-stronger.
- **Gallery default privacy:** public with random-suffix slug. Reason: Kevin asked for easy access; enumeration resistance via random suffix is sufficient for non-sensitive photos. Manual `gallery private` flag available.
- **Memory-learned window:** 24h rolling, not local-calendar-day. Reason: brief fires at 5:30 AM; calendar-day has barely started; rolling matches actual usage pattern.
