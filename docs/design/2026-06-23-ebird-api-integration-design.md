# eBird API Integration — Live Query Actions + Sync Upgrade

**Date:** 2026-06-23
**Status:** Approved design, pending implementation plan
**Owner files:** `user-data/extensions/integrations/ebird/`, `user-data/extensions/jobs/daily-brief/skeleton.ts`

## Motivation

The current `ebird` extension is a passive, single-hotspot background sync: every
12h it pulls recent observations for one hotspot (Central Park `L191106` by
default) and appends to a flatfile. It cannot answer questions **on demand** —
there are no MCP actions — so Robin can't pull "recent + notable sightings near
hotspots X/Y/Z, ranked by count" mid-conversation. This gap bit directly on
2026-06-23: vetting train-accessible birding destinations required live density
data, eBird's website is bot-walled (both `ebird.org` and `birdinghotspots.org`
returned bot blocks to fetches), and there was no API path to fall back on.

Two goals:
1. **Live query (A):** on-demand MCP actions so Robin reasons over eBird data in a
   conversation — data-driven spot-finding, "what's notable near this station,"
   density vetting before a recommendation (the Randall's-Island discipline:
   weight abundance, discount single-individual rows, never infer from presence).
2. **Sync upgrade (B):** multiple hotspots, and a birding line in the daily brief.

## Current state

- `user-data/extensions/integrations/ebird/index.ts` — `tick()` hits
  `GET /v2/data/obs/{hotspot}/recent` (`back=14`, `maxResults=100`), dedupes on
  `(date, species, location)`, writes a rolling 300-row flatfile
  `user-data/content/knowledge/birding/recent-observations.md`. No `actions`
  export, no event-store write (deliberate — see Decisions).
- `integration.yaml` — `schedule: '0 */12 * * *'`, `secrets: [EBIRD_API_KEY]`,
  `network: [api.ebird.org]`. Key already provisioned in the secrets `.env`.
- MCP exposure: `system/surfaces/mcp/extension/server.ts:439`
  `registerUserExtensionActions()` auto-discovers any user-data extension that
  exports an `actions` map and registers it as an MCP tool (precedent:
  `spotify_write`). **No `server.ts` change and no builtin promotion needed.**
- Brief: deterministic renderer at `user-data/extensions/jobs/daily-brief/`
  (`skeleton.ts` renders all sections; `compose.ts` merges reasoning). The
  brief-v2 design added `photowalks` as an integration feeding the 📷 Photography
  section — the exact pattern this birding line mirrors. Both renderer and eBird
  extension live under `user-data/`, so the renderer can read the eBird flatfile
  with no cross-tree import problem.

## Architecture

```
On demand (conversation)        ebird MCP tool → {action, params} → eBird API (+ ~10min cache)
Every sync tick (cron)          tick() → loop hotspots → recent-observations.md
                                       → one region notable pull → notable-sightings.md
4:30am daily-brief (renderer)   skeleton.ts reads notable-sightings.md → 📷 Photography line
```

All changes are additive to the existing extension plus one block in the brief
skeleton. eBird stays a user-data extension; sightings stay ambient (flatfile),
never the event store.

## Component A — MCP query actions

Export an `actions` map from `ebird/index.ts`; declare `mcp.actions` in
`integration.yaml`. Surfaces as MCP tool `ebird`, dispatched `{action, params}`.
Base `https://api.ebird.org/v2`, auth header `X-eBirdApiToken: $EBIRD_API_KEY`.

| action | endpoint(s) | key params | returns |
|---|---|---|---|
| `recent` | `/data/obs/{regionCode}/recent` **or** `/data/obs/geo/recent` | `regionCode` *or* `{lat,lng,dist≤50}`; `back≤30` (def 14); `maxResults` | species, **howMany**, obsDt, locName, locId |
| `notable` | `/data/obs/{regionCode}/recent/notable` **or** `/data/obs/geo/recent/notable` | same targeting; `back≤30`; `detail=simple\|full` | notable obs (rarity, not volume) |
| `nearby_hotspots` | `/ref/hotspot/geo?fmt=json` | `{lat,lng,dist≤500}`; `back` (visited-within filter); `enrich`, `enrichTop≤5` | locId, locName, lat/lng, `latestObsDt`, `numSpeciesAllTime` |
| `hotspot_info` | `/ref/hotspot/info/{locId}` + `/product/spplist/{locId}` | `locId` | metadata + all-time species count |

**Honesty constraints (from verifying the API):**
- `nearby_hotspots` returns **all-time** species + **last-observed date** only —
  *not* current abundance. Ranking "how hot right now" requires follow-ups, so
  `enrich` is opt-in: when true, the top `enrichTop` (≤5) hotspots get one bounded
  `recent` call each to attach a recent species/individual count. Off by default.
- `notable` is **rarity**, not volume. "See a lot of birds" must come from
  `recent` counts + `numSpeciesAllTime`, discounting single-individual rows.

**Cross-cutting:**
- In-memory TTL cache (~10 min) keyed by `action`+normalized params. The MCP
  server is a long-lived process, so this kills redundant calls within a session.
- Input validation clamps `dist` (≤50 geo obs, ≤500 hotspot geo) and `back` (≤30).
- Errors return structured `{error}`; missing key → `{error:'EBIRD_API_KEY not set'}`,
  non-200 → `{error:'ebird <status>'}`. The server already wraps thrown action
  errors as `{error}` — no silent failure, no fallback that masks a failure.
- Actions fetch via `ctx.fetch` (the same call path `tick` uses); verify the
  action context exposes it at impl, else fall back to global `fetch`.

## Component B1 — Multi-hotspot sync

- **Hotspot list:** default in code (`[L191106]`), override via new
  `EBIRD_HOTSPOTS` env (comma-separated locIds); legacy single `EBIRD_HOTSPOT`
  still honored. Kevin seeds his anchors via env.
- **Loop** the existing recent-fetch over the list, merging into the one ledger
  (the `location` column already distinguishes hotspots).
- **Per-hotspot cap (~60 rows each), not one global 300** — group by location and
  keep the newest K per hotspot before writing, so a busy hotspot can't evict a
  quiet one (the bug the old global cap would introduce once N>1).
- **Per-hotspot degradation:** each hotspot fetch is independently try/caught; a
  404/429 collects into `TickResult.degraded[]` and the tick still returns `ok`
  if any hotspot succeeded.
- **Notable pull:** one additional `notable` call per tick by **region code**
  (`EBIRD_NOTABLE_REGION`, default `US-NY`), `back=7` → new flatfile
  `content/knowledge/birding/notable-sightings.md` (same ambient, recall-excluded
  location). Region (not geo) because the config holds hotspot locIds, not coords.
  Feeds the brief.
- **Rate-limit posture:** small hotspot count, sequential (or ≤2-wide) fetches,
  well within the 120s tick budget; the cache covers the on-demand side.

## Component B2 — Brief birding line

- **Render site:** `daily-brief/skeleton.ts`, inside the 📷 Photography section,
  mirroring the photowalks block. No new section (respects the "all 13 sections,
  don't change the set" rule from brief-v2).
- **Source:** read `notable-sightings.md` (export a small reader from
  `ebird/index.ts`; same user-data tree, import is clean). Deterministic, no LLM,
  no network at render time.
- **Content:** up to ~3 "🐦 {species} — {locName} ({obsDt})" notable lines plus a
  one-line recent-activity count, **asOf-stamped** from the file's `last_synced`.
- **Empty-state:** "(no notable sightings near your hotspots in the last 7d)" —
  the correct, common output in slow season (e.g. late June). Stale data is
  labeled by its obs window, never implied as live.
- **Freshness:** change the cron to `0 3,15 * * *` so a sync lands ~90 min before
  the 4:30 render; the asOf stamp makes any staleness explicit regardless.

## Data shapes

- `recent-observations.md` — unchanged columns `| obs_date | species | count | location |`,
  now multi-hotspot with a per-hotspot row cap.
- `notable-sightings.md` — new: `| obs_date | species | count | location |`,
  notable-only, `back=7`, capped (~50).
- Action outputs — JSON arrays of the eBird response objects, lightly normalized
  (drop nulls); returned verbatim to the caller for reasoning.

## Error handling / degradation matrix

| Failure | Result |
|---|---|
| `EBIRD_API_KEY` missing | actions + tick return `{error/skipped: 'EBIRD_API_KEY not set'}` |
| One hotspot fetch fails in tick | that hotspot → `degraded[]`; others written; tick `ok` |
| eBird non-200 on an action | `{error:'ebird <status>'}` returned to caller |
| `notable-sightings.md` missing/empty at render | birding line renders the empty-state |
| `enrich` follow-up call fails | hotspot returned without the enriched count (base data intact) |

## Testing (collocated, node:test)

- `ebird/index.test.ts` (extend): per-action URL construction + param clamping;
  response parse; missing-key + non-200 error returns; cache hit suppresses a 2nd
  fetch; `nearby_hotspots` enrich bounded to `enrichTop` and off by default;
  multi-hotspot merge; **per-hotspot cap doesn't evict a quiet hotspot**;
  per-hotspot degradation (one fails, others succeed, `degraded[]` set);
  notable pull writes `notable-sightings.md`. Use `ctx.fetch` stubs / fixtures
  (photowalks' `fixtures/` is the precedent).
- `daily-brief/skeleton.test.ts` (extend): birding line renders from a seeded
  `notable-sightings.md`; empty-state when absent; asOf label present.

## Decisions

- **Ambient, not event store.** Sightings stay flatfile-only, excluded from
  recall — consistent with the existing deliberate choice and the memory-hygiene
  apparatus (domain gating, biographer blocklists). Writing hundreds of sightings
  into recall would fight that system. *(Approved by Kevin 2026-06-23.)*
- **Stays a user-data extension** (no builtin promotion): extension `actions` are
  already MCP-exposed via `registerUserExtensionActions`, and the brief renderer
  is itself under `user-data/`, so nothing requires shipping eBird in the package.
- **`nearby_hotspots`** ranks by all-time richness + recency by default; live
  density is opt-in/bounded (`enrich`). `notable` and `recent` are distinct
  signals (rarity vs volume) and kept separate.

## Out of scope

- Event-store ingestion of sightings; recall/biographer integration.
- Promoting eBird to a shipped builtin integration.
- Feeding the 📷 photography specialist a birding plan-candidate ("rare bird
  Saturday overlaps your outing") — a reasonable future enhancement, not core.
- eBird checklist submission / taxonomy sync / historical backfill.

## Sources

- eBird API 2.0 — https://documenter.getpostman.com/view/664302/S1ENwy59
- rebird hotspot-geo param reference — https://docs.ropensci.org/rebird/reference/ebirdhotspotlist.html
