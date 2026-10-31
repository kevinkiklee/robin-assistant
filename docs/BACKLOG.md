# Robin — Backlog

> Updated: 2026-10-29 (pruned from the 2026-05-19 build backlog)
> Companion: `docs/STATUS.md` (what runs today). Per-feature specs and plans: `docs/design/` (local only).
> History note: the public repository's history was reset on 2026-10-31 to remove personal data. Commit hashes cited below refer to the earlier history and don't resolve on GitHub; `docs/design/` specs are the maintainer's local notes and aren't published.

This file holds open work only. Every item cites the code or commit it was checked against. Shipped and dropped items from the original May backlog are listed at the bottom with their evidence, so nobody re-opens them by accident.

When you close an item, move it to [Closed](#closed) with the commit hash. When you find new open work, add it here only after you've confirmed it in the source.

---

## Open

### 1. Interactive `robin init`
`init` without `--yes` still refuses: `system/surfaces/cli/init.ts` prints "Interactive init not yet implemented". The non-interactive path covers daily use. It writes the schema, the hooks, the MCP entries (`robin mcp install`) and the launchd agent (`robin daemon install`, `system/lib/launchd/`).

**Remaining scope:** use `node:readline/promises` prompts for the model-role preset, integration selection with inline `robin reauth <name>`, and the optional service and MCP registration. Add a `--reconfigure=<section>` flag that re-runs one section. Cancelling mid-flow must leave a sane state. Keep it in its own file so the `--yes` path stays lean.

### 2. Real `explain` MCP tool
`explain` in `system/surfaces/mcp/core/server.ts` returns placeholder stubs for `recall`, `action_trust`, `learning` and `playbook` (the code comment reads "Real explanation logic ships in Plan 6"; no such plan exists). The remote surface leaves it out of `READ_ONLY_TOOLS` for that reason. There are two options. One is to build it on data that already exists: `recall_log` scores and kept sets, `agent_usage` outcomes, belief provenance, and correction history. The other is to remove the tool so it stops costing description tokens.

### 3. Test lab Plan 3 (paid modes)
Plan 2 shipped template mode only (`lab/`, 2026-10-21). The deferred work is listed in `docs/design/2026-10-21-robin-test-lab-plan-2.md`, under "Out of this plan" and "Carried into Plan 3":

- an LLM renderer with a verify gate, and `config`-mode runs against real providers
- the answer layer
- a fleet controller with a lockstep barrier, a response cache, a budget broker and an estimator
- a paired-bootstrap report and experiment YAML specs
- a scheduled reconcile arm, plus the recall audit and topic hygiene inside the loop

Every paid step goes estimate → approve. No Plan 3 document exists yet.

### 4. Behavioral habits, Phase 3 (feedback depth and surfacing)
`docs/design/2026-06-17-behavioral-habit-inference-design.md` §Phasing defines Phase 3 as "richer recall weighting + calibration views", in a separate spec. Phase 1 and Phase 2 shipped, but the Phase 3 spec was never written. The value-loops work (2026-08-10: open-loops resurfacing in recall audit) covers part of the surfacing side. Habit-weighted recall and a habit calibration view are still open. Write the spec before building.

### 5. Hot-reload permission gate
Integration hot-reload shipped (`system/integrations/_runtime/watch.ts`): it debounces, cleans up the previous registration, and re-registers. The original acceptance criterion isn't built: when `integration.yaml` asks for new permissions, the reload should pause until a grant is given. No grant command exists. Today a changed manifest takes effect on reload with no review step.

### 6. APFS-snapshot backups
`robin db backup` still uses `wal_checkpoint(TRUNCATE)` + `VACUUM INTO` (`system/surfaces/cli/db.ts`). `system/lib/backup/` holds only a `.gitkeep`. APFS snapshots would be faster but need elevated permissions. This is worth doing only if a non-sudo path exists. Low priority.

### 7. Metered-network auto-pause
Battery-threshold auto-pause shipped (`system/lib/power-auto/monitor.ts`). Metered-SSID detection did not: there is no SSID or metering code in `system/`. macOS doesn't expose metering reliably, so this needs a user-tagged SSID list in `policies.yaml`. Low priority.

### 8. Security follow-ups (review of 2026-10-31)
The 2026-10-31 review's high findings shipped: incognito in `captureSession` for every caller, the SessionEnd transcript gate, reserved event kinds on `remember`/`ingest`, fenced `recall`/`list` and integration results, look-alike fence tags neutralised, Discord `allowed_mentions`, the consent-form and redirect-allowlist fixes. Still open, highest first:

- **Untrusted text into committed beliefs.** A nightly synthesis that reads integration-derived text (inbox subjects in a staged brief) and auto-commits beliefs through `believe()` gives that text a path into auto-recalled memory. Fence those inputs, or stage (never commit) beliefs whose evidence includes integration rows.
- **Correction origin.** `record_correction` is a remote write and auto-recall presents corrections as instructions. Tag each correction's origin (local interactive / remote / agent) and inject only operator-origin ones with the imperative label, or take it off `REMOTE_WRITE_TOOLS`.
- **Publish attachments and images.** Text attachments (CSV, GPX, XMP) upload without a discretion scan; images keep EXIF (GPS included); HTML-page uploads happen before the final check, so a refused page can leave blobs behind. Scan text attachments, strip EXIF, upload after the final check. Image/attachment paths are checked lexically, not with `realpath` (`images.ts` `resolveLocalPath`).
- **Secrets from integrations.** Integration ticks (an emailed API key in a gmail snippet) store text unredacted; only captured sessions get `redactSecrets()`. `get` upserts entity keys and `resolve_prediction.evidence` is unchecked.
- **OAuth registration.** `/oauth/register` is unauthenticated and unbounded; there's no rate limit on consent access-key attempts.
- **Incognito and auto-recall.** During incognito, auto-recall still sends each prompt to the embedding API for its vector layer. Go lex-only while capture is suspended.
- ~~**Agent auto-land scope.**~~ Done 2026-10-31: protected set = the agent runtime's computed import graph + `surfaces/`, `kernel/config/`, `lib/secrets/`, capture, publish/discretion/notify, the reliability audit, migrations; plus an egress tripwire (network/subprocess/secrets/dynamic code in any file; env/URLs and any new import in non-test code; `system/scripts/` protected since build runs it), full-suite verification inside a seatbelt sandbox with a scrubbed env and a post-check worktree-drift check, and post-restart probation with auto-revert. Default stays on at the operator's request (`agent.auto_land`).
- **Auto-land egress check is a regex deny-list.** `reachViolation` matches `fetch(`, `node:child_process`, `spawn(` etc. by line regex, which aliasing or dynamic specifiers can evade. Replace with an allowlist of module specifiers taken from a parse of the file, and include test files in the new-import check; consider denying process-exec (except an allowlist) and launchd mach-lookup in the gate's seatbelt profile. (Rename, diff-driver and binary bypasses were closed 2026-10-31 with `GATE_DIFF_FLAGS` and the `.gitattributes`/binary holds.)
- **`ingest` overwrite.** `ingest` with a matching `source` + `payload.external_id` updates an existing integration event in place.

---

## Needs a decision, not a task

- **Two-way Discord.** Notifications are outbound REST only (`system/integrations/builtin/discord/`). Listening needs a gateway process. That is a separate decision covering process count, dependency weight and launchd service. See `CLAUDE.md` § Notifications.

## Not planned

- **Kuzu graph projection.** Dropped 2026-06-11 because upstream was archived. The scaffold was removed and the reasoning is in `ARCHITECTURE.md` §Database. Revisit only past ~1M relations *and* with a maintained engine *and* a feature that needs path queries.
- **DSPy prompt-optimization sidecar.** Not planned. Correction replay plus embedded, prompt-relevant corrections cover the few-shot value without a Python sidecar.
- **Codex SDK adapter.** Not planned under the Claude-only routing policy.
- **`gemini-cli` as a load-bearing provider.** Gemini is used for embeddings only (`system/brain/llm/google.ts`).
- **Windows support** and **hosted multi-tenant SaaS.** Out of scope; one user per daemon.
- **Shipping personal integrations in the package.** Per-user integrations stay in `user-data/extensions/` (gitignored).

---

## Closed

Status of every item in the 2026-05-19 backlog, checked on 2026-10-29.

| Item | Outcome | Evidence |
|---|---|---|
| P0.1 Wire cognition + integrations into the scheduler | Shipped | now 18 jobs in `system/brain/cognition/jobs.ts` |
| P0.2 Tier-1 integrations | Shipped; later pruned | and siblings. `github` removed; `chrome` disabled (now `system/integrations/builtin/_chrome/`) |
| P0.3 SurrealDB read path in migrate | Superseded | replaced by the NDJSON importer (`system/surfaces/cli/import.ts`); the `migrate/` directory was deleted |
| P0.4 Real-Ollama end-to-end validation | Superseded | Cognition moved to cloud providers (2026-05-24), then Claude-only routing; the `ollama.ts` adapter remains but isn't the default |
| P1.1 `robin-extension` MCP server | Shipped | now 7 ops tools + 5 built-in dispatchers + user-extension dispatchers |
| P1.2 Interactive `robin init` | **Open** | Open item 1 |
| P1.3 Hot-reload watcher | Shipped, minus the permission gate | gate is open item 5 |
| P1.4 Biographer stage-3 LLM disambiguation | Shipped | |
| P1.5 Daemon-unhealthy notification | Shipped, then grown | incident ladder `notifyOperator()` + Discord |
| P2.1 Kuzu projection | Dropped | See Not planned |
| P2.2 OTel exporter | Deleted | Shipped as a library in never wired; deleted 2026-10-29 along with the dormant DeepSeek adapter |
| P2.3 APFS snapshots | **Open** | Open item 6 |
| P2.4 DSPy sidecar | Not planned | See Not planned |
| P2.5 Multi-account integrations | Shipped | `<name>--<instance>` in `system/integrations/_runtime/loader.ts` |
| P2.6 Battery auto-pause / metered SSID | Battery shipped; SSID open | open item 7 |
| P2.7 Codex adapter | Not planned | See Not planned |
| T.1 CI workflow | Shipped | `.github/workflows/tests.yml`, `gitleaks.yml` |
| T.2 Docker image | Shipped | `Dockerfile` |
| T.3 launchd plist generator | Shipped | `system/lib/launchd/`, `robin daemon install` |
| T.4 `robin upgrade` | Shipped, then removed | Removed. Migrations apply on daemon start and on `init`; the `db.schema_current` invariant guards drift |
| T.5 `db backup / restore / vacuum` | Shipped | `system/surfaces/cli/db.ts` |
| T.6 Companion repo template | Shipped, then removed | removed in public-release prep |
| T.7 README + contribution docs | Shipped | `README.md`, `docs/CONTRIBUTING.md`, `docs/SECURITY.md` (no CODEOWNERS) |
| Per-integration end-to-end validation | Superseded | Per-integration staleness, skip-streak and degraded-stream invariants catch a tick that lands nothing |
| Job-row retention (old STATUS gap) | Shipped | `retention.run` prunes terminal job rows >7d; `jobs.history_bounded` invariant |
| Prediction resolver gap (`docs/design/2026-08-07-prediction-resolver-registry.md`) | Shipped another way | Structured resolution specs + deterministic resolver (migration 039, `docs/design/2026-10-03-prediction-specs.md`) |
