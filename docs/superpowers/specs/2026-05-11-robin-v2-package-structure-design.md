# Robin v2 Package Structure — `system/` Reorganization

**Status:** Approved design (plan-only; implementation deferred)
**Date:** 2026-05-11
**Predecessors:** Builds on the substrate established in `2026-05-11-robin-v2-database-and-memory-redesign-design.md` and the umbrella roadmap in `2026-05-11-robin-v2-evolution-roadmap.md`.
**Sequencing:** Lands after every theme the user intends to merge before restructure has merged. Themes deferred indefinitely (e.g., 1c per roadmap priority) do not block.

## 1. Motivation

The current `src/` tree has 21 top-level folders, ranging from 1 to 96 files each. Distribution is uneven and conceptually flat:

- 21 folders inside `src/` with no grouping by responsibility.
- `secrets/` has 1 file; `rules/` has 2; `outbound/` has 3. `integrations/` has 96; `cli/` 65; `mcp/` 32. Uneven.
- Named faculties from `docs/faculties.md` (intuition, biographer, discretion, dream, heartbeat, introspection) are scattered across `hooks/`, `recall/`, `capture/`, `daemon/`, `outbound/`, `graph/`, `rules/` — never surfaced in the tree.
- `tests/`, `scripts/`, and `bin/` live outside any code root, blurring the project's "what's code" boundary.

This spec defines a layered, faculty-aware reorganization that resolves these issues.

## 2. Design overview

Five top-level layers inside a `system/` wrapper, plus npm-package conventions and tests:

- `runtime/` — process lifecycle (cli, daemon, install, hosts, dev scripts).
- `data/` — persistence and derived storage (db + migrations, embedders).
- `cognition/` — cognitive operations on memory (named faculties + substrate).
- `io/` — boundaries with the outside world (capture, outbound, hooks dispatcher, integrations, mcp surface).
- `config/` — cross-cutting configuration (flat, 3 files).
- `bin/` — npm entrypoints (robin binary + hook shim).
- `tests/` — test code (excluded from npm publish).

Named faculties (intuition, biographer, discretion, dream) live directly under `cognition/`. Each faculty owns its primary engine when there's a single consumer: the recall engine lives in `cognition/intuition/`, the graph pipeline in `cognition/biographer/`. Substrate folders (`memory`, `jobs`) exist only when 3+ consumers genuinely share them.

Scheduling and operational self-checks (heartbeat, introspection) live in `runtime/daemon/`, not `cognition/`, even though `docs/faculties.md` lists them as faculties — they don't operate on memory in a meaningful way.

## 3. Tree shape

```
system/
├── bin/                  npm package entrypoints (robin, robin-hook.sh)
├── runtime/              process lifecycle
│   ├── cli/                user-facing command-line (incl. boot dispatch from old runtime/bin.js)
│   ├── daemon/             process infra + scheduling
│   │   ├── server.js, lock.js, port.js, sessions.js, idle-embedder.js
│   │   ├── heartbeat.js          (was: daemon/scheduler.js — scheduling, not cognition)
│   │   └── introspection.js      (operational self-check, not memory ops)
│   ├── install/            install + setup (incl. migrate-home — assumed install-time only)
│   ├── hosts/              host detection (claude-code / gemini)
│   └── scripts/            dev tooling — bench, fixtures, migrate-fresh, verify
├── data/                 persistence and derived storage
│   ├── db/                 SurrealDB client, lock, backup, migrate runner
│   │   └── migrations/       SQL migration files (was: schema/migrations/)
│   └── embed/              embedder profiles (mxbai, ollama, gemini)
├── cognition/            cognitive operations on memory
│   ├── intuition/          UserPromptSubmit injection + recall engine
│   │   └── handler.js, inject.js, engine.js, fusion.js, rank.js, reinforcement.js
│   ├── biographer/         per-turn events → entities/edges/episodes + graph pipeline
│   │   └── pipeline.js, prompt.js, output.js, edges.js,
│   │       stage1-exact.js, stage2-embedding.js, stage3-disambig.js, upsert-entity.js,
│   │       queue.js (was: daemon/biographer-queue.js — folded per single-consumer rule)
│   ├── discretion/         refuses inappropriate writes/commands/outbound payloads
│   │   └── handler.js, inbound-guard.js, outbound-policy.js,
│   │       bash-patterns.js, pii-patterns.js
│   ├── dream/              nightly 5-step consolidation (reflection is step 3)
│   │   └── pipeline.js, prompts.js, step-knowledge.js, step-patterns.js,
│   │       step-profile.js, step-reflection.js, step-comm-style.js, step-calibration.js,
│   │       candidates.js (was: rules/candidates.js)
│   ├── memory/             substrate — used by every faculty
│   │   └── attention.js, chronicle.js, decay.js, episodes.js (was: graph/episodes.js),
│   │       foresight.js, habits.js, knowledge.js, kind-registry.js, edge-registry.js,
│   │       rules.js (was: rules/rules.js — rules are a memory kind)
│   └── jobs/               substrate — scheduled cognitive jobs catalog
├── io/                   inbound and outbound boundaries with the outside world
│   ├── capture/            transcript reading, session capture, record-event, file-tail
│   ├── outbound/           rate limit, patterns (policy moved to discretion)
│   ├── hooks/              thin dispatcher
│   │   └── dispatcher.js (was: hooks/cli.js — renamed to avoid CLI confusion), disabled.js
│   ├── integrations/       third-party services; keeps _auth/_framework/_local convention
│   └── mcp/                MCP tool surface — agent-facing interface
├── config/               cross-cutting configuration (flat, 3 files)
│   └── paths.js, data-store.js, secrets.js
└── tests/                test code — excluded from npm publish
    ├── fixtures/, integration/, unit/
```

**Stays at repo root** (outside `system/`): `docs/`, `user-data/`, `package.json`, `biome.json`, `.github/`, `README.md`, `CHANGELOG.md`, `AGENTS.md`, `HANDOFF.md`, `LICENSE`.

## 4. Placement rules

Walked in order when deciding where a file lives:

1. **`bin/`** — npm entrypoints (`robin` binary + hook shim). Two files. A packaging convention, not a layer.
2. **`runtime/`** — runs *because Robin itself is running* but doesn't operate on memory in a meaningful way. Process lifecycle, install, host handshake, scheduling, operational self-check, dev scripts.
3. **`data/`** — persistence and its derived forms. DB (with migrations as an internal), embedders.
4. **`cognition/`** — operates on memory in a meaningful way. A cognition folder is **either** a named faculty (owns its primary engine when there's a single consumer) **or** substrate (shared by 3+ faculties with no single owner). Scheduling and self-checks live in `runtime/daemon/`, not `cognition/`, even when Robin's docs name them as faculties.
5. **`io/`** — thin boundary with the outside world. Logic invoked from boundaries belongs in faculties; the io layer routes events and exposes surfaces.
6. **`config/`** — cross-cutting configuration. Flat — 3 files. Not a junk drawer.
7. **`tests/`** — test code; mirrors the system/ tree under `tests/unit/` and `tests/integration/` (so `cognition/intuition/handler.js` tests live at `tests/unit/cognition/intuition/handler.test.js`). Excluded from npm publish.

### 4.1 No `index.js` files

**`index.js` files are forbidden inside `system/`.** Every file gets a descriptive name. A faculty's main entry uses a domain-meaningful name (e.g., `pipeline.js`) — never `index.js`. Imports always reference the specific file.

Rationale: `index.js` hides what's actually in a folder; descriptive names make grep work and imports self-documenting. Faculty pipelines (`biographer/pipeline.js`, `dream/pipeline.js`) follow a parallel naming pattern.

### 4.2 Import direction rules

```
config ← everything             (config imports nothing — leaf)
data ← runtime, cognition, io
cognition ← runtime, io          (faculties import data + config + memory substrate)
io ← runtime                     (io imports cognition handlers/engines via faculty paths)
runtime ← nothing                (runtime is top — orchestrates everything below)
```

In one sentence: **runtime orchestrates; io and cognition call each other through faculty handlers; data and config are leaves.** Cycles forbidden. A static check (Section 6.3, gate #1) enforces these at verification time.

### 4.3 Dispatch chain

Host invokes `bin/robin-hook.sh` → shell script invokes Node into `io/hooks/dispatcher.js` → dispatcher routes to faculty handler:

- `UserPromptSubmit` → `cognition/intuition/handler.js`
- inbound guards (PostToolUse, etc.) → `cognition/discretion/handler.js`

`io/hooks/dispatcher.js` knows the routing table; faculties don't know about the host. Hook event types are an io concern; faculties take normalized inputs.

### 4.4 Ledger placement rule

Append-only ledgers introduced by themes 2a (evidence) and 2b (action-trust) are memory kinds and live in `cognition/memory/<name>-ledger.js`, peer to `rules.js`, `knowledge.js`, `habits.js`. Their generation logic lives in the faculty that produces them (e.g., evidence-ledger generation in `cognition/dream/` if dream writes it; or its own faculty folder if the theme spec promotes it).

### 4.5 Faculty table vs file structure

`docs/faculties.md` lists heartbeat and introspection as faculties. The file structure places them in `runtime/daemon/` because functionally they don't operate on memory — heartbeat schedules; introspection self-checks. The faculty table is a *conceptual* index of Robin's cognitive lifecycle; folder placement follows the placement rules above. `docs/faculties.md` cross-references this section.

## 5. Migration mapping (current `src/` → new `system/`)

This table is **illustrative, not authoritative**. The restructure lands after theme work; by then this snapshot will be stale (themes add files, may rename existing ones). The placement rules in §4 govern; this table shows how today's tree projects onto them.

### 5.1 Top-level moves

| Current | New | Notes |
|---|---|---|
| `bin/` | `system/bin/` | npm entrypoints — package.json "bin" path updates |
| `src/` | `system/` (root) | the rename |
| `scripts/` | `system/runtime/scripts/` | dev tooling |
| `tests/` | `system/tests/` | excluded from npm via `.npmignore` |

### 5.2 `src/` → `system/runtime/`

| Current | New |
|---|---|
| `src/cli/` (whole) | `system/runtime/cli/` |
| `src/runtime/bin.js` | folds into `system/runtime/cli/` (boot dispatch is CLI) |
| `src/runtime/config.js` | `system/config/paths.js` |
| `src/runtime/data-store.js` | `system/config/data-store.js` |
| `src/runtime/file-tail.js` | `system/io/capture/file-tail.js` (verify single-consumer via grep) |
| `src/runtime/migrate-home.js` | `system/runtime/install/migrate-home.js` (verify install-time only) |
| `src/daemon/server.js, lock.js, port.js, sessions.js, idle-embedder.js` | same path under `system/runtime/daemon/` |
| `src/daemon/scheduler.js` | `system/runtime/daemon/heartbeat.js` (renamed) |
| `src/daemon/introspection.js` | `system/runtime/daemon/introspection.js` (kept in place) |
| `src/daemon/biographer-queue.js` | `system/cognition/biographer/queue.js` (folded — single-consumer) |
| `src/install/` (whole) | `system/runtime/install/` |
| `src/hosts/` (whole) | `system/runtime/hosts/` |

### 5.3 `src/` → `system/data/`

| Current | New |
|---|---|
| `src/db/` (whole) | `system/data/db/` |
| `src/schema/migrations/` | `system/data/db/migrations/` (migrations live inside db) |
| `src/embed/` (whole) | `system/data/embed/` |

### 5.4 `src/` → `system/cognition/`

**Faculty: intuition** (absorbs recall engine)

| Current | New |
|---|---|
| `src/hooks/handlers/intuition.js` | `system/cognition/intuition/handler.js` |
| `src/recall/intuition.js` | `system/cognition/intuition/inject.js` |
| `src/recall/index.js` | `system/cognition/intuition/engine.js` |
| `src/recall/fusion.js, rank.js, reinforcement.js` | `system/cognition/intuition/{fusion,rank,reinforcement}.js` |

**Faculty: biographer** (absorbs graph pipeline minus episodes; absorbs queue)

| Current | New |
|---|---|
| `src/capture/biographer.js` | `system/cognition/biographer/pipeline.js` |
| `src/capture/biographer-prompt.js` | `system/cognition/biographer/prompt.js` |
| `src/capture/biographer-output.js` | `system/cognition/biographer/output.js` |
| `src/graph/edges.js, stage1-exact.js, stage2-embedding.js, stage3-disambig.js, upsert-entity.js` | `system/cognition/biographer/*` |
| `src/graph/episodes.js` | `system/cognition/memory/episodes.js` (cross-faculty data type) |
| `src/daemon/biographer-queue.js` | `system/cognition/biographer/queue.js` (folded — single-consumer) |

**Faculty: discretion** (absorbs outbound policy + pattern data)

| Current | New |
|---|---|
| `src/hooks/handlers/discretion.js` | `system/cognition/discretion/handler.js` |
| `src/hooks/inbound-guard.js` | `system/cognition/discretion/inbound-guard.js` |
| `src/hooks/bash-patterns.js` | `system/cognition/discretion/bash-patterns.js` |
| `src/hooks/pii-patterns.js` | `system/cognition/discretion/pii-patterns.js` |
| `src/outbound/policy.js` | `system/cognition/discretion/outbound-policy.js` |

**Faculty: dream** (absorbs rule-candidate generation)

| Current | New |
|---|---|
| `src/dream/*` | `system/cognition/dream/*` (whole folder) |
| `src/rules/candidates.js` | `system/cognition/dream/candidates.js` |

**Substrate: memory** (absorbs rules-as-data and episodes)

| Current | New |
|---|---|
| `src/memory/*` (all files) | `system/cognition/memory/*` |
| `src/rules/rules.js` | `system/cognition/memory/rules.js` (rules are a memory kind) |
| `src/graph/episodes.js` | `system/cognition/memory/episodes.js` (noted above) |

**Substrate: jobs** — `src/jobs/` → `system/cognition/jobs/` (no internal changes).

### 5.5 `src/` → `system/io/`

| Current | New |
|---|---|
| `src/capture/session-capture.js, transcript.js, record-event.js, errors.js` | `system/io/capture/*` |
| `src/outbound/patterns.js, rate-limit.js` | `system/io/outbound/*` |
| `src/hooks/cli.js` | `system/io/hooks/dispatcher.js` (renamed) |
| `src/hooks/disabled.js` | `system/io/hooks/disabled.js` |
| `src/hooks/handlers/*` | moved into respective faculty folders (see above) |
| `src/integrations/*` | `system/io/integrations/*` (no internal reshuffling) |
| `src/mcp/*` | `system/io/mcp/*` (no internal reshuffling) |

### 5.6 `src/` → `system/config/`

| Current | New |
|---|---|
| `src/runtime/config.js` | `system/config/paths.js` (renamed) |
| `src/runtime/data-store.js` | `system/config/data-store.js` |
| `src/secrets/dotenv-io.js` | `system/config/secrets.js` (mechanism stays dotenv) |

### 5.7 Folders that cease to exist

- `src/schema/` — wrapper around migrations; absorbed into `data/db/migrations/`.
- `src/secrets/` — 1 file; absorbed into `config/`.
- `src/runtime/` (as a name) — reused as `system/runtime/`, but original contents redistributed.
- `src/recall/` — absorbed into `cognition/intuition/`.
- `src/graph/` — absorbed into `cognition/biographer/` + `cognition/memory/episodes.js`.
- `src/rules/` — absorbed into `cognition/dream/candidates.js` + `cognition/memory/rules.js`.
- `src/capture/` — split: IO bits to `io/capture/`, biographer bits to `cognition/biographer/`.
- `src/hooks/` — split: dispatcher to `io/hooks/`, handler logic to faculty folders.

**Net:** 21 folders inside `src/` → 5 layers + bin + tests = **7 top-level inside `system/`**. Inside `cognition/`: 4 faculties + 2 substrate = 6.

## 6. Sequencing, coordination, codemod plan

### 6.1 Sequencing

```
NOW
 │
 ├─ feat/surrealdb-improvements P3a (in-flight) — UNBLOCKS THEMES
 │
 ├─ Themes 1a–4 (sequenced per umbrella roadmap; some may be deferred)
 │
 └─ THIS RESTRUCTURE
```

**"Themes done"** means: every theme the user intends to merge before restructure has merged to `main`. Themes deferred indefinitely don't block. The user signals which themes are in scope; remaining themes either ship after the restructure (onto the new tree) or stay deferred.

**Why "after themes":**
- Themes already reference `src/` paths in their plans. Restructure before themes = rewriting 7 plans.
- Themes will add ~30–60 new files (ledgers, faculty extensions, observability tools). The restructure handles them through §4's placement rules — no per-theme path negotiation.
- The longer the deferral, the larger the move at once. That's acceptable — the move is mechanical once placement rules are settled.

### 6.2 Coordination

**Freeze window:** no concurrent PRs touching files inside `system/` during the restructure PR review. Duration: as short as practical — single-PR review window. Length depends on review velocity, not bounded by the spec.

**Handoff prerequisites:**
- All in-scope themes merged to `main`.
- The two locked worktrees (`worktree-agent-a256269*`, `worktree-agent-adf18f*`) — their work merged or abandoned, worktrees removed.
- `main` is green (all checks pass).

The implementation is a single mega-PR, not split. Splitting a rename across PRs leaves the tree half-renamed and tests broken between merges.

### 6.3 Codemod plan

Mechanical work, three passes:

**Pass 1a — folder moves only.** `git mv` per §5 mapping. No content changes. One commit. `git`'s rename detection runs cleanly because content is unchanged.

**Pass 1b — in-file renames.** Files like `biographer-prompt.js` → `prompt.js`, `capture/biographer.js` → `biographer/pipeline.js` happen in a second commit so Pass 1a's rename detection isn't confused by content drift. Includes updating default-export names where the filename was the identifier.

**Pass 2 — import rewrites.** Node script using `@babel/parser` to walk imports; alternative is regex against this codebase's consistent ES-module style. Tool choice deferred to implementation plan, but constrained: must handle relative-path rewriting and not corrupt dynamic imports. Covers `src/`, `bin/`, `tests/`, `scripts/`, `user-data/` (if any user-data hook scripts reference internals).

**Pass 3 — package surface.** Manual edits:
- `package.json` "bin": `"robin": "system/bin/robin"`
- `package.json` "files": `["system/", "AGENTS.md", "CHANGELOG.md", "docs/architecture.md", "docs/development.md", "docs/faculties.md", "docs/install.md", "docs/troubleshooting.md"]`
- New `.npmignore`: excludes `system/tests/`, `system/runtime/scripts/`
- `bin/robin` and `bin/robin-hook.sh` internal references (verify they exist first; update if so)
- README.md, AGENTS.md, `docs/*.md` path references
- `CHANGELOG.md` entry (follow existing format)
- Version bump to next alpha (e.g., `6.0.0-alpha.15` → `6.0.0-alpha.16` or a non-alpha if themes complete simultaneously)

### 6.4 Verification gates

All must pass before the PR is merged:

1. **Import-direction check** — small Node script parses each file's imports and asserts no `cognition/` file imports from `io/` or `runtime/`; no `data/` or `config/` file imports outside its peers or stdlib; no cycles. §4.2 rules become CI.
2. **Build sanity** — `node --check` succeeds on every `.js` file under `system/`.
3. **Lint** — `biome check .` exits zero.
4. **Tests** — `node --test 'system/tests/**/*.test.js'` all green; count matches pre-move count + theme additions.
5. **Bench regression** — `system/runtime/scripts/bench-recall.mjs` and `bench-embedder.js` run against a fixed snapshot. Threshold: no p50/p95 regression > 5%. Module resolution can shift when paths change; this catches it.
6. **Pre-move assumption verification (with grep, before the codemod runs):**
   - `runtime/file-tail.js` callers — only transcript tailing uses it? If multi-consumer, lands in `config/` or stays in `runtime/`.
   - `runtime/migrate-home.js` callers — install-time only? If also daemon-boot, stays in `runtime/` at layer root or in `runtime/daemon/`.

### 6.5 Rollback plan

The PR is reverted as a single commit. **Safe because the restructure is code-only — no data migrations, no SurrealDB schema changes.** User-data on disk is unaffected by the move.

`git revert` of the squash-merged restructure commit produces a tree byte-identical to `main` at the merge commit's parent.

## 7. Acceptance criteria

The restructure is complete when **all** of the following hold:

1. **File placement** — every file moved per §5 + any theme-added files placed per §4 rules. No file remains in a deprecated path (`src/`, `bin/` at repo root, `scripts/` at repo root, `tests/` at repo root).
2. **No `index.js` files** in `system/`.
3. **Import direction** — static check passes (gate 6.4.1).
4. **Build sanity** — `node --check` succeeds on every `.js` file in `system/`.
5. **Lint clean** — `biome check .` exits zero.
6. **Tests pass** — `node --test 'system/tests/**/*.test.js'` all green; test count matches pre-move + theme additions.
7. **Bench regression bound** — recall and embedder bench p50/p95 within 5% of pre-move baseline.
8. **Package surface intact** — `npm pack --dry-run` produces a tarball that:
   - includes `system/{runtime,data,cognition,io,config,bin}/`, docs, `AGENTS.md`, `CHANGELOG.md`
   - excludes `system/tests/`, `system/runtime/scripts/`, `user-data/`
   - the `robin` bin executes and the daemon starts cleanly when installed from the tarball
9. **Documentation aligned** — README, AGENTS.md, `docs/architecture.md`, `docs/faculties.md`, `docs/development.md`, `docs/install.md`, `docs/troubleshooting.md` updated to reference `system/` paths. CHANGELOG entry written (existing format).
10. **Faculty-table reconciliation** — `docs/faculties.md` notes which faculties live in `cognition/` vs `runtime/daemon/` and why (§4.5).
11. **Rollback verified** — a `git revert` of the squash-merged restructure commit produces a tree byte-identical to `main` at the merge commit's parent.

## 8. Non-goals (explicit exclusions)

This spec does **not** cover, and the implementation PR does **not** include:

- Internal reshape of `system/io/integrations/<service>/` — each integration's contents stay as-is.
- Internal reshape of `system/io/mcp/tools/` — folder moves whole; tool grouping is a separate review.
- Internal reshape of `system/runtime/cli/commands/` — 60+ command files are out of scope; flatten or regroup separately.
- Splitting large files — file moves only.
- Renaming public CLI commands (`robin install`, `robin doctor`, etc.) or MCP tool names exposed to the agent.
- Renaming SurrealDB tables, edges, or schema artifacts — owned by surrealdb-improvements and theme specs.
- Changing the package name or pre-release channel beyond a normal alpha bump.
- Reshaping `user-data/` (gitignored, instance-local).
- Reshaping `docs/` at repo root.
- Changing test runner (`node --test` stays) or lint tool (`biome` stays).

## 9. Open questions (deferred to implementation plan)

Flagged for the writing-plans step, not for resolution here:

- **`file-tail.js` placement** — slated for `io/capture/`. Grep verifies single-consumer before move. If multi-consumer, lands in `config/` or stays in `runtime/`.
- **`migrate-home.js` placement** — slated for `runtime/install/`. If also called at daemon boot, stays in `runtime/` at the layer root or moves to `runtime/daemon/`.
- **Test mirror strictness** — strict mirror (`tests/unit/cognition/intuition/handler.test.js`) vs partial (allow related tests to share a file). Default strict; relax case-by-case during codemod if a strict path is awkward.
- **Codemod tool choice** — `@babel/parser` + custom walker vs careful regex. Implementation-plan decision.

## 10. Spec lifecycle

Stable after approval. Placement rules extend only when a theme proposes a category that no existing rule covers — the ledger placement rule (§4.4) was added pre-emptively for themes 2a/2b as an example.

Theme work between approval and execution doesn't require spec edits. Theme implementers consult §4 placement rules when adding files. Spec is revisited only if a theme proposes a placement that contradicts an existing rule.

The implementation plan is a separate document (`docs/superpowers/plans/<date>-robin-v2-package-structure.md`) written by `superpowers:writing-plans` after this spec is approved.

## See also

- `2026-05-11-robin-v2-evolution-roadmap.md` — the seven-theme umbrella this restructure sequences after.
- `2026-05-11-robin-v2-database-and-memory-redesign-design.md` — the substrate this builds atop.
- `2026-05-11-surrealdb-improvements-design.md` — the engine layer (in-flight); restructure sequences after this lands.
- `docs/architecture.md`, `docs/faculties.md` — current cognitive-architecture reference; will be updated as part of acceptance #9 and #10.
