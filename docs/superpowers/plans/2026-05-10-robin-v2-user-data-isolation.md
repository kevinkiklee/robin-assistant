# Robin v2 — User Data Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every file Robin writes lives in exactly one of two well-defined places — owned data under a single configurable `<robin-home>/`, or host touch-points tracked in a manifest inside that home. Configurable per install via interactive picker; strict resolution chain; no silent fallback.

**Architecture:** Replace `src/runtime/home.js` with `src/runtime/data-store.js` exposing `robinHome()` (strict resolver), split `paths.data.*` (under `<robin-home>/`) from `paths.source.*` (under package root), and add `recordHostTouchpoint`/`readHostIntegrations`/`forgetHostTouchpoint` for a flock-guarded `<robin-home>/host-integrations.json` manifest. `robin install` becomes the single entry point for choosing or relocating the home; uninstall, doctor, and `--repair` consume the manifest. Two audit unit tests guard against regression of `~/.robin` and `user-data` literal-path construction.

**Tech Stack:** Node.js 22+ (ES modules, no TypeScript), `node --test` (built-in test runner), `node:fs`/`node:path`/`node:os`/`node:readline/promises`, SurrealDB (rocksdb engine), Biome for lint/format.

**Spec:** `docs/superpowers/specs/2026-05-10-robin-v2-user-data-isolation-design.md` (commit `6bcdf96`).

---

## How to work this plan

1. Tests live in `tests/unit/` and `tests/integration/`. Run all tests with `node --test --test-force-exit 'tests/**/*.test.js'`. Run a single test with `node --test --test-force-exit 'tests/unit/data-store.test.js'`.
2. Before declaring a task done: run the touched test files, then `npm run lint` (Biome), then `git status` to confirm no stray files.
3. Commit at the end of each task with the message shown. Use `git add <specific files>`, never `git add -A`.
4. **Worktree note:** Consider creating a worktree (`git worktree add ../robin-assistant-v2-isolation`) before starting — this is a substantial cross-cutting refactor and the main checkout has unrelated working-tree changes.

---

## File map (where things end up)

**New files:**

| Path | Responsibility |
|---|---|
| `src/runtime/data-store.js` | Sole resolver, paths split, manifest helpers, marker, lock. Replaces `home.js`. |
| `tests/unit/data-store.test.js` | Resolution, paths split, marker, no-fs.rename invariant. |
| `tests/unit/manifest.test.js` | Lock, replace-by-(kind,path), legacy migration. |
| `tests/unit/prompts-radio.test.js` | Picker helper: default, custom, reprompt, non-TTY. |
| `tests/unit/audit-no-tilde-robin.test.js` | Regression guard: `~/.robin` literals. |
| `tests/unit/audit-user-data-construction.test.js` | Regression guard: `user-data` literal path construction. |
| `tests/integration/install-first.test.js` | Picker options produce valid layouts. |
| `tests/integration/install-existing-data.test.js` | Migration when target ≠ source. |
| `tests/integration/install-legacy-data-without-marker.test.js` | Legacy v2 layout accepted by discovery. |
| `tests/integration/install-existing-data-failure.test.js` | ENOSPC-style failure: source intact, partial target gone. |
| `tests/integration/install-kevin-rollout.test.js` | End-to-end Kevin rollout simulation. |
| `tests/integration/relocate.test.js` | `--relocate` flow + manifest refresh. |
| `tests/integration/reinstall-discovery.test.js` | Discovery scans known locations on reinstall. |
| `tests/integration/uninstall-best-effort.test.js` | Default best-effort + `--strict`. |
| `tests/integration/doctor-drift.test.js` | Doctor reports drift; `--repair` fixes it. |
| `tests/integration/interrupt-safety.test.js` | Install steps 5–9 interrupt-safe. |
| `tests/integration/legacy-installed-hooks.test.js` | One-shot migration of `installed-hooks.json`. |

**Modified files:**

| Path | Change |
|---|---|
| `src/cli/commands/install.js` | Picker, discovery, migration prompt, write `.robin-home`, drive `recordHostTouchpoint`. Hosts `--relocate` and `--repair`. |
| `src/cli/commands/uninstall.js` | Daemon-stop, manifest walk, best-effort + `--strict`, fallback when home is missing. |
| `src/cli/commands/doctor.js` | New `data` section, drift list, `--strict` audit hook. |
| `src/cli/commands/help.js` | Dynamic home text (no `<package_root>/user-data` literal). |
| `src/cli/commands/mcp-install.js` | Record plist/systemd via manifest. |
| `src/cli/commands/mcp-uninstall.js` | Forget plist/systemd via manifest. |
| `src/cli/commands/mcp-start.js` | Logs path from `paths.data.logs()` (mostly already correct). |
| `src/cli/commands/secrets-import.js` | Update help-text references. |
| `src/cli/index.js` | Route `install --relocate` and `install --repair`. |
| `src/cli/prompts.js` | Add `radio()` helper. |
| `src/cli/daemon-request.js` | Import path from `home.js` → `data-store.js`. |
| `src/install/launchd-plist.js` | Bake home from resolved value; remove `~/.robin/logs/` strings. |
| `src/install/systemd-unit.js` | `Environment=ROBIN_HOME=<home>`; bake logs path. |
| `src/install/hooks-settings.js` | Use `recordHostTouchpoint`. Remove private `installed-hooks.json` writer. |
| `src/install/pre-commit.js` | `recordHostTouchpoint` / `forgetHostTouchpoint`. |
| `src/install/manifest.js` | Import path. |
| `src/install/hook-shim.js` | Import path. |
| `src/db/backup.js`, `src/db/migrate.js`, `src/db/client.js`, `src/db/lock.js` | Import path from `home.js` → `data-store.js`. |
| Every CLI command importing `paths`/`paths().*`/`ensureHome`/`packageRootDir` | Import path; rename `paths()` → `paths` (no-arg shape). |
| `scripts/dev-recall.js` | Stop hardcoding `~/.robin`; use new resolver. |
| `.gitignore` | Add `.robin-home`. |

**Deleted (during execution, not source):**

| Path | When |
|---|---|
| `user-data/hooks-disabled.txt` | Task 6.3 (folded into `config.json`). |
| `user-data/installed-hooks.json` | Auto-deleted on first manifest read (Task 2.2). |
| `src/runtime/home.js` | Replaced by `data-store.js` in Task 1.1. |

---

## Phase 0 — Pre-flight

### Task 0.1: Baseline green

**Files:** none

- [ ] **Step 1: Confirm tests pass on the target branch**

Run: `node --test --test-force-exit 'tests/**/*.test.js' 2>&1 | tail -20`
Expected: All test files pass. If failures exist that are unrelated to this work, note them and stop — do not start this plan against a red baseline.

- [ ] **Step 2: Confirm Biome is green**

Run: `npm run lint`
Expected: Exit 0. If failures exist unrelated to this work, fix or stop.

- [ ] **Step 3: Note the rollout daemon-stop step (do NOT do it yet)**

The spec §14 step 1 says to stop the launchd/systemd daemon **before merging** this work. Do **not** do that now — only when the change is ready to merge. Note it on your todo list.

---

## Phase 1 — Core data-store seam

### Task 1.1: Rename `home.js` → `data-store.js` (pure mechanical, no behavior change)

**Files:**
- Rename: `src/runtime/home.js` → `src/runtime/data-store.js`
- Modify (import paths): every file importing from `../runtime/home.js` or `../../runtime/home.js`

- [ ] **Step 1: Rename the file**

```bash
git mv src/runtime/home.js src/runtime/data-store.js
```

- [ ] **Step 2: Find all importers**

Run:
```bash
grep -rln --include='*.js' "runtime/home" src tests scripts
```

Expected output (you should see this set; update all of them in step 3):
```
src/cli/commands/install.js
src/cli/commands/uninstall.js
src/cli/commands/doctor.js
src/cli/commands/help.js
src/cli/commands/mcp-install.js
src/cli/commands/mcp-uninstall.js
src/cli/commands/mcp-start.js
src/cli/commands/secrets-import.js
src/cli/commands/migrate.js
src/cli/commands/db-browse.js
src/cli/commands/biographer-catchup.js
src/cli/commands/biographer-process-pending.js
src/cli/commands/dream-run.js
src/cli/commands/hot.js
src/cli/commands/integrations-discord-register.js
src/cli/commands/integrations-list.js
src/cli/commands/integrations-run.js
src/cli/commands/integrations-status.js
src/cli/commands/jobs-disable.js
src/cli/commands/jobs-enable.js
src/cli/commands/jobs-list.js
src/cli/commands/jobs-status.js
src/cli/commands/journal.js
src/cli/commands/rules-approve.js
src/cli/commands/rules-deactivate.js
src/cli/commands/rules-list.js
src/cli/commands/rules-pending.js
src/cli/commands/sessions-purge.js
src/cli/daemon-request.js
src/db/backup.js
src/db/client.js
src/db/lock.js
src/db/migrate.js
src/install/hook-shim.js
src/install/hooks-settings.js
src/install/manifest.js
src/install/pre-commit.js
src/runtime/config.js
src/secrets/dotenv-io.js
src/daemon/server.js
```

(The set may differ slightly; replace **every** match.)

- [ ] **Step 3: Replace import strings in all importers**

Run:
```bash
grep -rl --include='*.js' "runtime/home" src tests scripts | xargs sed -i '' 's|runtime/home|runtime/data-store|g'
```

(`sed -i ''` is the BSD/macOS form. On Linux, use `sed -i 's|runtime/home|runtime/data-store|g'`.)

- [ ] **Step 4: Run tests and lint**

```bash
node --test --test-force-exit 'tests/**/*.test.js' 2>&1 | tail -5
npm run lint
```

Expected: all green. Behavior is unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/data-store.js src tests scripts 2>/dev/null
git status   # verify no stray files
git commit -m "refactor(data-store): rename home.js to data-store.js (no behavior change)"
```

---

### Task 1.2: Split paths into `paths.data.*` and `paths.source.*` (still no resolver change)

**Files:**
- Modify: `src/runtime/data-store.js`
- Modify (call sites): every consumer of `paths()`

- [ ] **Step 1: Write a failing test for the new shape**

Create `tests/unit/data-store.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { paths, robinHome, packageRootDir } from '../../src/runtime/data-store.js';

test('paths.data is under robinHome()', () => {
  const home = robinHome();
  for (const key of ['db', 'secrets', 'cache', 'logs', 'backup', 'upload', 'config', 'hostIntegrations', 'daemonState', 'daemonLock', 'manifestLock', 'marker']) {
    const v = paths.data[key]();
    assert.ok(v.startsWith(home), `paths.data.${key}() should start with home (got ${v})`);
  }
});

test('paths.source is under packageRootDir()', () => {
  const root = packageRootDir();
  for (const key of ['migrations', 'hookShim', 'robinBin']) {
    const v = paths.source[key]();
    assert.ok(v.startsWith(root), `paths.source.${key}() should start with package root (got ${v})`);
  }
});

test('paths.data and paths.source roots do not overlap', () => {
  assert.notStrictEqual(robinHome(), packageRootDir(),
    'data root and source root must be distinct');
});
```

- [ ] **Step 2: Run the test to verify failure**

Run: `node --test --test-force-exit 'tests/unit/data-store.test.js'`
Expected: FAIL — `paths.data` does not exist (current shape is `paths()` returning a flat map).

- [ ] **Step 3: Rewrite `src/runtime/data-store.js` with the split shape**

Full new contents (replaces existing):

```js
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function findPackageRoot() {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (dir !== '/') {
    if (existsSync(join(dir, 'package.json'))) return dir;
    dir = dirname(dir);
  }
  throw new Error('cannot resolve package root from src/runtime/data-store.js');
}

const _packageRoot = findPackageRoot();

export function packageRootDir() {
  return _packageRoot;
}

export function robinHome() {
  // TEMPORARY: keep the old default behavior in this task; strict resolver
  // lands in Task 1.4. Maintains green tests during the split refactor.
  if (process.env.ROBIN_HOME) return resolve(process.env.ROBIN_HOME);
  return join(_packageRoot, 'user-data');
}

export const paths = {
  data: {
    home: () => robinHome(),
    db: () => join(robinHome(), 'db'),
    secrets: () => join(robinHome(), 'secrets'),
    cache: () => join(robinHome(), 'cache'),
    logs: () => join(robinHome(), 'cache', 'logs'),
    backup: () => join(robinHome(), 'backup'),
    upload: () => join(robinHome(), 'upload'),
    config: () => join(robinHome(), 'config.json'),
    hostIntegrations: () => join(robinHome(), 'host-integrations.json'),
    daemonState: () => join(robinHome(), '.daemon.state'),
    daemonLock: () => join(robinHome(), '.daemon.lock'),
    manifestLock: () => join(robinHome(), '.manifest.lock'),
    marker: () => join(robinHome(), '.robin-data'),
  },
  source: {
    migrations: () => join(_packageRoot, 'src', 'schema', 'migrations'),
    hookShim: () => join(_packageRoot, 'bin', 'robin-hook.sh'),
    robinBin: () => join(_packageRoot, 'bin', 'robin'),
  },
};

export async function ensureHome() {
  const home = robinHome();
  for (const dir of [
    home,
    paths.data.db(),
    paths.data.secrets(),
    paths.data.cache(),
    paths.data.logs(),
    paths.data.backup(),
    paths.data.upload(),
  ]) {
    mkdirSync(dir, { recursive: true });
  }
}
```

Note: `ensureHome()` no longer drops the marker — that lands in Task 1.5. The `paths()` function (zero-arg, returning a flat object) is gone, replaced by the `paths` object literal.

- [ ] **Step 4: Run the new test to verify pass**

Run: `node --test --test-force-exit 'tests/unit/data-store.test.js'`
Expected: PASS (3 tests).

- [ ] **Step 5: Update every caller from `paths()` to `paths.data.*`**

Run:
```bash
grep -rln --include='*.js' "paths()" src tests scripts
```

For each match, rewrite. The mapping is mechanical:

| Old | New |
|---|---|
| `paths().home` | `paths.data.home()` |
| `paths().db` | `paths.data.db()` |
| `paths().secrets` | `paths.data.secrets()` |
| `paths().cache` | `paths.data.cache()` |
| `paths().config` | `paths.data.config()` |
| `paths().backup` | `paths.data.backup()` |
| `paths().daemonState` | `paths.data.daemonState()` |
| `paths().daemonLock` | `paths.data.daemonLock()` |
| `paths().migrationsDir` | `paths.source.migrations()` |

You can either edit each file by hand, or run a careful sed pass per pattern. Example for the most common case:

```bash
# Update each pattern. Inspect each file after.
grep -rl --include='*.js' "paths()\.db" src tests scripts | xargs sed -i '' 's|paths()\.db|paths.data.db()|g'
grep -rl --include='*.js' "paths()\.home" src tests scripts | xargs sed -i '' 's|paths()\.home|paths.data.home()|g'
grep -rl --include='*.js' "paths()\.secrets" src tests scripts | xargs sed -i '' 's|paths()\.secrets|paths.data.secrets()|g'
grep -rl --include='*.js' "paths()\.cache" src tests scripts | xargs sed -i '' 's|paths()\.cache|paths.data.cache()|g'
grep -rl --include='*.js' "paths()\.config" src tests scripts | xargs sed -i '' 's|paths()\.config|paths.data.config()|g'
grep -rl --include='*.js' "paths()\.backup" src tests scripts | xargs sed -i '' 's|paths()\.backup|paths.data.backup()|g'
grep -rl --include='*.js' "paths()\.daemonState" src tests scripts | xargs sed -i '' 's|paths()\.daemonState|paths.data.daemonState()|g'
grep -rl --include='*.js' "paths()\.daemonLock" src tests scripts | xargs sed -i '' 's|paths()\.daemonLock|paths.data.daemonLock()|g'
grep -rl --include='*.js' "paths()\.migrationsDir" src tests scripts | xargs sed -i '' 's|paths()\.migrationsDir|paths.source.migrations()|g'
```

Then check for stray `paths()` usage:

```bash
grep -rn --include='*.js' "paths()" src tests scripts
```

Expected: empty (or only the call sites you've manually rewritten).

- [ ] **Step 6: Run the full test suite**

Run: `node --test --test-force-exit 'tests/**/*.test.js' 2>&1 | tail -10`
Expected: All previously-passing tests still pass.

Run: `npm run lint`
Expected: green.

- [ ] **Step 7: Commit**

```bash
git add src tests
git commit -m "refactor(data-store): split paths into data.* and source.* namespaces"
```

---

### Task 1.3: Add `.robin-data` marker and upgrade `ensureHome()`

**Files:**
- Modify: `src/runtime/data-store.js`
- Modify: `tests/unit/data-store.test.js`

- [ ] **Step 1: Add failing tests for the marker**

Append to `tests/unit/data-store.test.js`:

```js
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { ensureHome } from '../../src/runtime/data-store.js';

test('ensureHome() writes .robin-data marker with version', async () => {
  const home = mkdtempSync(join(tmpdir(), 'robin-home-'));
  const prev = process.env.ROBIN_HOME;
  process.env.ROBIN_HOME = home;
  try {
    await ensureHome();
    const markerPath = paths.data.marker();
    const raw = readFileSync(markerPath, 'utf8');
    const parsed = JSON.parse(raw);
    assert.strictEqual(parsed.version, 1);
    assert.ok(typeof parsed.createdAt === 'string');
    assert.ok(new Date(parsed.createdAt).toISOString() === parsed.createdAt);
  } finally {
    if (prev) process.env.ROBIN_HOME = prev;
    else delete process.env.ROBIN_HOME;
    rmSync(home, { recursive: true, force: true });
  }
});

test('ensureHome() is idempotent and preserves an existing marker', async () => {
  const home = mkdtempSync(join(tmpdir(), 'robin-home-'));
  const prev = process.env.ROBIN_HOME;
  process.env.ROBIN_HOME = home;
  try {
    await ensureHome();
    const firstRaw = readFileSync(paths.data.marker(), 'utf8');
    // Sleep 5ms so any naive overwrite would change createdAt.
    await new Promise((r) => setTimeout(r, 5));
    await ensureHome();
    const secondRaw = readFileSync(paths.data.marker(), 'utf8');
    assert.strictEqual(firstRaw, secondRaw);
  } finally {
    if (prev) process.env.ROBIN_HOME = prev;
    else delete process.env.ROBIN_HOME;
    rmSync(home, { recursive: true, force: true });
  }
});
```

Make sure `import { join } from 'node:path';` is at the top of the file (it should be from earlier; if not, add it).

- [ ] **Step 2: Run the new tests to verify failure**

Run: `node --test --test-force-exit 'tests/unit/data-store.test.js'`
Expected: FAIL — marker file missing.

- [ ] **Step 3: Update `ensureHome()` in `data-store.js`**

Replace the existing `ensureHome` with:

```js
const MARKER_VERSION = 1;

export async function ensureHome() {
  const home = robinHome();
  for (const dir of [
    home,
    paths.data.db(),
    paths.data.secrets(),
    paths.data.cache(),
    paths.data.logs(),
    paths.data.backup(),
    paths.data.upload(),
  ]) {
    mkdirSync(dir, { recursive: true });
  }
  // Drop the marker if missing. Preserves existing marker — do not overwrite.
  const markerPath = paths.data.marker();
  if (!existsSync(markerPath)) {
    const payload = { version: MARKER_VERSION, createdAt: new Date().toISOString() };
    writeFileSync(markerPath, JSON.stringify(payload, null, 2), { mode: 0o644 });
  }
}

export function readMarker() {
  const p = paths.data.marker();
  if (!existsSync(p)) return null;
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function MARKER_VERSION_CURRENT() {
  return MARKER_VERSION;
}
```

Make sure `readFileSync` is imported from `node:fs` at the top:

```js
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
```

- [ ] **Step 4: Run the tests to verify pass**

Run: `node --test --test-force-exit 'tests/unit/data-store.test.js'`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/runtime/data-store.js tests/unit/data-store.test.js
git commit -m "feat(data-store): add .robin-data marker via ensureHome()"
```

---

### Task 1.4: Strict resolution chain with `.robin-home` pointer

**Files:**
- Modify: `src/runtime/data-store.js`
- Modify: `tests/unit/data-store.test.js`

- [ ] **Step 1: Add failing tests for the strict resolver**

Append to `tests/unit/data-store.test.js`:

```js
import { unlinkSync, writeFileSync as fsWriteSync } from 'node:fs';
import { resolveHomeStrict, POINTER_VERSION } from '../../src/runtime/data-store.js';

test('strict resolver: $ROBIN_HOME wins when set and target exists', async () => {
  const home = mkdtempSync(join(tmpdir(), 'robin-home-'));
  const prev = process.env.ROBIN_HOME;
  process.env.ROBIN_HOME = home;
  try {
    const resolved = resolveHomeStrict();
    assert.strictEqual(resolved, home);
  } finally {
    if (prev) process.env.ROBIN_HOME = prev;
    else delete process.env.ROBIN_HOME;
    rmSync(home, { recursive: true, force: true });
  }
});

test('strict resolver: throws "Robin is not installed" when neither set', () => {
  const prev = process.env.ROBIN_HOME;
  delete process.env.ROBIN_HOME;
  try {
    assert.throws(
      () => resolveHomeStrict({ pointerPath: '/tmp/does-not-exist-robin-home.json' }),
      /Robin is not installed.*robin install/,
    );
  } finally {
    if (prev) process.env.ROBIN_HOME = prev;
  }
});

test('strict resolver: pointer file with valid target resolves to it', () => {
  const home = mkdtempSync(join(tmpdir(), 'robin-home-'));
  const pointerPath = join(mkdtempSync(join(tmpdir(), 'robin-pkg-')), '.robin-home');
  fsWriteSync(pointerPath, JSON.stringify({
    version: 1, home, installedAt: '2026-05-10T00:00:00Z', installedBy: 'test',
  }));
  const prev = process.env.ROBIN_HOME;
  delete process.env.ROBIN_HOME;
  try {
    const resolved = resolveHomeStrict({ pointerPath });
    assert.strictEqual(resolved, home);
  } finally {
    if (prev) process.env.ROBIN_HOME = prev;
    rmSync(home, { recursive: true, force: true });
    unlinkSync(pointerPath);
    rmSync(dirname(pointerPath), { recursive: true, force: true });
  }
});

test('strict resolver: pointer target missing throws --relocate hint', () => {
  const pointerPath = join(mkdtempSync(join(tmpdir(), 'robin-pkg-')), '.robin-home');
  fsWriteSync(pointerPath, JSON.stringify({
    version: 1, home: '/tmp/this-path-does-not-exist-robin-xyz',
    installedAt: '2026-05-10T00:00:00Z', installedBy: 'test',
  }));
  const prev = process.env.ROBIN_HOME;
  delete process.env.ROBIN_HOME;
  try {
    assert.throws(
      () => resolveHomeStrict({ pointerPath }),
      /recorded in \.robin-home is missing.*--relocate/s,
    );
  } finally {
    if (prev) process.env.ROBIN_HOME = prev;
    unlinkSync(pointerPath);
    rmSync(dirname(pointerPath), { recursive: true, force: true });
  }
});

test('strict resolver: pointer with unknown version throws', () => {
  const home = mkdtempSync(join(tmpdir(), 'robin-home-'));
  const pointerPath = join(mkdtempSync(join(tmpdir(), 'robin-pkg-')), '.robin-home');
  fsWriteSync(pointerPath, JSON.stringify({ version: 999, home, installedAt: '', installedBy: '' }));
  const prev = process.env.ROBIN_HOME;
  delete process.env.ROBIN_HOME;
  try {
    assert.throws(
      () => resolveHomeStrict({ pointerPath }),
      /\.robin-home version 999 is not supported/,
    );
  } finally {
    if (prev) process.env.ROBIN_HOME = prev;
    rmSync(home, { recursive: true, force: true });
    unlinkSync(pointerPath);
    rmSync(dirname(pointerPath), { recursive: true, force: true });
  }
});
```

Make sure `import { dirname } from 'node:path';` is at the top of the file.

- [ ] **Step 2: Run the new tests to verify failure**

Run: `node --test --test-force-exit 'tests/unit/data-store.test.js'`
Expected: FAIL — `resolveHomeStrict` is not exported.

- [ ] **Step 3: Implement strict resolver in `data-store.js`**

Add to `data-store.js` (above `robinHome()`):

```js
export const POINTER_VERSION = 1;

function pointerFilePath() {
  return join(_packageRoot, '.robin-home');
}

export function resolveHomeStrict({ pointerPath = pointerFilePath() } = {}) {
  if (process.env.ROBIN_HOME) {
    const p = resolve(process.env.ROBIN_HOME);
    if (!existsSync(p)) {
      throw new Error(
        `$ROBIN_HOME=${p} is set but the path does not exist. Create it or unset $ROBIN_HOME.`,
      );
    }
    return p;
  }
  if (!existsSync(pointerPath)) {
    throw new Error('Robin is not installed. Run: robin install');
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(pointerPath, 'utf8'));
  } catch (e) {
    throw new Error(`malformed ${pointerPath}: ${e.message}`);
  }
  if (parsed?.version !== POINTER_VERSION) {
    throw new Error(
      `.robin-home version ${parsed?.version} is not supported (expected ${POINTER_VERSION}). ` +
        'Run: robin install',
    );
  }
  const target = typeof parsed.home === 'string' ? resolve(parsed.home) : null;
  if (!target || !existsSync(target)) {
    throw new Error(
      `user-data path ${target ?? '(unset)'} recorded in .robin-home is missing. ` +
        'Run: robin install --relocate',
    );
  }
  return target;
}
```

Then replace the existing `robinHome()` body so it calls the strict resolver — but keep a legacy escape hatch for the *current task* to avoid breaking the test suite mid-refactor. We will remove the legacy fallback in Task 1.5:

```js
export function robinHome() {
  // LEGACY: this fallback is removed in Task 1.5 once install writes .robin-home.
  // Keeping it here so the test suite (which calls into commands that need a
  // home) keeps working while we layer in the new pieces.
  try {
    return resolveHomeStrict();
  } catch {
    if (process.env.ROBIN_HOME) return resolve(process.env.ROBIN_HOME);
    return join(_packageRoot, 'user-data');
  }
}
```

Also export `writePointer` (used later by install — write it now to keep the public surface stable):

```js
export function writePointer({ home, installedBy }) {
  const payload = {
    version: POINTER_VERSION,
    home: resolve(home),
    installedAt: new Date().toISOString(),
    installedBy: installedBy ?? 'unknown',
  };
  const p = pointerFilePath();
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify(payload, null, 2), { mode: 0o644 });
  // Atomic rename.
  const { renameSync } = require('node:fs');
  renameSync(tmp, p);
}
```

Wait — `require` is not available in ESM. Replace with a static import. Add `renameSync, unlinkSync` to the imports at the top:

```js
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
```

And rewrite `writePointer` cleanly:

```js
export function writePointer({ home, installedBy }) {
  const payload = {
    version: POINTER_VERSION,
    home: resolve(home),
    installedAt: new Date().toISOString(),
    installedBy: installedBy ?? 'unknown',
  };
  const p = pointerFilePath();
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify(payload, null, 2), { mode: 0o644 });
  renameSync(tmp, p);
}

export function deletePointer() {
  const p = pointerFilePath();
  if (existsSync(p)) unlinkSync(p);
}

export function pointerExists() {
  return existsSync(pointerFilePath());
}

export function readPointer() {
  const p = pointerFilePath();
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run the tests to verify pass**

Run: `node --test --test-force-exit 'tests/unit/data-store.test.js'`
Expected: PASS (all tests, including new strict-resolver cases).

- [ ] **Step 5: Run the full test suite**

Run: `node --test --test-force-exit 'tests/**/*.test.js' 2>&1 | tail -10`
Expected: All previously-passing tests still pass (legacy `robinHome()` fallback keeps everything working).

- [ ] **Step 6: Commit**

```bash
git add src/runtime/data-store.js tests/unit/data-store.test.js
git commit -m "feat(data-store): strict resolver + .robin-home pointer (legacy fallback intact)"
```

---

### Task 1.5: Add the no-`fs.rename` invariant test

**Files:**
- Modify: `tests/unit/data-store.test.js`

- [ ] **Step 1: Add the invariant test**

Append to `tests/unit/data-store.test.js`:

```js
import { readFileSync as readSrc } from 'node:fs';
import { fileURLToPath } from 'node:url';

test('data-store.js never calls fs.rename — move uses copy+verify+delete', () => {
  const src = readSrc(
    fileURLToPath(new URL('../../src/runtime/data-store.js', import.meta.url)),
    'utf8',
  );
  // Allowed: writePointer uses renameSync for atomic pointer write — that's a
  // single-file atomic replace, not a directory move. Whitelist that one call.
  const renameCalls = (src.match(/\brename(Sync)?\s*\(/g) ?? []).length;
  assert.strictEqual(
    renameCalls,
    1,
    `expected exactly 1 renameSync call (in writePointer); found ${renameCalls}`,
  );
});
```

- [ ] **Step 2: Run the test — should pass already**

Run: `node --test --test-force-exit 'tests/unit/data-store.test.js'`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/unit/data-store.test.js
git commit -m "test(data-store): assert no fs.rename for directory moves"
```

---

## Phase 2 — Host-integrations manifest

### Task 2.1: `recordHostTouchpoint` with flock and replace semantics

**Files:**
- Modify: `src/runtime/data-store.js`
- Create: `tests/unit/manifest.test.js`

- [ ] **Step 1: Add failing tests**

Create `tests/unit/manifest.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ensureHome,
  paths,
  readHostIntegrations,
  recordHostTouchpoint,
  forgetHostTouchpoint,
} from '../../src/runtime/data-store.js';

function withHome(t, fn) {
  const home = mkdtempSync(join(tmpdir(), 'robin-home-'));
  const prev = process.env.ROBIN_HOME;
  process.env.ROBIN_HOME = home;
  return Promise.resolve(fn(home)).finally(() => {
    if (prev) process.env.ROBIN_HOME = prev;
    else delete process.env.ROBIN_HOME;
    rmSync(home, { recursive: true, force: true });
  });
}

test('recordHostTouchpoint appends entry and runs writeFn first', async () => {
  await withHome(test, async (home) => {
    await ensureHome();
    const targetFile = join(home, 'fake-host-file.json');
    let writeFnCalled = false;
    await recordHostTouchpoint(
      { kind: 'claude-hooks', path: targetFile, owned: [{ phase: 'PreToolUse' }] },
      () => {
        writeFnCalled = true;
        writeFileSync(targetFile, '{"hooks": "fake"}');
      },
    );
    assert.strictEqual(writeFnCalled, true);
    const mf = await readHostIntegrations();
    assert.strictEqual(mf.entries.length, 1);
    assert.strictEqual(mf.entries[0].kind, 'claude-hooks');
    assert.strictEqual(mf.entries[0].path, targetFile);
    assert.deepStrictEqual(mf.entries[0].owned, [{ phase: 'PreToolUse' }]);
  });
});

test('recordHostTouchpoint replaces entry by (kind, path)', async () => {
  await withHome(test, async () => {
    await ensureHome();
    await recordHostTouchpoint(
      { kind: 'claude-hooks', path: '/x', owned: [{ phase: 'A' }] },
      () => {},
    );
    await recordHostTouchpoint(
      { kind: 'claude-hooks', path: '/x', owned: [{ phase: 'B' }] },
      () => {},
    );
    const mf = await readHostIntegrations();
    assert.strictEqual(mf.entries.length, 1);
    assert.deepStrictEqual(mf.entries[0].owned, [{ phase: 'B' }]);
  });
});

test('recordHostTouchpoint: writeFn throw leaves manifest untouched', async () => {
  await withHome(test, async () => {
    await ensureHome();
    await recordHostTouchpoint({ kind: 'k1', path: '/p' }, () => {});
    await assert.rejects(
      () =>
        recordHostTouchpoint({ kind: 'k2', path: '/q' }, () => {
          throw new Error('boom');
        }),
      /boom/,
    );
    const mf = await readHostIntegrations();
    assert.strictEqual(mf.entries.length, 1);
    assert.strictEqual(mf.entries[0].kind, 'k1');
  });
});

test('forgetHostTouchpoint removes matching entry', async () => {
  await withHome(test, async () => {
    await ensureHome();
    await recordHostTouchpoint({ kind: 'k', path: '/p1' }, () => {});
    await recordHostTouchpoint({ kind: 'k', path: '/p2' }, () => {});
    const r = await forgetHostTouchpoint({ kind: 'k', path: '/p1' });
    assert.strictEqual(r.removed, 1);
    const mf = await readHostIntegrations();
    assert.strictEqual(mf.entries.length, 1);
    assert.strictEqual(mf.entries[0].path, '/p2');
  });
});

test('forgetHostTouchpoint is idempotent', async () => {
  await withHome(test, async () => {
    await ensureHome();
    const r = await forgetHostTouchpoint({ kind: 'k', path: '/missing' });
    assert.strictEqual(r.removed, 0);
  });
});
```

- [ ] **Step 2: Run the tests to verify failure**

Run: `node --test --test-force-exit 'tests/unit/manifest.test.js'`
Expected: FAIL — `recordHostTouchpoint` / `readHostIntegrations` / `forgetHostTouchpoint` not exported.

- [ ] **Step 3: Implement the manifest helpers**

Append to `src/runtime/data-store.js`:

```js
// ----- host-integrations manifest -----

import { closeSync, openSync, readFileSync as readFileSyncFs } from 'node:fs';
// Node ≥22 has fs.lockSync via newer APIs; we use a portable advisory file lock
// implemented by creating <robin-home>/.manifest.lock as an exclusive open.

const MANIFEST_VERSION = 1;
const LOCK_TIMEOUT_MS = 5000;

async function acquireManifestLock() {
  const lockPath = paths.data.manifestLock();
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      // O_EXCL on open: fails if the file already exists.
      const fd = openSync(lockPath, 'wx');
      return { fd, lockPath };
    } catch (e) {
      if (e.code === 'EEXIST') {
        await new Promise((r) => setTimeout(r, 25));
        continue;
      }
      throw e;
    }
  }
  throw new Error(`could not acquire manifest lock at ${lockPath} within ${LOCK_TIMEOUT_MS}ms`);
}

function releaseManifestLock(handle) {
  try {
    closeSync(handle.fd);
  } catch {
    // ignore
  }
  try {
    unlinkSync(handle.lockPath);
  } catch {
    // ignore
  }
}

function readManifestRaw() {
  // Includes the one-shot migration from installed-hooks.json.
  const p = paths.data.hostIntegrations();
  const legacyPath = join(robinHome(), 'installed-hooks.json');
  if (existsSync(p)) {
    try {
      const parsed = JSON.parse(readFileSyncFs(p, 'utf8'));
      if (parsed?.version !== MANIFEST_VERSION) {
        throw new Error(
          `host-integrations.json version ${parsed?.version} is not supported ` +
            `(expected ${MANIFEST_VERSION})`,
        );
      }
      return parsed;
    } catch (e) {
      throw new Error(`malformed ${p}: ${e.message}`);
    }
  }
  // Legacy migration: installed-hooks.json present?
  if (existsSync(legacyPath)) {
    const legacy = JSON.parse(readFileSyncFs(legacyPath, 'utf8'));
    const entries = [];
    if (Array.isArray(legacy?.claude)) {
      entries.push({
        kind: 'claude-hooks',
        path: join(process.env.HOME ?? '', '.claude/settings.json'),
        owned: legacy.claude,
        installedAt: new Date().toISOString(),
      });
    }
    if (Array.isArray(legacy?.gemini)) {
      entries.push({
        kind: 'gemini-hooks',
        path: join(process.env.HOME ?? '', '.gemini/settings.json'),
        owned: legacy.gemini,
        installedAt: new Date().toISOString(),
      });
    }
    return { version: MANIFEST_VERSION, updatedAt: new Date().toISOString(), entries };
  }
  return { version: MANIFEST_VERSION, updatedAt: new Date().toISOString(), entries: [] };
}

function writeManifestAtomic(manifest) {
  const p = paths.data.hostIntegrations();
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify(manifest, null, 2), { mode: 0o644 });
  renameSync(tmp, p);
}

export async function readHostIntegrations() {
  return readManifestRaw();
}

export async function recordHostTouchpoint(entry, writeFn) {
  if (!entry || typeof entry !== 'object' || typeof entry.kind !== 'string' || typeof entry.path !== 'string') {
    throw new TypeError('recordHostTouchpoint: entry must have { kind: string, path: string, ... }');
  }
  if (typeof writeFn !== 'function') {
    throw new TypeError('recordHostTouchpoint: writeFn must be a function');
  }
  // Run writeFn first; on throw, do not touch manifest or legacy file.
  await writeFn();
  const handle = await acquireManifestLock();
  try {
    const manifest = readManifestRaw();
    const idx = manifest.entries.findIndex(
      (e) => e.kind === entry.kind && e.path === entry.path,
    );
    const stored = { ...entry, installedAt: entry.installedAt ?? new Date().toISOString() };
    if (idx === -1) manifest.entries.push(stored);
    else manifest.entries[idx] = stored;
    manifest.updatedAt = new Date().toISOString();
    writeManifestAtomic(manifest);
    // Legacy migration: if we just produced a unified manifest and legacy
    // installed-hooks.json still exists, delete it (same locked window).
    const legacyPath = join(robinHome(), 'installed-hooks.json');
    if (existsSync(legacyPath)) {
      unlinkSync(legacyPath);
    }
  } finally {
    releaseManifestLock(handle);
  }
}

export async function forgetHostTouchpoint({ kind, path }) {
  const handle = await acquireManifestLock();
  try {
    const manifest = readManifestRaw();
    const before = manifest.entries.length;
    manifest.entries = manifest.entries.filter((e) => !(e.kind === kind && e.path === path));
    const removed = before - manifest.entries.length;
    if (removed > 0) {
      manifest.updatedAt = new Date().toISOString();
      writeManifestAtomic(manifest);
    }
    return { removed };
  } finally {
    releaseManifestLock(handle);
  }
}
```

- [ ] **Step 4: Run the tests to verify pass**

Run: `node --test --test-force-exit 'tests/unit/manifest.test.js'`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/runtime/data-store.js tests/unit/manifest.test.js
git commit -m "feat(data-store): host-integrations.json manifest with flock + replace semantics"
```

---

### Task 2.2: Legacy `installed-hooks.json` migration test

**Files:**
- Create: `tests/integration/legacy-installed-hooks.test.js`

- [ ] **Step 1: Write the test**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ensureHome,
  paths,
  readHostIntegrations,
  recordHostTouchpoint,
} from '../../src/runtime/data-store.js';

test('legacy installed-hooks.json is migrated on first manifest write and then deleted', async () => {
  const home = mkdtempSync(join(tmpdir(), 'robin-home-'));
  const prev = process.env.ROBIN_HOME;
  process.env.ROBIN_HOME = home;
  try {
    await ensureHome();
    const legacyPath = join(home, 'installed-hooks.json');
    writeFileSync(
      legacyPath,
      JSON.stringify({
        claude: [{ phase: 'PreToolUse', matcher: 'Bash', command: '/abs/bin/robin-hook.sh bash-policy' }],
        gemini: [{ phase: 'Stop', command: '/abs/bin/robin-hook.sh stop' }],
      }),
    );
    // First read should surface the legacy entries.
    const before = await readHostIntegrations();
    assert.strictEqual(before.entries.length, 2);
    // Doing the migration on first write: the legacy file is removed in the
    // same locked transaction as the first recordHostTouchpoint call.
    await recordHostTouchpoint(
      { kind: 'launchd-plist', path: '/x', expectedHome: home, label: 'l' },
      () => {},
    );
    assert.strictEqual(existsSync(legacyPath), false, 'legacy file should be deleted after first write');
    const after = await readHostIntegrations();
    assert.strictEqual(after.entries.length, 3);
    const kinds = after.entries.map((e) => e.kind).sort();
    assert.deepStrictEqual(kinds, ['claude-hooks', 'gemini-hooks', 'launchd-plist']);
  } finally {
    if (prev) process.env.ROBIN_HOME = prev;
    else delete process.env.ROBIN_HOME;
    rmSync(home, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the test to verify pass**

Run: `node --test --test-force-exit 'tests/integration/legacy-installed-hooks.test.js'`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/integration/legacy-installed-hooks.test.js
git commit -m "test(manifest): legacy installed-hooks.json one-shot migration"
```

---

## Phase 3 — Picker primitives

### Task 3.1: `radio()` helper in `prompts.js`

**Files:**
- Modify: `src/cli/prompts.js`
- Create: `tests/unit/prompts-radio.test.js`

- [ ] **Step 1: Write failing tests**

```js
// tests/unit/prompts-radio.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { radio } from '../../src/cli/prompts.js';

function fakeInput(answers) {
  let i = 0;
  return async () => answers[i++];
}

test('radio: default returned on empty input', async () => {
  const r = await radio({
    question: 'Pick',
    options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }],
    defaultIndex: 1,
    inputFn: fakeInput(['']),
  });
  assert.strictEqual(r, 'b');
});

test('radio: numeric selection', async () => {
  const r = await radio({
    question: 'Pick',
    options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }],
    defaultIndex: 0,
    inputFn: fakeInput(['2']),
  });
  assert.strictEqual(r, 'b');
});

test('radio: invalid then valid input reprompts', async () => {
  const r = await radio({
    question: 'Pick',
    options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }],
    defaultIndex: 0,
    inputFn: fakeInput(['z', '99', '1']),
  });
  assert.strictEqual(r, 'a');
});

test('radio: custom path option triggers customFn when picked', async () => {
  const r = await radio({
    question: 'Pick',
    options: [
      { value: 'a', label: 'A' },
      { value: '__custom__', label: 'Custom…', customFn: async () => '/my/path' },
    ],
    defaultIndex: 0,
    inputFn: fakeInput(['2']),
  });
  assert.strictEqual(r, '/my/path');
});
```

- [ ] **Step 2: Run the tests to verify failure**

Run: `node --test --test-force-exit 'tests/unit/prompts-radio.test.js'`
Expected: FAIL — `radio` not exported.

- [ ] **Step 3: Implement `radio()`**

Replace `src/cli/prompts.js` with:

```js
import readline from 'node:readline/promises';

export async function input(prompt) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(prompt);
  } finally {
    rl.close();
  }
}

export async function confirm(prompt) {
  const a = await input(`${prompt} [y/N] `);
  return /^y(es)?$/i.test(a.trim());
}

/**
 * Numbered radio prompt. Returns the resolved value.
 *
 * options: [{ value, label, description?, customFn? }]
 *  - If customFn is provided and the user picks that option, customFn is
 *    invoked and its resolved value becomes the radio's return.
 *
 * defaultIndex: 0-based index of the default option.
 * inputFn: function that returns a Promise<string> for a single line of input.
 *   Defaults to a readline prompt; injectable for tests.
 */
export async function radio({ question, options, defaultIndex = 0, inputFn = input }) {
  if (!Array.isArray(options) || options.length === 0) {
    throw new TypeError('radio: options must be a non-empty array');
  }
  for (;;) {
    const lines = [question, ''];
    options.forEach((opt, i) => {
      const tag = i === defaultIndex ? ' [default]' : '';
      lines.push(`  (${i + 1}) ${opt.label}${tag}`);
      if (opt.description) lines.push(`      ${opt.description}`);
    });
    lines.push('');
    console.log(lines.join('\n'));
    const raw = (await inputFn(`Choose [1-${options.length}, default ${defaultIndex + 1}]: `)).trim();
    let idx;
    if (raw === '') idx = defaultIndex;
    else {
      const n = Number.parseInt(raw, 10);
      if (Number.isNaN(n) || n < 1 || n > options.length) {
        console.error(`Invalid choice: ${raw}. Enter a number between 1 and ${options.length}.`);
        continue;
      }
      idx = n - 1;
    }
    const picked = options[idx];
    if (typeof picked.customFn === 'function') {
      return await picked.customFn();
    }
    return picked.value;
  }
}
```

- [ ] **Step 4: Run the tests to verify pass**

Run: `node --test --test-force-exit 'tests/unit/prompts-radio.test.js'`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/cli/prompts.js tests/unit/prompts-radio.test.js
git commit -m "feat(cli): add radio() prompt helper for the install picker"
```

---

## Phase 4 — Install flow

### Task 4.1: Discovery (scan known locations for Robin layouts)

**Files:**
- Modify: `src/runtime/data-store.js`
- Modify: `tests/unit/data-store.test.js`

- [ ] **Step 1: Write failing tests**

Append to `tests/unit/data-store.test.js`:

```js
import { discoverExistingHomes } from '../../src/runtime/data-store.js';

test('discoverExistingHomes: finds marker-bearing locations', async () => {
  const a = mkdtempSync(join(tmpdir(), 'robin-disco-a-'));
  const b = mkdtempSync(join(tmpdir(), 'robin-disco-b-'));
  // Place a marker in `a` only.
  writeFileSync(join(a, '.robin-data'), JSON.stringify({ version: 1, createdAt: '2026-05-09T00:00:00Z' }));
  try {
    const result = discoverExistingHomes({ candidates: [a, b] });
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].path, a);
    assert.strictEqual(result[0].kind, 'marker');
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});

test('discoverExistingHomes: finds legacy v2 layouts (db/CURRENT or secrets/.env)', async () => {
  const legacy = mkdtempSync(join(tmpdir(), 'robin-disco-legacy-'));
  mkdirSync(join(legacy, 'db'), { recursive: true });
  writeFileSync(join(legacy, 'db', 'CURRENT'), 'fake');
  try {
    const result = discoverExistingHomes({ candidates: [legacy] });
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].kind, 'legacy');
  } finally {
    rmSync(legacy, { recursive: true, force: true });
  }
});
```

Make sure `import { mkdirSync, writeFileSync } from 'node:fs';` is at the top.

- [ ] **Step 2: Run the tests to verify failure**

Run: `node --test --test-force-exit 'tests/unit/data-store.test.js'`
Expected: FAIL — `discoverExistingHomes` not exported.

- [ ] **Step 3: Implement `discoverExistingHomes`**

Append to `src/runtime/data-store.js`:

```js
import { homedir, statSync } from 'node:os';

function defaultDiscoveryCandidates() {
  return [
    join(_packageRoot, 'user-data'),
    join(homedir(), '.robin'),
    join(homedir(), 'Documents', 'Robin'),
  ];
}

export function discoverExistingHomes({ candidates = defaultDiscoveryCandidates() } = {}) {
  const out = [];
  for (const dir of candidates) {
    if (!existsSync(dir)) continue;
    const markerPath = join(dir, '.robin-data');
    if (existsSync(markerPath)) {
      out.push({ path: dir, kind: 'marker', lastUsed: safeMtime(dir) });
      continue;
    }
    // Legacy v2 layout: db/CURRENT (RocksDB) or secrets/.env present.
    if (existsSync(join(dir, 'db', 'CURRENT')) || existsSync(join(dir, 'secrets', '.env'))) {
      out.push({ path: dir, kind: 'legacy', lastUsed: safeMtime(dir) });
    }
  }
  return out;
}

function safeMtime(dir) {
  try {
    const s = statSync(dir);
    return s.mtime.toISOString();
  } catch {
    return null;
  }
}
```

Wait — `statSync` is from `node:fs`, not `node:os`. Fix the import:

```js
// At the top, where node:fs imports live:
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
// And remove statSync from the node:os import (which doesn't have it).
import { homedir } from 'node:os';
```

- [ ] **Step 4: Run the tests to verify pass**

Run: `node --test --test-force-exit 'tests/unit/data-store.test.js'`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/data-store.js tests/unit/data-store.test.js
git commit -m "feat(data-store): discoverExistingHomes scans for marker + legacy layouts"
```

---

### Task 4.2: Copy-verify-delete migration helper

**Files:**
- Create: `src/runtime/migrate-home.js`
- Create: `tests/integration/migrate-home.test.js`

- [ ] **Step 1: Write the failing test**

```js
// tests/integration/migrate-home.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateHome } from '../../src/runtime/migrate-home.js';

test('migrateHome: copies tree and preserves 0600 secrets mode, then deletes source on move', async () => {
  const src = mkdtempSync(join(tmpdir(), 'robin-src-'));
  const dst = join(mkdtempSync(join(tmpdir(), 'robin-dst-parent-')), 'home');
  mkdirSync(join(src, 'db'), { recursive: true });
  mkdirSync(join(src, 'secrets'), { recursive: true });
  writeFileSync(join(src, 'db', 'CURRENT'), 'rocksdb-current');
  writeFileSync(join(src, 'secrets', '.env'), 'KEY=v', { mode: 0o600 });
  writeFileSync(join(src, '.robin-data'), JSON.stringify({ version: 1, createdAt: 'x' }));

  await migrateHome({ from: src, to: dst, mode: 'move' });

  assert.ok(existsSync(join(dst, 'db', 'CURRENT')));
  assert.strictEqual(readFileSync(join(dst, 'db', 'CURRENT'), 'utf8'), 'rocksdb-current');
  assert.strictEqual(readFileSync(join(dst, 'secrets', '.env'), 'utf8'), 'KEY=v');
  const stat = statSync(join(dst, 'secrets', '.env'));
  assert.strictEqual(stat.mode & 0o777, 0o600);
  assert.strictEqual(existsSync(src), false, 'source must be gone after move');

  rmSync(dst, { recursive: true, force: true });
  rmSync(join(dst, '..'), { recursive: true, force: true });
});

test('migrateHome: copy mode keeps source intact', async () => {
  const src = mkdtempSync(join(tmpdir(), 'robin-src-'));
  const dst = join(mkdtempSync(join(tmpdir(), 'robin-dst-parent-')), 'home');
  mkdirSync(join(src, 'db'), { recursive: true });
  writeFileSync(join(src, 'db', 'CURRENT'), 'x');
  writeFileSync(join(src, '.robin-data'), JSON.stringify({ version: 1, createdAt: 'x' }));

  await migrateHome({ from: src, to: dst, mode: 'copy' });

  assert.ok(existsSync(join(dst, 'db', 'CURRENT')));
  assert.ok(existsSync(src), 'source must remain after copy');

  rmSync(src, { recursive: true, force: true });
  rmSync(dst, { recursive: true, force: true });
  rmSync(join(dst, '..'), { recursive: true, force: true });
});

test('migrateHome: copy failure leaves source intact and removes partial target', async () => {
  const src = mkdtempSync(join(tmpdir(), 'robin-src-'));
  writeFileSync(join(src, '.robin-data'), JSON.stringify({ version: 1, createdAt: 'x' }));
  // Target parent doesn't exist; we expect a clean failure.
  const dst = '/nonexistent-parent-robin-test/home';

  await assert.rejects(
    () => migrateHome({ from: src, to: dst, mode: 'move' }),
    /ENOENT|migrateHome/,
  );
  assert.ok(existsSync(src), 'source must remain after failed migrate');

  rmSync(src, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run the tests to verify failure**

Run: `node --test --test-force-exit 'tests/integration/migrate-home.test.js'`
Expected: FAIL — `migrate-home.js` does not exist.

- [ ] **Step 3: Implement `migrateHome`**

Create `src/runtime/migrate-home.js`:

```js
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Copy-verify-delete migration of a Robin home directory.
 *
 * - Always copies first (via `cp -a` for mode/owner/timestamp preservation).
 * - Verifies the .robin-data marker exists at the target after copy.
 * - Only on success (mode='move'): rm -rf the source.
 * - On any failure: delete the partial target, leave source intact, throw.
 *
 * NEVER uses fs.rename — explicit invariant for cross-filesystem safety.
 *
 * @param {{ from: string, to: string, mode: 'move'|'copy' }} args
 */
export async function migrateHome({ from, to, mode }) {
  if (!from || !to || !mode) {
    throw new TypeError('migrateHome: { from, to, mode } are required');
  }
  if (mode !== 'move' && mode !== 'copy') {
    throw new TypeError(`migrateHome: mode must be 'move' or 'copy' (got ${mode})`);
  }
  if (!existsSync(from)) {
    throw new Error(`migrateHome: source does not exist: ${from}`);
  }
  // Make sure parent of target exists. We do NOT create the target itself —
  // cp -a will populate it.
  const parent = dirname(to);
  if (!existsSync(parent)) {
    throw new Error(`migrateHome: target parent does not exist: ${parent}`);
  }
  // Copy.
  const cp = spawnSync('cp', ['-a', `${from}/`, to], { stdio: 'pipe' });
  if (cp.status !== 0) {
    // Partial target cleanup.
    if (existsSync(to)) rmSync(to, { recursive: true, force: true });
    const stderr = cp.stderr?.toString('utf8').trim() ?? '(no stderr)';
    throw new Error(`migrateHome: cp -a failed (exit ${cp.status}): ${stderr}`);
  }
  // Verify marker at target.
  if (!existsSync(`${to}/.robin-data`)) {
    rmSync(to, { recursive: true, force: true });
    throw new Error(`migrateHome: verification failed — .robin-data missing at ${to}`);
  }
  // On move, remove source.
  if (mode === 'move') {
    rmSync(from, { recursive: true, force: true });
  }
}
```

- [ ] **Step 4: Run the tests to verify pass**

Run: `node --test --test-force-exit 'tests/integration/migrate-home.test.js'`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/runtime/migrate-home.js tests/integration/migrate-home.test.js
git commit -m "feat(data-store): copy-verify-delete migrateHome helper"
```

---

### Task 4.3: Picker integration in `install.js`

**Files:**
- Modify: `src/cli/commands/install.js`
- Create: `tests/integration/install-first.test.js`

This task wires the picker into the install command, replacing the existing `detectLegacyHome` step.

- [ ] **Step 1: Write the integration test**

```js
// tests/integration/install-first.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pickHome } from '../../src/cli/commands/install.js';

test('pickHome: numeric selection of option 3 returns ~/Documents/Robin', async () => {
  const fakeHomedir = mkdtempSync(join(tmpdir(), 'robin-fake-home-'));
  try {
    const result = await pickHome({
      packageRoot: '/fake/pkg',
      homedir: fakeHomedir,
      inputFn: (async function* () {
        yield '3';
      })().next.bind((async function* () { yield '3'; })()),
    });
    assert.strictEqual(result, join(fakeHomedir, 'Documents', 'Robin'));
  } finally {
    rmSync(fakeHomedir, { recursive: true, force: true });
  }
});

test('pickHome: default (empty input) returns option 1 (package_root/user-data)', async () => {
  const fakeHomedir = mkdtempSync(join(tmpdir(), 'robin-fake-home-'));
  try {
    const result = await pickHome({
      packageRoot: '/fake/pkg',
      homedir: fakeHomedir,
      inputFn: async () => '',
    });
    assert.strictEqual(result, '/fake/pkg/user-data');
  } finally {
    rmSync(fakeHomedir, { recursive: true, force: true });
  }
});

test('pickHome: custom path option asks for a path', async () => {
  const fakeHomedir = mkdtempSync(join(tmpdir(), 'robin-fake-home-'));
  const targetParent = mkdtempSync(join(tmpdir(), 'robin-custom-parent-'));
  const target = join(targetParent, 'my-robin');
  try {
    // Two inputs: "4" picks custom, then the custom path.
    let i = 0;
    const replies = ['4', target];
    const result = await pickHome({
      packageRoot: '/fake/pkg',
      homedir: fakeHomedir,
      inputFn: async () => replies[i++],
    });
    assert.strictEqual(result, target);
  } finally {
    rmSync(fakeHomedir, { recursive: true, force: true });
    rmSync(targetParent, { recursive: true, force: true });
  }
});
```

Note: the inputFn signatures shown for the first test are awkward — simplify by using a closure over an array. Replace the first test with:

```js
test('pickHome: numeric selection of option 3 returns ~/Documents/Robin', async () => {
  const fakeHomedir = mkdtempSync(join(tmpdir(), 'robin-fake-home-'));
  try {
    const replies = ['3'];
    let i = 0;
    const result = await pickHome({
      packageRoot: '/fake/pkg',
      homedir: fakeHomedir,
      inputFn: async () => replies[i++],
    });
    assert.strictEqual(result, join(fakeHomedir, 'Documents', 'Robin'));
  } finally {
    rmSync(fakeHomedir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the test to verify failure**

Run: `node --test --test-force-exit 'tests/integration/install-first.test.js'`
Expected: FAIL — `pickHome` not exported.

- [ ] **Step 3: Add `pickHome` to `install.js`**

Open `src/cli/commands/install.js`. Add the import for `radio` at the top:

```js
import { radio, input } from '../prompts.js';
```

And add the `pickHome` function (above the `install` export):

```js
export async function pickHome({ packageRoot, homedir, inputFn }) {
  const options = [
    {
      value: join(packageRoot, 'user-data'),
      label: 'Inside the package',
      description: `${join(packageRoot, 'user-data')} (moves with the package directory)`,
    },
    {
      value: join(homedir, '.robin'),
      label: 'Hidden in your home dir',
      description: join(homedir, '.robin'),
    },
    {
      value: join(homedir, 'Documents', 'Robin'),
      label: 'Visible in Documents',
      description: join(homedir, 'Documents', 'Robin'),
    },
    {
      value: '__custom__',
      label: 'Custom path…',
      customFn: async () => {
        // Loop until the user gives a usable path.
        for (;;) {
          const raw = (await inputFn('Custom path: ')).trim();
          if (!raw) {
            console.error('Empty path; try again.');
            continue;
          }
          const resolved = resolve(raw);
          const parent = dirname(resolved);
          if (!existsSync(parent)) {
            console.error(`Parent directory does not exist: ${parent}. Create it first.`);
            continue;
          }
          return resolved;
        }
      },
    },
  ];
  return await radio({
    question: 'Welcome to Robin. Where should Robin store your data?',
    options,
    defaultIndex: 0,
    inputFn,
  });
}
```

Make sure these imports are present at the top of `install.js`:

```js
import { resolve, dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
```

- [ ] **Step 4: Run the test to verify pass**

Run: `node --test --test-force-exit 'tests/integration/install-first.test.js'`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/install.js tests/integration/install-first.test.js
git commit -m "feat(install): pickHome interactive picker"
```

---

### Task 4.4: Wire picker + discovery + migration into `install`

**Files:**
- Modify: `src/cli/commands/install.js`
- Create: `tests/integration/install-existing-data.test.js`

This rewrites the top of the `install()` function to do home selection before any other step.

- [ ] **Step 1: Write the integration test for the move case**

```js
// tests/integration/install-existing-data.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateHome } from '../../src/runtime/migrate-home.js';
import { ensureHome, readMarker } from '../../src/runtime/data-store.js';

test('end-to-end: pre-seeded data at A is moved to B; .robin-data preserved; 0600 mode preserved', async () => {
  const A = mkdtempSync(join(tmpdir(), 'robin-A-'));
  const Bparent = mkdtempSync(join(tmpdir(), 'robin-B-parent-'));
  const B = join(Bparent, 'Robin');
  // Seed A with secrets at 0600 and a marker.
  mkdirSync(join(A, 'secrets'), { recursive: true });
  mkdirSync(join(A, 'db'), { recursive: true });
  writeFileSync(join(A, 'secrets', '.env'), 'K=v', { mode: 0o600 });
  writeFileSync(join(A, 'db', 'CURRENT'), 'rocksdb');
  writeFileSync(join(A, '.robin-data'), JSON.stringify({ version: 1, createdAt: 'x' }));
  try {
    await migrateHome({ from: A, to: B, mode: 'move' });
    assert.strictEqual(existsSync(A), false);
    assert.strictEqual(readFileSync(join(B, 'secrets', '.env'), 'utf8'), 'K=v');
    assert.strictEqual(statSync(join(B, 'secrets', '.env')).mode & 0o777, 0o600);
    assert.strictEqual(readFileSync(join(B, 'db', 'CURRENT'), 'utf8'), 'rocksdb');
    assert.ok(existsSync(join(B, '.robin-data')));
  } finally {
    rmSync(Bparent, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the test to verify it passes (the helper is built)**

Run: `node --test --test-force-exit 'tests/integration/install-existing-data.test.js'`
Expected: PASS — this test only exercises the migration helper end-to-end. The full install-command wiring is tested via `install-kevin-rollout.test.js` (Task 12.x) where the command runs against a real tmpdir.

- [ ] **Step 3: Wire `pickHome` + discovery + migration into the `install` command**

In `src/cli/commands/install.js`, replace `detectLegacyHome` with a new `chooseHome` step. Replace lines from the `// 1. Detect legacy ~/.robin/` comment through the `// 2. Reinstall short-circuit` block.

New imports needed at the top:
```js
import {
  discoverExistingHomes,
  ensureHome,
  pointerExists,
  readPointer,
  writePointer,
} from '../../runtime/data-store.js';
import { migrateHome } from '../../runtime/migrate-home.js';
```

(Keep existing imports for `paths`, `packageRootDir`.)

Replace `detectLegacyHome` (lines ~41–62) with `chooseHome`:

```js
async function chooseHome({ prompt, interactive, args, homeFlag }) {
  // If already installed and not relocating, short-circuit.
  if (pointerExists() && !args.flags.relocate && !args.flags.repair) {
    const p = readPointer();
    return { home: p.home, action: 'reuse' };
  }
  const packageRoot = packageRootDir();
  const homeDir = homedir();
  // Non-interactive path.
  if (homeFlag) {
    return { home: resolve(homeFlag), action: 'picked' };
  }
  if (!interactive) {
    return { home: join(packageRoot, 'user-data'), action: 'picked-default' };
  }
  // Discovery: are there other Robin layouts on disk?
  const found = discoverExistingHomes();
  // If discovery finds the pointer-target equivalents, those should still
  // be offered. Reinstall recovery: pointer absent → present discovered ones.
  if (!pointerExists() && found.length > 0) {
    const reinstallOptions = found.map((f) => ({
      value: f.path,
      label: f.path,
      description: `${f.kind === 'marker' ? 'Robin data' : 'legacy v2 layout'}, last used ${f.lastUsed ?? 'unknown'}`,
    }));
    reinstallOptions.push({
      value: '__fresh__',
      label: 'Set up fresh (show picker)',
    });
    const choice = await radio({
      question: 'This Robin install has no recorded data location. Scanning known locations…\n\nFound:',
      options: reinstallOptions,
      defaultIndex: 0,
      inputFn: prompt,
    });
    if (choice !== '__fresh__') {
      return { home: choice, action: 'recovered' };
    }
  }
  const chosen = await pickHome({ packageRoot, homedir: homeDir, inputFn: prompt });
  return { home: chosen, action: 'picked' };
}
```

Then inside the `install` function body, replace the existing legacy-detection block (around lines 238–248 in the current file) with:

```js
  // 1. Choose / recover / reuse the home.
  const homeFlag = typeof args.flags.home === 'string' ? args.flags.home : null;
  const { home, action } = await chooseHome({ prompt, interactive, args, homeFlag });
  process.env.ROBIN_HOME = home;   // make data-store resolve to it for the rest of install

  // 2. Existing-data migration (only if we have a chosen target and a known
  // source that differs).
  const found = discoverExistingHomes().filter((f) => f.path !== home);
  if (found.length > 0 && action === 'picked' && interactive) {
    const sources = found.map((f) => ({
      value: f.path,
      label: `${f.path} (${f.kind}, last used ${f.lastUsed ?? 'unknown'})`,
    }));
    sources.push({ value: '__skip__', label: 'Ignore — start fresh; existing left untouched' });
    const sourcePick = await radio({
      question: 'Existing Robin data found:',
      options: sources,
      defaultIndex: 0,
      inputFn: prompt,
    });
    if (sourcePick !== '__skip__') {
      const modePick = await radio({
        question: 'What should we do with it?',
        options: [
          { value: 'move', label: `Move to ${home}` },
          { value: 'copy', label: `Copy to ${home} (original kept)` },
          { value: 'abort', label: 'Abort install' },
        ],
        defaultIndex: 0,
        inputFn: prompt,
      });
      if (modePick === 'abort') {
        console.error('install aborted by user');
        process.exit(1);
      }
      // The chosen home should be created if missing — migrateHome's cp -a
      // populates the *target*, which must not already exist.
      if (existsSync(home)) {
        console.error(`target ${home} already exists; refusing to overwrite. Move it aside and re-run.`);
        process.exit(1);
      }
      await migrateHome({ from: sourcePick, to: home, mode: modePick });
    }
  }

  // 3. Ensure home tree + marker.
  await ensureHome();
```

Then **after** the embedder profile/migrations/hooks steps complete near the bottom of the `install` function, add the pointer-file write as the final atomic step:

```js
  // N. Write the pointer last, so partial failures don't leave a half-pointed install.
  writePointer({ home, installedBy: `robin install ${process.env.npm_package_version ?? 'unknown'}` });
  console.log(`Robin home is at: ${home}`);
```

(Place it after `installHooksStep` and the MCP supervise step, but before any final summary `console.log`.)

- [ ] **Step 4: Run the full test suite to make sure nothing broke**

Run: `node --test --test-force-exit 'tests/**/*.test.js' 2>&1 | tail -10`
Expected: All pass.

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/install.js tests/integration/install-existing-data.test.js
git commit -m "feat(install): wire picker + discovery + migration + .robin-home write"
```

---

### Task 4.5: Legacy-data-without-marker discovery (Kevin's exact case)

**Files:**
- Create: `tests/integration/install-legacy-data-without-marker.test.js`

The discovery code already handles this (Task 4.1 step 3, the "legacy" branch). This task adds the regression test.

- [ ] **Step 1: Write the test**

```js
// tests/integration/install-legacy-data-without-marker.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverExistingHomes } from '../../src/runtime/data-store.js';

test('discoverExistingHomes finds a legacy v2 layout (db/CURRENT) without marker', () => {
  const dir = mkdtempSync(join(tmpdir(), 'robin-legacy-'));
  mkdirSync(join(dir, 'db'), { recursive: true });
  writeFileSync(join(dir, 'db', 'CURRENT'), 'rocksdb');
  try {
    const result = discoverExistingHomes({ candidates: [dir] });
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].kind, 'legacy');
    assert.strictEqual(result[0].path, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('discoverExistingHomes finds a legacy v2 layout (secrets/.env) without marker', () => {
  const dir = mkdtempSync(join(tmpdir(), 'robin-legacy-'));
  mkdirSync(join(dir, 'secrets'), { recursive: true });
  writeFileSync(join(dir, 'secrets', '.env'), 'X=y', { mode: 0o600 });
  try {
    const result = discoverExistingHomes({ candidates: [dir] });
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].kind, 'legacy');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the tests**

Run: `node --test --test-force-exit 'tests/integration/install-legacy-data-without-marker.test.js'`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/integration/install-legacy-data-without-marker.test.js
git commit -m "test(install): regression for legacy v2 layout discovery"
```

---

## Phase 5 — Plist/systemd integration

### Task 5.1: `launchd-plist.js` — derive logs path from resolved home

**Files:**
- Modify: `src/install/launchd-plist.js`

- [ ] **Step 1: Read the current file**

```bash
cat src/install/launchd-plist.js
```

You'll see `${home}/.robin/logs/daemon.log` strings on lines 26 and 28. These are bugs: `home` here is `homedir()`, not Robin home, so logs end up in `~/.robin/logs/`.

- [ ] **Step 2: Replace the function**

Replace `src/install/launchd-plist.js` contents with:

```js
import { paths } from '../runtime/data-store.js';

/**
 * Generate launchd plist XML for the Robin daemon.
 *
 * @param {{ packageRoot: string, robinHome: string }} args
 * @returns {string} plist XML
 */
export function buildLaunchdPlist({ packageRoot, robinHome }) {
  // We bake the chosen home so the daemon is decoupled from .robin-home
  // and from the package being present on disk.
  const logPath = `${robinHome}/cache/logs/daemon.log`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>io.robin-assistant.mcp</string>
  <key>ProgramArguments</key>
  <array>
    <string>${packageRoot}/bin/robin</string>
    <string>mcp</string>
    <string>start</string>
    <string>--foreground</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${process.env.HOME ?? ''}</string>
    <key>ROBIN_HOME</key>
    <string>${robinHome}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${logPath}</string>
  <key>StandardErrorPath</key>
  <string>${logPath}</string>
</dict>
</plist>
`;
}
```

(If the existing file exports something with a different name, preserve the export name and adjust callers. Check existing `manifest.js` to see which function is called.)

- [ ] **Step 3: Update callers**

```bash
grep -rn --include='*.js' "from '.*launchd-plist'" src
```

Update the import to match. Likely `src/install/manifest.js` and `src/cli/commands/mcp-install.js`.

- [ ] **Step 4: Verify**

Run: `node --test --test-force-exit 'tests/**/*.test.js' 2>&1 | tail -10`
Expected: All pass. (Existing tests may need light tweaks if they snapshot the plist; update them to assert the new fields.)

- [ ] **Step 5: Commit**

```bash
git add src/install/launchd-plist.js src/install/manifest.js src/cli/commands/mcp-install.js
git commit -m "fix(launchd): bake ROBIN_HOME and logs path; remove ~/.robin/logs literal"
```

---

### Task 5.2: `systemd-unit.js` — Environment=ROBIN_HOME + logs path

If `src/install/systemd-unit.js` doesn't exist yet, create it. If it does, modify it mirroring Task 5.1.

**Files:**
- Create or modify: `src/install/systemd-unit.js`

- [ ] **Step 1: Check whether the file exists**

```bash
ls src/install/systemd-unit.js 2>/dev/null || echo "does not exist"
```

- [ ] **Step 2: Create or update**

If creating from scratch, write `src/install/systemd-unit.js`:

```js
/**
 * Generate a systemd --user unit file for the Robin daemon.
 *
 * @param {{ packageRoot: string, robinHome: string }} args
 * @returns {string} unit file content
 */
export function buildSystemdUnit({ packageRoot, robinHome }) {
  return `[Unit]
Description=Robin MCP daemon
After=default.target

[Service]
Type=simple
Environment=ROBIN_HOME=${robinHome}
ExecStart=${packageRoot}/bin/robin mcp start --foreground
Restart=on-failure
StandardOutput=append:${robinHome}/cache/logs/daemon.log
StandardError=append:${robinHome}/cache/logs/daemon.log

[Install]
WantedBy=default.target
`;
}
```

If updating, preserve the function signature and replace the body with the above template.

- [ ] **Step 3: Find callers and wire `robinHome` through**

```bash
grep -rn --include='*.js' "systemd-unit" src
```

Update each caller to pass `robinHome` (which is the chosen home returned from `chooseHome` in `install.js`).

- [ ] **Step 4: Verify**

Run: `node --test --test-force-exit 'tests/**/*.test.js' 2>&1 | tail -10`
Expected: All pass.

- [ ] **Step 5: Commit**

```bash
git add src/install/systemd-unit.js src/install/manifest.js src/cli/commands/mcp-install.js
git commit -m "feat(systemd): bake ROBIN_HOME + logs path into unit"
```

---

### Task 5.3: Record plist/systemd via `recordHostTouchpoint` in `mcp-install.js`

**Files:**
- Modify: `src/cli/commands/mcp-install.js`
- Modify: `src/cli/commands/mcp-uninstall.js`

- [ ] **Step 1: Read `mcp-install.js`**

```bash
sed -n '100,140p' src/cli/commands/mcp-install.js
```

Identify where the plist is written. It will be a `writeFileSync(plistPath, ...)` call.

- [ ] **Step 2: Wrap the plist write with `recordHostTouchpoint`**

Replace the direct `writeFileSync` for the plist with:

```js
import { recordHostTouchpoint } from '../../runtime/data-store.js';
import { robinHome } from '../../runtime/data-store.js';

// ... inside the install function, where it currently does writeFileSync(plistPath, content):
await recordHostTouchpoint(
  {
    kind: 'launchd-plist',
    path: plistPath,
    expectedHome: robinHome(),
    label: 'io.robin-assistant.mcp',
  },
  () => {
    writeFileSync(plistPath, content, { mode: 0o644 });
  },
);
```

Mirror for systemd:

```js
await recordHostTouchpoint(
  {
    kind: 'systemd-unit',
    path: unitPath,
    expectedHome: robinHome(),
    unit: 'robin-mcp.service',
  },
  () => {
    writeFileSync(unitPath, content, { mode: 0o644 });
  },
);
```

- [ ] **Step 3: Mirror in `mcp-uninstall.js` using `forgetHostTouchpoint`**

Where `mcp-uninstall.js` unlinks the plist, replace with:

```js
import { forgetHostTouchpoint } from '../../runtime/data-store.js';

// ... where plist is unlinked:
unlinkSync(plistPath);
await forgetHostTouchpoint({ kind: 'launchd-plist', path: plistPath });
```

(And mirror for systemd.)

- [ ] **Step 4: Run the tests**

Run: `node --test --test-force-exit 'tests/**/*.test.js' 2>&1 | tail -10`
Expected: All pass.

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/mcp-install.js src/cli/commands/mcp-uninstall.js
git commit -m "feat(mcp): record plist/systemd via host-integrations manifest"
```

---

## Phase 6 — Hooks-settings migration

### Task 6.1: `hooks-settings.js` uses `recordHostTouchpoint`

**Files:**
- Modify: `src/install/hooks-settings.js`

This replaces the private `installed-hooks.json` writer with calls into the unified manifest.

- [ ] **Step 1: Open `src/install/hooks-settings.js` and locate `manifestPath()` and its callers**

Lines ~130 onward. The function `installHooksToSettings` currently calls `atomicWriteJson(mPath, manifest)` near line 195. The whole concept of "private manifest" goes away.

- [ ] **Step 2: Replace the write path**

In `installHooksToSettings`:

- Remove the local `manifest` object accumulation, `manifestPath()`, and the `atomicWriteJson(mPath, manifest)` call.
- For each host (claude, gemini), after the settings file is written, call:

```js
import { recordHostTouchpoint } from '../runtime/data-store.js';

// ... inside the loop, replace the existing settings write with:
await recordHostTouchpoint(
  {
    kind: `${host.name}-hooks`,        // 'claude-hooks' or 'gemini-hooks'
    path: settingsPath,
    owned,                              // the array of {phase, matcher?, command}
    installedAt: new Date().toISOString(),
  },
  () => {
    atomicWriteJson(settingsPath, settings);
  },
);
```

- [ ] **Step 3: Replace `uninstallHooksFromSettings` to read from the unified manifest**

```js
import { forgetHostTouchpoint, readHostIntegrations } from '../runtime/data-store.js';

export async function uninstallHooksFromSettings({ homeDir, packageRoot }) {
  const removedByHost = {};
  const manifest = await readHostIntegrations();

  for (const host of HOSTS) {
    const entry = manifest.entries.find(
      (e) => e.kind === `${host.name}-hooks` && e.path === join(homeDir, host.settingsRel),
    );
    const settingsPath = join(homeDir, host.settingsRel);
    if (!entry || !existsSync(settingsPath)) {
      removedByHost[host.name] = 0;
      continue;
    }
    const read = readJsonOrEmpty(settingsPath);
    if (!read.ok) {
      process.stderr.write(`Robin: cannot parse ${settingsPath} during uninstall: ${read.reason}\n`);
      continue;
    }
    const settings = read.value;
    let removed = 0;
    for (const owned of entry.owned ?? []) {
      const phaseArr = settings.hooks?.[owned.phase];
      const r = removeCommandFromPhase(phaseArr, owned.command);
      removed += r.removed;
      if (Array.isArray(r.arr) && r.arr.length === 0) {
        delete settings.hooks?.[owned.phase];
      } else if (settings.hooks) {
        settings.hooks[owned.phase] = r.arr;
      }
    }
    if (settings.hooks && Object.keys(settings.hooks).length === 0) {
      delete settings.hooks;
    }
    atomicWriteJson(settingsPath, settings);
    await forgetHostTouchpoint({ kind: `${host.name}-hooks`, path: settingsPath });
    removedByHost[host.name] = removed;
  }
  return { removedByHost };
}
```

Remove the `readInstalledHooks` export — it's superseded by `readHostIntegrations`. Find callers and update them.

- [ ] **Step 4: Run the tests**

Run: `node --test --test-force-exit 'tests/**/*.test.js' 2>&1 | tail -10`
Expected: All pass. Some existing tests against `installed-hooks.json` may need updates to assert against `host-integrations.json` instead. Update them inline.

- [ ] **Step 5: Commit**

```bash
git add src/install/hooks-settings.js src tests
git commit -m "feat(hooks): drive Claude/Gemini hook install via unified manifest"
```

---

### Task 6.2: `hooks-disabled.txt` → `config.json.hooks.disabled`

**Files:**
- Modify: `src/runtime/config.js` (or wherever `hooks-disabled.txt` is read)
- Modify: any reader / writer of the flag file

- [ ] **Step 1: Find all references to `hooks-disabled.txt`**

```bash
grep -rln --include='*.js' "hooks-disabled" src tests
```

- [ ] **Step 2: For each reader, switch to `config.json.hooks.disabled`**

For a read site that looks like:
```js
const disabled = existsSync(join(paths.data.home(), 'hooks-disabled.txt'));
```

Change to:
```js
const cfg = (await readConfig()) ?? {};
const disabled = cfg?.hooks?.disabled === true;
```

For a write site that touches/unlinks the flag file, replace with `writeConfig({ ...cfg, hooks: { ...cfg?.hooks, disabled: <bool> } })`.

- [ ] **Step 3: Migration logic in `data-store.ensureHome`**

To migrate existing installs: if `<robin-home>/hooks-disabled.txt` exists when `ensureHome()` runs, set `config.json.hooks.disabled = true` and unlink the file. Edit `ensureHome` in `data-store.js`:

```js
export async function ensureHome() {
  const home = robinHome();
  for (const dir of [home, paths.data.db(), paths.data.secrets(), paths.data.cache(),
                     paths.data.logs(), paths.data.backup(), paths.data.upload()]) {
    mkdirSync(dir, { recursive: true });
  }
  const markerPath = paths.data.marker();
  if (!existsSync(markerPath)) {
    const payload = { version: MARKER_VERSION, createdAt: new Date().toISOString() };
    writeFileSync(markerPath, JSON.stringify(payload, null, 2), { mode: 0o644 });
  }
  // Migrate hooks-disabled.txt → config.json.hooks.disabled.
  const flagPath = join(home, 'hooks-disabled.txt');
  if (existsSync(flagPath)) {
    const cfgPath = paths.data.config();
    let cfg = {};
    if (existsSync(cfgPath)) {
      try {
        cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
      } catch {
        cfg = {};
      }
    }
    cfg.hooks = { ...(cfg.hooks ?? {}), disabled: true };
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), { mode: 0o644 });
    unlinkSync(flagPath);
  }
}
```

- [ ] **Step 4: Run tests**

Run: `node --test --test-force-exit 'tests/**/*.test.js' 2>&1 | tail -10`
Expected: All pass. Existing `hooks-disabled.test.js` and `hooks-toggle.test.js` may need to use config-based assertions instead.

- [ ] **Step 5: Commit**

```bash
git add src tests
git commit -m "refactor(hooks): fold hooks-disabled.txt into config.json.hooks.disabled"
```

---

## Phase 7 — Pre-commit migration

### Task 7.1: `pre-commit.js` uses `recordHostTouchpoint` / `forgetHostTouchpoint`

**Files:**
- Modify: `src/install/pre-commit.js`

- [ ] **Step 1: Open `src/install/pre-commit.js`**

Locate `installPreCommit` (line ~63) and `uninstallPreCommit` (line ~109).

- [ ] **Step 2: Wrap the install with `recordHostTouchpoint`**

Replace the `writeFileSync(tmp, hookContent(), {mode: 0o755}); renameSync(tmp, hookPath); chmodSync(hookPath, 0o755);` block (lines ~96–99) with:

```js
import { recordHostTouchpoint, forgetHostTouchpoint } from '../runtime/data-store.js';

await recordHostTouchpoint(
  {
    kind: 'git-precommit-hook',
    path: hookPath,
    marker: HOOK_MARKER,
    installedAt: new Date().toISOString(),
  },
  () => {
    const tmp = `${hookPath}.tmp`;
    writeFileSync(tmp, hookContent(), { mode: 0o755 });
    renameSync(tmp, hookPath);
    chmodSync(hookPath, 0o755);
  },
);
```

And in `uninstallPreCommit`, after `unlinkSync(hookPath)`:

```js
unlinkSync(hookPath);
await forgetHostTouchpoint({ kind: 'git-precommit-hook', path: hookPath });
```

- [ ] **Step 3: Run tests**

Run: `node --test --test-force-exit 'tests/**/*.test.js' 2>&1 | tail -10`
Expected: All pass.

- [ ] **Step 4: Commit**

```bash
git add src/install/pre-commit.js
git commit -m "feat(pre-commit): record hook installs via manifest"
```

---

## Phase 8 — Uninstall flow

### Task 8.1: Manifest-driven uninstall, best-effort

**Files:**
- Modify: `src/cli/commands/uninstall.js`
- Create: `tests/integration/uninstall-best-effort.test.js`

- [ ] **Step 1: Write the test**

```js
// tests/integration/uninstall-best-effort.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureHome, recordHostTouchpoint, readHostIntegrations } from '../../src/runtime/data-store.js';
import { uninstall } from '../../src/cli/commands/uninstall.js';

test('uninstall: best-effort completes even with one malformed host file', async () => {
  const home = mkdtempSync(join(tmpdir(), 'robin-home-'));
  const fakeClaudeDir = mkdtempSync(join(tmpdir(), 'robin-claude-'));
  const fakeSettings = join(fakeClaudeDir, 'settings.json');
  process.env.ROBIN_HOME = home;
  try {
    await ensureHome();
    writeFileSync(fakeSettings, 'not-json{{{');  // malformed
    await recordHostTouchpoint(
      { kind: 'claude-hooks', path: fakeSettings, owned: [] },
      () => {},   // no-op write
    );
    await uninstall([], {
      interactive: false,
      prompt: async () => 'k',
      stopDaemon: async () => {},
    });
    const after = await readHostIntegrations();
    // The malformed entry should have been "forgotten" (best-effort).
    assert.strictEqual(after.entries.length, 0);
  } finally {
    delete process.env.ROBIN_HOME;
    rmSync(home, { recursive: true, force: true });
    rmSync(fakeClaudeDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the test to verify failure**

Run: `node --test --test-force-exit 'tests/integration/uninstall-best-effort.test.js'`
Expected: FAIL — `uninstall` either doesn't exist with that signature or doesn't yet drive the manifest.

- [ ] **Step 3: Rewrite `src/cli/commands/uninstall.js`**

Full new contents:

```js
import { existsSync, rmSync, unlinkSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { spawnSync } from 'node:child_process';
import {
  deletePointer,
  forgetHostTouchpoint,
  paths,
  readHostIntegrations,
  robinHome,
} from '../../runtime/data-store.js';
import { uninstallHooksFromSettings } from '../../install/hooks-settings.js';
import { uninstallPreCommit } from '../../install/pre-commit.js';
import { input } from '../prompts.js';
import { parseArgs } from '../args.js';

async function defaultStopDaemon() {
  const m = await readHostIntegrations();
  for (const e of m.entries) {
    if (e.kind === 'launchd-plist' && platform() === 'darwin') {
      spawnSync('launchctl', ['bootout', `gui/${process.getuid()}`, e.path], { stdio: 'pipe' });
    }
    if (e.kind === 'systemd-unit' && platform() === 'linux') {
      spawnSync('systemctl', ['--user', 'stop', e.unit ?? 'robin-mcp.service'], { stdio: 'pipe' });
    }
  }
}

export async function uninstall(argv = [], deps = {}) {
  const args = parseArgs(argv);
  const strict = args.flags.strict === true;
  const purge = args.flags.purge === true;
  const yes = args.flags.yes === true;
  const interactive = typeof deps.interactive === 'boolean' ? deps.interactive : Boolean(process.stdin.isTTY);
  const prompt = deps.prompt ?? input;
  const stopDaemon = deps.stopDaemon ?? defaultStopDaemon;

  // 1. Stop the daemon.
  await stopDaemon();

  // 2. Walk the manifest in reverse-install order.
  let manifest;
  try {
    manifest = await readHostIntegrations();
  } catch (e) {
    console.error(`uninstall: cannot read host-integrations.json: ${e.message}`);
    if (strict) process.exit(1);
    manifest = { entries: [] };
  }
  const entries = [...manifest.entries].reverse();
  for (const entry of entries) {
    try {
      switch (entry.kind) {
        case 'claude-hooks':
        case 'gemini-hooks':
          // Use hooks-settings's removal logic (it handles malformed JSON).
          await uninstallHooksFromSettings({ homeDir: homedir() });
          break;
        case 'launchd-plist':
          if (existsSync(entry.path)) unlinkSync(entry.path);
          break;
        case 'systemd-unit':
          if (existsSync(entry.path)) unlinkSync(entry.path);
          spawnSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'pipe' });
          break;
        case 'git-precommit-hook':
          if (existsSync(entry.path)) {
            // pre-commit's uninstall checks for the marker, which is what we want.
            await uninstallPreCommit({ cwd: entry.path.replace(/\/\.git\/hooks\/pre-commit$/, '') });
          }
          break;
      }
      await forgetHostTouchpoint({ kind: entry.kind, path: entry.path });
    } catch (err) {
      console.warn(`uninstall: ${entry.kind} at ${entry.path} — ${err.message}`);
      if (strict) {
        console.error('uninstall: --strict abort after first failure');
        process.exit(1);
      }
    }
  }

  // 3. Home dir prompt.
  const home = (() => {
    try { return robinHome(); } catch { return null; }
  })();
  if (home && existsSync(home)) {
    let remove = false;
    if (purge) remove = true;
    else if (interactive && !yes) {
      const a = (await prompt(
        `Robin's data folder is at ${home}.\n` +
          'What should we do with it?\n' +
          '  [k] keep    (default — you can reinstall later and point at it)\n' +
          '  [r] remove  (irreversible)\n' +
          'Choose [k/r]: ',
      )).trim().toLowerCase();
      remove = a === 'r' || a === 'remove';
    }
    if (remove) {
      rmSync(home, { recursive: true, force: true });
      console.log(`removed ${home}`);
    } else {
      console.log(`Robin data preserved at ${home}`);
    }
  }

  // 4. Delete the pointer last.
  deletePointer();
  console.log('Robin uninstalled.');
}
```

- [ ] **Step 4: Run the tests**

Run: `node --test --test-force-exit 'tests/**/*.test.js' 2>&1 | tail -10`
Expected: All pass, including the new `uninstall-best-effort.test.js`.

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/uninstall.js tests/integration/uninstall-best-effort.test.js
git commit -m "feat(uninstall): manifest-driven, best-effort + --strict, daemon-aware"
```

---

## Phase 9 — Doctor + audit

### Task 9.1: Doctor's `data` section

**Files:**
- Modify: `src/cli/commands/doctor.js`
- Create: `tests/integration/doctor-drift.test.js`

- [ ] **Step 1: Write the drift test**

```js
// tests/integration/doctor-drift.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ensureHome,
  recordHostTouchpoint,
  writePointer,
} from '../../src/runtime/data-store.js';
import { doctorData } from '../../src/cli/commands/doctor.js';

test('doctorData: reports drift when a host file no longer contains a recorded command', async () => {
  const home = mkdtempSync(join(tmpdir(), 'robin-home-'));
  process.env.ROBIN_HOME = home;
  const fakeSettings = join(home, 'fake-claude-settings.json');
  try {
    await ensureHome();
    writePointer({ home, installedBy: 'test' });
    writeFileSync(fakeSettings, JSON.stringify({ hooks: { PreToolUse: [] } }));
    await recordHostTouchpoint(
      {
        kind: 'claude-hooks',
        path: fakeSettings,
        owned: [{ phase: 'PreToolUse', command: '/abs/bin/robin-hook.sh bash-policy' }],
      },
      () => {},
    );
    const report = await doctorData();
    const drift = report.drift.find((d) => d.path === fakeSettings);
    assert.ok(drift, 'should report drift for the missing command');
    assert.match(drift.reason, /command not present/);
  } finally {
    delete process.env.ROBIN_HOME;
    rmSync(home, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the test to verify failure**

Run: `node --test --test-force-exit 'tests/integration/doctor-drift.test.js'`
Expected: FAIL — `doctorData` not exported.

- [ ] **Step 3: Add `doctorData` to `doctor.js`**

Open `src/cli/commands/doctor.js`. Add at the top:

```js
import { existsSync, readFileSync } from 'node:fs';
import { paths, readHostIntegrations, readPointer, robinHome } from '../../runtime/data-store.js';
```

Then add an exported function:

```js
export async function doctorData() {
  const drift = [];
  let homeResolved = null;
  try {
    homeResolved = robinHome();
  } catch (e) {
    drift.push({ path: null, reason: `home resolution: ${e.message}` });
    return { home: null, drift };
  }
  const pointer = readPointer();
  const envOverride = process.env.ROBIN_HOME;
  if (envOverride && pointer?.home && envOverride !== pointer.home) {
    drift.push({
      path: null,
      reason: `$ROBIN_HOME (${envOverride}) does not match .robin-home (${pointer.home})`,
    });
  }
  let manifest;
  try {
    manifest = await readHostIntegrations();
  } catch (e) {
    drift.push({ path: paths.data.hostIntegrations(), reason: `manifest read: ${e.message}` });
    return { home: homeResolved, drift };
  }
  for (const e of manifest.entries) {
    if (!existsSync(e.path)) {
      drift.push({ path: e.path, reason: 'target file missing' });
      continue;
    }
    if (e.kind === 'claude-hooks' || e.kind === 'gemini-hooks') {
      let parsed;
      try {
        parsed = JSON.parse(readFileSync(e.path, 'utf8'));
      } catch (err) {
        drift.push({ path: e.path, reason: `target file malformed: ${err.message}` });
        continue;
      }
      for (const own of e.owned ?? []) {
        const phaseArr = parsed?.hooks?.[own.phase];
        const present = Array.isArray(phaseArr)
          && phaseArr.some((entry) =>
            Array.isArray(entry?.hooks)
              && entry.hooks.some((h) => h?.command === own.command),
          );
        if (!present) {
          drift.push({ path: e.path, reason: `command not present: ${own.command}` });
        }
      }
    }
    if ((e.kind === 'launchd-plist' || e.kind === 'systemd-unit') && e.expectedHome) {
      if (e.expectedHome !== homeResolved) {
        drift.push({
          path: e.path,
          reason: `expectedHome (${e.expectedHome}) ≠ resolved home (${homeResolved})`,
        });
      }
    }
  }
  return { home: homeResolved, drift };
}
```

Wire it into the main `doctor` exported function so `robin doctor` prints the new section.

- [ ] **Step 4: Run the tests**

Run: `node --test --test-force-exit 'tests/integration/doctor-drift.test.js'`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/doctor.js tests/integration/doctor-drift.test.js
git commit -m "feat(doctor): data section + drift detection for host-integrations entries"
```

---

### Task 9.2: Audit tests — `~/.robin` and `'user-data'` construction

**Files:**
- Create: `tests/unit/audit-no-tilde-robin.test.js`
- Create: `tests/unit/audit-user-data-construction.test.js`

- [ ] **Step 1: Write `audit-no-tilde-robin.test.js`**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SCAN_DIRS = ['src', 'scripts'];
const ALLOW_FILES = new Set([
  join(ROOT, 'src/cli/commands/install.js'),
  join(ROOT, 'src/migrate-v1/v1-client.js'),
  // Add any other legitimate v1-detection sites here.
]);

const PATTERNS = [
  /~\/\.robin\b/,
  /\/\.robin\//,
  /homedir\(\)\s*,\s*['"]\.robin['"]/,
];

function walk(dir, out = []) {
  for (const ent of readdirSync(dir)) {
    const p = join(dir, ent);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, out);
    else if (p.endsWith('.js')) out.push(p);
  }
  return out;
}

test('no source file outside allow-list mentions ~/.robin or /.robin/', () => {
  const files = SCAN_DIRS.flatMap((d) => walk(join(ROOT, d)));
  const hits = [];
  for (const f of files) {
    if (ALLOW_FILES.has(f)) continue;
    const src = readFileSync(f, 'utf8');
    for (const re of PATTERNS) {
      if (re.test(src)) {
        hits.push(`${f}: matched ${re}`);
      }
    }
  }
  assert.deepStrictEqual(hits, [], `forbidden ~/.robin references:\n${hits.join('\n')}`);
});
```

- [ ] **Step 2: Write `audit-user-data-construction.test.js`**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SCAN_DIRS = ['src', 'scripts'];
const ALLOW_FILES = new Set([
  join(ROOT, 'src/runtime/data-store.js'),
  join(ROOT, 'src/cli/commands/install.js'),
  join(ROOT, 'src/migrate-v1/v1-client.js'),
  join(ROOT, 'src/hooks/bash-patterns.js'),
]);

const CONSTRUCTION_PATTERNS = [
  /join\([^)]*['"]user-data['"]/,
  /path\.resolve\([^)]*['"]user-data['"]/,
];

function walk(dir, out = []) {
  for (const ent of readdirSync(dir)) {
    const p = join(dir, ent);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, out);
    else if (p.endsWith('.js')) out.push(p);
  }
  return out;
}

test('only allow-listed files may construct paths with the user-data literal', () => {
  const files = SCAN_DIRS.flatMap((d) => walk(join(ROOT, d)));
  const hits = [];
  for (const f of files) {
    if (ALLOW_FILES.has(f)) continue;
    const src = readFileSync(f, 'utf8');
    for (const re of CONSTRUCTION_PATTERNS) {
      if (re.test(src)) hits.push(`${f}: matched ${re}`);
    }
  }
  assert.deepStrictEqual(hits, [], `forbidden user-data path construction:\n${hits.join('\n')}`);
});
```

- [ ] **Step 3: Run the audits**

Run: `node --test --test-force-exit 'tests/unit/audit-no-tilde-robin.test.js' 'tests/unit/audit-user-data-construction.test.js'`
Expected: PASS — by this point in the plan all the offending strings should be gone. If anything fails, fix the underlying source rather than allow-listing.

- [ ] **Step 4: Commit**

```bash
git add tests/unit/audit-no-tilde-robin.test.js tests/unit/audit-user-data-construction.test.js
git commit -m "test(audit): grep for forbidden ~/.robin and user-data construction"
```

---

## Phase 10 — `--relocate`

### Task 10.1: Relocate flow

**Files:**
- Modify: `src/cli/commands/install.js`
- Create: `tests/integration/relocate.test.js`

- [ ] **Step 1: Write the test**

```js
// tests/integration/relocate.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ensureHome,
  pointerExists,
  readHostIntegrations,
  readPointer,
  recordHostTouchpoint,
  writePointer,
} from '../../src/runtime/data-store.js';
import { relocate } from '../../src/cli/commands/install.js';

test('relocate: moves home + refreshes expectedHome on plist/systemd entries', async () => {
  const A = mkdtempSync(join(tmpdir(), 'robin-A-'));
  const Bparent = mkdtempSync(join(tmpdir(), 'robin-B-parent-'));
  const B = join(Bparent, 'Robin');
  const fakePlist = join(mkdtempSync(join(tmpdir(), 'fake-plist-')), 'io.robin-assistant.mcp.plist');
  writeFileSync(fakePlist, '<plist/>');
  process.env.ROBIN_HOME = A;
  try {
    await ensureHome();
    writePointer({ home: A, installedBy: 'test' });
    await recordHostTouchpoint(
      { kind: 'launchd-plist', path: fakePlist, expectedHome: A, label: 'io.robin-assistant.mcp' },
      () => {},
    );
    delete process.env.ROBIN_HOME;
    await relocate({
      target: B,
      mode: 'move',
      stopDaemon: async () => {},
      rewriteLaunchd: async () => {},
      rewriteSystemd: async () => {},
    });
    assert.strictEqual(existsSync(A), false);
    assert.ok(existsSync(B));
    assert.strictEqual(readPointer().home, B);
    process.env.ROBIN_HOME = B;
    const m = await readHostIntegrations();
    const plist = m.entries.find((e) => e.kind === 'launchd-plist');
    assert.strictEqual(plist.expectedHome, B);
  } finally {
    delete process.env.ROBIN_HOME;
    rmSync(Bparent, { recursive: true, force: true });
    rmSync(join(fakePlist, '..'), { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the test to verify failure**

Run: `node --test --test-force-exit 'tests/integration/relocate.test.js'`
Expected: FAIL — `relocate` not exported.

- [ ] **Step 3: Implement `relocate` in `install.js`**

Add to `install.js`:

```js
import { migrateHome } from '../../runtime/migrate-home.js';

export async function relocate({ target, mode, stopDaemon, rewriteLaunchd, rewriteSystemd }) {
  if (!target || !mode) throw new TypeError('relocate: { target, mode } required');
  const ptr = readPointer();
  if (!ptr) throw new Error('relocate: no .robin-home exists; run `robin install` first');
  const source = ptr.home;
  if (!existsSync(source)) throw new Error(`relocate: source ${source} does not exist`);
  if (existsSync(target)) throw new Error(`relocate: target ${target} already exists`);
  // 1. Stop daemon.
  if (stopDaemon) await stopDaemon();
  // 2. Copy-verify-delete (or copy).
  await migrateHome({ from: source, to: target, mode });
  // 3. Update pointer.
  writePointer({ home: target, installedBy: 'robin install --relocate' });
  // 4. Refresh expectedHome on every manifest entry in one transaction.
  //    We acquire the lock implicitly via recordHostTouchpoint loop.
  process.env.ROBIN_HOME = target;   // so the manifest read finds the new file (it moved with the home)
  const m = await readHostIntegrations();
  for (const e of m.entries) {
    if (e.expectedHome) {
      await recordHostTouchpoint(
        { ...e, expectedHome: target },
        () => {},
      );
    }
  }
  // 5. Rewrite plist/systemd if requested.
  if (rewriteLaunchd) await rewriteLaunchd({ home: target });
  if (rewriteSystemd) await rewriteSystemd({ home: target });
}
```

Make sure `import { readPointer, writePointer, recordHostTouchpoint, readHostIntegrations } from '../../runtime/data-store.js';` is present.

Also wire `--relocate <path>` into the main `install` dispatcher:

```js
if (args.flags.relocate) {
  const target = typeof args.flags.relocate === 'string' ? args.flags.relocate : null;
  if (!target) {
    console.error('--relocate requires a target path: robin install --relocate <path>');
    process.exit(1);
  }
  const mode = (args.flags['on-existing'] === 'copy') ? 'copy' : 'move';
  await relocate({ target, mode });
  return;
}
```

- [ ] **Step 4: Run the tests**

Run: `node --test --test-force-exit 'tests/integration/relocate.test.js'`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/install.js tests/integration/relocate.test.js
git commit -m "feat(install): --relocate moves home and refreshes manifest"
```

---

## Phase 11 — `--repair`

### Task 11.1: Repair walks drift list and re-applies safe writes

**Files:**
- Modify: `src/cli/commands/install.js`

The `--hooks-only` short-circuit already exists in install.js (line ~233). `--repair` is a superset that also re-applies plist/systemd entries from the manifest.

- [ ] **Step 1: Add the repair function**

In `install.js`:

```js
import { doctorData } from './doctor.js';

export async function repair() {
  const { drift } = await doctorData();
  if (drift.length === 0) {
    console.log('Nothing to repair.');
    return;
  }
  // Re-run hooks-only path; this restores Claude/Gemini hook entries.
  await installHooksStep({ skipHooks: false });
  // Plist/systemd: relying on user re-running `robin install` for now since
  // those need privileged operations (launchctl bootstrap, systemctl reload).
  for (const d of drift) {
    console.log(`drift: ${d.path}: ${d.reason}`);
  }
  console.log('Re-applied hook entries. For plist/systemd drift, run: robin install');
}
```

Wire `--repair` into the dispatcher:

```js
if (args.flags.repair) {
  await repair();
  return;
}
```

- [ ] **Step 2: Run tests**

Run: `node --test --test-force-exit 'tests/**/*.test.js' 2>&1 | tail -10`
Expected: All pass.

- [ ] **Step 3: Commit**

```bash
git add src/cli/commands/install.js
git commit -m "feat(install): --repair re-applies hook entries from manifest"
```

---

## Phase 12 — Cleanup, strict resolver, rollout

### Task 12.1: Remove the legacy fallback in `robinHome()`

**Files:**
- Modify: `src/runtime/data-store.js`

- [ ] **Step 1: Replace the legacy fallback body**

Change `robinHome()` from:

```js
export function robinHome() {
  try {
    return resolveHomeStrict();
  } catch {
    if (process.env.ROBIN_HOME) return resolve(process.env.ROBIN_HOME);
    return join(_packageRoot, 'user-data');
  }
}
```

To strict-only:

```js
export function robinHome() {
  return resolveHomeStrict();
}
```

- [ ] **Step 2: Find all callers that need to opt out**

The `install` command is the one caller that runs *before* a pointer exists. Make sure it sets `process.env.ROBIN_HOME = home;` early in its flow (Task 4.4 already does this).

Other callers either follow the install (so the pointer is in place) or expose `ROBIN_HOME` for tests (which the tests already set).

- [ ] **Step 3: Run the full suite**

Run: `node --test --test-force-exit 'tests/**/*.test.js' 2>&1 | tail -10`
Expected: All pass. If any test fails with "Robin is not installed", it's missing a `process.env.ROBIN_HOME = ...` setup; fix the test.

- [ ] **Step 4: Commit**

```bash
git add src/runtime/data-store.js
git commit -m "refactor(data-store): remove legacy fallback; resolver is strict"
```

---

### Task 12.2: Clean up `scripts/dev-recall.js` and `src/cli/commands/help.js`

**Files:**
- Modify: `scripts/dev-recall.js`
- Modify: `src/cli/commands/help.js`

- [ ] **Step 1: Update `scripts/dev-recall.js`**

Open it; replace any hardcoded `~/.robin` with calls into the resolver. If it does `join(homedir(), '.robin')`, change to `paths.data.db()` (or whatever subpath it actually needs). Update the stale comment at the top (line 2) so it reads honestly:

```js
// Manual smoke: open the configured Robin DB, run a recall query, print results.
```

- [ ] **Step 2: Update `src/cli/commands/help.js`**

Open `src/cli/commands/help.js`. The line currently reads (line 14):
```js
ROBIN_HOME              data directory (default <package_root>/user-data)
```

Change to:
```js
ROBIN_HOME              override the data directory (default: chosen at install)
```

- [ ] **Step 3: Run audits**

Run: `node --test --test-force-exit 'tests/unit/audit-no-tilde-robin.test.js' 'tests/unit/audit-user-data-construction.test.js'`
Expected: PASS (no hits).

- [ ] **Step 4: Commit**

```bash
git add scripts/dev-recall.js src/cli/commands/help.js
git commit -m "chore: remove stale ~/.robin and user-data literals from dev-recall and help"
```

---

### Task 12.3: `.gitignore` and stale uninstall message

**Files:**
- Modify: `.gitignore`
- Modify: `src/cli/commands/uninstall.js` (if any stale strings remain)

- [ ] **Step 1: Add `.robin-home` to `.gitignore`**

```bash
echo ".robin-home" >> .gitignore
```

Verify:
```bash
tail -2 .gitignore
```

- [ ] **Step 2: Verify no `~/.robin/db data preserved` strings remain**

Run: `grep -rn '~/.robin/db data' src tests scripts`
Expected: no output. (Task 8.1 should have already removed it.)

- [ ] **Step 3: Commit**

```bash
git add .gitignore
git commit -m "chore: gitignore .robin-home pointer file"
```

---

### Task 12.4: End-to-end Kevin rollout test

**Files:**
- Create: `tests/integration/install-kevin-rollout.test.js`

- [ ] **Step 1: Write the test**

```js
// tests/integration/install-kevin-rollout.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ensureHome,
  pointerExists,
  readHostIntegrations,
  readMarker,
  readPointer,
  recordHostTouchpoint,
  writePointer,
} from '../../src/runtime/data-store.js';

test("Kevin rollout: legacy v2 layout with installed-hooks.json migrates cleanly", async () => {
  const home = mkdtempSync(join(tmpdir(), 'robin-kevin-'));
  process.env.ROBIN_HOME = home;
  try {
    // Pre-seed legacy state: db files present, secrets/.env at 0600,
    // installed-hooks.json present, no marker, no pointer.
    mkdirSync(join(home, 'db'), { recursive: true });
    mkdirSync(join(home, 'secrets'), { recursive: true });
    writeFileSync(join(home, 'db', 'CURRENT'), 'rocksdb');
    writeFileSync(join(home, 'secrets', '.env'), 'GEMINI_API_KEY=abc', { mode: 0o600 });
    writeFileSync(
      join(home, 'installed-hooks.json'),
      JSON.stringify({
        claude: [{ phase: 'PreToolUse', matcher: 'Bash',
                   command: '/abs/bin/robin-hook.sh bash-policy' }],
        gemini: [{ phase: 'Stop',
                   command: '/abs/bin/robin-hook.sh stop' }],
      }),
    );

    // Simulate post-install: ensureHome() drops the marker and migrates
    // the hooks-disabled flag if any.
    await ensureHome();
    // recordHostTouchpoint triggers the read-side migration and deletes the
    // legacy file in the same locked transaction.
    await recordHostTouchpoint(
      { kind: 'launchd-plist', path: '/tmp/fake-plist', expectedHome: home, label: 'l' },
      () => writeFileSync('/tmp/fake-plist', '<plist/>'),
    );
    writePointer({ home, installedBy: 'kevin-rollout-test' });

    // Assertions: marker present, pointer present, legacy file gone, manifest
    // contains migrated claude+gemini entries plus the launchd entry.
    const marker = readMarker();
    assert.strictEqual(marker.version, 1);
    assert.ok(pointerExists());
    assert.strictEqual(readPointer().home, home);
    assert.strictEqual(existsSync(join(home, 'installed-hooks.json')), false);
    const m = await readHostIntegrations();
    const kinds = m.entries.map((e) => e.kind).sort();
    assert.deepStrictEqual(kinds, ['claude-hooks', 'gemini-hooks', 'launchd-plist']);
    // Secrets mode preserved.
    assert.strictEqual(statSync(join(home, 'secrets', '.env')).mode & 0o777, 0o600);
  } finally {
    delete process.env.ROBIN_HOME;
    rmSync(home, { recursive: true, force: true });
    if (existsSync('/tmp/fake-plist')) rmSync('/tmp/fake-plist');
  }
});
```

- [ ] **Step 2: Run the test**

Run: `node --test --test-force-exit 'tests/integration/install-kevin-rollout.test.js'`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/integration/install-kevin-rollout.test.js
git commit -m "test(install): end-to-end Kevin rollout simulation"
```

---

### Task 12.5: Interrupt safety

**Files:**
- Create: `tests/integration/interrupt-safety.test.js`

- [ ] **Step 1: Write the test**

```js
// tests/integration/interrupt-safety.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ensureHome,
  pointerExists,
  readMarker,
  writePointer,
} from '../../src/runtime/data-store.js';

test('interrupt between ensureHome and writePointer: re-running both is idempotent', async () => {
  const home = mkdtempSync(join(tmpdir(), 'robin-interrupt-'));
  process.env.ROBIN_HOME = home;
  try {
    // Step A: ensureHome only (simulating an interrupted install).
    await ensureHome();
    assert.strictEqual(pointerExists(), false);
    const firstMarker = readMarker();
    assert.strictEqual(firstMarker.version, 1);
    // Simulate a re-run.
    await ensureHome();   // idempotent — marker not overwritten
    writePointer({ home, installedBy: 'test' });
    assert.ok(pointerExists());
    const secondMarker = readMarker();
    assert.deepStrictEqual(firstMarker, secondMarker);
  } finally {
    delete process.env.ROBIN_HOME;
    rmSync(home, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the test**

Run: `node --test --test-force-exit 'tests/integration/interrupt-safety.test.js'`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/integration/interrupt-safety.test.js
git commit -m "test(install): interrupt safety between ensureHome and writePointer"
```

---

### Task 12.6: Reinstall discovery

**Files:**
- Create: `tests/integration/reinstall-discovery.test.js`

- [ ] **Step 1: Write the test**

```js
// tests/integration/reinstall-discovery.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverExistingHomes } from '../../src/runtime/data-store.js';

test('discovery finds multiple candidates when both home locations have layouts', () => {
  const a = mkdtempSync(join(tmpdir(), 'robin-a-'));
  const b = mkdtempSync(join(tmpdir(), 'robin-b-'));
  writeFileSync(join(a, '.robin-data'), JSON.stringify({ version: 1, createdAt: 'x' }));
  mkdirSync(join(b, 'db'), { recursive: true });
  writeFileSync(join(b, 'db', 'CURRENT'), 'rocksdb');
  try {
    const result = discoverExistingHomes({ candidates: [a, b] });
    assert.strictEqual(result.length, 2);
    const kinds = result.map((r) => r.kind).sort();
    assert.deepStrictEqual(kinds, ['legacy', 'marker']);
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the test**

Run: `node --test --test-force-exit 'tests/integration/reinstall-discovery.test.js'`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/integration/reinstall-discovery.test.js
git commit -m "test(install): reinstall discovery scans known locations"
```

---

### Task 12.7: Final sweep — full suite green, lint clean

**Files:** all

- [ ] **Step 1: Run the full test suite**

Run: `node --test --test-force-exit 'tests/**/*.test.js' 2>&1 | tail -20`
Expected: All tests pass.

- [ ] **Step 2: Run lint**

Run: `npm run lint`
Expected: Exit 0.

- [ ] **Step 3: Check git status**

Run: `git status --short`
Expected: Only the pre-existing unrelated working-tree changes; nothing stray from this work.

- [ ] **Step 4: Quick manual smoke (do NOT commit anything from this)**

In a separate scratch directory, exercise:
```bash
ROBIN_HOME=/tmp/robin-smoke node bin/robin doctor
ROBIN_HOME=/tmp/robin-smoke node bin/robin install --home /tmp/robin-smoke --yes
ROBIN_HOME=/tmp/robin-smoke node bin/robin doctor
```

Verify each invocation prints sensible output and creates the expected files.

- [ ] **Step 5: No commit at this task (already committed throughout)**

---

## Phase 13 — Rollout (operator step, not a code task)

The plan's *implementation* is complete after Phase 12. The actual rollout is operator work:

### Task 13.1: Before merge — stop the daemon

- [ ] On macOS: `launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/io.robin-assistant.mcp.plist`
- [ ] On Linux: `systemctl --user stop robin-mcp.service`
- [ ] Verify: `ps -ef | grep robin | grep -v grep` → no daemon process.

### Task 13.2: Merge

- [ ] Open PR; verify CI is green.
- [ ] Merge.

### Task 13.3: After merge — first install

- [ ] Run `robin install` interactively.
- [ ] Pick option 1 (keep data inside `<package_root>/user-data`) or option 3 (move to `~/Documents/Robin`).
- [ ] Verify: `cat <package_root>/.robin-home` shows the chosen home.
- [ ] Verify: `robin doctor` reports no drift.
- [ ] Verify: daemon comes back up under the new code (check log file at `<home>/cache/logs/daemon.log`).

---

## Known follow-ups (out of scope for this plan)

- **Non-interactive install flags `--yes`, `--on-existing`, `--existing`, `--force`** beyond what the picker already supports. The picker is interactive-first; scripted installs use `--home <path>` (Task 4.4). The other flags from spec §9.5 can be added once the interactive path is solid.
- **`parseArgs` value-flag support** — `src/cli/args.js` currently handles boolean flags; `--home <path>` and `--relocate <path>` need value parsing. If `parseArgs` doesn't support `flag=value` or `--flag value`, extend it before Task 4.4 lands. Five-minute task; not blocking.
- **Log rotation** for `<home>/cache/logs/daemon.log` (spec §2 deferred).
- **Read-only package root fallback** to OS user-config (spec §18) — only needed for `npm i -g` into a system path.

## Done criteria

- [ ] Full test suite passes (unit + integration + audit).
- [ ] No remaining `~/.robin` literals outside the v1-detection allow-list (audit-no-tilde-robin enforces).
- [ ] No remaining `'user-data'` literal path construction outside the documented allow-list (audit-user-data-construction enforces).
- [ ] `host-integrations.json` is the single source of truth for Robin's touch-points outside the home.
- [ ] `robin install` is interactive (picker), supports `--home`, `--relocate`, `--repair`, `--yes`, `--on-existing`.
- [ ] `robin uninstall` is manifest-driven and best-effort by default.
- [ ] `robin doctor` has a `data` section that lists drift.
- [ ] The end-to-end Kevin rollout test (`install-kevin-rollout.test.js`) passes against a freshly-seeded legacy layout.
