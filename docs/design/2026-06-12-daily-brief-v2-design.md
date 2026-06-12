# Daily Brief v2 — Trend Engine + Specialist Synthesis

**Date:** 2026-06-12
**Status:** Approved design, pending implementation plan
**Owner files:** `user-data/extensions/jobs/daily-brief/`, `user-data/extensions/jobs/dream-synthesis/`

## Motivation

Kevin's verdict on the current brief: it reports instead of advising (🎯 lines like
"green for training"), repeats itself day to day (the same whoop-rebound story four
mornings running), misses multi-week arcs, and leads with the wrong content mix.
Ranked priorities for what should lead the brief:

1. Health trajectory (multi-week trends, not last night's number)
2. Money picture (spend pace / estate-batch arc, not daily balances)
3. One genuinely surprising cross-stream insight per night
4. Today's plan (prioritized, prescriptive)
5. Project pulse
6. People & dates

Explicitly deprioritized: Robin's self-scorecard and world-context (NHL/markets/
weather) — they stay as sections but never lead.

Style mandate: adviser + chief-of-staff (concrete suggestions with reasoning AND a
prioritized daily agenda). Personal domains (rest days, photo outings, finance
nudges) are fully in scope. **All 13 sections always render** (cardinal rule kept);
repetition is fixed through content, not section removal.

Budget: ~$1–2/night for the overnight agentic pass (up from ~$0.20–0.50).

## Architecture

```
4:00am  Dream-synthesis v2 (single job, agents via runAgent)
  STEP 0  computeTrends(db, now)          deterministic, pure, no LLM
  STEP 1  4 specialists, SEQUENTIAL       bounded runAgent each (~$0.30, ~6 turns)
  STEP 2  day planner                     bounded runAgent (~$0.40)
  WRAPPER validation/dedup/tiering        deterministic, writes artifact v2
4:30am  daily-brief                       pure renderer (unchanged role)
```

No new scheduled job. Latency is irrelevant overnight; sequential execution keeps
ledger accounting simple and lets the pipeline stop early near the cost ceiling.

## Component 1 — Trend engine (`user-data/extensions/jobs/_shared/trends.ts`)

Pure function `computeTrends(db, now)` → 7/30/90-day aggregates per stream:

- **whoop**: recovery/sleep-efficiency/HRV means + slopes vs baseline, computed
  from **finalized cycles only** — the in-flight provisional cycle is excluded
  (4am scores rescore upward after wake; the 2026-06-12 80%→65% incident).
- **finance**: daily spend pace vs trailing-90 monthly norm; estate-batch progress
  (open vs closed issues in the Linear finance/estate cluster).
- **photography**: days since last ingested frame, frames/week trend. Stamped with
  the LRC sync date — "no frames since the 6/9 sync", never "11 days without
  shooting" when the data can't support it.
- **projects**: event velocity per active project entity (week over week).
- **dates**: upcoming-dates scan from calendar events (by event start day, using
  the fixed `eventDay` logic).

Every datum carries an `asOf` freshness stamp. Output is embedded in the synthesis
artifact (extends the existing `datapointsUsed` pinning pattern) so the 4:30 render
shows the same numbers the 4:00 reasoning cited. The skeleton imports the same
module to compute live when the artifact is missing.

## Component 2 — Specialists (STEP 1, sequential)

**Common contract.** Each agent receives: the trend JSON, its stream's last-14-day
events, the last 3 briefs' front-matter, and a shared style covenant (calibrated,
no cheerleading, "new or nothing"). Each returns structured output:

```
{ trajectoryLine, planCandidates[], sectionSplices{}, proposedBeliefs[],
  proposedPredictions[], citedEventIds[] }
```

Empty results are honest and expected. Each specialist owns a **belief-topic
namespace** and must run the diff-against-head discipline (recall_belief) within
it; the wrapper rejects out-of-namespace proposals.

| Agent | Namespace | Specifics |
|---|---|---|
| 🩺 health | `whoop.*`, `kevin.health.*` | Finalized cycles only. Medication context from `medical/medications.md` (canonical file, never belief snippets). |
| 💰 money | `finance.*` | Transaction ledger is truth; balances are Plaid-lagged (current DATA-TRUST rules carry over verbatim). Tracks estate batch against the Linear cluster. |
| 📷 photography | `kevin.photography.*`, `project.*` (photo) | Primed with `photo-baseline-already-doing.md`. Mechanism-level or silent — anything that would appear in a beginners' article returns nothing. Never pushes publishing. Pairs cadence with forecast light windows. |
| 🌶️ surprise hunter | any | Free `recall` access + the full surprise ledger. No obligation to produce — prompt rewards empty over weak. Also owns **reflection** and the **contradiction sweep** (artifact-only outputs, as today). |

**Quality bar for 🌶️:** connects ≥2 streams; cites event ids the wrapper verifies
exist; absent from the surprise ledger; passes "could Kevin have seen this in any
single section?" = no.

**Budget guard:** ledger checked between agents; when remaining budget < the next
agent's cap, remaining specialists are skipped in reverse priority (surprise hunter first; day planner
protected — it can run on trend data alone). A skipped specialist's section
renders its deterministic trend line only. Caps (~$0.30 / ~6 turns per specialist,
~$0.40 planner) are initial values; the artifact records per-agent spend/turns for
a one-week shakedown calibration.

## Component 3 — Day planner (STEP 2)

Runs last. Consumes the specialists' `planCandidates` + calendar/inbox/linear/
horizon/weather. Picks ≤3 items, ordered by consequence × time-sensitivity; may override
specialists (a deadline beats a photo outing). Health-related plan items anchor to
finalized cycles/trend, never the provisional morning score. Also owns splices for
the operational sections it reads (calendar/inbox/linear/horizon/weather).

## Component 4 — Wrapper (deterministic, extends current dream-synthesis wrapper)

- Validates all structured outputs; verifies `citedEventIds` exist.
- **Dedup:** each 📈/🌶️/splice line is compared against yesterday's front-matter
  and the sections' own trend lines (normalized-token overlap ≥0.6 → dropped).
  **Exemption:** ☀️ items driven by open deadlines repeat daily until resolved,
  re-ranking upward as the deadline nears.
- Appends surfaced surprises to `state/runtime/surprise-ledger.json` (capped at
  the last 90 entries).
- Belief tiering, prediction auto-commit, journal: unchanged. Same-topic duplicate
  proposals collapse to the highest-confidence one.
- Writes artifact with `version: 2` + per-agent status/spend. The renderer handles
  v1 and v2 shapes during transition; a stale or v1 artifact never breaks a brief.

## Component 5 — Renderer changes (`daily-brief/` skeleton + compose)

Front-matter becomes (hard budget ≤12 lines total):

- **☀️ Today's plan** — ≤3 ordered items, each citing its analyst + a section
  anchor (replaces 🎯).
- **📈 Trajectories** — exactly one line per specialist that produced one:
  interpretation and direction, never a restatement of section numbers
  (with 🌶️, replaces 🔗).
- **🌶️ One thing I found** — ≤1, or the honest "(nothing cleared the bar tonight)".

🔮 predictions / 🧠 belief updates move to a compact two-line footer above the
closing bar (full fidelity still flows to the learning loop via the artifact).
People & dates surface in ☀️ when actionable today and in Horizon when upcoming.
Whoop/Financials/Photography sections gain deterministic trend lines with `asOf`
stamps. All 13 sections render, as today.

## Component 6 — Photowalk discovery (new integration)

A new integration (`user-data/extensions/integrations/photowalks/`) that finds
NYC photowalks for the **next 4 weeks** and surfaces them in the brief.

- **Sources:** Meetup search (photography events, NYC area —
  meetup.com/find/?keywords=photography), plus other recurring NYC sources
  worth a parser (B&H Event Space, Eventbrite search, NYC street-photography
  collectives). Meetup's public API is gone, so the tick fetches the search/
  group pages and parses embedded JSON (`__NEXT_DATA__`/JSON-LD); per-source
  parsers are isolated so one breaking doesn't kill the tick. Exact source
  list finalized at implementation after testing which parse reliably.
- **Tick:** daily; ingests `photowalk.event` events with
  `{title, date, time, location, group, url, source}`, deduped by source id.
- **Rendering:** the 📸 Photography section gains an "Upcoming photowalks"
  list (next 4 weeks, by event date — using the event-start windowing
  pattern, not capture ts). Renders deterministically from captured events;
  quiet line when none found.
- **Analyst integration:** the 📷 photography analyst receives upcoming
  photowalks alongside light windows and may promote one to a `planCandidate`
  ("Saturday's walk overlaps your golden-hour window"). Solo-practice note:
  Kevin's core practice is solitary photowalks by design — group walks are an
  *option* to surface, never framed as something he should be doing.

## Error handling / degradation matrix

| Failure | Result |
|---|---|
| One specialist errors or is budget-skipped | Its section renders trend line only; its 📈 line absent |
| Day planner fails | ☀️ falls back to deadline-driven items derived from trends/linear (deterministic) or renders honestly empty |
| Entire synthesis fails | Skeleton + trend lines (already better than today's skeleton-only fallback) |
| Artifact missing/stale/v1 at 4:30 | Renderer computes trends live via the same module; renders accordingly |

## Testing

- `computeTrends`: unit tests per stream — provisional-cycle exclusion, `asOf`
  staleness, empty-stream behavior.
- Wrapper: dedup threshold + deadline exemption, citation verification,
  surprise-ledger append/cap, namespace rejection, duplicate-topic collapse.
- Agent contracts: schema-validation tests with canned outputs.
- Integration: full pipeline with stubbed agents against a seeded DB.
- Existing cardinal-rule skeleton test extends to trend lines.

## Out of scope

- Web publishing (removed 2026-05-30, stays removed).
- Changing section set or render-everything rule.
- Multi-model routing experiments (agentic stays on the current provider policy).
- Morning-of re-synthesis (the `/brief` reader's whoop refresh already covers it).
