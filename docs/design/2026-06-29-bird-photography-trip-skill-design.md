# Bird Photography Trip skill — design

**Date:** 2026-06-29
**Status:** Spec — awaiting Kevin's review before build
**Author:** Robin (with Kevin)

## 1. Purpose & the core reframe

A `/bird-trip` skill that produces accurate, data-backed **bird-photography** trip
plans. It is **not** a birding (listing) planner. A birder optimizes species count;
a bird *photographer* optimizes **photographable, photogenic subjects in good light,
against clean backgrounds, with workable access.** Every design choice serves the
photographer, not the lister.

Driven by Kevin's 2026-06-29 genre shift (wildlife → secondary; 2026 vacations are
wildlife/bird trips) and his incoming Z8 + 600mm PF rig.

## 2. Scope & modes (locked with Kevin 2026-06-29)

Two modes, mirroring the lens-analysis "modes" pattern:

- **Scout** — find/rank *where to go*. Two sub-scales, because they need different
  data strategies (review finding #5):
  - **Scout-region (macro)** — pick a destination/region for a vacation
    (Bosque vs Everglades vs Yellowstone). Research-heavy, cross-season; raw eBird
    `recent` counts are **not** comparable across regions/seasons, so this leans on
    seasonal data + the three-axis rubric, not live obs.
  - **Scout-hotspots (micro)** — rank the best hotspots inside a chosen area for a
    given day/window. eBird-heavy (`nearby_hotspots` + `recent`), within one radius.
- **Plan** — deep brief for a chosen location/trip. **Auto-detects single-day vs
  multi-day**, with manual override.

**Single vs multi-day detection rule (review finding #4):** multi-day if the request
spans >1 date, names multiple locations, or says "trip/vacation/itinerary"; else
single-day. User can force either (`/bird-trip plan <loc> --multi` / `--single`).

## 3. File structure (mirror lens-analysis)

- `~/.claude/skills/bird-trip/SKILL.md` — trigger + "read the method file"
- `~/.claude/commands/bird-trip.md` — the `/bird-trip` command (frontmatter:
  `description`, `model: claude-opus-4-8`); resolves mode/target, then defers to the
  method file
- `user-data/content/knowledge/birding/bird-photography-trip-method.md` —
  **canonical method, single source of truth.** Both entrypoints obey it; edit once.
- **Output:** saved to `user-data/content/knowledge/birding/trips/<slug>.md` (locked:
  save by default). A living doc — multi-day trips evolve. Optionally publishable to
  askrobin.io.

**Don't-fork rule (review finding #9):** reconcile with / update existing birding
knowledge (`nyc-birding-spots-near-astoria.md`, `notable-sightings.md`,
`recent-observations.md`, `weekend-trip-options-*.md`) rather than re-deriving. Cite
and extend; don't duplicate.

## 4. Data sources — and their limits (the load-bearing section)

| Source | Powers | Hard limit to encode in the method |
|---|---|---|
| eBird MCP `recent` | Axis-1 density *if trip is imminent* | ≤30 days / ≤50 km. **Answers "what's there NOW, not during a future window"** (finding #1). |
| eBird MCP `notable` | Rarities, recent standouts | Same recency window; rarity ≠ photographability. |
| eBird MCP `nearby_hotspots` (+enrich) | Hotspot discovery, recent species count | ≤500 km; **birder-biased** — top hotspot ≠ best photo spot (finding #3). |
| eBird MCP `hotspot_info` | Hotspot metadata | Location/coords; no photo info. |
| eBird **bar charts (via web)** | **Trip-window seasonality** (abundance by week) | Not an MCP endpoint — fetch via web; the correct source for future-dated trips (finding #1). |
| Web research | **Axes 2 & 3** (photographability, photogenic-ness): photo trip reports, refuge maps, blind/boardwalk/auto-loop info, Street View/satellite for backdrops, access/permits/closures | Qualitative; **cite sources, tag confidence, flag unvalidated** (finding #2). |
| Robin weather | Sunrise/sunset, golden-hour windows, cloud, wind | Provides *times*, not solar **azimuth** — compute sun position separately; don't overpromise (finding #7). |
| NOAA tide (Robin) | Shorebird/wader tide windows | **US-coastal only; conditional** — irrelevant inland (Bosque, Yellowstone); international needs other sources (finding #7). |
| `kevin-as-photographer.md`, `photo-gear-inventory.md` | His criteria, style, gear/reach math | — |

**Rule:** axis 1 is quantitative (eBird); **axes 2–3 are research + judgment** and
are the *least* data-backed — so they carry explicit confidence and the validation
tag. Never let eBird density silently override an unphotographable or ugly-backdrop
location.

## 5. The scoring model (Kevin's three asks, made concrete)

Each location scored **Low / Med / High** with a one-line justification, plus a
composite and a **validation tag**:

1. **Variety & density** — photo-worthy species count *and* abundance, weighted to
   large/approachable subjects; **discount single-individual rows and skulking/canopy
   species that don't photograph** (the Randall's lesson — density, not presence).
   Source: eBird (seasonal bar charts for future trips; `recent` if imminent).
2. **Photographability** — can you actually get the shot? **Quantitative reach match
   (finding #8):** Kevin's reach = 600 mm native / 840 mm w/ TC-1.4× / ~900 mm-eq
   DX-crop on the Z8 (45.7 MP) / 1260 mm-eq DX-crop + TC — mapped to target-species
   size at its typical working distance ("wading bird at 15 m fills the frame at 600;
   canopy warbler is out of reach"). Plus: species approachability, **light quality and
   angle** at the *accessible* vantage (soft golden-hour light flatters plumage; harsh
   midday is unflattering — favor spots/times where good light lines up with the
   subject), blinds/boardwalks/**auto-loops** (drive-up = high keeper rate), eye-level
   vs down-angle, water for reflections. Source: research + judgment.
3. **Photogenic-ness** — backdrop quality (clean water/sky/foliage vs clutter/
   man-made), foreground, reflections, overall scenic beauty. A common bird in a
   gorgeous setting beats a rarity against a parking lot. Source: research + judgment.

**Validation tag (finding #6, concrete bar):**
- **Validated** = multiple recent/seasonal checklists confirm density at a
  photographable range **AND** a cited photo report / known blind / Street-View read
  confirms axes 2–3.
- **Scouted-but-unvalidated** = inferred from habitat type, presence-only, or a single
  source. Recommend with this caveat stated, never confidently (Randall's lesson).

## 6. Standard pre-trip checklist (the "standard things" + additions)

Additions beyond Kevin's stated asks marked ➕:

- **Target-species shortlist** — size → reach needed, behavior, best approach,
  plumage/season window
- **Best dates + what's present then** — migration / breeding / wintering, from
  seasonal bar charts (not live obs)
- ➕ **Activity × light plan (finding #4, refined per Kevin 2026-06-29)** — two
  first-class, sometimes-competing constraints: **(a) the subject's active window**
  (kettles midday, leks/rookeries dawn, tide-driven shorebirds) and **(b) light
  quality** — golden hour's soft warm light makes birds look great; harsh midday is
  unflattering. Plan for **both**; where peak activity and best light conflict (e.g.
  midday raptor kettles), name the tradeoff and pick deliberately rather than
  defaulting to either one.
- ➕ **Light plan** — sunrise/sunset, golden-hour windows, **sun azimuth vs the prime
  vantage** (front-lit vs back-lit subjects), best-AM-vs-PM call
- ➕ **Tide plan** *(coastal/estuarine only)* — high/low timing that concentrates
  birds (NOAA; skip inland)
- ➕ **Wind** — direction → where to stand for head-on flight (birds take off/land
  into wind)
- **Vantages/blinds/boardwalks/auto-loops** — drive-up vs hike; accessibility
- ➕ **Access & conditions gotchas** — **gate-opens-at-sunrise-so-you-miss-the-light
  trap**, permits/quotas that sell out, seasonal road/closures, heat/bug/mud hazards
  (Everglades), cell coverage, parking
- ➕ **Gear plan for this trip** — body/lens/TC pick + the reach math from axis 2;
  gimbal vs handheld; starting settings (SS floor for BIF, AF mode, drive); street
  setup still rides along, reach rig leads
- ➕ **Ethics** — distance, no baiting/flushing, nesting-season sensitivity
- ➕ **Realistic expectations & backup** — likely keepers vs hope; rain/no-show plan

## 7. Multi-day template (Everglades-class)

Single-day output is a concise one-location brief. Multi-day adds:

- **Day-by-day itinerary** sequenced by **subject activity + light + tide**
- **Drive times** between hotspots; **basecamp/lodging positioning** to kill pre-dawn
  drives
- **Fees/passes** (park entrance, photo blinds), reservations
- **Rain-day alternates** + an **"if you only get one good morning" priority ranking**
- **Per-location mini-briefs** + an overview sequence

## 8. Anti-patterns baked in (from Kevin's logged lessons)

- Density not presence; discount single-individual rows
- Don't recommend from habitat type alone; flag scouted-but-unvalidated
- **Photogenic backdrop is required** — reject open-field/scrub-only spots for
  *photography* even if species-rich
- Don't guess his longest lens — use the actual reach math
- Recent-obs ≠ future-window; use seasonal data for trips months out

## 9. Effort right-sizing (finding #10)

- **Single-day local** (NYC area) — light: eBird `recent`/`nearby_hotspots` + existing
  `birding/` knowledge + a couple of access checks.
- **Multi-day destination / macro scout** — heavier: parallel research (one agent per
  candidate region or per hotspot, à la the lens-analysis multi-lens sweep), but
  bounded. State what was and wasn't validated; never silently truncate coverage.

## 10. Open questions (resolve during build)

- Solar-azimuth source: small inline computation vs a web lookup per
  location/date/time — pick the lighter reliable path.
- Whether scout-region should default to publishing the shortlist to askrobin.io or
  keep it local until Kevin picks.
- Slug convention for `trips/` (e.g. `everglades-2026-12` vs date-prefixed).

## 11. Build plan (after Kevin approves this spec)

1. Write the canonical method file (`bird-photography-trip-method.md`) — the bulk.
2. Write `SKILL.md` (trigger) + `/bird-trip` command (orchestration) — thin wrappers
   pointing at the method, mirroring lens-analysis.
3. Smoke-test on a real case: single-day local (e.g. Jamaica Bay) and the multi-day
   Everglades trip.
