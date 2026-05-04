---
title: Action-trust closing-the-loop
date: 2026-05-03
status: design
scope: robin-assistant CLI (Dream surfacing + new CLI subcommand + tests)
---

# Action-trust closing-the-loop

## Problem

The action-state machine (AUTO/ASK/NEVER) is mostly built:
- `system/scripts/capture/lib/actions/classify.js` deterministically maps tool calls to class slugs.
- `system/scripts/capture/lib/actions/precheck.js` enforces hard rules.
- `system/scripts/capture/lib/actions/compact-summary.js` regenerates the policies summary.
- `user-data/runtime/config/policies.md` is the explicit policy.
- `user-data/memory/self-improvement/action-trust.md` is the trust ledger.
- Dream Phase 12.5 (`system/jobs/dream.md` line 129) handles calibration: tally outcomes, demote on `corrected`, propose promotion at ≥5 successes / 0 corrections in 30d, auto-finalize 24h after surfacing if no objection, 7-day probation, 90-day decay.

What's broken:
- **Promotion proposals "emit to the escalation report"** but no escalation report file exists. Dream writes to `dream-state.md` `## Notable` and that's it. The user never sees pending promotions; auto-finalize fires after 24h whether or not the user actually saw the proposal.
- **No user-facing review surface.** No way to see "what's currently AUTO," "what's pending promotion," "what was recently demoted," without grepping multiple files.
- **`[action]` captures aren't flowing.** `action-trust.md` `## Open` is empty (header only). Either model isn't emitting `[action]` captures, or it is but they're going somewhere else. Without captures, the calibration loop has no input — promotion proposals will never fire.
- **Dream Phase 12.5 has no e2e tests.** Only the helper modules (classify/precheck/compact-summary) are tested. The promotion/demotion/probation/decay logic isn't covered end-to-end.

## Goals

- Make Dream's pending-review output a real, persistent, user-facing file.
- Surface that file at session start so the user sees pending promotions before auto-finalize.
- Provide a CLI surface for ad-hoc review of the trust state.
- Verify and document why `[action]` captures aren't flowing; strengthen the capture instruction.
- Add e2e test coverage for Phase 12.5.

## Non-goals

- Auto-emission of `[action]` captures via hook (would require outcome detection across turns; defer).
- Cross-class trust transfer (autonomy roadmap explicit out-of-scope).
- Class-splitting via Dream (out of scope).
- New action classes beyond what `classify.js` already produces.
- Web UI for trust review (CLI is the surface).

## Architecture

### Surfacing file

A new file `<workspace>/user-data/runtime/state/needs-your-input.md` becomes Dream's persistent escalation surface. Replaces the phantom "escalation report" referenced in dream.md lines 114, 122, 132, 161.

Schema:

```markdown
---
generated_at: 2026-05-04T05:00:00Z
generated_by: dream
---

# Needs your input

Pending items from the most recent Dream run. Items here either auto-resolve
on a deadline (e.g., promotion proposals 24h after surfacing) or require your
explicit response. Items resolved since last Dream run are removed.

## Action-trust promotion proposals

<!-- proposal-id:20260504-01 -->
**`gmail-reply-to-known-sender` → AUTO** (auto-finalize at 2026-05-05T05:00Z)
- evidence: 6 successes, 0 corrections, last 30 days
- last action: 2026-05-03
- to object: append `[correction|origin=user] reject promotion 20260504-01: <reason>` to inbox

## Action-trust probation watch

- `gmail-archive` — under probation until 2026-05-10 (7-day post-promotion window). 0 corrections so far.

## Action-trust recent activity

- `spotify-skip` — promoted to AUTO 2026-05-01
- `github-mark-read` — demoted to ASK 2026-04-29 (1 correction)

## Recall telemetry

- Auto-recall avg injection bytes rising: 412 → 980 (2.4× over prior period). Investigate.

## Conversation pruning candidates

- 3 conversation pages older than 90d with zero inbound links (review at `recall conversation-pruning` for the list).
```

Sections are written by Dream phases that previously wrote to "escalation report":
- Phase 8 (preference promotion) — contradictions
- Phase 11.5 (recall telemetry review) — trends, dead routes, missing aliases
- Phase 12.5 (action-trust calibration) — promotions, probation, demotions, decay
- Phase 18 (conversation pruning) — candidates

If a section has no items in the current Dream run, Dream omits the section header. If the file would be empty, Dream writes only the frontmatter + the `# Needs your input` heading + a single line `_(no items)_`.

### CLAUDE.md startup integration

`needs-your-input.md` is added to startup #4 read list — positioned LAST (per-day volatile, prompt-cache-friendly). Read only if exists and not empty. If it has items, the model surfaces them in the first response of the session naturally ("FYI, Dream flagged X for review").

### CLI subcommand

New `robin trust` subcommand at `bin/robin.js`:

- `robin trust` (default) — print summary: counts of AUTO/ASK/NEVER classes, count of `## Open` trust entries with pending review, count of pending promotions.
- `robin trust status` — print full current state from `policies.md` (the AUTO/ASK/NEVER lists) and `action-trust.md` `## Open` (active classes with their counters).
- `robin trust pending` — print just the action-trust section of `needs-your-input.md`.
- `robin trust history [--days N]` — print `## Closed` entries from `action-trust.md` (default last 30 days).
- `robin trust class <slug>` — print everything about one class: state in `policies.md`, counters in `## Open` if active, history in `## Closed`.

All commands read existing files; no writes. Read-only surface.

### `[action]` capture diagnostic

Add a diagnostic check `npm run check-action-captures` that scans recent `inbox.md` (last 30 days) for `[action]` lines and reports:
- Count of action captures
- Count by class
- Whether action-trust.md `## Open` has corresponding entries

Wired into Dream Phase 12.5 as a pre-step: if zero `[action]` captures in last 7 days, append a note to `needs-your-input.md` under "Action-trust capture pipeline":
> ⚠ No `[action]` captures recorded in 7 days. Either no AUTO/ASK actions occurred (unlikely) or capture-emission rule isn't being honored. Review `system/rules/capture.md` `### [action] tag` section.

Strengthen the capture instruction: add a one-line reminder to CLAUDE.md operational rules that links to capture.md `### [action] tag` and emphasizes the settled-class elision (don't clutter with already-settled classes).

## Components (new)

- **`system/scripts/cli/trust.js`** — CLI subcommand handler. Reads `policies.md`, `action-trust.md`, `needs-your-input.md`. Pure read; no writes. Exports default subcommand handler called from `bin/robin.js`.
- **`system/scripts/diagnostics/check-action-captures.js`** — scans `inbox.md` for `[action]` lines; reports counts; exits 0 always (informational). Exposed as `npm run check-action-captures`.
- **`system/scripts/lib/needs-input.js`** — small helpers:
  - `appendSection(workspaceRoot, sectionName, body)` — atomic append to `needs-your-input.md`. Creates file with frontmatter if missing.
  - `clearSection(workspaceRoot, sectionName)` — remove a section (when items resolved).
  - `clearFile(workspaceRoot)` — reset to empty state.
  - `readSections(workspaceRoot)` → `{section: body}` map.

## Components (modified)

- **`bin/robin.js`** — register `trust` subcommand, dispatch to `system/scripts/cli/trust.js`.
- **`system/jobs/dream.md`** — replace "escalation report" references in phases 8, 11.5, 12.5, 18 with explicit writes to `needs-your-input.md` via `system/scripts/lib/needs-input.js`. Phase 12.5 gains the `[action]` capture pipeline check (described above). At the START of every Dream run, Phase 0 clears resolved sections from `needs-your-input.md` (any item whose proposal-id has a matching `## Closed` entry, any probation-watch entry whose probation expired, etc.). Pre-merge gate: re-measure dream.md token count.
- **`CLAUDE.md`**:
  - Startup #4 — append (only if exists): `user-data/runtime/state/needs-your-input.md`. Position LAST in read list with `today.md` from learning-queue thread.
  - Operational rules — add: "When `needs-your-input.md` is non-empty, surface its items in the first response of the session naturally — especially auto-finalizing promotion proposals; the user has 24h before they auto-resolve."
  - Operational rules — add: "Action captures: per `system/rules/capture.md` `### [action] tag`, emit `[action] <class> • <outcome> • <ref>` for unsettled classes only (settled-class elision). Without these captures, the calibration loop has no input and promotions will never fire."
- **`package.json`** — add `check-action-captures` script.
- **`system/scaffold/runtime/state/.gitkeep`** — ensure runtime/state exists at install (probably already does; verify).
- **`CHANGELOG.md`**.

## Data flow (canonical promotion case)

```
Day 0–N: Model emits [action] captures for gmail-reply-to-known-sender
   - inbox.md gets:
     [action] gmail-reply-to-known-sender • approved • thread:abc123
     [action] gmail-reply-to-known-sender • approved • thread:def456
     ... (5 total over 30 days, 0 corrections)

Day 30 — Dream runs:
   1. Phase 12.5 reads action-trust.md ## Open + recent [action] captures
   2. gmail-reply-to-known-sender hits promotion threshold
   3. Dream appends to needs-your-input.md:
      ## Action-trust promotion proposals
      <!-- proposal-id:20260504-01 -->
      **gmail-reply-to-known-sender → AUTO** (auto-finalize at 2026-05-05T05:00Z)
      - evidence: 5 successes, 0 corrections, last 30 days
      - to object: append [correction|origin=user] reject promotion 20260504-01

Day 30, evening — User starts session:
   1. CLAUDE.md startup #4 reads needs-your-input.md
   2. Model surfaces in first response: "FYI, Dream is proposing to promote
      gmail-reply-to-known-sender to AUTO; auto-finalizes in 22h. Want to
      object or let it through?"
   3a. User approves → no action; Dream Day 31 finalizes
   3b. User objects → user/model writes [correction|origin=user] reject
       promotion 20260504-01: <reason> to inbox.md

Day 31 — Dream runs:
   1. Phase 0 clears resolved items from needs-your-input.md
   2. Phase 12.5 sees the proposal-id; checks for matching corrections in
      inbox.md.
      a. No correction found → finalize: move class to AUTO in policies.md;
         append ## Closed entry to action-trust.md; set probation-until=Day 38;
         remove proposal from needs-your-input.md
      b. Correction found → cancel: append ## Closed entry "promotion rejected";
         keep class in ASK; remove proposal from needs-your-input.md
```

## Error handling

- **`needs-your-input.md` doesn't exist:** CLAUDE.md startup gracefully skips. Dream creates on first write.
- **`needs-your-input.md` exists but is empty (frontmatter + `_(no items)_`):** CLAUDE.md startup reads but treats as no items.
- **Concurrent Dream runs writing to needs-your-input.md:** Dream lock guarantees serial Dream execution; no race.
- **Trust CLI invoked when `action-trust.md` is missing or empty:** prints "no active classes" / "no history"; exits 0.
- **Migration history of `needs-your-input.md`:** brand-new file; no migration needed. Existing instances get it on first Dream run after upgrade.
- **Promotion proposal references unknown class slug:** Dream still writes the proposal; user can object; CLI handles "unknown class" gracefully.
- **Dream Phase 0 clearing logic fails:** Phase 0 wraps each section-clear in try/catch; failure on one section doesn't abort the rest of Dream. Logged in dream-state.md notable.

## Edge cases

- **Multiple proposals for same class in different proposal-ids:** Phase 12.5 dedupes by class slug; latest proposal-id wins; old proposals removed.
- **Auto-finalize race:** if user writes objection within minutes of the 24h boundary, Dream Phase 0 sees the correction and cancels. Dream's cadence (24h+ between runs) is coarse enough that the race is benign.
- **Empty action-trust ledger but dream still tries to read:** Dream gracefully no-ops; the calibration step is skipped.
- **`[action]` capture pipeline check trips (zero captures in 7d) repeatedly:** the warning gets re-appended each Dream run. Acceptable — it's a real signal that something needs fixing.
- **User edits policies.md by hand mid-promotion:** explicit policy wins over earned trust per CLAUDE.md operational rules. Dream's promotion attempt would be a no-op (class already in AUTO list); proposal removed from needs-your-input.md.

## Telemetry

`state/telemetry/action-trust.log` (JSONL) appends:
```jsonc
{ "ts": "...", "event": "promotion_proposed", "proposal_id": "20260504-01", "class": "gmail-reply-to-known-sender", "evidence": { "successes": 5, "corrections": 0 } }
{ "ts": "...", "event": "promotion_finalized", "proposal_id": "...", "class": "...", "probation_until": "..." }
{ "ts": "...", "event": "promotion_rejected", "proposal_id": "...", "class": "...", "reason": "..." }
{ "ts": "...", "event": "demotion", "class": "...", "trigger": "user_correction" | "self_correction" | "decay_90d" }
{ "ts": "...", "event": "probation_cleared", "class": "..." }
{ "ts": "...", "event": "capture_pipeline_warning", "days_silent": 14 }
```

## Testing

### Unit
- `system/tests/lib/needs-input.test.js` — appendSection idempotency, clearSection, clearFile, readSections; atomic writes.
- `system/tests/cli/trust.test.js` — each subcommand against fixture `policies.md` + `action-trust.md`; verifies output format; pure read.
- `system/tests/diagnostics/check-action-captures.test.js` — fixture inbox with N action captures; verifies counts.

### E2E (under `system/tests/e2e/jobs/`)
- `action-trust-promotion.test.js` — fixture: action-trust.md with 5 successes / 0 corrections / 30d for class X. Run Dream protocol's Phase 12.5 (via test harness). Assert: needs-your-input.md gets the proposal section; telemetry logs `promotion_proposed`.
- `action-trust-auto-finalize.test.js` — fixture: existing proposal with surfaced-at >24h, no matching correction. Run Dream. Assert: class moved to AUTO in policies.md; ## Closed entry appended; needs-your-input.md cleared; probation-until set.
- `action-trust-promotion-rejected.test.js` — same as above but with `[correction|origin=user] reject promotion <id>` in inbox. Assert: class stays in ASK; ## Closed entry says "rejected"; proposal removed.
- `action-trust-demotion-on-correction.test.js` — fixture with class in AUTO and a `corrected` outcome since last Dream. Assert: moved to ASK in policies.md; ## Closed entry; telemetry logs `demotion`.
- `action-trust-probation-clear.test.js` — fixture with AUTO class probation expired, 0 corrections. Assert: probation flag cleared; telemetry logs `probation_cleared`.
- `action-trust-90d-decay.test.js` — fixture with AUTO class, no entries 90+ days. Assert: demoted to ASK; ## Closed `decay (idle 90d)`.
- `action-trust-capture-warning.test.js` — fixture with no `[action]` captures in last 7 days. Assert: warning section appended to needs-your-input.md.
- `needs-your-input-startup-load.test.js` — non-empty needs-your-input.md exists; verify CLAUDE.md startup #4 reads it (via test harness).

## Pre-merge verification gates

1. **Re-measure `dream.md` token count** after Phase 0 (clear) addition + capture-pipeline-check addition. If over per-protocol cap, reorganize Phase 0 into a Dream pre-script invoked from the protocol.
2. **Verify `needs-your-input.md` placement at end of CLAUDE.md startup #4** doesn't disrupt cache reuse (alongside `today.md` from learning-queue thread). Expect both to be at the END of the read list.
3. **Run `npm run check-action-captures`** against Kevin's instance. If zero captures in 7 days, surface that immediately as a finding rather than waiting for first Dream run.

## Scope

**M.** Touches: 1 new CLI subcommand + dispatch (`bin/robin.js`, `cli/trust.js`), 1 new diagnostic, 1 new helper (`needs-input.js`), Dream protocol updates (multiple phases), CLAUDE.md startup + 2 operational rule notes, `package.json` script, ~12 tests. No public-facing API change beyond the new CLI subcommand.
