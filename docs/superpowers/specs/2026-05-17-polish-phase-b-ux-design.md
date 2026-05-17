# Polish Program — Phase B: UX Polish Design

**Author:** Kevin (with Claude during /superpowers:brainstorming, 2026-05-17)
**Status:** Draft, awaiting Phase A audit notes before finalization, then user review before /superpowers:writing-plans
**Sibling spec:** `docs/superpowers/specs/2026-05-17-polish-phase-a-sanitation-design.md` (Phase A; Phase B depends on its audit notes)
**Parallel lane (out of scope):** `docs/superpowers/specs/2026-05-17-cognition-e1-self-improvement-design.md`

---

## TL;DR

Four-sub-area UX sweep that gives every in-scope surface a tested output contract: CLI ergonomics, doctor + health, agent-facing (Discord + MCP), memory output. Phase B is informed by Phase A's bridge table — surfaces deleted in A.2 shrink scope; silent-failure sites surfaced in A.1 seed CLI error-message work; new invariants from A.4 require doctor-display rendering. Output: snapshot tests, format helpers, a typed MCP error-reason enum, a centralized question rendering layer for Discord, and a `remediation` field on every invariant. Exit gate is concrete (every CLI `--help` snapshot green; doctor <2s and ≤12 lines on healthy instance; Discord edge-case matrix green; every MCP tool typed). Time-box ~24–38 working hours.

---

## Background

### Why this is its own phase

Sanitation (Phase A) reduces surface area and surfaces facts. UX polish (Phase B) then makes the remaining surfaces legible. Doing them together creates two failure modes:
- UX work redesigns surfaces that A.2 would have deleted (wasted effort).
- UX work writes error messages for catches A.1 is still classifying (premature contract).

Sequencing Phase A → audit-bridge → Phase B keeps each phase sharp.

### What Phase B inherits from Phase A

Phase A's audit notes ship a "Bridge to Phase B" table. Each row is a Phase B work-item seed:

| Phase B target | Type | Provenance |
|---|---|---|
| Add error message at `<file>:<line>` | error-message | A.1 |
| Drop `<surface>` from B.1 scope (deleted) | scope-reduction | A.2 |
| Doctor must render invariant `<id>` | doctor-display | A.4 |
| MCP tool `<name>` returns `<shape>` | mcp-contract | A.1/A.3 |
| Daemon log event `<name>` structured; surface in doctor | observability | A.4 |

These seed each sub-area below. Phase B spec finalization (status flip from Draft to Approved) happens only after Phase A's audit notes are reviewed by the user.

### Decisions taken during brainstorm

| Decision | Choice | Rationale |
|---|---|---|
| Sequencing | Phase A fully → Phase B | Sanitation reshapes UX scope. |
| Sub-area dispatch within B | Per-sub-area parallel where independent | B.1, B.2, B.3, B.4 are largely independent surfaces. |
| Snapshot test convention | Inline string literals + normalization helper | Decided in Phase A spec (cross-cutting). |
| Discord retry policy | Exp backoff, 3 retries, then surface | Confirmed during brainstorm. |
| Existing CLI exit codes | Preserved | Confirmed during brainstorm. |
| Color in doctor | Only when `isTTY && !NO_COLOR && !--json` | — |
| `--legacy` flag for old doctor format | NOT shipped | CLAUDE.md "no backwards-compat shims." |
| MCP error-reason enum migration | Legacy strings aliased; new reasons direct | Avoids breaking existing agent prompts. |

---

## Architecture overview

```
                                ┌────────────────────────────────┐
                                │  Phase A audit notes (input)   │
                                └─────────────────┬──────────────┘
                                                  │
                          Bridge table seeds each sub-area
                                                  │
                                                  ▼
        ┌────────────────────────────────────────────────────────────┐
        │ Phase B: UX polish (this spec)                             │
        │                                                            │
        │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐     │
        │  │ B.1 CLI      │  │ B.2 doctor + │  │ B.3 agent-   │     │
        │  │  ergonomics  │  │  health      │  │  facing      │     │
        │  └──────────────┘  └──────────────┘  └──────────────┘     │
        │  ┌──────────────┐                                          │
        │  │ B.4 memory   │   snapshot test infra (shared)           │
        │  │  output      │   system/tests/helpers/normalize-…       │
        │  └──────────────┘                                          │
        └──────────────────────────────┬─────────────────────────────┘
                                       │
                                       ▼
                          Phase B exit gate (verification script)
```

**Time-box:**
- B.1: 6–10 working hours
- B.2: 4–8
- B.3: 6–10
- B.4: 4–6
- Snapshot infrastructure + final wiring: 4

**Sub-area dispatch.** B.1, B.2, B.3, B.4 are independent at the surface level (each owns its own files). Dispatched in parallel via subagents where the snapshot-test infrastructure (cross-cutting) is in place first.

**Audit-bridge integration.** Each sub-area below has a "Scope inputs from Phase A bridge" subsection listing which bridge-table row types it consumes.

---

## B.1 CLI ergonomics

**Step 0 — audit current state** (committed to Phase B's "B.1 inventory" — written before fix commits start):

For every `robin <subcmd>`:
- Current exit code(s) observed (instrument with `echo $?` after representative runs).
- Current `--json` support (yes / no / partial).
- Current `--help` shape (snapshot of current output).
- Current error message format on failure (run with invalid args, capture).
- Current sibling commands referenced in help text.

Inventory lives in `docs/superpowers/notes/2026-05-17-polish-phase-b-b1-inventory.md` (committed before B.1 fix commits).

**Method.**

1. **Inventory table** populated from Step 0.

2. **Standardize exit codes (preserving existing).** Propose code map based on audit:
   - `0` — success
   - `1` — generic error
   - `2` — user error (bad args, missing required flag)
   - `3` — precondition failure (missing secret, daemon not running, install not pointed)

   Any command with an in-the-wild exit code that doesn't fit (e.g., `publish exit 3` happens to fit, but some may not) preserves its current code. Documented in `system/runtime/cli/exit-codes.js` with explicit "preserved" annotation.

3. **Per-command audit:**
   - **Help text**: one-line summary; multi-line detail if non-obvious; `Related:` footer derived from CLI command registry.
   - **Output format**: human-readable default + `--json` for every non-interactive subcommand. Shared JSON envelope: `{ ok, command, data, error?, took_ms }`. Documented in `system/runtime/cli/json-envelope.md`.
   - **Error messages**: surface one-line cause + one-line remediation hint. No bare stack traces to stdout in non-debug mode (debug = `ROBIN_DEBUG=1`).

4. **CLI command registry.** New file: `system/runtime/cli/command-registry.js`. Hand-authored, listing `{ name, summary, group, siblings? }` per command. The `Related:` footer in `--help` is generated from `group` membership (a command's group-siblings appear in `Related:`).

5. **JSON-mode coverage.** Every non-interactive subcommand gets `--json`. Snapshot-tested per command.

6. **Discoverability.** `Related:` footer only. No `robin help <topic>` style (out of scope).

**Scope inputs from Phase A bridge:**
- `error-message` rows → B.1 wires user-facing error messages with remediation hints at the indicated sites.
- `scope-reduction` rows → drop the listed commands from inventory.

**Threshold.**

Every CLI subcommand:
- has a tested `--help` snapshot
- has a documented exit code from the audit-derived map
- supports `--json` if non-interactive
- has a `Related:` footer if it has siblings
- surfaces user-facing errors with cause + remediation

**Output.**

- `system/runtime/cli/command-registry.js`
- `system/runtime/cli/exit-codes.js`
- `system/runtime/cli/json-envelope.md`
- Snapshot tests: `system/tests/unit/cli-help-<command>.test.js`, `system/tests/unit/cli-json-<command>.test.js`
- Per-command commits

**Risk + rollback.**

Help text desyncs from behavior. Mitigation: snapshot tests fail on any behavior change that doesn't update help. Rollback per-commit (each command independent).

---

## B.2 Doctor + health surface redesign

**Method.**

1. **Output contract — realm-grouped, detail-on-failure.**

```
Robin doctor — 2026-05-17 13:42:01

paths        ok        3 checks
db           warn      4 checks (1 warn)
  ⚠ db.embedder_profile_match — active=mxbai-1024, table=mxbai-1024-v2 (mismatched)
    → robin embeddings activate mxbai-1024-v2  OR  robin embeddings backfill mxbai-1024
mcp          ok        3 checks
integrations warn     12 checks (2 warn)
  ⚠ integrations.sync_freshness whoop — last_sync_at=4h ago, cadence=30m (stale)
    → robin integrations run whoop
  ⚠ integrations.sync_freshness photos — last_sync_at=8h ago, cadence=6h (stale)
    → robin integrations run photos
runtime      ok        5 checks
meta         ok        1 check

Summary: 28 ok, 2 warn, 0 fail. Exit 0.
```

Healthy instance: 1 line per realm + summary line ≈ 8–12 lines total.
Failure scale: +1 line per `warn`/`fail` check + remediation line. No fixed budget; scales naturally with failures.

2. **`--verbose` flag.** Adds per-check provenance under each check line (when last passed, related events from `runtime_invariants_state`).

3. **`--json`** snapshot test (the realm-grouped JSON shape).

4. **Color detection — precise.**
   `process.stdout.isTTY && !process.env.NO_COLOR && !args.includes('--json')`. Three levels: green (ok), yellow (warn), red (fail).

5. **Remediation inline.** Every `warn`/`fail` renders remediation under the line, prefixed `→`. Source: extend invariant definition schema with `remediation: string | string[]`.

   **Migration:** B.2 backfills `remediation` for ALL existing invariants in `system/runtime/invariants/*`. Doctor falls back to "see docs" only for invariants imported from external sources (none exist today). Field is optional in the schema for forward compatibility.

6. **`health()` MCP tool.** Returns realm-grouped JSON, trimmed for agent consumption: no remediation strings (agent renders those from invariant `class`). Snapshot test.

7. **`show_telemetry_rollup` MCP tool.** Reshape into per-faculty rows. Hide zero-rows behind `verbose: true` argument. Snapshot test.

8. **Scope: output formatter swap.** Doctor's check layer stays intact (`system/runtime/invariants/runner.js`). Render path: `system/runtime/cli/commands/doctor.js` plus its private helpers `_doctor-status.js`, `_doctor-probes.js`, `_doctor-special-commands.js`. Invariant schema gets the `remediation` field. No `--legacy` flag (CLAUDE.md "no backwards-compat shims" rule).

**Scope inputs from Phase A bridge:**
- `doctor-display` rows → B.2 ensures the named invariants render correctly.
- A.4's doctor JSON schema test is the foundation; B.2 extends with `remediation`.

**Threshold.**

- Healthy instance: doctor runs <2s, ≤12 lines.
- Failing instance: every failure has cause + remediation.
- `health()` MCP shape tested.
- All existing invariants have `remediation` populated.

**Output.**

- Render path rewrite in `system/runtime/cli/commands/doctor.js`
- Invariant schema extension + backfill (all files in `system/runtime/invariants/`)
- `health()` reshape (cognition-e1 owns the file `system/io/mcp/tools/health.js`, so this surface change is filed to e1 lane if it changes the wire shape; otherwise B.2 only edits the formatter helper that `health()` calls into)
- `show_telemetry_rollup` reshape (cognition-e1 owns `system/cognition/telemetry/rollup-registry.js`; B.2 only edits the rendering helper, not the rollup logic)
- Snapshot tests: `doctor-output.test.js`, `doctor-json-schema.test.js`, `health-mcp-shape.test.js`, `telemetry-rollup-output.test.js`

**Note on cognition-e1 boundary.** `health.js` and `rollup-registry.js` are on the cognition-e1 exclude list. B.2 changes that touch their wire shape are filed to e1 lane; B.2 changes to the rendering layer (display only, no shape change) are in scope.

**Risk + rollback.**

Invariant schema extension affects every check. Mitigation: `remediation` is optional (default `null` rendering to "see docs"); backfill can be incremental; snapshot tests catch field regressions. Per-commit revert for rollback.

---

## B.3 Agent-facing UX (Discord + MCP)

**Method.**

1. **Discord reply edge-case test matrix.** `system/tests/unit/discord-reply-formatter.test.js`:
   - **Oversize (>2000 chars)** splits without breaking words or code fences.
   - **Code fence spanning chunk boundary** stays balanced (existing logic, snapshot-locked).
   - **GFM table** renders as fenced code block.
   - **Markdown link** `[label](url)` survives split.
   - **Multi-paragraph reply** preserves paragraph breaks across chunks.
   - **Rate-limit during multi-chunk send:** first chunk succeeds, second hits 429. Retry policy applies per chunk (NOT per reply): exponential backoff with jitter, base 500ms (500ms → ~1s → ~2s), max 3 retries, then surface failure for that chunk. Worst-case per-chunk delay ~3.5s. If Discord returns a `Retry-After` header, the backoff floor for that retry is `max(jittered_default, Retry-After)`. Test asserts: user sees one coherent reply (no duplicate first chunk); after final retry exhausts, agent receives `{ ok: false, reason: 'rate_limited', sent_chunks: N }`.
   - **Outbound-blocked mid-thread:** first chunk passes policy, second triggers `outbound_blocked`. Test asserts: user sees first chunk + follow-up notice "rest of reply blocked by policy: <reason>"; agent receives structured error with `sent_chunks: N`.
   - **AskUserQuestion-under-Discord prevention:** when `process.env.ROBIN_SESSION_PLATFORM === 'discord'`, the agent layer intercepts `AskUserQuestion` calls before invocation. Helper: `system/io/integrations/discord/ask-fallback.js` (new) produces a numbered-text rendering from `{question, options}` that the agent can directly include in its reply text.

2. **MCP tool result shapes.**

   **Success envelope:** `{ ok: true, ...payload }`
   **Failure envelope:** `{ ok: false, reason: '<enum>', message: '<human>', ...details }`

   Reasons enumerated in `system/io/mcp/error-reasons.js` (new):
   ```js
   export const ERROR_REASONS = {
     RATE_LIMITED: 'rate_limited',
     OUTBOUND_BLOCKED: 'outbound_blocked',
     REQUIRES_PERMISSION: 'requires_permission',
     INVALID_ARGS: 'invalid_args',
     NOT_FOUND: 'not_found',
     IN_FLIGHT: 'in_flight',
     UPSTREAM_FAILED: 'upstream_failed',
     // ... populated from audit
   };
   ```

   **Migration strategy.** Every existing tool keeps its current error string as `reason` AND gets aliased into an enum entry. Alias map in `error-reasons.js`:
   ```js
   export const REASON_ALIASES = {
     'rate-limited': ERROR_REASONS.RATE_LIMITED,
     'permission-required': ERROR_REASONS.REQUIRES_PERMISSION,
     // ... from audit
   };
   ```
   New tools and new error paths use the enum directly. Audit notes (B.3 inventory) lists the alias map.

3. **Recall snippets — budget-based.** Default: return up to 5 events full-length until cumulative size hits 4000 chars, then truncate remaining events to 200 chars with `…` ellipsis. Agent overrides via arguments: `recall(query, limit, snippet_budget_chars, snippet_per_event_max)`. Snapshot tests for short-event and long-event cases.

4. **Action-trust feedback — hint not mandate.** When an outbound tool returns `requires_permission`, response shape includes:
   - `class` (already does)
   - `prompt_hint` — short text the agent MAY use verbatim or rewrite in Robin's voice. Documented in `system/io/mcp/error-reasons.js` as "hint, not script."

5. **Centralized question rendering.** Robin's agent layer detects `ROBIN_SESSION_PLATFORM` at start and registers the appropriate "ask the user" path:
   - Terminal-native (Claude Code default) — `AskUserQuestion` works as-is.
   - Text-fallback (Discord) — `ask-fallback.js` produces numbered-text rendering.

   Future tools that want to ask the user get the right path automatically without per-call branching.

**Scope inputs from Phase A bridge:**
- `mcp-contract` rows → contribute new enum entries to `error-reasons.js`.
- `observability` rows → daemon log structured events surface in `health()` (last-N recent activity).

**Threshold.**

- Every `mcp__robin__*` tool has typed success + failure shape with enum'd `reason` (existing tools via alias map; new tools direct).
- Discord edge-case matrix passes including rate-limit and outbound-blocked cases.
- Recall returns budget-trimmed by default.
- `prompt_hint` shipped on all outbound `requires_permission` responses.

**Output.**

- `system/io/mcp/error-reasons.js`
- MCP tool result-shape conversions (per-tool commit; cognition-e1-owned tools filed to e1 lane)
- Discord reply formatter test matrix
- `system/io/integrations/discord/ask-fallback.js`
- Recall snippet logic (in `system/io/format/recall.js`)
- Action-trust `prompt_hint` field (in the action-policy refusal helper)

**Risk + rollback.**

MCP shape changes break consumers. Consumer surface = the agent (primary) + ad-hoc scripts hitting the daemon over MCP + the CLI's `robin show-*` commands that wrap MCP tools. Mitigation: alias map preserves legacy reasons; snapshot tests at all three call sites. Per-tool commit so a single regression reverts one shape, not all.

---

## B.4 Memory output polish

**Method.**

1. **Scope line.** `system/io/format/**` (new directory) hosts shared rendering helpers. `user-data/jobs/briefing/**` is out of scope (user-owned). B.4 touches:
   - MCP tool wrappers in `system/io/mcp/tools/` (excluding cognition-e1-owned `health.js`, `remember.js`).
   - CLI command output in `system/runtime/cli/commands/`.

2. **`recall` output.** Wire shape covered in B.3 (snippet budget); B.4 covers the higher-level `format_recall_results()` helper used when rendering to Discord text or CLI human-mode.

3. **`find_entity`, `get_entity`, `related_entities`.** Standardize MCP output:
   - `{ id, kind, name, summary, edges: [...], events: [...], meta: { total_edges, total_events } }`
   - Long fields trimmed; total counts in `meta`.
   - **Agent opt-out for full content:** tool argument `full: true` returns untrimmed.

4. **`list_journal`, `list_episodes`, `list_arcs`.** Tabular human mode, JSON mode via shared envelope. Consistent sort: most-recent-first. Snapshot tests for empty and typical cases.

5. **`get_arc`, `get_knowledge`.** Header (id, name, kind, dates, counts) + body + footer (linked entities, recent events). Trimmed by default; `full: true` argument for untrimmed.

**Scope inputs from Phase A bridge:**
- Tests added in A.3 for memory-module behavior → seed snapshot tests.
- `scope-reduction` rows → drop deleted surfaces.

**Threshold.**

- Every memory MCP tool has snapshot-tested output shape for empty-result + typical-result cases.
- CLI rendering consistent across `list_*` tools (shared sort, shared columns where applicable).
- `full: true` argument documented in each tool's MCP schema description.

**Output.**

- `system/io/format/recall.js`
- `system/io/format/entity.js`
- `system/io/format/journal.js`
- `system/io/format/arc.js`
- `system/io/format/knowledge.js`
- Tool wrapper updates (per-tool commit)
- Snapshot tests in `system/tests/unit/format-*.test.js`

**Risk + rollback.**

Trimming hides info the agent needs. Mitigation: `full: true` argument documented in tool description so agent knows when to ask for it. Rollback per-tool.

---

## Cross-cutting (inherited from Phase A spec)

- **Snapshot test convention** — inline string literals with normalization helper. See Phase A spec for details.
- **CHANGELOG** — Keep-a-Changelog format at package root. Phase B entries land under `## [unreleased] - Phase B`.
- **Commit hygiene** — atomic single-command commits (`git commit -m "msg" -- file1 file2`). No `-a`/`-am`.
- **Test cadence** — `pnpm test:fast` inner loop; `pnpm test` before phase exit.

---

## Phase B exit gate (concrete)

1. `pnpm test` exits 0; new snapshot tests committed.
2. `robin --help` and every subcommand `--help` snapshot test green.
3. `robin doctor` runs <2s on healthy instance, ≤12 lines.
4. `robin doctor --json` schema snapshot test green; every existing invariant has `remediation` populated.
5. Discord reply edge-case matrix green (including rate-limit and outbound-blocked cases).
6. Every `mcp__robin__*` tool has typed result shape + enum'd error reasons; alias map covers existing strings.
7. `show_telemetry_rollup` output snapshot tested.
8. `system/scripts/polish-verify.sh --phase=b` exits 0.
9. CHANGELOG `## [unreleased] - Phase B` section populated with `Added`/`Changed`/`Fixed`/`Removed` entries per sub-area.

---

## Out of scope

- Cognition-e1-owned files (see Phase A spec for the full exclude list).
- `user-data/jobs/briefing/**` (user-owned).
- v1 quarantine, `robin-cursor/`, `robin-gemini/`, `askrobin.io/`, `archive/`.
- New CLI subcommands (only polish existing ones).
- New MCP tools (only polish existing ones).
- Multi-tenant, web-product, or platform-expansion work.
- New "robin help <topic>" style or interactive command-explorer UI.

---

## Open issues for /superpowers:writing-plans

(To be resolved in the implementation plan, not the spec.)

- Snapshot test file naming: `cli-help-<command>.test.js` vs `cli/<command>-help.test.js`?
- Should the CHANGELOG live in the package root or under `docs/`?
- For the alias-map: write tests asserting every legacy reason has an alias entry, or trust the audit?
- For B.2 `--verbose`: render provenance from `runtime_invariants_state` table or from in-memory invariant runner state?
- For B.3 retry policy: does the backoff jitter cap at the rate-limit reset window from Discord's `Retry-After` header, or always use the base interval?
