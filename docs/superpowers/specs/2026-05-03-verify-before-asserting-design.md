---
title: Verify-before-asserting systematization
date: 2026-05-03
status: design
scope: robin-assistant CLI (recall extension + freshness helpers + capture rule update)
---

# Verify-before-asserting systematization

## Problem

`corrections.md` over the last week shows a recurring pattern: model makes confident assertions without first checking authoritative sources. Four representative cases (all 2026-05-02 / 2026-05-03):

1. **Gardening recommendations.** Model gave generic fertilizer advice ignoring the existing `knowledge/home/outdoor-space.md` rooftop garden file. Auto-recall didn't fire because the entity was aliased only on spatial terms ("rooftop patio"), not activity terms ("garden").
2. **Stale synced data.** Model quoted "today's Whoop recovery" from yesterday's sync row without checking `last_synced`. The actual current row was a different value.
3. **Inherited assertions.** `financial-snapshot.md` claimed "Backdoor Roth pro-rata clean" — inherited from older snapshot, never re-verified after a Rollover IRA surfaced.
4. **Identity inference from indirect signals.** From sync-chrome + sync-youtube data, model asserted "active PSN gamer" and "cooking content viewer" — both wrong. Subscription ≠ watching; forum visits ≠ being a member.

Common failure: model didn't read the relevant authoritative file before stating something. The existing auto-recall hook catches NAMED entities (people, places, projects) but misses:
- Domain-level relevance (gardening → garden file)
- Freshness verification (today's data → check timestamp)
- Source-trust gradients (browsing data → can't infer identity)

## Goals

- Extend auto-recall to fire on domain keywords, not just entities.
- Make synced-data freshness verification mechanical: every synced file declares `last_synced`; CLAUDE.md rule + helper enforces.
- Update capture rules so identity-inferring captures from derived/low-trust sources MUST tag as `[?]`, not `[fact]`.
- Add lint check for `[fact|origin=derived]` violations.
- Document the failure mode prominently so future corrections can cite the rule.

## Non-goals

- Pre-assertion-write hook (model writes to memory file → check source freshness). Too aggressive; too many false positives. Defer.
- LLM-based "is this assertion grounded?" check at write time. Too expensive for marginal value.
- Generalized "what should I have read?" suggestion engine. Domain triggers + entity recall + freshness watermarks cover the documented failure modes.
- Restructuring memory file schemas to embed source provenance per assertion (each line cites which source). Too intrusive; defer until repeat misses justify.
- Auto-redaction of quoted untrusted content (covered by existing UNTRUSTED-START boundaries).

## Architecture

Three independent components, each addressing one class of failure.

### Component 1 — Domain-trigger recall

The existing `onUserPromptSubmit` hook (`system/scripts/hooks/claude-code.js`) calls `scanEntityAliases` and `recall` to inject `<!-- relevant memory -->` blocks for entity matches. Extend with a parallel **domain-trigger pass**:

1. Load domain map from `user-data/runtime/config/recall-domains.md` (new file; ships with sensible defaults in scaffold).
2. Map shape: `{ keyword | regex } → [memory_file_path]`.
3. Match user prompt + previous assistant message against domain keywords (case-insensitive, word-boundary).
4. For each match, add the mapped file paths to the recall injection.
5. Dedupe against entity-recall results so the same file isn't injected twice.

Default `recall-domains.md` (shipped via scaffold):

```markdown
---
description: Domain-trigger recall map. Matches user message against keywords; injects mapped memory files at session prompt time. User-editable.
type: reference
---

# Recall domains

Format: each section is a domain. Keywords are matched case-insensitive with word boundaries. Files are injected as <!-- relevant memory --> blocks.

## gardening
keywords: garden, gardening, plant, plants, fertilizer, soil, mulch
files:
  - user-data/memory/knowledge/home/outdoor-space.md

## finance
keywords: investment, IRA, 401k, Roth, brokerage, retirement, taxes
files:
  - user-data/memory/knowledge/finance/financial-snapshot.md

## health
keywords: whoop, recovery, HRV, sleep score, strain
files:
  - user-data/memory/knowledge/health/whoop.md

## briefing freshness
keywords: today's, this morning, latest
files:
  - user-data/runtime/jobs/daily-briefing.md
```

Users edit this file to map their own domains.

### Component 2 — Freshness contract for synced data

Every file written by a sync job (`sync-whoop`, `sync-nhl`, `sync-gmail`, `sync-calendar`, etc.) must include `last_synced: <ISO 8601>` in its frontmatter. Implementation:

- New helper `system/scripts/lib/freshness.js` exports:
  - `stampLastSynced(filePath)` — used by sync writers to update frontmatter atomically.
  - `isFresh(filePath, maxAgeHours = 24)` → boolean.
  - `getLastSynced(filePath)` → ISO string or null.
- All existing sync writers in `user-data/runtime/scripts/sync-*.js` updated to call `stampLastSynced` after each successful write.
- New CLAUDE.md operational rule: "When quoting any field from a synced file (those with `last_synced:` in frontmatter), check `isFresh` before stating as 'today's' or 'current'. If stale: kickstart the sync, or label the quote as `data from <date>`."
- New diagnostic `npm run check-sync-freshness` — scans all `*.md` files under `user-data/memory/sync/` and `user-data/runtime/state/sync/`; reports any missing `last_synced` or older than `maxAgeHours`. Wired into Dream's existing `## Notable` section if any are stale.

### Component 3 — Derived-source identity dampening

`system/rules/capture.md` `## Tags` section gains an explicit list of **derived sources** (low trust for identity claims):

```markdown
### Derived sources (low trust for identity claims)

The following data sources contain CORRELATIONAL signals only — they cannot
be promoted to identity, taste, or behavior assertions without explicit user
confirmation:

- Browsing history (chrome history, search history, URL visits)
- Subscription / follow lists (YouTube subs, Spotify follows, Twitter follows)
- App installs / device inventory
- Forum/site visit counts
- Email subject/sender frequency (without read state)

Captures from these sources MUST use `[?|origin=derived]` (uncertain),
not `[fact|origin=derived]` (asserted). Counts and clusters can be reported
literally ("Y visits to X.com in 30d"), but behavioral labels ("active gamer",
"cook", "frequent orderer") require explicit confirmation.

Sync writers for derived sources stamp captures with the appropriate tag
automatically; the model should respect the inherited tag.
```

`system/scripts/diagnostics/check-derived-tagging.js` — new lint that scans `inbox.md` and recent direct-writes (last 30 days) for `[fact|origin=<derived-source>]` violations. Exit 1 if any found, with the offending lines printed. Wired into CI via `npm run check-derived-tagging`.

## Components (new)

- **`system/scripts/lib/freshness.js`** — atomic frontmatter helpers. Exports `stampLastSynced`, `isFresh`, `getLastSynced`.
- **`system/scripts/diagnostics/check-sync-freshness.js`** — scans synced files for missing or stale `last_synced`; reports counts, max age. Wired into Dream notable section.
- **`system/scripts/diagnostics/check-derived-tagging.js`** — lint for `[fact|origin=<derived-source>]` violations. CI gate.
- **`system/scripts/hooks/lib/domain-recall.js`** — load `recall-domains.md`, build keyword → files map, match prompt, return injection list. Used by `claude-code.js` `onUserPromptSubmit`.
- **`system/scaffold/runtime/config/recall-domains.md`** — default domain map (shipped at install).
- **`system/migrations/0028-add-recall-domains.js`** — copies scaffold to `user-data/runtime/config/recall-domains.md` if missing on user's instance. Idempotent.

## Components (modified)

- **`system/scripts/hooks/claude-code.js`** — `onUserPromptSubmit` calls `domain-recall.js` after entity scan; merges/dedups results into the same `<!-- relevant memory -->` block. Existing telemetry (`recall.log`) gains a `domain` source field.
- **`system/rules/capture.md`** — add the "Derived sources (low trust for identity claims)" subsection per Component 3.
- **`CLAUDE.md`**:
  - Operational rules — add: "When quoting a field from a synced file (those with `last_synced:` in frontmatter), check `isFresh` before stating as 'today's' or 'current'. If stale: kickstart the sync inline, or label the quote as `data from <date>`."
  - Operational rules — add: "Identity from indirect signals: see `system/rules/capture.md` `### Derived sources`. Browsing data, sub lists, app installs etc. cannot be promoted to identity claims (`[fact|origin=derived]`); use `[?|origin=derived]` and ask for confirmation."
- **`user-data/runtime/scripts/sync-*.js`** (Kevin's instance — referenced by spec as the change target; package ships only the helper) — call `stampLastSynced` after each successful write.
- **`system/jobs/dream.md`** — Phase 11.5 (Recall telemetry review) gains: count domain-trigger recalls vs entity recalls; flag any domain in `recall-domains.md` that fires zero times in 60 days (dead-keyword cleanup signal). Phase 12.5 already writes to `needs-your-input.md` (per thread #3); add a section there for stale sync files.
- **`package.json`** — add `check-sync-freshness` and `check-derived-tagging` scripts.
- **`.github/workflows/tests.yml`** — add `npm run check-derived-tagging` to the `unit` job (CI gate).
- **`CHANGELOG.md`**.

## Data flow examples

### Domain-trigger recall (gardening case)

```
1. User: "what fertilizer should I use this spring?"
2. onUserPromptSubmit:
   - scanEntityAliases → no match (no entity alias for "fertilizer")
   - domain-recall.js → matches "fertilizer" keyword in [gardening] section
   - Domain map yields: user-data/memory/knowledge/home/outdoor-space.md
   - Injects:
     <!-- relevant memory: gardening (domain match) -->
     [contents of outdoor-space.md]
3. Model now has the rooftop-garden context and can recommend
   container-suitable fertilizer for sunflowers + wildflowers.
```

### Freshness check (Whoop case)

```
1. User: "what's my recovery today?"
2. Model attempts to quote whoop file
3. Per CLAUDE.md operational rule, check isFresh:
   - getLastSynced('user-data/.../whoop.md') = "2026-05-03T11:00:00Z"
   - now = "2026-05-04T05:55:00Z"
   - age = 18.9h, maxAge = 24h → fresh
4. Quote as "today's recovery is X"

Alternative (stale):
2'. getLastSynced returns "2026-05-02T11:00:00Z"; age = 42.9h → STALE
3'. Model kicks off sync inline:
    Bash: launchctl kickstart -k "gui/$(id -u)/com.robin.sync-whoop"
    sleep 8
    re-read file
    OR fall back to: "Whoop data from 5/2 (sync stale): X"
```

### Derived-source dampening (PSN case)

```
1. sync-chrome writes to inbox.md:
   [?|origin=sync:chrome|domain=browsing] psnprofiles.com: 113 visits / 30d
   (Note: tagged [?], not [fact])
2. Dream Phase 7 (population for learning queue) sees the [?] item:
   - Adds learning-queue entry: "What's the relationship to psnprofiles.com?
     113 visits over 30d, but visits ≠ membership."
3. Model in next session reads the entry, may ask the user.
4. If model attempts to write [fact|origin=sync:chrome] anywhere:
   check-derived-tagging lint catches it; CI fails.
```

## Error handling

- **`recall-domains.md` missing** (e.g., new install before migration ran) — `domain-recall.js` no-ops gracefully; only entity recall fires. Migration 0028 creates on next install.
- **`recall-domains.md` malformed** — parser logs warning to recall.log, returns empty map; entity recall still fires.
- **Synced file missing `last_synced`** — `isFresh` returns `null`; CLAUDE.md rule treats as "unknown freshness", model labels quote with "data freshness unknown."
- **Sync writer crashes mid-write** — atomic write semantics in `stampLastSynced`; partial writes don't corrupt frontmatter.
- **Domain keyword false positive** ("the new garden in the front of city hall is a metaphor for tax policy") — minor cost: extra file injection. Acceptable.
- **Domain map and entity index conflict** (same file matched both ways) — domain-recall dedups against entity-recall results; only injected once.
- **Derived-tagging lint flags a legitimate `[fact|origin=derived]`** (rare; e.g., user explicitly confirmed) — author manually adds an `# allow-derived-fact: <reason>` comment on the line; lint respects.

## Edge cases

- **Empty `recall-domains.md`** — domain-recall returns empty list; only entity recall fires.
- **Multiple domains match same prompt** — all matched files injected (deduped).
- **`last_synced` is in the future** (clock skew) — `isFresh` returns `true` (positive age check); benign.
- **`last_synced` parses as invalid date** — treat as null; "freshness unknown."
- **Sync file rotates content but doesn't update `last_synced`** — bug in writer; `check-sync-freshness` catches it on next Dream run.
- **Domain section has no `keywords:` or no `files:`** — skip silently; lint warns.

## Telemetry

`state/telemetry/recall.log` already exists. Extend each entry with a `source` field: `entity` or `domain` or `entity+domain`. Existing entries (entity-only) backfilled as `entity`.

`state/telemetry/derived-tagging.log` (JSONL) for the lint:
```jsonc
{ "ts": "...", "event": "violation", "file": "inbox.md", "line": 42, "tag": "[fact|origin=sync:chrome]", "expected": "[?|origin=sync:chrome]" }
{ "ts": "...", "event": "scan", "files_scanned": 17, "violations": 0 }
```

## Testing

### Unit
- `system/tests/lib/freshness.test.js` — `stampLastSynced` (atomic write, idempotent), `isFresh` (boundary cases: exactly 24h, future timestamp, missing field), `getLastSynced`.
- `system/tests/hooks/domain-recall.test.js` — recall-domains parser, keyword match (case-insensitive, word-boundary), file dedup against entity recall, malformed map fallback.
- `system/tests/diagnostics/check-sync-freshness.test.js` — fixture with mix of fresh + stale + missing-stamp files; verifies report.
- `system/tests/diagnostics/check-derived-tagging.test.js` — fixture inbox with violations + allow-derived-fact comment; verifies exit code + report.
- `system/tests/migrate/migration-0028-recall-domains.test.js` — copies scaffold; idempotent on re-run.

### E2E
- `system/tests/e2e/hooks/onUserPromptSubmit-domain-recall-injection.test.js` — prompt mentions "fertilizer"; domain map matches gardening; relevant memory block contains expected file contents.
- `system/tests/e2e/hooks/onUserPromptSubmit-domain-no-double-inject.test.js` — prompt matches both entity (e.g., "Astoria" → outdoor-space.md aliased) AND domain (gardening → outdoor-space.md); file injected once.
- `system/tests/e2e/hooks/onUserPromptSubmit-domain-empty-map.test.js` — empty/missing recall-domains.md; entity recall still fires; no crash.
- `system/tests/e2e/jobs/dream-stale-sync-flag.test.js` — fixture sync file with `last_synced` >24h; Dream Phase 12.5 (or new step) appends to needs-your-input.md.

## Pre-merge verification gates

1. **Run `npm run check-sync-freshness` against Kevin's instance.** Establish baseline; see how many sync files are missing `last_synced` today.
2. **Run `npm run check-derived-tagging` against Kevin's instance.** Establish baseline.
3. **Verify domain-recall doesn't blow up the recall-injection size.** Spot-check `recall.log`'s `bytesInjected` field before/after — should not regress significantly. If domain-recall causes >2× injection on average, narrow the default keyword list.
4. **Re-measure dream.md token count** if the Phase 11.5 / 12.5 additions push it.

## Migration / rollout

- Migration 0028 ships `recall-domains.md` to user-data on next install.
- Existing sync writers (Kevin's instance) need a one-time pass to add `stampLastSynced` calls. List of files: `user-data/runtime/scripts/sync-{whoop,nhl,gmail,calendar,weather,ebird,lunch-money,github,spotify,chrome,linear,youtube}.js`.
- `[fact|origin=derived]` lint runs immediately against current state — expect baseline violations from existing data; either fix in-line OR backdate with `# allow-derived-fact: pre-existing` comments. Document baseline in CHANGELOG.

## Scope

**M/L.** Touches: 4 new scripts/helpers, 2 new diagnostics, 1 new migration, 1 new scaffold file, recall hook extension, capture rule update, CLAUDE.md (2 operational rule notes), Dream phase additions (small), package.json scripts, CI workflow, ~12 tests, sync-writer updates (in user-data, not package code). No public-facing API change.
