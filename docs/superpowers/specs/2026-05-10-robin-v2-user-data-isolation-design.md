# Robin v2 — User data isolation

**Status:** Design (pre-implementation)
**Date:** 2026-05-10
**Predecessors:** v1 `robin-assistant/` (kept user data in `<repo>/user-data/`, gitignored, single folder). Phase 4d (jobs) shipped on `v6.0.0-alpha.9` with `src/runtime/home.js` centralizing data paths; this design extends that seam.
**Phase note:** Cross-cutting cleanup, not a new feature. Tightens the data/host boundary the codebase already half-implements.

---

## 1. Goal

Every file Robin writes lives in exactly one of two well-defined places:

1. **Owned data** — under a single configurable `<robin-home>/` directory. Chosen at install time, never committed.
2. **Tracked host touch-points** — files outside `<robin-home>/` that Robin modifies (host CLI settings, OS service registrations, git hooks), each recorded in a manifest *inside* `<robin-home>/`.

Clean separation for user UX (one folder to back up, move, or wipe) and dev DX (one seam to read from; one place where forbidden path strings can hide).

## 2. Out of scope

- Encryption at rest. Filesystem-level encryption (FileVault / LUKS) continues to be the only confidentiality story.
- Multi-user / multi-tenant Robin. One human, one home.
- Cross-machine sync. The home is local; how it's backed up is the user's call.
- Read-only sources (Chrome history, Calendar, etc.). Robin already reads these from OS paths; not Robin's data, not in the manifest.
- Log rotation policy. `cache/logs/daemon.log` grows unbounded; rotation is a follow-up.

## 3. The boundary

Three categories, defined by who writes the file:

| Category | Examples | Lives where | Tracked? |
|---|---|---|---|
| **(1) Owned data** | `db/`, `secrets/.env`, `cache/`, `backup/`, `upload/`, `config.json`, daemon log, manifests, daemon lock | `<robin-home>/` | implicit (whole dir) |
| **(2) Host touch-points** | `~/.claude/settings.json`, `~/.gemini/settings.json`, `~/Library/LaunchAgents/io.robin-assistant.mcp.plist`, `~/.config/systemd/user/robin-mcp.service`, `<repo>/.git/hooks/pre-commit` | OS-required paths | `<robin-home>/host-integrations.json` |
| **(3) Read-only sources** | Chrome history, Spotify cache, etc. | Wherever the OS / app puts them | not tracked |

Rule: every Robin write is either (1) or (2). Category (2) writes go through a single helper that records the touch-point after the write succeeds.

## 4. Resolution chain

`bin/robin` (CLI) and the daemon (Node, spawned by launchd/systemd) both call a single `robinHome()`. `bin/robin-hook.sh` is a pure passthrough — it execs `node bin/robin <subcommand>` and never resolves the home itself; the resulting Node process does. So there is exactly one resolver, in one language.

Order, with explicit failure semantics — **no silent fallback ever**:

```
$ROBIN_HOME set?
  └─ yes → resolve, validate path exists. Use it.
$ROBIN_HOME unset, <package_root>/.robin-home exists?
  └─ yes → parse JSON, validate target exists.
            target missing → HARD ERROR:
              "user-data path X recorded in .robin-home is missing.
               Run: robin install --relocate"
            target ok      → use it.
$ROBIN_HOME unset AND .robin-home missing?
  └─ HARD ERROR: "Robin is not installed. Run: robin install"
```

The pre-existing implicit `<package_root>/user-data/` default is removed at runtime. It survives only as the picker's default radio option (option 1).

**Install is the one resolver bypass.** `robin install` cannot call `robinHome()` at startup — by definition, on a first install, neither `$ROBIN_HOME` nor `.robin-home` is set, and the strict resolver would error with "Robin is not installed." Instead, install drives its picker/discovery first, then writes `.robin-home` (§9.2 step 7), and only then may it (or anything else) call `robinHome()` normally. All other commands take the strict path. The CLI dispatcher in `src/cli/index.js` enforces this: it does not eagerly resolve `robinHome()` before dispatching; commands opt in.

**`ensureHome()` runs on every successful resolve.** After `robinHome()` returns a valid path, the entry-point wrapper calls `ensureHome()`, which idempotently creates any missing `paths.data.*` subdirs and re-writes the `.robin-data` marker if absent. Cheap (a few `mkdir -p` stat calls) and corrects accidental hand-deletions of `cache/` etc. without a re-install.

**`$ROBIN_HOME` escape hatch** applies to the current process only — it does not propagate to the daemon (which uses the home value baked into its plist/systemd unit at install time). `robin doctor` warns when `$ROBIN_HOME` is set in the shell and disagrees with `.robin-home`.

**Invariant: `.robin-home` is the single source of truth.** The launchd plist and systemd unit are denormalized caches of it; every install/relocate rewrites them in sync. Doctor cross-checks.

## 5. The seam

A single module `src/runtime/data-store.js` (renamed from `home.js` — not "evolving"). Nothing else constructs `<robin-home>` or `<package_root>` paths for data purposes.

```
┌──────────────────────────────────────────────────────────┐
│  src/runtime/data-store.js                               │
│  ─ robinHome()              resolution + validation      │
│  ─ paths.data.{db, secrets, cache, logs, backup, upload, │
│                config, hostIntegrations, daemonState,    │
│                daemonLock, manifestLock, marker}         │
│  ─ paths.source.{migrations, hookShim, robinBin}         │
│  ─ ensureHome()             mkdir tree + write marker    │
│  ─ recordHostTouchpoint(entry, writeFn)                  │
│  ─ readHostIntegrations()                                │
│  ─ forgetHostTouchpoint({kind, path})                    │
└──────────────────────────────────────────────────────────┘
        ▲                                  ▲
        │ owned-data reads/writes          │ wraps every host write
        │                                  │
   db, secrets, cache,               install/mcp-install, hooks-settings,
   backup, logs, manifests           pre-commit, launchd-plist, systemd-unit
```

`paths.data.*` is rooted at `<robin-home>/`. `paths.source.*` is rooted at `packageRoot()`. They never overlap and are not interchangeable. A unit test asserts the split.

## 6. On-disk layout

```
<robin-home>/
  db/                       SurrealDB / RocksDB files
  secrets/.env              mode 0600
  cache/logs/daemon.log     rotation TBD
  cache/<other transient>/
  backup/                   snapshot tarballs (db/backup.js)
  upload/                   user-staged input files
  config.json               mode 0644 — { hooks: { disabled: bool }, … }
  host-integrations.json    NEW — every category-(2) touch-point
  .robin-data               sentinel marker — { version, createdAt }
  .daemon.state             daemon pid/port/socket
  .daemon.lock              daemon single-instance lock
  .manifest.lock            NEW — flock guard for manifest writes
```

Notes:

- `daemon.log` derives from `<robin-home>/cache/logs/daemon.log` at install time; the stale `~/.robin/logs/` literal in `launchd-plist.js` is removed.
- The stray `user-data/hooks-disabled.txt` flag file is folded into `config.json` as `{ hooks: { disabled: true } }`.
- `installed-hooks.json` (legacy) is migrated on first read of `host-integrations.json` and deleted in the same atomic write — no dual-write window.

## 7. Pointer file (`<package_root>/.robin-home`)

```jsonc
{
  "version": 1,
  "home": "/Users/iser/Documents/Robin",   // absolute, must exist
  "installedAt": "2026-05-10T19:30:00Z",
  "installedBy": "robin install v6.0.0-alpha.9"
}
```

- Added to `.gitignore`.
- Unknown `version` is a hard error on read.
- Shares its `version` integer with the `.robin-data` marker — they represent the same on-disk layout version and bump in lockstep.

## 8. Host-integrations manifest (`host-integrations.json`)

Flat, kind-tagged, versioned. One file per home.

```jsonc
{
  "version": 1,
  "updatedAt": "2026-05-10T19:30:00Z",
  "entries": [
    { "kind": "claude-hooks",
      "path": "/Users/iser/.claude/settings.json",
      "owned": [
        { "phase": "PreToolUse", "matcher": "Bash",
          "command": "/abs/path/bin/robin-hook.sh bash-policy" },
        { "phase": "UserPromptSubmit", "matcher": null,
          "command": "/abs/path/bin/robin-hook.sh auto-recall" }
      ],
      "installedAt": "2026-05-10T19:30:00Z" },

    { "kind": "gemini-hooks",
      "path": "/Users/iser/.gemini/settings.json",
      "owned": [ /* … */ ],
      "installedAt": "…" },

    { "kind": "launchd-plist",
      "path": "/Users/iser/Library/LaunchAgents/io.robin-assistant.mcp.plist",
      "createdAt": "…",
      "expectedHome": "/Users/iser/Documents/Robin",
      "label": "io.robin-assistant.mcp" },

    { "kind": "systemd-unit",
      "path": "/Users/iser/.config/systemd/user/robin-mcp.service",
      "createdAt": "…",
      "expectedHome": "…",
      "unit": "robin-mcp.service" },

    { "kind": "git-precommit-hook",
      "path": "/repo/.git/hooks/pre-commit",
      "installedAt": "…",
      "marker": "robin pre-commit run" }
  ]
}
```

Shape rationale:

- **Flat array, kind-tagged.** Iteration order = install order; reverse for uninstall.
- **`expectedHome` on plist/systemd.** Lets doctor detect drift after manual edits or out-of-band relocates.
- **No file contents copied in.** Only paths and Robin's claim about what it owns inside each file. Host files may contain unrelated config; none of that is mirrored.
- **Versioning.** Future migrations bump `version`; readers fail closed on unknown values.

### Helper API contract

```js
recordHostTouchpoint(entry, writeFn)
  // 1. Acquire <robin-home>/.manifest.lock (flock; 5s timeout).
  // 2. Call writeFn() — the actual host-file write.
  //    Throws → release lock, propagate; manifest untouched.
  // 3. On success, read manifest, REPLACE any entry matching
  //    (entry.kind, entry.path) with the new entry, atomic temp+rename,
  //    release lock.
  // Replace-by-(kind, path), not merge. Caller passes the full new state
  // for that touch-point.

readHostIntegrations() -> { version, updatedAt, entries: [...] }
  // On entry, if installed-hooks.json exists and host-integrations.json
  // does not, fold the legacy file in and delete it in the same locked
  // transaction.

forgetHostTouchpoint({ kind, path }) -> { removed: 0|1 }
  // Same lock; idempotent.
```

Concurrent writers (daemon vs install vs hook firing) serialize on `.manifest.lock`. Read-only consumers don't take the lock.

## 9. Install flow

`robin install` is the single entry point for choosing or changing the data location.

### 9.1 Picker UX (first install, TTY)

```
Welcome to Robin. Where should Robin store your data?

  (1) Inside the package        /Users/iser/workspace/.../robin-assistant-v2/user-data
      (note: moves with the package directory)
  (2) Hidden in your home dir   /Users/iser/.robin
  (3) Visible in Documents      /Users/iser/Documents/Robin
  (4) Custom path…

Choose [1-4, default 1]:
```

- Numbered prompt via `src/cli/prompts.js`'s new `radio()` helper. No TUI dependency.
- Custom path is `resolve()`d; parent must exist and be writable; target must be missing, empty, or contain `.robin-data` already. Anything else → reprompt with the specific error.
- Non-interactive (no TTY, or `--yes`): default option (1), unless `--home <path>` is passed.

### 9.2 First-install steps

1. Resolve target from picker or `--home`.
2. **Discover existing data** by scanning `<package_root>/user-data/`, `~/.robin/`, `~/Documents/Robin/`, plus any `--existing <path>`. A location counts as Robin data if it contains the `.robin-data` marker **or** matches the legacy v2 layout (`db/CURRENT` or `secrets/.env` present without a marker — handles Kevin's existing install).
3. If at least one location was found and the chosen target is different, prompt:

   ```
   Existing Robin data found:
     /Users/iser/workspace/.../user-data/   (legacy v2 layout, last modified 2026-05-09)
   What should we do?
     [m] move it to /Users/iser/Documents/Robin
     [c] copy it to /Users/iser/Documents/Robin (original kept)
     [i] ignore — start fresh; existing left untouched
     [a] abort
   Choose [m/c/i/a]:
   ```

   `du` runs with a 500ms cap; if slow, prompt shows "size unknown" rather than blocking.

4. **Move/copy is always copy-verify-delete** — never `mv`, never `fs.rename`. `cp -a` (preserves mode/owner/timestamps, critical for `secrets/.env` at 0600) → verify (`.robin-data` present at target, no copy errors) → only then `rm -rf` source. On any failure mid-copy (ENOSPC, permission denied, source disappeared, etc.): delete the *partial target*, leave source intact, single error.
5. Create the target tree (`mkdir -p` for each `paths.data.*`); write `.robin-data` marker (adding it on top of legacy data is part of the migration).
6. Run DB schema init/migrations against the new home. Migrations are idempotent; same code path covers first-init and upgrade.
7. Write `<package_root>/.robin-home` (atomic temp+rename).
8. Generate/write launchd plist and/or systemd unit, baking in the resolved home (`<home>/cache/logs/daemon.log` for the log path, `ROBIN_HOME=<home>` as an env on systemd). Record both via `recordHostTouchpoint`.
9. Install host hooks (Claude / Gemini settings) via `recordHostTouchpoint`.
10. Print a one-screen summary: home path, what was migrated, host files touched, next steps.

### 9.3 Reinstall recovery

Defined as: `robin install` invoked when `.robin-home` is missing or its target doesn't exist.

```
This Robin install has no recorded data location.
Scanning known locations…

Found:
  (1) /Users/iser/Documents/Robin           (Robin data, last used 2026-05-09)
  (2) /Users/iser/.robin                    (Robin data, last used 2026-04-22)
  (3) Set up fresh (show picker)
  (4) Enter a different path…

Choose [1-4]:
```

Selecting an existing path writes `.robin-home` and re-runs steps 6–9. Migrations are idempotent, so re-pointing at a prior install is safe. No matches → falls through to the first-install picker.

### 9.4 Relocate

`robin install --relocate <path>` (or interactive `robin install` when `.robin-home` is valid → confirm "you already have Robin at X; relocate?").

1. Validate target path same way as picker.
2. Offer copy-then-delete (move) or copy-keep-original (copy).
3. **Stop the daemon via the OS service tool**, not SIGTERM. If a launchd entry is in the manifest: `launchctl bootout gui/$(id -u) <plist>`. If a systemd entry: `systemctl --user stop <unit>`. Otherwise: fall back to pid in `paths.data.daemonState` and SIGTERM. 5s wait; if not down, abort with instructions.
4. Copy-verify-delete the home.
5. Update `.robin-home`.
6. Rewrite launchd plist and systemd unit with the new path. In **one** `host-integrations.json` transaction (single lock acquisition), refresh `expectedHome` on every entry that has it.
7. Restart the daemon via `launchctl bootstrap` / `systemctl --user start`.

### 9.5 Non-interactive / scripted install

- `--home <path>` — skip picker; use this path.
- `--yes` — accept defaults at every prompt.
- `--on-existing=move|copy|ignore|abort` — non-interactive answer; default `abort`.
- `--existing <path>` — declare a known prior install location; bypasses scanning.
- `--force` — only meaningful with `--on-existing=ignore`; required when the target has non-Robin contents. The non-force error message includes the target path and a summary of what's there, so the user can decide whether `--force` is appropriate.

### 9.6 Failure modes addressed

- Picker user types a path whose parent doesn't exist → "parent dir must exist; create it first?" reprompt.
- Partial copy mid-flight → partial target deleted, source intact, single error, `.robin-home` unwritten.
- Cross-filesystem target → safe by construction (`cp -a` + verify + `rm -rf source`; never `rename()`).
- Target has Robin layout from a different schema/marker version → version check; abort with upgrade instructions.
- Daemon won't stop within 5s during relocate → abort, leave `.robin-home` and home dir untouched.
- `--force` on a target with foreign contents → write proceeds; foreign files left in place alongside Robin's; manifest records what Robin created so uninstall is still precise.
- User Ctrl-C anywhere between steps 5–9 → re-running install discovers the partial state and completes (interrupt-safe).

## 10. Uninstall

Best-effort by default; `--strict` aborts on the first per-entry failure.

1. **Stop the daemon first** via the OS service tool (same logic as 9.4 step 3). If the daemon won't stop, abort.

   Edge case: `<robin-home>/` is missing (user `rm -rf`'d it before running uninstall). The manifest is gone too, so uninstall can't iterate touch-points. Fallback: uninstall greps the same well-known host paths the install touches (`~/.claude/settings.json`, `~/.gemini/settings.json`, `~/Library/LaunchAgents/io.robin-assistant.*`, `~/.config/systemd/user/robin-*`) for the shim-path prefix and removes matches best-effort — the same scan-and-prefix-match the existing `uninstallHooksFromSettings()` already does when its manifest is missing. After the scan, uninstall reports any host paths it touched. Pre-commit hooks in arbitrary repos can't be discovered without the manifest; those are listed as "may still exist" in the final summary so the user can clean them up manually.
2. Walk `host-integrations.json` entries in **reverse-install order**. For each entry, **do the host work first, then update the manifest**:

   ```
   try:
       switch entry.kind:
         case "claude-hooks" | "gemini-hooks":
             remove only the recorded `owned` items from host settings,
             atomic-write. If host file is malformed JSON: warn, leave it.
         case "launchd-plist":
             launchctl bootout gui/$(id -u) <plist>  (best-effort)
             unlink the plist file.
         case "systemd-unit":
             systemctl --user disable --now <unit>   (best-effort)
             unlink the unit file
             systemctl --user daemon-reload
         case "git-precommit-hook":
             unlink only if file still contains the recorded marker.
   except as err:
       warn(err); continue          (best-effort)
       in --strict: abort with partially-removed list.

   forgetHostTouchpoint(entry)      (only after host work)
   ```
3. Prompt about `<robin-home>/` itself:

   ```
   Robin's data folder is at /Users/iser/Documents/Robin (~140MB).
   What should we do with it?
     [k] keep    (default — you can reinstall later and point at it)
     [r] remove  (irreversible)
   Choose [k/r]:
   ```

   `--yes` keeps. `--purge` is the only non-interactive way to remove; if the home dir is missing, `--purge` is a no-op with a one-line note.
4. Unlink `<package_root>/.robin-home`. Stale `~/.robin/db data preserved…` strings in `cli/commands/uninstall.js` are replaced with the actual resolved path printed before removal.

## 11. Doctor

`robin doctor` gains a `data` section:

- **Home resolution** — print resolved path, resolution source (`$ROBIN_HOME` / `.robin-home`), and `.robin-data` marker version. Warn if `$ROBIN_HOME` is set in the shell and disagrees with `.robin-home`.
- **Home contents** — every `paths.data.*` target exists; `secrets/.env` mode is 0600; `.manifest.lock` exists or can be created.
- **Manifest health** — `host-integrations.json` parses; `version` is supported; for every entry: target file exists, content cross-check. Hook entries: target settings file parses cleanly *and* the recorded `command` is present. Plist/systemd: recorded `expectedHome` matches `.robin-home`. **A malformed host file is reported as drift, not a crash.**
- **Drift list** — for each divergence, a one-line fix suggestion (`robin install --repair` for things repair handles; `robin install --relocate <path>` for `expectedHome` drift; manual guidance for foreign-content cases).
- **Audit invariant** — `doctor --strict` runs the static audit (§13). If no source tree is present (npm-installed), prints `audit skipped: no source tree at <package_root>/src` and exits the audit step with a neutral status — never silently passes.

## 12. `robin install --repair`

Re-applies install steps for entries whose drift `doctor` detected, without changing `.robin-home`. Shares install's safety rules:

- Refuses to write into a host file that doesn't parse.
- Never overwrites foreign content.
- Failures are reported per entry; clean entries unaffected.

## 13. Static audit (tests)

Two cheap regression guards as unit tests; run in CI in under a second.

- **`tests/unit/audit-no-tilde-robin.test.js`** — greps `src/` and `scripts/` for `~/.robin`, `/.robin/`, and `homedir() + '.robin'`-style constructions. Allow-list:
  - `src/cli/commands/install.js` (legacy-v1 detection block),
  - `src/migrate-v1/*.js`.

  `scripts/dev-recall.js` is **not** allow-listed; the file is actually changed to call the new resolver.

- **`tests/unit/audit-user-data-construction.test.js`** — scoped to JS path construction, not free text. Patterns: `join\([^)]*['"]user-data['"]`, `path\.resolve\([^)]*['"]user-data['"]`. Allowed only in:
  - `src/runtime/data-store.js`,
  - `src/cli/commands/install.js` (picker default),
  - `src/migrate-v1/*.js`,
  - `src/hooks/bash-patterns.js` (matches *runtime* paths in user shell commands, not Robin's own writes).

  Docs/README/CHANGELOG out of scope — the audit reads JS, not prose.

`doctor --strict` reuses the same code, gated behind source-tree presence.

## 14. Rollout

**One change, one install.** No feature flag, no two-release migration.

1. **Before merging**, stop the running launchd daemon: `launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/io.robin-assistant.mcp.plist`. (Linux equivalent: `systemctl --user stop robin-mcp.service`.) This prevents the in-flight daemon — running old code — from spawning hook subprocesses that hit the new strict resolver and error in a tight loop while Kevin is mid-install.
2. Land the entire design as a single change set: `data-store.js` rename, marker, manifest, picker, discovery (which accepts both `.robin-data` markers *and* legacy v2 layouts), strict resolution chain, audit tests.
3. After merge, the next `robin <anything>` invocation hits the new strict resolver and fails with the documented "Robin is not installed. Run: robin install" error. Existing data untouched. Host CLI hooks (Claude / Gemini) will also error if fired in this window — expected, brief.
4. Run `robin install`. Discovery sees `<package_root>/user-data/` as a legacy v2 layout, offers it as a recovery option. Pick it (stay in place) or pick option 3 (move to `~/Documents/Robin`). Install drops the marker, writes `.robin-home`, rewrites and reloads plist/systemd, populates `host-integrations.json` from the existing `installed-hooks.json` via the read-side migration. The daemon comes back up under the new code, pointed at the chosen home.

## 15. File-level change list

### New files

- `src/runtime/data-store.js` — supersedes `home.js`. Exports above.
- `tests/unit/data-store.test.js`, `tests/unit/manifest.test.js`, `tests/unit/prompts-radio.test.js`, `tests/unit/audit-no-tilde-robin.test.js`, `tests/unit/audit-user-data-construction.test.js`.
- `tests/integration/install-first.test.js`, `install-existing-data.test.js`, `install-legacy-data-without-marker.test.js`, `install-existing-data-failure.test.js`, `install-kevin-rollout.test.js`, `relocate.test.js`, `reinstall-discovery.test.js`, `uninstall-best-effort.test.js`, `doctor-drift.test.js`, `interrupt-safety.test.js`, `legacy-installed-hooks.test.js`.

### Modified

- `src/cli/commands/install.js` — picker, discovery (marker + legacy heuristics), migration prompt, write `.robin-home`, drive `recordHostTouchpoint` from each sub-step. Hosts `--relocate` and `--repair` flags.
- `src/cli/commands/uninstall.js` — daemon stop, manifest-driven walk, best-effort default + `--strict`, replace stale strings.
- `src/cli/commands/doctor.js` — new `data` section; drift list; `--strict` audit hook.
- `src/cli/index.js` — route `install --relocate` and `install --repair`.
- `src/cli/prompts.js` — add `radio()`.
- `src/install/launchd-plist.js` — bake home from resolved value; logs at `<home>/cache/logs/daemon.log`; drop `~/.robin/logs/` strings.
- `src/install/systemd-unit.js` — `Environment=ROBIN_HOME=<home>`; logs to `<home>/cache/logs/daemon.log`.
- `src/install/hooks-settings.js` — write via `recordHostTouchpoint`; uninstall reads from unified manifest. Private `installed-hooks.json` writer removed; read-side migration in `readHostIntegrations()`.
- `src/install/pre-commit.js` — `recordHostTouchpoint`/`forgetHostTouchpoint` around hook writes/unlinks.
- `src/cli/commands/mcp-install.js`, `mcp-uninstall.js` — record/forget plist and systemd entries via the manifest.
- `src/cli/commands/mcp-start.js` — logs path from `paths.data.logs` (mostly already correct; one-line tidy).
- `src/db/backup.js`, `src/db/migrate.js`, `src/db/client.js`, every CLI command importing `paths` — change import path; behavior unchanged.
- `scripts/dev-recall.js` — actual code change: stop hardcoding `~/.robin`; call new resolver.
- `bin/robin-hook.sh` — no change needed; remains a pure passthrough to `node bin/robin <subcommand>`. The resolver lives only in Node.
- `.gitignore` — add `.robin-home`. (`.robin-data` is covered by `/user-data/` when home is the default; immaterial elsewhere.)

### Deleted / cleaned

- `user-data/hooks-disabled.txt` — folded into `config.json.hooks.disabled`.
- `installed-hooks.json` — auto-deleted on first manifest read.

## 16. Test strategy

### Unit

- `data-store.test.js` — resolution order; `$ROBIN_HOME` wins; missing `.robin-home` + no env throws documented error; `.robin-home` pointing at missing path throws; `paths.data.*` and `paths.source.*` are disjoint and not interchangeable. Asserts move helper has no `fs.rename`/`fs.renameSync` calls (cross-FS safety by construction).
- `manifest.test.js` — replace-by-`(kind, path)` not merge; writeFn throwing leaves manifest untouched; two simulated flock holders serialize; legacy `installed-hooks.json` migrates on first read and is deleted in the same write.
- `prompts-radio.test.js` — picker handles default, custom path, invalid input reprompt, non-TTY fallback.
- `audit-no-tilde-robin.test.js` and `audit-user-data-construction.test.js` — described in §13.

### Integration (tmpdir per test, real FS)

- `install-first.test.js` — picker options 1/2/3/custom each produce a valid layout, marker, baked plist/systemd, populated manifest.
- `install-existing-data.test.js` — pre-seed `<package_root>/user-data/` with marker, pick option 3, choose `move`: source gone, target valid, `secrets/.env` still 0600, db rows preserved.
- `install-legacy-data-without-marker.test.js` — pre-seed `<package_root>/user-data/` with `db/CURRENT` but no marker: discovery accepts it, install writes marker as part of migration. **Actual Kevin rollout case.**
- `install-existing-data-failure.test.js` — simulate ENOSPC mid-copy: source intact, partial target gone, exit non-zero, `.robin-home` unwritten.
- `relocate.test.js` — daemon stop honored, `expectedHome` refreshed in one transaction, baked plist updated.
- `reinstall-discovery.test.js` — seed layouts at two known locations, delete `.robin-home`, run install: scan finds both, picker offers them.
- `uninstall-best-effort.test.js` — malformed host file: uninstall completes (exit 0); `--strict` aborts (non-zero) after first failure.
- `doctor-drift.test.js` — hand-edit a host file to remove a Robin hook: doctor reports drift; `install --repair` restores it; foreign hooks untouched.
- `interrupt-safety.test.js` — kill the process between install steps 5–9; re-running install completes cleanly.
- `legacy-installed-hooks.test.js` — pre-seed `installed-hooks.json`, no `host-integrations.json`: first read produces unified manifest, legacy file gone.
- `install-kevin-rollout.test.js` — end-to-end simulation of the Kevin rollout: tmpdir contains a v2 layout at `<package_root>/user-data/` with populated `db/`, `secrets/.env` at 0600, and a populated `installed-hooks.json`; no `.robin-data` marker, no `.robin-home`. Run `robin install`; pick option 1 (stay in place). Verify: marker written, `.robin-home` written, `installed-hooks.json` is gone, `host-integrations.json` contains the migrated Claude/Gemini entries, `secrets/.env` mode preserved, db rows preserved, plist log path is now `<home>/cache/logs/daemon.log`.

## 17. Decisions locked

1. **Data location is configurable**, chosen interactively at install time. Default radio option: `<package_root>/user-data` (matches v1).
2. **Pointer lives in `<package_root>/.robin-home`.** Reinstall scans known locations and offers them.
3. **Migration when picker target differs from existing data:** detect & prompt (`move` / `copy` / `ignore` / `abort`).
4. **`installed-hooks.json` back-compat:** one-shot read-side migration, deleted in same atomic write.
5. **`hooks-disabled.txt` → `config.json.hooks.disabled`:** folded.
6. **Rollout:** single merge, no feature flag, `robin install` run once.
7. **Phase 1 scope:** `--repair` and `--relocate` both included.

## 18. Open questions / follow-ups (not blocking)

- Log rotation for `cache/logs/daemon.log`. Out of scope for this design.
- Backup retention in `backup/`. Out of scope.
- `robin doctor --strict` audit-grep behavior on the published npm package (no `src/` tree): currently reports "audit skipped". If we want a way to ship the audit results *with* the package, that's a follow-up.
- **Read-only package root** (e.g., `npm i -g` into a system path where the user can't write `<package_root>/.robin-home`). Not addressed in this design — the package-root pointer file presumes a writable checkout, which matches Kevin's current setup. If a future install case needs read-only support, the fallback is to write the pointer to `~/.config/robin/install.json` (XDG) / `~/Library/Application Support/Robin/install.json`. Adding that fallback later does not require changes to `.robin-home`'s schema or to consumers — only to the writer/reader pair in `data-store.js`.

---

**End of design.** Implementation plan to follow.
