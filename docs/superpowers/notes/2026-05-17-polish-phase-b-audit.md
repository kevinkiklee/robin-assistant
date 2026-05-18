# Polish Phase B — Audit Notes

**Date range:** 2026-05-17
**Phase B complete:** 2026-05-17
**Total Phase B commits:** ~30 (4 setup + 4 B.1 + 5 B.2 + 6 B.3 + 5 B.4 + finalization)
**Combined Phase A + B polish commits:** ~74

## Phase B summary

All four sub-areas shipped:

- **B.1 CLI ergonomics** — exit-codes contract (4 canonical values), JSON envelope shape, command-registry (69 commands), help-formatter, central `--help` dispatcher in `dispatchFor()`, omnibus snapshot suite. 66/69 dispatchable commands now show `Related:` footer.
- **B.2 Doctor + health redesign** — 14 invariants backfilled with `remediation`, schema test now requires it, `renderDoctor()` ships realm-grouped output with inline `→` remediation lines, `--verbose` adds `last_passed` provenance, TTY-gated ANSI color, `reshapeForMCP()` and `reshapeTelemetryRollup()` helpers (wiring to the cognition-e1-owned MCP tools filed below).
- **B.3 Agent-facing UX** — `ERROR_REASONS` enum (12 canonical values) + alias map (20 legacy strings canonicalized from 86 inventoried); action-trust refusals include `prompt_hint`; Discord formatter scaffold (`constants.js`, `formatter.js`, `sender.js`, `ask-fallback.js`) — Discord transport didn't exist in v2 yet, scaffold is forward-compat for when it lands; recall budget-based snippet trimming.
- **B.4 Memory output polish** — `formatEntity`, `formatJournal`, `formatArc`, `formatKnowledge` helpers + tests. Per-tool wiring filed as follow-up (table at end of this file).

## B.1 CLI ergonomics

### Inventory (B.1 Step 0 — audit current surface)
(populated by Task 1)

### Decisions
| Command | --help? | --json? | Exit codes used | Sibling group | Action | Commit |
|---|---|---|---|---|---|---|
| (B.1 Tasks 5+6) — `--help` was previously a no-op on every leaf command. Rather than touch 69 files, wired a centralized `--help` early-out in `dispatchFor` that prints `usage + summary + Related:` for any leaf or group, sourcing the summary from `command-registry.js` and the `Related:` footer from `appendRelated()`. Argv mapping (registry name → argv) lives in `command-registry.js`'s `argvFor()`. | central | n/a | n/a | n/a | central dispatcher | accc2b4 + 06e629f |
| all 69 dispatchable commands | yes (via central dispatcher) | n/a | 0 on `--help` | per registry `group` | omnibus snapshot test asserts exit 0, summary present, ≥30 commands w/ Related: | d467bfe |
| 66 commands with siblings | yes | n/a | 0 | yes | Related: footer in --help via central dispatcher | 06e629f |
| skipped (non-dispatchable): version, surreal-install, surreal-ensure-running, brief-gallery, mcp-ensure-running, help | n/a (CLI flag / obsolete registry entry) | n/a | n/a | n/a | skipped in snapshot test | n/a |

## B.2 Doctor + health redesign

### Decisions
| Subarea | Action | Commit |
|---|---|---|

## B.3 Agent-facing UX

### Discord matrix
| Case | Test status | Commit |
|---|---|---|

### MCP tool result shapes
| Tool | Legacy reason | Enum reason | Commit |
|---|---|---|---|

## B.4 Memory output polish

### Decisions
| Helper / Tool | Snapshot test | Commit |
|---|---|---|

### B.4 tool wiring deferred

The following MCP tools should call into the new format helpers. Filing as follow-up — each requires per-tool snapshot tests to validate the shape change doesn't break existing agent consumers:

| Tool | Helper | Notes |
|---|---|---|
| `find_entity` | `formatEntity` | trim long edges/events lists; agent can pass `full: true` |
| `get_entity` | `formatEntity` | same |
| `related_entities` | `formatEntity` | applied per result |
| `list_journal` | `formatJournal` | sort most-recent-first; trim to default 50 |
| `list_episodes` | `formatJournal` | same |
| `list_arcs` | `formatJournal` | same |
| `get_arc` | `formatArc` | header+summary+footer shape |
| `get_knowledge` | `formatKnowledge` | header+body+related shape |
| `recall` | `trimRecallEvents` (Task 18) | budget-based snippet trimming |

### B.4 tool wiring decisions

All 9 tools wired with a `full: true` opt-out and per-tool snapshot tests. Each commit touches only the tool file + its new shape test.

| Tool | Helper | Status | Commit |
|---|---|---|---|
| list_arcs | formatJournal | wired | e8c4003 |
| list_journal | formatJournal | wired | ec44796 |
| list_episodes | formatJournal | wired | 4dbf2f3 |
| get_arc | formatArc | wired (header/summary + legacy entity_ids/episode_ids/status preserved) | 0bd1019 |
| get_knowledge | formatKnowledge | wired (per-row wrap) | f60192a |
| find_entity | formatEntity | wired (per-match wrap; edges/events placeholders since match results carry neither today) | 7ee11f8 |
| get_entity | formatEntity | wired (legacy `entity.meta` renamed to `entity.entity_meta` to avoid colliding with helper's `meta`; edge_summary/mention_count/last_mentioned_at preserved) | a26dead |
| related_entities | formatEntity | wired (per neighbor; distance + edge_type + strength preserved) | 1e687ad |
| recall | trimRecallEvents | wired (added `snippet_budget_chars` + `snippet_per_event_max` schema params) | 0f2254f |

Shape-change side-effect: `tools-2c-smoke.test.js` previously asserted bare `{ knowledge: [] }` / `{ entries: [] }` returns; widened to `knowledge`/`entries`-only deep-equal with separate meta assertion (commit 8ff874d). No other in-tree consumer of these tool outputs found (`dev-recall.js` reads `r.hits`, still works).

## Cognition-e1 follow-ups landed

| File | Finding | Resolution | Commit |
|---|---|---|---|
| `system/io/mcp/tools/health.js` | health() MCP tool now wires `reshapeForMCP({results, ts, summary})` — output is realm-grouped (`db`, `runtime`). Flat backward-compat fields preserved (version, db_open, embedder_loaded, pending_events, active_sessions, embed_usage) so existing consumers and the legacy `tool-health.test.js` keep passing. New 4-case snapshot test at `system/tests/unit/mcp-tool-health-shape.test.js`. | shipped | `9cd4a11` |

## Open for cognition-e1 lane

| File | Finding | Suggested fix |
|---|---|---|
| `system/io/mcp/tools/show-telemetry-rollup.js` | The tool's current contract returns telemetry_hourly rows directly with `event_kind` per row (used by `system/tests/integration/telemetry-show-rollup-tool.test.js`). `reshapeTelemetryRollup` aggregates per-faculty (drops `event_kind` granularity) AND its canonical `FACULTIES` list omits `reinforcement` / `belief` / `dream` / `meta_cognition` — all faculties produced by `rollup-registry.js`'s `NAME_TO_FACULTIES` map. Direct wiring would silently drop those rows and break event_kind filtering. | (1) Extend `FACULTIES` in `system/io/format/telemetry-rollup.js` to include `reinforcement`, `belief`, `dream`, `meta_cognition` (match `NAME_TO_FACULTIES`); (2) decide whether `event_kind` is part of the new per-faculty shape or whether the helper should accept a `groupBy: 'faculty' \| 'faculty+event_kind'` switch; (3) migrate `telemetry-show-rollup-tool.test.js` accordingly. Owner is e1 because the registry → bucket → reshape contract is e1's surface. |

## Open for prompt-injection lane

| File | Finding | Suggested fix |
|---|---|---|

## Open for user

| Item | Question | Recommended action |
|---|---|---|

## Won't fix

| Item | Rationale |
|---|---|
