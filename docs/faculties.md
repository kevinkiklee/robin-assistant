# Faculties

Robin's behaviour is organised into seven named faculties. Each maps to a specific mechanism, a single point in the request lifecycle, and a small set of files. This page describes each in depth: when it fires, what it does, what it writes, and how to inspect or disable it.

## intuition

**The UserPromptSubmit hook that injects relevant memory into the next turn.**

- **Trigger:** Claude Code or Gemini CLI fires `UserPromptSubmit` with `{prompt, transcript_path, session_id}`.
- **Files:** `src/hooks/handlers/intuition.js` (hook entry), `src/recall/intuition.js` (daemon endpoint), `/internal/intuition` (HTTP).
- **Behaviour:** Reads the last 8 KB of the transcript JSONL, extracts the previous assistant message (capped at 2000 chars), POSTs `{query, prior_assistant, k:6, recency_days:30, token_budget:1500}` to the daemon with a 300 ms hard timeout. Daemon runs the recall pipeline (HNSW kNN + recency window + source/trust filters), formats hits as a `<!-- relevant memory -->` block, greedy-packs lines under the token budget, returns. Host injects the block into the model's context.
- **Writes:** one row in `runtime_intuition_telemetry` per fire (query length, hit count, tokens injected, latency, truncation flag). Telemetry is advisory; failures here never break the response.
- **Fail-soft:** every error path (no daemon, timeout, non-2xx, malformed payload) exits 0 silently. The agent turn proceeds without injection.
- **Cutover suppression:** if `$CLAUDE_PROJECT_DIR/system/scripts/hooks/host-hook.js` exists (a v1 hook installation), intuition yields with a one-line stderr notice to avoid double `<!-- relevant memory -->` blocks.
- **Disable:** `robin hooks disable intuition` sets `hooks.disabled = true` in `<robinHome>/config.json`. The kill-switch is global — when disabled, all hook phases are suppressed.
- **Inspect:** `SELECT * FROM runtime_intuition_telemetry ORDER BY ts DESC LIMIT 20`.

## biographer

**Per-turn consolidation: turns raw events into structured entities, edges, and episodes.**

- **Trigger:** Claude Code or Gemini CLI fires the `Stop` hook after each agent turn. The hook spawns `robin biographer process-pending` as a detached subprocess.
- **Files:** `src/capture/biographer.js`, `src/capture/biographer-prompt.js`, `src/capture/biographer-output.js`, `src/graph/`.
- **Behaviour:** Reads new events with `biographed_at IS NONE`, makes one LLM call per event through `host.invokeLLM` (with cache-controlled prompt layers), parses the structured output (entities + typed edges + episode boundary signal), and UPSERTs via a three-stage entity resolution cascade (exact name → embedding similarity → LLM disambiguation).
- **Writes:**
  - `entities` (resolved or upserted, 384-dim HNSW embedded)
  - `mentions` / `about` / `precedes` (event→entity, event→entity, event→event)
  - `works_on` / `participates_in` / `co_occurs_with` (entity→entity, with weight on co_occurs_with)
  - `episodes` (opens new, extends active, closes after 30-min quiet window)
  - `events.biographed_at` flipped to `time::now()`
- **Failure handling:** 3-retry on transient LLM errors with exponential backoff. Malformed JSON output is terminal — event's `id` is appended to `runtime:biographer.failed_event_ids` and excluded from future runs unless `--retry-failed` is passed.
- **Concurrency:** transaction-conflict retries (4 attempts with jitter) handle parallel biographer runs against the same event without double-writing.
- **Manual trigger:** `robin biographer-catchup [--retry-failed]` for a full catch-up.

## heartbeat

**The 60-second scheduler tick.**

- **Trigger:** internal interval inside the daemon, started at boot.
- **Files:** `src/daemon/scheduler.js`.
- **Behaviour:** Runs the following on each tick:
  - Integration sync dispatch (any integration whose `next_run_at` ≤ now)
  - Biographer queue drain (flush pending events for biographing)
  - Stale-session sweep (mark sessions inactive for > 10 min as `stale`)
  - Quiet-window cursor advance (close episodes after 30-min idle)
  - Job scheduler (manually-runnable + cron-style internal jobs)
- **Writes:** depends on what each subsystem does. The heartbeat itself doesn't write; it only dispatches.
- **Tuning:** interval is fixed at 60s — no flag yet.

## discretion

**Refuses inappropriate writes (inbound), commands (bash), and outbound payloads.**

Three sub-mechanisms share the name and the refusal-logging table:

### Inbound (memory writes)

- **Trigger:** Every call to `remember`, `record_correction`, and the conversation-capture pipeline.
- **File:** `src/hooks/inbound-guard.js` (`guardInboundContent`).
- **Behaviour:** Pattern-matches the payload against credential / secret / private-key / JWT / password-assignment patterns (`src/hooks/pii-patterns.js`). On match: refuse, write to `refusals(direction='inbound')`, return a structured error to the caller.
- **Override:** `robin remember --force <content>` bypasses for CLI use. Agents have no override path — they must escalate to the user.

### Bash (PreToolUse)

- **Trigger:** Claude Code's `PreToolUse` hook fires when the agent invokes Bash.
- **File:** `src/hooks/handlers/discretion.js`, `src/hooks/bash-patterns.js`.
- **Behaviour:** Static pattern match against 7 deny rules (no daemon round-trip): `secrets-read`, `env-dump`, `destructive-rm`, `low-level-fs`, `git-expose-userdata`, `eval-injection`, `db-direct-access` (refuses `surreal sql/connect/import/export` against the local DB). Match → exit 2, command refused with stderr explanation.
- **Disable:** `robin hooks disable discretion`.

### Outbound (writes to external systems)

- **Trigger:** Every outbound integration tool: `github_write`, `spotify_write`, Discord replies.
- **File:** `src/outbound/policy.js` (`checkOutbound`), `src/outbound/patterns.js`.
- **Behaviour:** PII / secret patterns + verbatim-quote-from-untrusted-event guard (refuses to forward a quote from a `trust='untrusted'` event ≤ 7 days old) + sliding-1h rate limiter (default 10 writes per tool per hour). Refusals logged to `refusals(direction='outbound')`.

### Audit

- `robin refusals list` — recent rows from `refusals` (both directions).
- `SELECT * FROM refusals WHERE direction = 'inbound' ORDER BY created_at DESC LIMIT 20`.

## dream

**Nightly 5-step consolidation into long-term memory.**

- **Trigger:** Cron tick at 4 AM (`process.env.TZ`), or manual: `robin dream run`, or via the `run_dream` MCP tool.
- **Files:** `src/dream/pipeline.js` (orchestrator), `src/dream/step-*.js` (steps).
- **Behaviour:** Sequentially runs five steps over events stamped `dreamed_at IS NONE`, each under its own try/catch so one failure does not abort the others. Errors land in `summary.<step>.error`. After all steps complete:
  1. `dreamStepKnowledge` — promotes durable facts into `knowledge` (any entity with ≥ 3 un-dreamed mentions is a candidate; LLM decides whether to promote).
  2. `dreamStepPatterns` — mines recurring shapes into `patterns`.
  3. `dreamStepReflection` — clusters correction events into `rule_candidates` (see [reflection](#reflection)).
  4. `dreamStepProfile` — updates the long-running user `profile`.
  5. `dreamStepThreads` — segments ongoing arcs into `threads`.
  6. Marks every event with `dreamed_at IS NONE` as dreamed (one batched UPDATE).
  7. Upserts `runtime:dream` with `last_run_at` and `last_run_at_success` for the scheduler.
- **Idempotence:** re-running observes an empty un-dreamed set and is a no-op.
- **Writes:** `knowledge`, `patterns`, `rule_candidates`, `profile`, `threads`, `events.dreamed_at`.
- **Manual:** `robin dream run` (synchronous, prints summary).

## reflection

**Correction-to-rule learning loop. Step 3 of dream.**

- **Trigger:** runs as a step inside `dreamProcess`; not separately schedulable.
- **File:** `src/dream/step-reflection.js`.
- **Behaviour:** Selects events with `meta.kind = 'correction'` and `ts >= time::now() - 30d`, runs single-link agglomerative clustering on their embeddings (cosine threshold 0.85), and for each cluster of ≥ 3 events: checks `findOverlappingPendingCandidate` to avoid duplicates, then calls the LLM with the cluster's contents and the `CORRECTION_RULE_SYSTEM` prompt to draft a behavioural rule. Creates a `rule_candidates` row with `status='pending'`.
- **Writes:** `rule_candidates`.
- **Promotion:** the user approves with `robin rules approve <id>` (or the `update_rule` MCP tool). Approved rules become `rules` rows and surface in the `<!-- robin -->` block of `~/.claude/CLAUDE.md` / `~/.gemini/GEMINI.md` on the next session start.
- **Inspect:** `robin rules pending`, `robin rules list`.

## introspection

**Daemon-boot integrity check against the install-time manifest baseline.**

- **Trigger:** Once at daemon boot, before serving requests.
- **Files:** `src/daemon/introspection.js`, `src/install/manifest.js`.
- **Behaviour:** Loads `<robinHome>/manifest.json` (written by `robin install` — captures sha256 of tracked handler files, mode bits on `secrets/.env` and `db/`, supervisor file checksum). Recomputes the current state. Diffs and produces a `findings[]` array of `{kind, path, expected, actual}` for any drift. Persists the result to `runtime_introspection_state` (singleton, keyed `current`) so SessionStart hooks read cached findings without recomputing.
- **Finding kinds:** `hash_drift`, `mode_drift`, `missing_file`, `supervisor_drift`, `no_baseline`.
- **Behaviour on drift:** Non-blocking. Daemon serves requests, but findings surface as `[daemon] introspection warning ...` stderr lines, and SessionStart hooks repeat them to the user on each new agent session.
- **Rebaseline after intentional change:** `robin doctor --rebaseline` (re-runs `computeManifest` and overwrites `manifest.json`).
- **No baseline:** if `manifest.json` is absent (fresh dev clone, or it was deleted), introspection reports a single `no_baseline` finding and `baselined=false`. Run `robin install` to write one.

## See also

- [`architecture.md`](architecture.md) — how the faculties fit into the request lifecycle
- [`development.md`](development.md) — adding a new hook handler or MCP tool
- [`troubleshooting.md`](troubleshooting.md) — what to do when a faculty misfires
