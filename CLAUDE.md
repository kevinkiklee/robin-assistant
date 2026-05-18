# CLAUDE.md — Robin

## Hard rule — never call or use v1

**Never call any `mcp__robin-assistant-v1__*` tool and never read, edit, or otherwise interact with anything under `~/workspace/robin/robin-assistant-v1/`.** v1 is frozen and out of scope. The current Robin is this directory (`robin-assistant-v2`). Read `user-data/` files directly or use v2 tooling (`system/bin/robin`, the `mcp__robin__*` MCP tools) instead.

## Auto-generated workspace context

Operational context (sleep / weather / jobs list / integrations roster / character read / comm style / calibration / security posture) is regenerated hourly into **`CLAUDE.local.md`** (workspace-local, gitignored). Claude Code auto-loads it alongside this file; you'll see those sections in the same context window without anything appearing in this tracked file. The regenerator targets `<packageRoot>/CLAUDE.local.md` and `<packageRoot>/GEMINI.local.md` only — it no longer writes to `~/.claude/CLAUDE.md` or `~/.gemini/GEMINI.md` (those stay clean across other projects).

## Capability discovery first

Before proposing an external tool ("let me create a Gist", "you could use WordPress", "I'll write a one-off script") to handle a user request, **check whether Robin already covers it.** The publish-to-web bug — suggesting Gist when `robin publish` exists — is the canonical regression this rule prevents. The same failure mode can fire for *any* request that matches a built-in: search, capture, schedule, audit, sync, resolve, publish, dedupe, backfill.

Where to look, in order:

1. **`robin --help`** (plus `robin <subcommand> --help` for nested options). Many commands have hidden depth: `robin embeddings backfill`, `robin pre-commit install`, `robin published`, `robin actions set`, `robin secrets set`, `robin jobs run`, `robin auth google`. When the request smells like a built-in capability, start here.
2. **MCP tools** — the `mcp__robin__*` surface, catalogued in `AGENTS.md`. Read tools (`recall`, `get_knowledge`, `find_entity`, integration reads), write tools (`remember`, `record_correction`, integration writes), ops (`run_biographer`, `run_dream`, `run_job`).
3. **`user-data/scripts/`** — personal scripts the user has accumulated (recapture jobs, dedupe scripts, one-off backfills). Often one already matches the request — `ls user-data/scripts/` is a 50-byte check.
4. **`user-data/jobs/`** — scheduled job definitions. Before proposing "we should run X every Y", check whether a job already exists.

If Robin genuinely doesn't cover the request, then propose external — but say so explicitly ("Robin doesn't have a built-in for this; here's what I'd do instead") so the user can confirm.

**Common smell:** a configured third-party MCP (WordPress, external CMS, vendor API) that turns out to be a client/work integration, not the user's. Don't assume a configured MCP is the user's preferred surface — verify by checking past usage in `user-data/io/` or asking once. The publish bug fired because the WordPress MCP biased the agent toward a client site that isn't the user's blog.

## Where files go (writes are not optional)

Robin has a defined user-data layout. **Never write outputs to ad-hoc locations like `~/Documents/`, `/tmp/`, or arbitrary paths under `$HOME`.** Pick the correct slot:

| What you're writing | Location | Naming |
|---|---|---|
| One-shot deliverables the user explicitly asked for (plans, briefs, reports, packing lists, itineraries) | `user-data/artifacts/<topic>-<date>.md` | kebab-case + ISO date if dated |
| Personal scripts the user runs locally | `user-data/scripts/<purpose>.{js,sh,py}` | imperative kebab-case |
| Job definitions (scheduled work) | `user-data/jobs/<job-name>.md` | kebab-case |
| Skill definitions | `user-data/skills/<skill-name>/` | kebab-case directory |

`user-data/` is gitignored at the package level. Anything sensitive (the user's whole personal context, secrets, integration tokens) lives here. Never stage or commit `user-data/` to git.

When the user asks to "capture", "save", or "remember" something:
1. **Default: DB only.** Call `mcp__robin__remember` and stop. The biographer auto-extracts entities (people, things, places, topics) and edges, so structured data — meds, prefs, decisions, facts — is queryable via `recall` and `find_entity` without a parallel markdown file.
2. **Only write a markdown artifact when**:
   - The user explicitly asked for an artifact ("give me a packing list", "write up a plan"), OR
   - You proposed an artifact and the user agreed.
   In both cases, write to `user-data/artifacts/`.
3. **Never write to `user-data/sources/`** for new captures. If the data feels durable enough that you're tempted to use `sources/`, that's the signal to put it in the DB instead. `sources/` is reserved for pre-existing binary attachments (PDFs, CSVs, large reference files).
4. If `mcp__robin__remember` errors, surface the daemon error to the user so they can investigate — don't silently fall back to a file.

## Publishing artifacts to the web

When the user asks to "publish to the web", "post this", "share this publicly", "put this online", or any synonym — use **`robin publish`**. It writes a markdown file to `<PUBLISH_PUBLIC_URL>/p/<slug>` (default `https://askrobin.io/p/<slug>`) via Vercel Blob in seconds — no rebuild, no redeploy. This is Robin's first-party publish surface and the right answer for any "publish / share to the web" request.

**Do not propose GitHub Gist, WordPress, Medium, Notion, or other external surfaces unless the user explicitly asks for one.** A configured WordPress MCP server is not a sign that the user wants to publish there — it's almost always a client/work site, not their blog. Defaulting to Gist / WordPress when `robin publish` exists is a regression worth catching in review.

```bash
robin publish --source <path> [--slug <slug>] [--mode default|overwrite|as-new|delete]
```

- `--source` (required for `default` / `overwrite` / `as-new`) — path to the markdown file, typically under `user-data/artifacts/`.
- `--slug` (optional for `default` / `overwrite` / `as-new`; **required for `delete`**) — when omitted, derived from the filename stem.
- **Slug-collision behavior is sensitive to mode AND slug origin** (this is the easy-to-miss part):
  - `default` + user-passed `--slug <existing>` → **overwrites** the prior page (`action: "overwrite"`).
  - `default` + filename-derived slug that collides → appends a numeric suffix to find a free slot (`action: "append"`). Re-publishing the same artifact without `--slug` does **not** clobber the existing page.
  - `--mode overwrite` (any origin) → always overwrites.
  - `--mode as-new` (any origin) → always creates a new page with a numeric suffix appended, even if no collision exists.
- `--mode delete` — remove a published page by slug. Requires `--slug`.
- Output: JSON envelope with `url`, `slug`, `action`, `assets`, `warnings`. Always show the user the live URL.

Companion: `robin published` lists pages published from this Robin instance (groups by slug; reads `user-data/io/publish/index.jsonl`). Run it before publishing if the user might be overwriting something — `--mode overwrite` and a user-specified existing `--slug` both destroy the prior page.

Required secrets: `BLOB_READ_WRITE_TOKEN`, `PUBLISH_USER_ID`, `BLOB_PUBLIC_BASE_URL`. If any are missing the CLI exits 3 with a remediation hint pointing to `robin secrets set <KEY>=...`. Don't try to work around missing secrets by falling back to an external surface — surface the missing-secret error and let the user fix it.

## Platform-specific UI constraints

The Discord bot spawns this agent with `ROBIN_SESSION_PLATFORM=discord` set in the environment (see `system/io/integrations/discord/agent.js`). Branch on it for UI choices the user can actually see.

**Discord (`process.env.ROBIN_SESSION_PLATFORM === 'discord'`):**

- **`AskUserQuestion` does nothing visible.** Discord has no terminal for the interactive picker — the call returns but the user sees nothing, then wonders why you're silent. Ask in plain message text and list options inline (numbered or bulleted). Same for any other Claude Code UI that depends on the terminal.
- **2000-character cap per message.** `system/io/integrations/discord/constants.js` exports `DISCORD_MESSAGE_MAX = 2000`; the reply path calls `formatter.splitMessage` to chunk oversized replies (code-fence-aware so triple-backticks stay balanced across boundaries). Multi-message replies still ship, but each chunk hits the API separately — keep responses tight, and don't dump multi-screen tables when a summary plus "ask if you want detail X" works.
- **GFM tables are auto-converted to fenced code blocks** by `formatter.tablesToCodeBlocks` (the higher-level `formatForDiscord` wraps it) because Discord renders raw GFM tables as literal pipes. Tables work, but render as monospace, not styled. Use sparingly.
- **Markdown links render** — prefer `[label](url)` when the label is shorter than the URL. Bare URLs auto-link but are noisier.
- **No file uploads from the agent reply path.** If the user needs a file (a guide, a brief, a CSV), publish it via `robin publish` and link the URL.
- **Embeds and rich attachments aren't wired up** for agent replies — text content only.

**Default (env unset):** Claude Code, Cursor, Gemini CLI, or another full agent host. `AskUserQuestion`, embeds, file references, the full UI all work — optimize for that surface and don't degrade to Discord-style plain prompts.

## Memory writes — resilient by design

`recordEvent` (the underlying writer for `remember`, `ingest`, `record_correction`, and the integrations) wraps embedding upserts in try/catch. If the embedder produces a vector that the active embedding table's schema rejects (profile mismatch, dimension mismatch, embedder unavailable), the event row is **still created** and the call returns success. The embedding failure is logged via `console.warn`. Recall by semantic search will be degraded until the profile mismatch is fixed and the row is back-filled, but writes never throw `InternalError` to MCP clients.

When you see `recordEvent: embedding failed for events:...` in `user-data/runtime/logs/daemon.log`, the fix is one of:
- `robin embeddings list` — check `active_profile` vs the config's `embedder_profile`
- `robin embeddings activate <profile>` — flip the active profile to match the loaded embedder
- `robin embeddings backfill <profile>` — re-embed events under the new profile

Don't "fix" embedding errors by reverting the try/catch — that re-introduces the user-visible `InternalError` for every memory write.

## Test scripts and writing performant tests

Test scripts in `package.json` (all use `--test-force-exit --test-timeout=20000 --test-concurrency=18`):

| Script | What it runs | When to use |
|---|---|---|
| `pnpm test` | Everything (`system/tests/**/*.test.js`) | Pre-commit / CI |
| `pnpm test:unit` | Just `system/tests/unit/**` | Validating logic changes |
| `pnpm test:integration` | Just `system/tests/integration/**` | Validating CLI / daemon flows |
| `pnpm test:fast` | Unit suite with `ROBIN_SKIP_SLOW=1` (skips embedder + install tests) | Inner-loop iteration; ~5s |
| `pnpm test:watch` | Unit suite in watch mode | TDD on a single file |
| `pnpm test:file <path>` | One or more named files | Focused single-file run |

`test:fast` is the right default for inner-loop work — it skips the ~6 tests that load the mxbai-1024 embedder or run the full install flow (each ~1s) and finishes in ~5s instead of ~6.5s.

**Rules for writing tests that stay fast**:

- **Never `setTimeout` without `.unref()`** unless you also `clearTimeout` on every code path. A 5-second pending timer in a test that asserts within 100ms is a 4.9-second handle leak. Without `--test-force-exit` the test runner waits for it; with `--test-force-exit` it just makes shutdown noisier.
- **Prefer `mock.timers`** over real `setTimeout(r, 200)` when the unit under test owns the timer. `system/tests/integration/whoop-quiet-window.test.js` shows the pattern (`mock.timers.enable({ apis: ['Date'], now: ... })`). Real `await sleep(N)` is only acceptable when the code under test schedules a timer through APIs you don't control.
- **Skip slow tests behind `ROBIN_SKIP_SLOW`** when they cost >300ms and exist to verify real model loading, real install flows, or real subprocess spawning. The pattern is `test('...', { skip: process.env.ROBIN_SKIP_SLOW === '1' }, async () => {...})`. The CI/full `pnpm test` still runs them.
- **Don't spawn the CLI as a subprocess from a unit test.** Each `node`/`robin` subprocess on macOS costs ~150ms. If you're spawning to test logic, refactor the logic out and call the function directly. Subprocess tests belong in `system/tests/integration/`.
- **Use `mem://` for SurrealDB unit tests.** It's the only embedded engine fast enough for per-test setup; `rocksdb://` and `surrealkv://` write to disk and are an order of magnitude slower. Always pair every `connect({engine:'mem://'})` with `await close(db)` at the end of the test — the NAPI engine leaks threadsafe handles without it (see the `--test-force-exit` note below).
- **Avoid `beforeEach` setup that allocates a real DB or model** when test bodies can share fixtures. Each fresh `mem://` connection costs ~30ms; multiplied across hundreds of tests this dominates wall time. Prefer a single `before` hook + per-test transactions or unique IDs.
- **Don't leak `setInterval` past `stop()`**. Tests calling `sched.start()` must call `sched.stop()` (or assert via mock timers). `setInterval` handles without `.unref()` keep the process alive.
- **Cap polling loops at the tightest interval that's not flaky** — 50ms is plenty in this repo; 100ms is the upper bound. Anything higher just inflates the slowest test on a fast machine.

## Recurring bugs not covered by invariants

**First-line diagnostic for anything Robin-shaped: `robin doctor`.** Surfaces install-pointer state, daemon pid + port, native-binding ABI, supervisor status, recent biographer.log errors, per-integration freshness in one pass. Flags: `--lint-hooks`, `--purge-stale-sessions`, `--rebaseline`, `--invariants` (registry status with remediation).

**For DB auth flapping, install-pointer disappearance, MCP wiring drift, integration freshness, Lunch Money dupes, pnpm/Node ABI mismatch, orphan `node --test` procs, stuck `in_flight=true`, hooks-settings missing, v2 MCP not exposed — see `RUNBOOK.md`.** Those are managed as operational invariants with auto-repair; the runbook has full symptom/cause/fix entries.

The entries below are *not* invariants — keep them in CLAUDE.md so the agent recognizes the symptom in-context:

### ESM cache pins job code until daemon restart

**Symptom.** You edit `user-data/jobs/**/*.js` or `user-data/io/**/*.js`. Cron continues firing but captured rows still emit pre-edit chrome. Manual `robin jobs run <name>` matches disk; cron-fired rows don't.

**Cause.** Node's ESM cache pins imported modules for the daemon's lifetime. `runner.js` does `await import(modUrl)` once per job; subsequent invocations reuse the cached module.

**Fix.** Already shipped: `system/runtime/daemon/job-hot-reload.js` watches both dirs and SIGTERMs the daemon on debounced `.js` change; launchctl respawns with a fresh module graph. Disable with `ROBIN_DISABLE_HOT_RELOAD=1`. If symptoms recur, confirm `[hot-reload] watching <dir>` appears at boot in `user-data/runtime/logs/daemon.log`.

### `integration <name>: Cannot find module .../manifest.js` warnings for shared-code dirs

**Symptom.** Daemon boot log shows e.g. `integration discord: Cannot find module '.../system/io/integrations/discord/manifest.js'` and similar for `imessage` — even though both are working. `robin doctor` surfaces these as false breakage.

**Cause.** `system/io/integrations/discord/` and `/imessage/` hold *support code* (formatter, sender, allowlist, SQLite reader) that user-data integrations import from. They don't define an integration of their own — there's no `manifest.js` in those dirs.

**Fix.** Already shipped: `system/io/integrations/_framework/manifest-loader.js` checks `statSync` on `manifest.js` before attempting import. Dirs without `manifest.js` are silently skipped. Real failures still warn. Test coverage: `system/tests/unit/manifest-loader.test.js`.

### Hot-reload restarts daemon on phantom fsevents

**Symptom.** Daemon log shows `[hot-reload] user-data change detected (<file>) — restarting daemon` repeatedly for the same file the user never touched (often `lunch_money/invariants/no-dupes.js`). Each restart SIGTERMs mid-tick; long-running syncs (gmail first-sync, lunch_money 14-day window) never complete; `last_sync_at` never advances.

**Cause.** macOS fsevents (and Linux inotify under heavy IO) fires `change` events for atime-only writes, Spotlight indexing, antivirus scans. The hot-reload watcher used to fire on every event; debounce only coalesced bursts.

**Fix.** Already shipped: `system/runtime/daemon/job-hot-reload.js` keeps an in-memory `mtimes` Map seeded at startup; an event only fires `signalSelf` if `statSync(path).mtimeMs > mtimes.get(path)`. New files (mtime unknown) still fire so brand-new modules are picked up. Tests under `system/tests/unit/job-hot-reload.test.js`.

### `io.robin-assistant.mcp` plist KeepAlive loop

**Symptom.** `launchctl list io.robin-assistant.mcp` shows `LastExitStatus = 256` and pid `-`; log spams `daemon already running (pid N)` every ~10s.

**Cause.** `robin mcp start --foreground` used to exit 1 when another daemon owned the lock; KeepAlive respawned forever.

**Fix.** Already shipped: `system/runtime/cli/commands/mcp-start.js` catches `EALREADY`, attaches to the live daemon, returns 0. If it recurs, that catch was reverted.

### Concurrent-agent git-index race steals your commit message

**Symptom.** You ran `git add <my-files>` then `git commit -m "<my-message>"`. `git log` shows HEAD has your files **plus** an unrelated session's files, all under the other session's commit message.

**Cause.** Git's index lock serializes single commands but doesn't compose across two. Between your `git add` and `git commit`, another agent ran `git commit -am "<their-msg>"`. The `-a` flag auto-stages all modified tracked files and atomically commits everything in the index — including yours.

**Fix.** Prevent at write time; there's no clean post-hoc remediation.

- **Atomic single-command commits:** `git commit -m "msg" -- file1 file2 file3`. Stages and commits in one operation.
- **Never use `-a` or `-am`** in trees that may host concurrent agents.
- If two-step is unavoidable, run `git diff --cached --name-only` before and `git show HEAD --stat` after. If the post-commit diff is wider than expected, do NOT push.
- For invasive multi-file work, use a git worktree (`git worktree add ../robin-feat-X`) and operate via `git -C ../robin-feat-X …`.
- **Commit work-in-progress promptly when concurrent agents are active.** Uncommitted working-tree edits can be wiped by another session's reset/stash flow even when the index race itself doesn't fire.

## Operational invariants

The auto-generated symptom/cause/fix runbook lives in [`RUNBOOK.md`](./RUNBOOK.md) (regenerated by `robin doctor --emit-runbook --write`). When a symptom matches one of the categories listed above, jump straight there for the canonical fix.
