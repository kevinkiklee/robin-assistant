# Diagnostics

Devtools and validation — token measurement, prefix-bloat measurement, plugin-drift detection, manifest drift detection, doc-path linter, tool-call stats, golden-session snapshot.

## Scripts

| Script | Purpose |
|---|---|
| `measure-tokens.js` | Measure tier token/byte/line counts. `--check` enforces caps, `--json` for machine-readable, `--diff` for delta vs. baseline |
| `measure-prefix-bloat.js` | Measure plugin/skill prefix bloat from a Claude Code session JSONL. Two modes: usage-based (primary; aggregates assistant `usage`) and reminder-based (fallback; parses `<system-reminder>`). `--first-turn` for session-start signal |
| `check-plugin-prefix.js` | Detect plugins/MCPs not on the whitelist (`lib/plugin-whitelist.json`). Catches silent re-introductions from plugin auto-updates |
| `golden-session.js` | Tier 1 load-order snapshot. `--check` compares against committed snapshot; `--update-snapshot` to re-baseline (requires CHANGELOG entry) |
| `tool-call-stats.js` | Per-turn tool-call statistics from session transcripts. `--baseline` scrapes recent transcripts and writes a baseline JSON; `--report` aggregates `turn-stats.log` |
| `manifest-snapshot.js` | Take/update the security manifest snapshot used by tamper detection |
| `check-manifest.js` | Detect drift in `.claude/settings.json` hooks vs. the committed manifest. Runs on SessionStart |
| `check-doc-paths.js` | Lint markdown for stale path references across docs |
| `analyze-finances.js` | Ad-hoc analysis of `cost-history.jsonl` |

## Configs

- `lib/token-budget.json` — single source of truth for tier classification, file caps, and budgets
- `lib/plugin-whitelist.json` — allowed plugin namespaces in robin-assistant Claude Code sessions
- `lib/token-baselines.json` — committed snapshot for `--diff`
- `lib/tokenizer.js` — shared tokenizer utility (rough estimate, ~10% accuracy)

## Phase 1a (cost-and-latency optimization) artifacts

- Pre-prune baselines: `docs/superpowers/specs/baselines/2026-05-03-section-1-pre.json`
- Post-1a verdict (deferred to first post-prune session): `docs/superpowers/specs/baselines/2026-05-03-phase-1a-post.json`
- Post-1b verdict: `docs/superpowers/specs/baselines/2026-05-03-phase-1b-post.json`
- Phase 5 cache-TTL finding: `docs/superpowers/specs/baselines/2026-05-03-phase-5-cache-ttl-finding.md`
