# Nikon Body Operational Reference — Design

- **Date:** 2026-07-03
- **Status:** Design — awaiting review
- **Author:** Robin (brainstormed with Kevin)

## Problem

When Kevin asks an operational question about one of his Nikon bodies (Z8, Zf,
Zfc, Z50II) — e.g. "how do I see the per-channel histogram on the Z8" — Robin
has no local answer and web-searches every time. Two root gaps:

1. **Content gap.** Existing camera files are technique/genre-oriented (birding
   AF, low-light, video setup, user-modes). None is an *operational reference* —
   "where is X / how do I do X on this body."
2. **Retrieval gap.** Auto-recall Layer 1 (`config/recall-topics.yaml`) matches
   whole-word, but the body terms are imprecise: `z8`/`zfc`/`z50ii` aren't match
   terms, and `zf`/`z50` don't match "zfc"/"z50ii" (the trailing letters kill the
   `\b` boundary). So a body question surfaces the gear list, not operational
   content.

## Goals

- Body operational questions answer from **local** content — no web search for
  the common case.
- The right content **surfaces automatically** on a body-named prompt, sliced to
  the relevant operation.
- Uncovered/rare questions degrade to **one targeted manual fetch**, not a blind
  search.
- Bounded token cost; no new infrastructure beyond content + config + a small
  invariant fix.

## Non-goals

- Not a full mirror of Nikon's manuals.
- Not a scheduled crawl/refresh job.
- Not a rewrite of the existing technique guides (cross-link, don't duplicate).

## Architecture

Per body (×4), two files in `user-data/content/knowledge/`:

1. **`nikon-<body>-reference.md`** — curated operational reference. Value =
   distillation + gotchas + Kevin's defaults; built from Nikon's manual + the
   existing technique files, not manual prose. **Self-contained per body**
   (deliberate cross-body duplication — Z8/Zf and Z50II/Zfc share menus — because
   a reference must answer in a single slice; shared-common+deltas would force
   multi-doc reads and defeat the slicer). Force-injected via recall-topics
   Layer 1, sliced to the relevant section.
2. **`nikon-<body>-manual-map.md`** — the manual's base/TOC URL + URLs for the
   high-value sections only (Nikon's numbered per-section slugs rot across manual
   revisions, so no exhaustive map). Robin's targeted-fetch lookup. **Not**
   force-injected (a URL table is useless as injected context).

Retrieval reuses the existing auto-recall Layer-1 keyword→doc mechanism. No new
infrastructure.

## Doc structure (slicer-driven)

The slicer (`system/brain/memory/section-slice.ts`) is **lexical, not semantic**:
splits on `##`, scores each section by query-word overlap with **headings weighted
2×**, substring match, 3-char token floor; if no word overlaps anywhere it falls
back to whole-doc top-truncation. Auto-recall hard-caps injection at ~4000 chars,
up to 2 sections. Authoring rules follow directly:

- **Keyword-rich H2 headings** (the load-bearing rule): a heading must contain the
  words Kevin actually types. Not `## Histograms` but
  `## Histograms — luminance, RGB / per-channel, highlights & blinkies`.
- **One operation per section, ~1.5–2.5k chars** so two can co-inject within the
  4000 budget.
- **Comprehensive body vocabulary** (synonyms: "blinkies"/"highlight display",
  "AF-ON"/"back-button focus") — a total keyword miss dumps the useless top of the
  doc.
- **Sections ordered by ask-frequency** (histogram/AF/exposure first) so a bare
  body-name prompt (`z8` is below the 3-char slice-token floor → top-truncation
  fallback) still surfaces useful content.
- **Minimal preamble**: one-line purpose + freshness stamp.
- **Fixed section skeleton** across all four bodies, cross-linking to the deeper
  technique files where one exists (e.g. Video → `video-<body>-setup.md`).

Skeleton (H2s): Displays & histograms · Autofocus · Metering & exposure · Custom
buttons & i-menu · Drive/shutter/silent · Video · Connectivity/transfer · Key
custom-setting locations · Capability facts/specs · Firmware-added features ·
Gotchas.

## Retrieval wiring

Four rules appended to `user-data/config/recall-topics.yaml`:

```yaml
  - id: nikon-z8
    match: [z8, "z 8"]
    docs: [content/knowledge/nikon-z8-reference.md]
  - id: nikon-zf
    match: [zf, "z f"]
    docs: [content/knowledge/nikon-zf-reference.md]
  - id: nikon-zfc
    match: [zfc, "z fc"]
    docs: [content/knowledge/nikon-zfc-reference.md]
  - id: nikon-z50ii
    match: [z50ii, "z50 ii", "z 50 ii", z50, "z 50"]
    docs: [content/knowledge/nikon-z50ii-reference.md]
```

- **Word-boundary reasoning:** `\bzf\b` ∌ "zfc" and `\bz50\b` ∌ "z50ii", so each
  spelling needs its own term. `z50`/`z 50` are safe on the Z50II rule since Kevin
  doesn't own the original Z50. Nikon's spaced official forms ("z 8", "z f",
  "z fc") are included. Collision-checked: no body's terms fire another's rule.
- **Intended overlap** with the broad `photography` topic (which has `zf`, `z50`):
  both fire, so a body question surfaces gear context *and* the ops reference —
  same layering as the existing `zone-focusing` overlap.
- **Size handling.** Layer-1 injection is capped at ~4000 chars regardless of file
  size, so a reference costs the same per turn at 10k or 25k. The
  `recall.topics_resolvable` 16k warn is **stale** — its "injected whole, never
  truncated" premise predates the slicer. **Fix:** make `validateRecallTopics`
  flag an oversized *mapped* doc only when it **lacks `##` sectioning** (genuinely
  un-sliceable). Keep references lean for grep/index cost, not per-turn tokens.

## Freshness / firmware

- Header stamp `Last verified: YYYY-MM-DD · FW <version>`; inline `(FW x.y+)` tag on
  any firmware-gated fact (e.g. the g18 video-histogram options added in FW 2.10).
- **Bounded verify (not a crawl):** stable operations answer straight from local;
  Robin does **one** targeted manual-map fetch only when a fact is FW-tagged **and**
  its stamp is old (or Kevin mentions updating firmware). No scheduled job, no
  per-question web hit.
- **Stamp-advance loop:** a verify-fetch that confirms/corrects a fact updates that
  doc's stamp + fact, so freshness moves forward and verification stays rare rather
  than creeping toward always-fetch.
- **Honest limit:** the verify rule only catches facts the build tagged
  FW-sensitive — so build agents tag anything menu/feature-related that's plausibly
  FW-dependent, and the doc-level stamp is the coarse fallback (doc older than
  ~6 months → treat menu specifics as lower-confidence). Record Kevin's installed FW
  per body in the header when known, so "requires FW X+" caveats match his actual
  body.

## Build (fan-out, one agent per body)

1. Work from the manual's TOC; fetch only the ~15–25 pages matching the skeleton
   sections (not the whole manual). The fetched URLs *become* the manual-map.
2. Fold in the matching existing technique files + known gotchas.
3. Emit the reference by filling an **identical literal template** (exact H2
   headings, stamp format, ask-frequency ordering) — agents fill a template, they
   do not invent structure.
4. Emit the manual-map.

A final **normalization pass** reconciles phrasing/depth so the slicer behaves
uniformly across bodies. Robin reviews each before it lands. New docs are picked up
by normal knowledge ingestion so Layer-2 vector recall backstops Layer-1.

## Testing

- **Unit** (extend `system/lib/recall-topics.test.ts`): each body term matches its
  own doc; no cross-fire (`zf`∌"zfc", `z50`∌"z50ii") — locks in the word-boundary
  fix against regression.
- **Slice-assertion** (deterministic): for ~4 representative questions per body,
  `sliceToRelevantSection(doc, q)` returns the intended section — validates the
  keyword-rich-heading discipline per body.
- **`robin doctor recall.topics_resolvable`** stays green (all four docs resolve;
  invariant fix → no false size-warn).
- **Live end-to-end:** the per-channel-histogram question injects the Z8 Histograms
  section.

## Risks / tradeoffs

- **Local staleness** (the core tradeoff): trades web-freshness for local-staleness.
  Contained by stamps + bounded verify + stamp-advance loop. Residual risk if
  build-time FW tagging misses a fact.
- **Cross-body duplication / drift:** four self-contained docs share menu content.
  Contained by the shared template + normalization pass + each doc being
  independently verifiable. Chosen over shared-common+deltas because the slicer
  needs single-doc answers.
- **Invariant change:** tiny, but touches shared doctor code — unit-tested.

## Files

- **Create (personal, gitignored):** 8 files in `user-data/content/knowledge/` —
  `nikon-{z8,zf,zfc,z50ii}-reference.md` + `nikon-{z8,zf,zfc,z50ii}-manual-map.md`.
- **Edit (personal, gitignored):** `user-data/config/recall-topics.yaml` (+4 rules).
- **Edit (repo):** `system/lib/recall-topics.ts` (`validateRecallTopics`
  slicer-aware); `system/lib/recall-topics.test.ts` (+ cross-fire tests) and a
  slice-assertion test.
