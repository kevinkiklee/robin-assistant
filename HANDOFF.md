# User-data isolation — handoff

**Branch:** `feat/user-data-isolation` (this worktree)
**Base:** `main` at `190bb1d`
**Spec:** `docs/superpowers/specs/2026-05-10-robin-v2-user-data-isolation-design.md` (`6bcdf96`)
**Plan:** `docs/superpowers/plans/2026-05-10-robin-v2-user-data-isolation.md` (`57dd8db`)

## Status

All 32 plan tasks complete across 36 commits. 166 files changed (+2,438 / -8,104 net — the larger deletion count reflects consolidation of `installed-hooks.json`, `hooks-disabled.txt`, and stale `~/.robin` code paths into the unified `host-integrations.json` manifest).

- 37/37 isolation-specific tests pass (data-store, manifest, install-first/existing/legacy/kevin-rollout, interrupt-safety, reinstall-discovery, migrate-home, legacy-installed-hooks, relocate, doctor-drift, uninstall-best-effort, audit-no-tilde-robin, audit-user-data-construction).
- 806/816 in the broader unit suite — the 10 failures are all pre-existing `ERR_MODULE_NOT_FOUND` errors (`bash-policy.js`, `tamper-check.js`, `step-corrections.js`, `intuition` handlers) confirmed present on `main` before this work began.
- Lint: 0 errors in code paths touched by this work.

## What got built

1. **`src/runtime/data-store.js`** — sole resolver. `paths.data.*` (under `<robin-home>/`) and `paths.source.*` (under package root). Strict `robinHome()` with no silent fallback. `.robin-data` marker. `.robin-home` pointer (in package root). `recordHostTouchpoint` / `readHostIntegrations` / `forgetHostTouchpoint` with `.manifest.lock` flock and replace-by-`(kind, path)` semantics. Legacy `installed-hooks.json` migrated read-side on first manifest write.

2. **Interactive picker** in `robin install` — four options (package_root/user-data, `~/.robin`, `~/Documents/Robin`, custom). Discovery scans known locations on reinstall. Existing-data migration prompt with copy-verify-delete (never `fs.rename`). `--home`, `--relocate`, `--repair` flags.

3. **`bin/robin-hook.sh`** — unchanged (pure passthrough; no resolver in shell).

4. **launchd plist + systemd unit** — bake `ROBIN_HOME=<home>` and log path `<home>/cache/logs/daemon.log`. Recorded in the manifest with `expectedHome`.

5. **Hook installers (Claude/Gemini settings, git pre-commit, MCP plist/systemd)** — all route writes through `recordHostTouchpoint`. The legacy `installed-hooks.json` and `hooks-disabled.txt` flag file are folded into the unified manifest / `config.json.hooks.disabled`.

6. **`robin uninstall`** — manifest-driven, best-effort by default, `--strict` aborts on first failure, `--purge` removes home dir. OS-aware daemon stop via `launchctl bootout` / `systemctl stop` from the manifest.

7. **`robin doctor`** — new `Data section` reports home resolution, env/pointer mismatch, manifest health, and drift on host-integration entries (missing files, missing commands, `expectedHome` divergence).

8. **Audit tests** — `tests/unit/audit-no-tilde-robin.test.js` and `audit-user-data-construction.test.js` enforce no source file references `~/.robin` or constructs `user-data` paths outside the allow-list.

## Rollout (operator work — when you're ready)

Per spec §14, this is a one-merge / one-install cutover. **Do this in order**:

```bash
# 1. Stop the running daemon (so it doesn't hook-loop against the new strict CLI during the install window).
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/io.robin-assistant.mcp.plist
#   (or on Linux: systemctl --user stop robin-mcp.service)

# 2. Merge the feature branch.
cd /Users/iser/workspace/robin/robin-assistant-v2
git merge feat/user-data-isolation
#   (or: open a PR with `gh pr create` if you want a review surface first)

# 3. After merge: the next `robin <anything>` will fail with
#    "Robin is not installed. Run: robin install"
#    Run install once.
robin install

#    The picker scans known locations. <package_root>/user-data/ is discovered as a
#    legacy v2 layout (it has db/CURRENT and secrets/.env from your current state).
#    Pick option 1 to keep data in place, or option 3 to move to ~/Documents/Robin.
#    Install drops the marker, writes .robin-home, rewrites the plist with the baked
#    ROBIN_HOME, populates host-integrations.json from your installed-hooks.json
#    via the read-side migration.

# 4. Verify.
robin doctor   # should report no drift; daemon back up; logs at <home>/cache/logs/daemon.log
```

## What I did NOT do (deliberately)

- **Did not push** to remote.
- **Did not merge** into main.
- **Did not stop your running daemon** — that would have killed your live system while you slept.
- **Did not touch the `package-lock.json` modification** in the main worktree (it's a version-string sync from `npm install`; unrelated to this work).
- **Did not delete the worktree** — it's clean and ready for you to inspect.

## Worktree

`/Users/iser/workspace/robin/robin-assistant-v2-worktrees/isolation` on branch `feat/user-data-isolation`. Remove with `git worktree remove` once you've merged or decided to discard.

## Known concerns flagged during execution

- **Per-phase hooks-disabled → global boolean** (Task 6.2): the previous `hooks-disabled.txt` could selectively disable a single phase (e.g. just `bash-policy`); the new `config.json.hooks.disabled` is all-or-nothing. The spec was explicit about this (`hooks.disabled === true`), but it's a real behavior change. If per-phase disable matters, it's a follow-up.

- **`renameSync` invariant** in `data-store.js`: count is exactly 2 (`writePointer` and `writeManifestAtomic`, both single-file atomic replaces). The audit test asserts this; future additions of `fs.rename` will fail loudly.

- **Pre-existing test failures**: 10 `ERR_MODULE_NOT_FOUND` failures in the unit suite are unrelated to this work — they reference modules that don't exist in `main` either (`bash-policy.js`, `tamper-check.js`, `step-corrections.js`, `intuition` handlers). Worth a separate cleanup pass.

- **One pre-existing integration test is flaky** (`multi-instance.test.js`, "daemon did not start" timing issue) — also unrelated.
