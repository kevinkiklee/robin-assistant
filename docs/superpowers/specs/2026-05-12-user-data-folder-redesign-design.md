# user-data/ folder redesign

**Date:** 2026-05-12
**Status:** Draft — pending user review
**Scope:** Rationalize `<robin_home>/user-data/` so its layout mirrors the package's faculty precedent (`system/cognition · io · data · runtime`) while keeping every user-touchable surface at the root.

## Goal

Today's `user-data/` is hard to read. Six top-level files (mixed JSON + dotfiles), eleven sibling directories, and ad-hoc nesting that doesn't follow any visible rule (`runtime/state/`, `skills/external/`, `cache/logs/` mixing cache with append-only logs, an empty `backup/`, etc.). The goal is a layout where:

1. **One look at the root tells you what to touch.** User-content directories and `config/` are at the top; internal state is under four named realm directories.
2. **Internal layout mirrors `system/`.** A reader who knows the package code can predict where data lives: `system/io/publish/` ↔ `user-data/io/publish/`; `system/runtime/daemon/` ↔ `user-data/runtime/daemon/`.
3. **No file is in two reasonable places.** Today the daemon's pid is at the root, its status is in `runtime/state/`, and its log is in `cache/logs/`. After: all three live under `runtime/daemon/` and `runtime/logs/`.

## Non-goals

- **No schema or DB layout changes.** `data/db/` keeps its internal RocksDB shape (`manifest/`, `sstables/`, `vlog/`, `wal/`).
- **No new file purposes.** Every file maps 1:1 to an existing target path. (Exception: the install marker, today `/.robin-data`, gains two layout-version fields when the migrator writes it at its new path — see §migration.)
- **No retroactive cleanup of past v1-import reports** beyond moving them. Their content is preserved.
- **No change to package skeleton, CLAUDE.md, or AGENTS.md text** except where they cite a moved path.
- **No content split.** `config.json`'s schema and `secrets/.env` format are unchanged; we only move the files.

## Final layout

```
user-data/
│
├── artifacts/                       # markdown working docs (user reads/edits)
├── jobs/                            # job overrides (user authors)
├── skills/                          # external skills (was skills/external/)
│   ├── INDEX.md
│   ├── article-extractor/
│   ├── deep-research/
│   ├── docx/
│   ├── pdf/
│   ├── pptx/
│   ├── xlsx/
│   └── youtube-transcript/
├── sources/                         # text inputs to ingest
│   ├── articles/
│   ├── documents/
│   └── notes/
├── upload/                          # binary drops for io integrations
│   ├── processed/
│   ├── style/
│   └── <Photos-*, letterboxd-*.csv, ...>/
├── config/                          # all configuration
│   ├── config.json
│   └── secrets/
│       └── .env                     # 0600
│
│  ── faculty realms (internal — Robin's state) ──
│
├── cognition/
│   └── reinforcement-last-run.json
├── io/
│   ├── publish/
│   │   └── index.jsonl
│   └── sqlite-snapshots/            # cached snapshots of external sqlite DBs
│                                    # (Apple Photos library, iMessage, etc.) —
│                                    # shared by lrc + chrome integrations
├── data/
│   ├── db/                          # RocksDB store (interior unchanged)
│   └── snapshots/                   # Robin DB pre-migration backups only
└── runtime/
    ├── logs/
    │   ├── biographer.log
    │   ├── daemon.log
    │   ├── publish.log
    │   └── surreal.log
    ├── daemon/
    │   ├── status.json
    │   ├── .pid
    │   ├── .state
    │   └── .lock
    └── install/
        ├── manifest.json
        ├── .manifest.lock
        ├── host-integrations.json
        ├── .marker.json
        └── reports/
            └── v1-import-*.json
```

**Root count:** 10 entries (5 user-content dirs + `config/` + 4 faculty realms), down from 17 today.

## Path migration table

Every file/directory in today's `user-data/` maps to exactly one new path.

### User-content (already at root; minor changes only)

| Today | After | Note |
|---|---|---|
| `artifacts/` | `artifacts/` | unchanged |
| `jobs/` | `jobs/` | unchanged |
| `skills/external/<name>/` | `skills/<name>/` | `external/` collapsed; INDEX.md moves up too |
| `skills/external/INDEX.md` | `skills/INDEX.md` | |
| `sources/articles/` | `sources/articles/` | unchanged |
| `sources/documents/` | `sources/documents/` | unchanged |
| `sources/notes/` | `sources/notes/` | unchanged |
| `sources/media/` | *(deleted)* | currently empty; binary media lives in `upload/` |
| `upload/Photos-3-001/` | `upload/Photos-3-001/` | unchanged |
| `upload/style/` | `upload/style/` | unchanged |
| `upload/processed/` | `upload/processed/` | unchanged |

### Config & secrets

| Today | After |
|---|---|
| `config.json` | `config/config.json` |
| `secrets/.env` | `config/secrets/.env` |

`config/secrets/.env` keeps the 0600 file mode that `system/config/secrets.js` enforces today (via `chmodSync(path, 0o600)` on every write). The dir mode is not currently enforced and stays unchanged.

### Cognition realm

| Today | After |
|---|---|
| `runtime/state/recall-reinforce-last-run.json` | `cognition/reinforcement-last-run.json` |

### Io realm

| Today | After |
|---|---|
| `runtime/state/published/index.jsonl` | `io/publish/index.jsonl` |
| `runtime/state/published/` (dir) | `io/publish/` |
| `cache/sqlite-snapshots/` | `io/sqlite-snapshots/` (external-DB caches owned by `system/io/integrations/{lrc,chrome}/sync.js`; distinct from Robin DB snapshots) |

### Data realm

| Today | After |
|---|---|
| `db/` (including `db/LOCK` and all child dirs) | `data/db/` |
| `backup/` | `data/snapshots/` (currently empty; reserved for `robin migrate` Robin-DB snapshots via `data/db/backup.js`) |

### Runtime realm

| Today | After |
|---|---|
| `cache/logs/biographer.log` | `runtime/logs/biographer.log` |
| `cache/logs/daemon.log` | `runtime/logs/daemon.log` |
| `cache/logs/surreal.log` | `runtime/logs/surreal.log` |
| `runtime/state/telemetry/publish.log` | `runtime/logs/publish.log` |
| `runtime/state/daemon-status.json` | `runtime/daemon/status.json` |
| `/.daemon.pid` | `runtime/daemon/.pid` |
| `/.daemon.state` | `runtime/daemon/.state` |
| `/.daemon.lock` | `runtime/daemon/.lock` |
| `/manifest.json` | `runtime/install/manifest.json` |
| `/.manifest.lock` | `runtime/install/.manifest.lock` |
| `/host-integrations.json` | `runtime/install/host-integrations.json` |
| `/.robin-data` | `runtime/install/.marker.json` |
| `cache/v1-import-report-*.json` | `runtime/install/reports/v1-import-*.json` |

### Disappearing top-level dirs

- `cache/` — split into `runtime/logs/`, `data/snapshots/`, and `runtime/install/reports/`.
- `backup/` — folded into `data/snapshots/`.
- `runtime/state/` — contents redistributed to the owning faculty (`cognition/`, `io/publish/`, `runtime/daemon/`, `runtime/logs/`).
- `skills/external/` — collapsed to `skills/`.

## Design rationale

### Faculty precedent over content/system

An earlier design draft proposed a `content/` vs `system/` top-level split. The user (Kevin) corrected this with: *"remember that we have faculties. follow the faculties precedence we have in this package."* The package already organizes code into named faculties under `system/{cognition,io,data,runtime}/` (documented in `docs/faculties.md`), so `user-data/` mirrors that taxonomy rather than inventing a new one. The realm directory a file lives under tells you which faculty in `system/` owns the producer.

### "Earn a sub-directory" rule

A faculty inside a realm earns its own sub-directory only when it owns ≥2 files. Single-file faculties live at the realm level with a faculty-prefixed name. Today this applies in just two places:

- `cognition/reinforcement-last-run.json` — reinforcement owns one file, so no `cognition/reinforcement/` dir.
- `io/publish/index.jsonl` — publish gets a dir because the io realm has only one faculty with disk state today; keeping `publish/` as a sub-dir leaves room for more publish-side files (cursors, retry queue, etc.) without re-organizing. As more io faculties accrue state, we expect `io/integrations/`, `io/capture/` to follow the same shape.

### Centralized logs under runtime/

Logs across faculties (biographer, daemon, surreal, publish) live in `runtime/logs/` instead of each faculty's own dir. Rationale: operators tail logs collectively while debugging, and `runtime/` is the realm that owns operational concerns. This is a deliberate exception to strict per-faculty co-location.

### Un-hidden state under hidden faculty parents

The daemon and install lock/pid/marker files stay dot-prefixed (`runtime/daemon/.pid`, `runtime/install/.marker.json`, …). Rationale matches Unix tradition (lockfiles and pidfiles are conventionally hidden) and keeps them out of `ls` listings during day-to-day directory exploration. The parent dir already signals "internal," so hiding the leaf is a minor convenience, not a substantive boundary.

### Disappearance of cache/

`cache/` mixed three distinct things: append-only logs, durable diagnostic reports, and transient snapshots. Each gets a faculty-aligned home:

- Logs → `runtime/logs/` (centralized).
- v1-import reports → `runtime/install/reports/` (they are install-time diagnostics).
- sqlite snapshots → `data/snapshots/` (substrate-owned).

No file's purpose is changed by the move; the directory name `cache/` was the only thing that promised "feel free to delete," and nothing in there was actually safe to delete carelessly.

## Code changes (mechanical only)

All path constants live in `system/config/data-store.js`. The `paths.data.*` object is the single source of truth for runtime paths. Updating it propagates everywhere:

```js
// system/config/data-store.js — updated paths.data shape
export const paths = {
  data: {
    home: () => robinHome(),

    // user-content surfaces
    artifacts: () => join(robinHome(), 'artifacts'),
    jobs: () => join(robinHome(), 'jobs'),
    skills: () => join(robinHome(), 'skills'),
    sources: () => join(robinHome(), 'sources'),
    upload: () => join(robinHome(), 'upload'),

    // config
    config: () => join(robinHome(), 'config', 'config.json'),
    secrets: () => join(robinHome(), 'config', 'secrets'),

    // cognition realm
    reinforcementLastRun: () => join(robinHome(), 'cognition', 'reinforcement-last-run.json'),

    // io realm
    publishIndex: () => join(robinHome(), 'io', 'publish', 'index.jsonl'),
    sqliteSnapshots: () => join(robinHome(), 'io', 'sqlite-snapshots'),

    // data realm
    db: () => join(robinHome(), 'data', 'db'),
    snapshots: () => join(robinHome(), 'data', 'snapshots'),  // Robin DB backups

    // runtime realm
    logs: () => join(robinHome(), 'runtime', 'logs'),
    daemonStatus: () => join(robinHome(), 'runtime', 'daemon', 'status.json'),
    daemonPid: () => join(robinHome(), 'runtime', 'daemon', '.pid'),
    daemonState: () => join(robinHome(), 'runtime', 'daemon', '.state'),
    daemonLock: () => join(robinHome(), 'runtime', 'daemon', '.lock'),
    manifest: () => join(robinHome(), 'runtime', 'install', 'manifest.json'),
    manifestLock: () => join(robinHome(), 'runtime', 'install', '.manifest.lock'),
    hostIntegrations: () => join(robinHome(), 'runtime', 'install', 'host-integrations.json'),
    marker: () => join(robinHome(), 'runtime', 'install', '.marker.json'),
    installReports: () => join(robinHome(), 'runtime', 'install', 'reports'),

    // (removed: cache, backup, runtime/state subtree)
  },
  source: { /* unchanged */ },
};
```

**Other files that hardcode moved paths** (audit via `grep -rEn "user-data/(cache|backup|runtime/state|secrets/|manifest\.json|host-integrations|\.daemon|\.robin-data)" system/` and `grep -rEn "paths\.data\.(cache|backup)\(" system/` — the second grep catches accessor callers, since the accessors themselves are being removed):

- `system/io/publish/config.js` — `LOG_PATH` and `TELEMETRY_PATH` constants. Switch to `paths.data.logs()` + `paths.data.publishIndex()`.
- `system/runtime/install/manifest.js` — `manifestPath()` returns `<home>/manifest.json`; switch to `paths.data.manifest()`.
- `system/runtime/install/postinstall.js` — probe at line 40 checks `existsSync(join(packageRoot, 'user-data', '.robin-data'))` to decide whether to skip install. Probe must accept *either* the old marker (`.robin-data` at root) *or* the new (`runtime/install/.marker.json`) to remain idempotent across the redesign.
- `system/runtime/install/migrate-home.js` — post-copy verification at line 37 reads `${to}/.robin-data`. After the redesign this becomes `${to}/runtime/install/.marker.json`; update verifier and any test fixtures.
- `system/config/data-store.js` line 434 — `readMarker()` walks `.robin-data`; switch to new marker path via `paths.data.marker()` and accept both during the transition window (returns the new marker if present, falls back to old).
- `system/runtime/install/v1-import/index.js` — copies v1 `sources/` into v2 root `sources/`; the destination path is unchanged but the call site should re-derive from `paths.data.sources()` so a future move stays a single edit.
- `system/runtime/install/v1-import/passes/f-sources.js` — same: derive from `paths`.
- `system/runtime/install/agents-md.js` — generated AGENTS.md text mentions `<package_root>/user-data/db/` and `<package_root>/user-data/secrets/.env`; update to the new paths (`data/db/`, `config/secrets/.env`).
- `system/runtime/cli/commands/migrate.js` line 19 — `snapshot(paths.data.db(), paths.data.backup())` references the removed `paths.data.backup()` accessor. Replace with `paths.data.snapshots()`.
- `system/runtime/cli/commands/import-v1.js` lines 152–153 — writes `v1-import-report-*.json` into `paths.data.cache()` (removed). Switch to `paths.data.installReports()`.
- `system/runtime/scripts/migrate-fresh.mjs` lines 7, 25, 49–57 — hardcodes `ROBIN_HOME/cache/backups` for pre-redesign tarballs and `ROBIN_HOME/db` as the source. Repoint to `runtime/install/reports/` (or `data/snapshots/`) and `data/db/` respectively.
- `system/io/integrations/lrc/sync.js` line 7 — `join(paths.data.cache(), 'sqlite-snapshots')` for the iMessage chat.db snapshot. Switch to `paths.data.sqliteSnapshots()`.
- `system/io/integrations/chrome/sync.js` line 15 — same pattern as lrc. Switch to `paths.data.sqliteSnapshots()`.
- `system/runtime/daemon/boot.js` — error message about `secrets import --from <v1-user-data>`; cosmetic, no path change needed.
- `system/cognition/discretion/bash-patterns.js` — comments reference legacy paths; update for accuracy.
- `system/cognition/jobs/internal/log-rotate.js` — uses `paths.data.logs()` (unchanged accessor; new target is `runtime/logs/`); should keep working without edit, but verify rotation policy still finds the four logs at their new home.
- `system/cognition/jobs/builtin/daily-briefing.md` — grep confirms no hardcoded `user-data/` paths; no change needed.
- Tests under `system/tests/` that reference old paths — update in lockstep.

`ensureHome()` in `data-store.js` is the single entry point that every CLI command, every hook, and the daemon boot path already calls (verified: `mcp-start`, `jobs-list`, `hooks-enable`, `hooks-disable`, `integrations-status`, `stop-hook`, etc. all start with `await ensureHome()`). It becomes the single migrator trigger:

```js
export async function ensureHome() {
  const home = robinHome();
  mkdirSync(home, { recursive: true });

  // 1. Run the layout migrator BEFORE creating any new-layout dirs.
  //    The migrator is a no-op when the marker already reports v2.
  //    Pre-creating new dirs first would make `rename old→new` fail
  //    on POSIX (rename refuses to overwrite a non-empty dir, and
  //    empty-dir behavior is platform-dependent).
  await migrateUserDataLayout(home);

  // 2. mkdir the v2 dir set (idempotent; recursive).
  for (const dir of [
    paths.data.artifacts(), paths.data.jobs(), paths.data.skills(),
    paths.data.sources(),   paths.data.upload(),
    dirname(paths.data.config()),    // config/
    paths.data.secrets(),            // config/secrets/
    dirname(paths.data.reinforcementLastRun()),  // cognition/
    dirname(paths.data.publishIndex()),          // io/publish/
    paths.data.sqliteSnapshots(),                // io/sqlite-snapshots/
    paths.data.db(), paths.data.snapshots(), paths.data.logs(),
    dirname(paths.data.daemonStatus()),          // runtime/daemon/
    dirname(paths.data.manifest()),              // runtime/install/
    paths.data.installReports(),
  ]) {
    mkdirSync(dir, { recursive: true });
  }

  // 3. Marker: writes runtime/install/.marker.json with
  //    { user_data_layout_version: 2, created_at: <preserved or now> }
  //    if it doesn't already exist. The migrator (step 1) has already
  //    deleted the legacy /.robin-data if it was present.
  ensureMarker();

  // 4. Existing hooks-disabled.txt migration (unchanged from today).
  // ...
}
```

(Dir-mode enforcement on `config/secrets/` is not added here; only the existing 0600 enforcement on the `.env` file inside `system/config/secrets.js` is preserved.)

## One-shot migration

`migrateUserDataLayout(home)` lives at `system/runtime/install/layout-migrator.js`. It is called by `ensureHome()` (so every CLI command, hook, and daemon-boot path triggers it as a no-op check on each invocation) and also exposed as `robin migrate-user-data` for explicit dry-runs.

### Detecting the layout version (chicken-and-egg)

The version-decision logic must work *before* the new marker exists. It probes both locations and returns one of three discrete states (`'v2' | 'v1' | 'fresh'`):

```js
function detectLayoutVersion(home) {
  const newMarker = join(home, 'runtime', 'install', '.marker.json');
  if (existsSync(newMarker)) {
    const v = JSON.parse(readFileSync(newMarker, 'utf8')).user_data_layout_version;
    return v >= 2 ? 'v2' : 'v1';   // marker exists at new path but reports v1 → migrate
  }
  if (existsSync(join(home, '.robin-data'))) return 'v1';
  return 'fresh';  // first-ever install
}

// In migrateUserDataLayout(home):
const state = detectLayoutVersion(home);
if (state === 'v2') return;     // no-op
if (state === 'fresh') return;  // nothing to migrate; ensureHome() writes the v2 marker
// else state === 'v1': proceed with the migration below.
```

### Daemon-running guard (v1→v2 only)

**Critical safety check.** The v1→v2 migration includes renaming `db/` to `data/db/`. If the daemon is running, its RocksDB writer has a held file handle into `db/`; renaming the directory underneath it will at minimum produce stale writes and at worst corrupt the store.

Before running the migration steps, the migrator checks:

```js
if (state === 'v1') {
  const daemonPidPath = existsSync(join(home, '.daemon.pid'))
    ? join(home, '.daemon.pid')
    : join(home, 'runtime', 'daemon', '.pid');  // (rare: partial prior run)
  if (existsSync(daemonPidPath)) {
    const pid = Number(readFileSync(daemonPidPath, 'utf8').trim());
    if (isPidAlive(pid)) {
      throw new Error(
        'Layout v1→v2 migration cannot run while the daemon is alive ' +
        `(pid ${pid}). Run "robin daemon stop", then re-run any robin command.`
      );
    }
  }
}
```

`isPidAlive` is reused from `system/config/daemon-state.js`. The guard fires only on the v1→v2 transition; once at v2, subsequent migrator calls return early in step-0 without inspecting the daemon, so day-to-day operation is unaffected.

CLI commands that ride `ensureHome()` while the daemon is up and the layout is v1 will surface this error and fail. That is intentional: it forces an explicit `robin daemon stop` before the destructive rename. The doctor command — which by convention runs even when the daemon is unhealthy — must catch this thrown error and present it as a structured "needs daemon stop" message rather than crashing.

### Single-process guard

The migrator uses a PID-encoded lockfile at `<home>/.layout-migrator.lock` (created at the home root *during* migration, deleted on success). This prevents two concurrent `ensureHome()` callers (e.g., two CLI commands racing) from migrating in parallel.

Acquire:

```js
if (existsSync(lockPath)) {
  const holder = Number(readFileSync(lockPath, 'utf8').trim());
  if (isPidAlive(holder)) {
    // Wait up to N ms for the holder to finish, then re-check.
    // If still held after timeout, throw — the user can investigate.
  } else {
    // Stale lock from a crashed prior run — steal it.
    unlinkSync(lockPath);
  }
}
writeFileSync(lockPath, String(process.pid), { mode: 0o644 });
```

Release: `unlinkSync(lockPath)` in a `finally` block, so a crash leaves a stale lock that the next call recognizes (via `isPidAlive`) and steals. The lock lives at root rather than `runtime/install/` because `runtime/install/` may not exist yet (mkdir happens after migration); after migration the lockfile is deleted, so it doesn't pollute the final tree.

This lock is distinct from the daemon's `.daemon.lock` (which serializes embedded-DB writes among CLI subcommands).

### Execution order

`rename(2)` is atomic on the same filesystem (everything is under `<robin_home>/`). For each step, the rule is: mkdir the *parent* of the target, then `rename`. **Do not pre-create the target directory itself** — POSIX `rename` over a non-empty dir is `ENOTEMPTY`, and over an empty dir is platform-dependent (Linux replaces it; macOS may refuse).

For directory moves where the target's parent already exists from a previous partial run:

```
if existsSync(new):
    if isEmpty(new):
        rmdirSync(new); rename(old, new)
    elif isEmpty(old) || !existsSync(old):
        # previous run already moved; nothing to do
        skip
    else:
        # both old and new have content — partial state we can't auto-resolve
        throw new Error(`layout-migrator: both ${old} and ${new} are non-empty — resolve manually`)
else:
    rename(old, new)
```

Order:

1. `db/` → `data/db/` (largest single move; do first so the destructive rename happens while the daemon-guard is fresh)
2. `cache/logs/*` → `runtime/logs/*`
3. `cache/v1-import-report-*.json` → `runtime/install/reports/`
4. `cache/sqlite-snapshots/` → `io/sqlite-snapshots/`
5. `runtime/state/published/index.jsonl` → `io/publish/index.jsonl`
6. `runtime/state/telemetry/publish.log` → `runtime/logs/publish.log`
7. `runtime/state/recall-reinforce-last-run.json` → `cognition/reinforcement-last-run.json`
8. `runtime/state/daemon-status.json` → `runtime/daemon/status.json`
9. Root JSONs and dotfiles other than the legacy marker: `config.json` → `config/config.json`; `manifest.json` → `runtime/install/manifest.json`; `host-integrations.json` → `runtime/install/host-integrations.json`; `.daemon.pid` → `runtime/daemon/.pid`; `.daemon.state` → `runtime/daemon/.state`; `.daemon.lock` → `runtime/daemon/.lock`; `.manifest.lock` → `runtime/install/.manifest.lock`.
10. `secrets/` → `config/secrets/`
11. `skills/external/*` → `skills/*` (each entry individually; the `external/` parent is removed in step 13)
12. Marker write: read `<home>/.robin-data` (preserving `createdAt` if present), then write `runtime/install/.marker.json` as `{ user_data_layout_version: 2, migrated_at: <now ISO>, created_at: <preserved or now> }`. Unlink `<home>/.robin-data`. (The marker is *rewritten*, not renamed — the schema gains version fields.)
13. Remove now-empty dirs: `cache/`, `backup/`, `runtime/state/`, `runtime/state/published/`, `runtime/state/telemetry/`, `sources/media/`, `skills/external/`.

After step 12 the marker reports v2, so subsequent `migrateUserDataLayout` calls return immediately in the version-detection check. Step 13 is best-effort: stray empty dirs left by a crashed-after-step-12 run are flagged by doctor (exit 1) but don't block operation.

### Recovery from partial state

A crash during step N leaves a mixed-layout tree. The next `ensureHome()` call re-enters the migrator; because each step checks `existsSync(new)` before acting, completed steps are skipped. The only unrecoverable case is the rare "both source and target are non-empty" condition (e.g., user manually ran a partial move) — the migrator throws and instructs the user to resolve manually. The lockfile prevents concurrent recovery attempts.

### File modes

Step 9 (`secrets/` → `config/secrets/`) is a directory rename, preserving inode and modes. The `.env` file inside continues to be re-`chmod 0600`'d on every write by `system/config/secrets.js`, so even if filesystem-level mode propagation glitches the next secret write self-heals.

### --dry-run

`robin migrate-user-data --dry-run` prints the full step plan with computed source and destination paths, then exits without writing. `--verbose` adds per-rename trace to stderr.

## Doctor integration

`system/runtime/cli/commands/doctor.js` gains a "Layout" check that reads the marker's `user_data_layout_version` and compares the on-disk top-level set against the expected v2 set.

```
Layout (v2):
  ✓ artifacts/ jobs/ skills/ sources/ upload/ config/
  ✓ cognition/ io/ data/ runtime/
  ✗ stray: cache/        ← old-layout debris
```

**Exit-code semantics** (consistent with the rest of doctor's 0/1/2 levels):

- **Exit 0**: marker reports v2 and the top-level set is exactly the expected ten entries.
- **Exit 1 (warning)**: marker reports v2 but a stray legacy dir (`cache/`, `backup/`, `runtime/state/`, `skills/external/`, `sources/media/`) is present. Migration completed but cleanup is incomplete. Doctor prints a one-line `robin migrate-user-data` suggestion.
- **Exit 2 (error)**: marker still reports v1 (migration hasn't run, daemon was up and blocked it, or migrator crashed before step 12); OR an expected v2 dir is missing while the marker says v2 (suggests a failed mid-migration that wasn't recovered). Doctor refuses to declare the install healthy.

If the marker says v1 specifically because the daemon was running, doctor surfaces the typed error from the migrator: "Stop the daemon, then re-run any robin command." That separates "user just needs to stop the daemon" from "the install is corrupted."

Doctor does not auto-clean stray dirs — that's the migrator's job. Doctor only surfaces what it sees.

## Testing strategy

- **Unit tests** for `paths.data.*` returning the new strings (round-trip via `robinHome()`).
- **Migrator integration test** under `system/tests/integration/`: build a synthetic v1 layout in a tmpdir, run the migrator, assert the new layout matches the migration table file-for-file (use `find` snapshots).
- **`ensureHome()` test** asserts every new dir exists after a fresh `install` from a clean tmpdir.
- **Daemon-running guard test** — assert that calling `migrateUserDataLayout` while a fake live daemon (a sleeping child process whose pid is written to `.daemon.pid`) throws the "stop the daemon" error, and that the v1→v2 move did NOT proceed. Reuses the live-pid pattern from existing `migrate.test.js`.
- **Stale lockfile recovery test** — write `<home>/.layout-migrator.lock` containing a non-existent pid (e.g., 999999), then run the migrator; assert the lock is stolen and migration completes.
- Existing `system/tests/integration/v1-import.test.js` and `jobs-roundtrip.test.js` need their tmpdir fixtures updated to the new layout. The v1-import flow is unaffected (it always copies *into* the live user-data, whatever shape it has).

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Daemon running during v1→v2 migration corrupts RocksDB via mid-rename | Explicit daemon-running guard in the migrator (PID-alive check on `.daemon.pid`); throws a "stop the daemon" error. v2→v2 calls skip the check entirely. |
| Two CLI commands race the migrator | PID-encoded lockfile at `<home>/.layout-migrator.lock`; stale locks (dead PID) are stolen, live ones are waited on. |
| External users' or test instances' user-data on the old layout | `ensureHome()` triggers the migrator on every entry path, marker-gated, idempotent. No user action needed beyond a one-time daemon stop. |
| Skill loader hardcodes `skills/external/<name>/` | Pre-spec audit (`grep -rEn "skills/external" --include="*.js" --include="*.md"`) returned empty — no callers. Safe to collapse. |
| Code outside `system/` hardcodes a moved path | Final grep sweep before merge: `grep -rEn "user-data/(cache\|backup\|runtime/state\|secrets/\|manifest\.json\|host-integrations\|\.daemon\|\.robin-data)" .` plus `grep -rEn "paths\.data\.(cache\|backup)\(" .` should return nothing in source files (allowed in this spec doc and in CHANGELOG). |
| Doc churn | Spec includes the full migration table; `agents-md.js` is the only generated doc that bakes paths and is updated in this change. CLAUDE.md/AGENTS.md in `robin-assistant-v2` and the package skeleton get a follow-up sweep against the new paths. |
| Mid-migration crash | Step-level idempotency + the "both old and new non-empty" guard. Recovery is just re-running `ensureHome()` (any CLI command works); the stale lockfile is stolen via `isPidAlive`. |
| Reverse migration | Not supported. Rollback means restoring a snapshot of `user-data/`. The migrator preserves modes and uses `rename` (no copy), so the old layout's bytes are gone — there is no in-place rollback. |
| Cross-filesystem `<robin_home>` | The migrator uses `rename(2)`, which is intra-filesystem only. `<robin_home>` is always one fs (set at install time by `migrate-home.js`), so this is a non-issue in practice; if it ever becomes one, fall back to `cp -a` + `rm -rf`. |
| Doctor must run even when the install is broken | The daemon-running-error path throws a typed error the doctor command catches and reports as a structured "needs daemon stop" message rather than letting it propagate as an uncaught exception. |

## Out of scope (follow-ups)

- A `runtime/telemetry/` realm if telemetry grows beyond a single log file.
- Per-integration sub-dirs under `io/integrations/` for caches (lunch_money txs, finance_quote prices, etc.) — none exist on disk today.
- Renaming `upload/` → `inbox/` or `sources/` → `library/` for ergonomic naming. Not part of this redesign; revisit independently.
- Splitting `config/config.json` into multiple smaller config files. The new `config/` directory makes that a low-cost future change; not part of this redesign.
- Replacing the intra-fs `rename`-based migrator with a copy-and-verify migrator that supports cross-filesystem `<robin_home>`.

## See also

- [`docs/faculties.md`](../../faculties.md) — the named-faculty taxonomy this layout mirrors.
- [`docs/superpowers/specs/2026-05-11-runtime-layer-hardening-design.md`](2026-05-11-runtime-layer-hardening-design.md) — adjacent runtime hardening.
- [`system/config/data-store.js`](../../../system/config/data-store.js) — the file that owns `paths.data.*`.
