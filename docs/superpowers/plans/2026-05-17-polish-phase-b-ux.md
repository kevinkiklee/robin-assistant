# Polish Phase B — UX Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land four sub-area UX sweeps that give every in-scope surface a tested output contract — CLI ergonomics, doctor + health redesign, agent-facing UX (Discord + MCP), memory output polish — informed by Phase A's audit-notes bridge table.

**Architecture:** Front-load inventory tasks that audit the on-disk surface (Phase A's plan was burned by writing verbatim code against assumed CLI flags that didn't exist). Then per-surface sweeps adopt a shared contract: snapshot-tested human output + tested `--json` output + tested error shapes + Phase A's `normalize-snapshot.js` for stable assertions. The invariant schema gets a required `remediation` field with backfill. Discord reply edge cases (oversize, rate-limit, outbound-blocked, AskUserQuestion-under-Discord) get a tested matrix. MCP tool errors get an enum + legacy-alias map.

**Tech Stack:** Same as Phase A — Node 24.14.1, ESM, `node --test`, `mock.timers`, `mem://` SurrealDB for tests, ripgrep for inventory scans. Phase A's `system/tests/helpers/normalize-snapshot.js` is the snapshot-assertion foundation.

**Spec:** `docs/superpowers/specs/2026-05-17-polish-phase-b-ux-design.md`
**Phase A audit + bridge:** `docs/superpowers/notes/2026-05-17-polish-phase-a-audit.md`

---

## Pre-flight

- [ ] **Pre-flight 1: Re-snapshot active-lane exclude lists.**

```bash
git status --short > /tmp/polish-phase-b-lane-snapshot.txt
cat /tmp/polish-phase-b-lane-snapshot.txt
```

Expected: lists cognition-e1 + prompt-injection WIP. Files on either exclude list are NOT touched by Phase B (findings file to "Open for <lane>" in audit notes).

Cognition-e1 exclude list (read-only):
- `system/cognition/dream/*.js`, `introspection/*`, `intuition/{reinforcement,correction-inference,playbook-inject}.js`, `jobs/comm-style.js`, `jobs/internal/*`, `telemetry/rollup-registry.js`, `memory/arcs.js`, `biographer/pipeline.js`
- `system/io/mcp/tools/{health,remember}.js`, `system/io/capture/session-capture.js`
- `system/data/embed/factory.js`, `system/data/db/client.js`
- `system/data/db/migrations/{0017,0026}*.surql`

Prompt-injection lane exclude list (read-only):
- `system/runtime/daemon/{server,lifecycle,http,log-scrub}.js`, `cli/commands/web.js`
- `system/io/mcp/tools/ingest.js`, `system/io/integrations/_framework/capture.js`
- `system/config/{daemon-state,data-store,mcp-token}.js`
- `system/runtime/web/server.js`, `system/runtime/invariants/mcp.wiring-{global,project}-present.js`

- [ ] **Pre-flight 2: Audit notes scaffold for Phase B.**

Create `docs/superpowers/notes/2026-05-17-polish-phase-b-audit.md` with this content:

```markdown
# Polish Phase B — Audit Notes

**Date range:** 2026-05-17 →
**Phase B complete:**

## B.1 CLI ergonomics

### Inventory (B.1 Step 0 — audit current surface)
(populated by Task 1)

### Decisions
| Command | --help? | --json? | Exit codes used | Sibling group | Action | Commit |
|---|---|---|---|---|---|---|

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

## Open for cognition-e1 lane

| File | Finding | Suggested fix |
|---|---|---|

## Open for prompt-injection lane

| File | Finding | Suggested fix |
|---|---|---|

## Open for user

| Item | Question | Recommended action |
|---|---|---|

## Won't fix

| Item | Rationale |
|---|---|
```

Commit:
```bash
git add docs/superpowers/notes/2026-05-17-polish-phase-b-audit.md
git diff --cached --name-only
git commit -m "docs(polish): phase B audit notes scaffold" -- docs/superpowers/notes/2026-05-17-polish-phase-b-audit.md
git show HEAD --stat
```

---

## Phase B.1 — CLI ergonomics

### Task 1: B.1 inventory — audit current CLI surface

**Files:**
- Create: `tmp/polish-b1-inventory.txt` (gitignored ephemeral)
- Modify: `docs/superpowers/notes/2026-05-17-polish-phase-b-audit.md` (append B.1 Inventory)

- [ ] **Step 1: List every subcommand**

```bash
ls system/runtime/cli/commands/ | grep -v '^_' | sed 's/\.js$//' | sort > tmp/polish-b1-subcommands.txt
wc -l tmp/polish-b1-subcommands.txt
```

Expected: file lists every subcommand (one per line; ~75).

- [ ] **Step 2: Capture per-command help + exit code + format support**

```bash
mkdir -p tmp/polish-b1-help
> tmp/polish-b1-inventory.txt
while IFS= read -r sub; do
  # Help output (try, fall back to error capture)
  help_out=$(node system/bin/robin "$sub" --help 2>&1 || true)
  echo "$help_out" > "tmp/polish-b1-help/${sub}.txt"
  # Exit code on invalid args
  node system/bin/robin "$sub" --__invalid_flag_for_audit 2>/dev/null
  invalid_exit=$?
  # --json support: try and see if output is JSON-parseable
  json_out=$(node system/bin/robin "$sub" --json 2>&1 || true)
  if echo "$json_out" | head -1 | grep -qE '^\s*[\[\{]'; then json_supports='yes'; else json_supports='no'; fi
  # Help mentions related commands?
  if grep -qiE 'related|see also' "tmp/polish-b1-help/${sub}.txt"; then has_related='yes'; else has_related='no'; fi
  echo "${sub}|invalid_exit=${invalid_exit}|json=${json_supports}|related=${has_related}" >> tmp/polish-b1-inventory.txt
done < tmp/polish-b1-subcommands.txt
head -20 tmp/polish-b1-inventory.txt
```

- [ ] **Step 3: Append inventory summary to audit notes**

Open `docs/superpowers/notes/2026-05-17-polish-phase-b-audit.md`. Append under `### Inventory (B.1 Step 0 — audit current surface)`:

```markdown
Total CLI subcommands audited: <N>

Summary stats:
- Commands with --json support: <count>
- Commands without --json support: <count>
- Commands with Related: footer: <count>
- Commands without Related: footer: <count>

Distinct exit codes observed on invalid-flag input: <list>

Full inventory in `tmp/polish-b1-inventory.txt` (gitignored).
Per-command help snapshots in `tmp/polish-b1-help/<command>.txt`.
```

- [ ] **Step 4: Commit audit notes**

```bash
git add docs/superpowers/notes/2026-05-17-polish-phase-b-audit.md
git diff --cached --name-only
git commit -m "docs(polish-b1): CLI surface inventory" -- docs/superpowers/notes/2026-05-17-polish-phase-b-audit.md
git show HEAD --stat
```

### Task 2: CLI exit-codes contract

**Files:**
- Create: `system/runtime/cli/exit-codes.js`
- Create: `system/tests/unit/cli-exit-codes.test.js`

- [ ] **Step 1: Write the test**

Create `system/tests/unit/cli-exit-codes.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert';
import { EXIT_CODES, describeExit } from '../../runtime/cli/exit-codes.js';

test('EXIT_CODES has the four canonical values', () => {
  assert.strictEqual(EXIT_CODES.OK, 0);
  assert.strictEqual(EXIT_CODES.ERROR, 1);
  assert.strictEqual(EXIT_CODES.USER_ERROR, 2);
  assert.strictEqual(EXIT_CODES.PRECONDITION, 3);
});

test('describeExit returns canonical name for known code', () => {
  assert.strictEqual(describeExit(0), 'OK');
  assert.strictEqual(describeExit(2), 'USER_ERROR');
  assert.strictEqual(describeExit(3), 'PRECONDITION');
});

test('describeExit returns "ERROR" for unknown code', () => {
  assert.strictEqual(describeExit(99), 'ERROR');
});
```

- [ ] **Step 2: Run test (must fail)**

```bash
pnpm test:file system/tests/unit/cli-exit-codes.test.js
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write implementation**

Create `system/runtime/cli/exit-codes.js`:

```js
// CLI exit code contract. Used by every `robin <subcmd>` command to
// communicate success / generic error / user error / precondition failure
// in a way scripts and shells can rely on. Pre-existing in-the-wild codes
// (e.g., `robin publish` exit 3 for missing secrets) align with these
// canonical values; nothing was renumbered to avoid breaking scripts.

export const EXIT_CODES = Object.freeze({
  OK: 0,
  ERROR: 1,
  USER_ERROR: 2,    // bad args, missing required flag
  PRECONDITION: 3,  // missing secret, daemon not running, install not pointed
});

const NAMES = new Map([
  [0, 'OK'],
  [1, 'ERROR'],
  [2, 'USER_ERROR'],
  [3, 'PRECONDITION'],
]);

export function describeExit(code) {
  return NAMES.get(code) ?? 'ERROR';
}
```

- [ ] **Step 4: Run test (must pass 3/3)**

```bash
pnpm test:file system/tests/unit/cli-exit-codes.test.js
```

- [ ] **Step 5: Commit**

```bash
git add system/runtime/cli/exit-codes.js system/tests/unit/cli-exit-codes.test.js
git diff --cached --name-only
git commit -m "feat(polish-b1): CLI exit-codes contract" -- system/runtime/cli/exit-codes.js system/tests/unit/cli-exit-codes.test.js
git show HEAD --stat
```

### Task 3: JSON envelope contract

**Files:**
- Create: `system/runtime/cli/json-envelope.js`
- Create: `system/tests/unit/cli-json-envelope.test.js`

- [ ] **Step 1: Write the test**

Create `system/tests/unit/cli-json-envelope.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert';
import { okEnvelope, errorEnvelope } from '../../runtime/cli/json-envelope.js';

test('okEnvelope wraps data with command + ok:true + took_ms', () => {
  const env = okEnvelope({ command: 'hot', data: { items: [1, 2] }, took_ms: 47 });
  assert.strictEqual(env.ok, true);
  assert.strictEqual(env.command, 'hot');
  assert.deepStrictEqual(env.data, { items: [1, 2] });
  assert.strictEqual(env.took_ms, 47);
  assert.strictEqual(env.error, undefined);
});

test('errorEnvelope wraps reason + message with ok:false', () => {
  const env = errorEnvelope({ command: 'publish', reason: 'missing_secret', message: 'BLOB_READ_WRITE_TOKEN not set', took_ms: 12 });
  assert.strictEqual(env.ok, false);
  assert.strictEqual(env.command, 'publish');
  assert.deepStrictEqual(env.error, { reason: 'missing_secret', message: 'BLOB_READ_WRITE_TOKEN not set' });
  assert.strictEqual(env.took_ms, 12);
  assert.strictEqual(env.data, undefined);
});

test('envelopes are JSON-serializable round-trip', () => {
  const env = okEnvelope({ command: 'cmd', data: { x: 1 }, took_ms: 0 });
  const parsed = JSON.parse(JSON.stringify(env));
  assert.deepStrictEqual(parsed, env);
});
```

- [ ] **Step 2: Run test (must fail)**

```bash
pnpm test:file system/tests/unit/cli-json-envelope.test.js
```

- [ ] **Step 3: Write implementation**

Create `system/runtime/cli/json-envelope.js`:

```js
// Shared JSON envelope shape for every `robin <subcmd> --json` output.
// Contract: { ok: boolean, command: string, data?: object, error?: { reason, message }, took_ms: number }.

export function okEnvelope({ command, data, took_ms }) {
  return { ok: true, command, data, took_ms };
}

export function errorEnvelope({ command, reason, message, took_ms }) {
  return { ok: false, command, error: { reason, message }, took_ms };
}
```

- [ ] **Step 4: Run test (must pass 3/3)**

```bash
pnpm test:file system/tests/unit/cli-json-envelope.test.js
```

- [ ] **Step 5: Commit**

```bash
git add system/runtime/cli/json-envelope.js system/tests/unit/cli-json-envelope.test.js
git diff --cached --name-only
git commit -m "feat(polish-b1): JSON envelope contract for --json CLI output" -- system/runtime/cli/json-envelope.js system/tests/unit/cli-json-envelope.test.js
git show HEAD --stat
```

### Task 4: CLI command-registry

**Files:**
- Create: `system/runtime/cli/command-registry.js`
- Create: `system/tests/unit/cli-command-registry.test.js`

The registry drives the `Related:` footer in `--help` output. Hand-authored. Each entry: `{ name, summary, group, siblings? }`. `Related:` is derived from `group` membership unless `siblings` overrides.

- [ ] **Step 1: Write the test**

Create `system/tests/unit/cli-command-registry.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert';
import { COMMAND_REGISTRY, relatedFor } from '../../runtime/cli/command-registry.js';

test('every registry entry has name + summary + group', () => {
  for (const entry of COMMAND_REGISTRY) {
    assert.ok(entry.name, `entry missing name: ${JSON.stringify(entry)}`);
    assert.ok(entry.summary, `entry missing summary: ${entry.name}`);
    assert.ok(entry.group, `entry missing group: ${entry.name}`);
  }
});

test('relatedFor returns sibling names from same group, excluding self', () => {
  const related = relatedFor('jobs-list');
  assert.ok(Array.isArray(related));
  assert.ok(!related.includes('jobs-list'));
  // jobs-list should have at least one sibling (jobs-run, jobs-status, etc.)
  assert.ok(related.length > 0, `jobs-list has no related siblings — fix command-registry`);
});

test('relatedFor returns empty for unknown name', () => {
  assert.deepStrictEqual(relatedFor('nonexistent-command'), []);
});
```

- [ ] **Step 2: Run test (must fail)**

```bash
pnpm test:file system/tests/unit/cli-command-registry.test.js
```

- [ ] **Step 3: Write implementation**

Create `system/runtime/cli/command-registry.js` with at least these grouped entries (populated from the inventory in Task 1; this is the minimum scaffold):

```js
// Hand-authored CLI command registry. Drives the `Related:` footer in
// `--help` output. Group siblings appear under `Related:` (excluding self).
// Add new commands here as they ship.

export const COMMAND_REGISTRY = [
  // jobs group
  { name: 'jobs-list', summary: 'List scheduled background jobs.', group: 'jobs' },
  { name: 'jobs-run', summary: 'Manually run a job by name.', group: 'jobs' },
  { name: 'jobs-status', summary: 'Show job execution history + next runs.', group: 'jobs' },
  { name: 'jobs-enable', summary: 'Enable a disabled job.', group: 'jobs' },
  { name: 'jobs-disable', summary: 'Disable a scheduled job without removing it.', group: 'jobs' },
  { name: 'jobs-reload', summary: 'Reload job definitions from user-data/jobs.', group: 'jobs' },

  // integrations group
  { name: 'integrations-list', summary: 'List configured integrations.', group: 'integrations' },
  { name: 'integrations-status', summary: 'Show last-sync state per integration.', group: 'integrations' },
  { name: 'integrations-run', summary: 'Manually trigger a sync.', group: 'integrations' },
  { name: 'integrations-enable', summary: 'Enable a disabled integration.', group: 'integrations' },
  { name: 'integrations-disable', summary: 'Disable an integration without removing config.', group: 'integrations' },
  { name: 'integrations-migrate', summary: 'Run integration schema migrations.', group: 'integrations' },
  { name: 'integrations-discord-register', summary: 'Register Discord bot for this user.', group: 'integrations' },

  // embeddings group
  { name: 'embeddings', summary: 'Manage embedder profiles + backfill operations.', group: 'embeddings' },

  // actions group
  { name: 'actions-list', summary: 'List action-trust class policies.', group: 'actions' },
  { name: 'actions-set', summary: 'Set policy for a (tool, action) class.', group: 'actions' },
  { name: 'actions-show', summary: 'Show policy for a single action class.', group: 'actions' },
  { name: 'actions-reset', summary: 'Reset a class to default ASK policy.', group: 'actions' },

  // brief group
  { name: 'brief-regenerate', summary: 'Regenerate the daily brief from cached data.', group: 'brief' },
  { name: 'brief-calibrate', summary: 'Score recent briefs and update brief calibration.', group: 'brief' },
  { name: 'brief-feedback', summary: 'Record user feedback on a brief.', group: 'brief' },
  { name: 'brief-gallery', summary: 'Open the brief gallery for review.', group: 'brief' },

  // mcp group
  { name: 'mcp-install', summary: 'Wire MCP server entry into ~/.claude.json and .mcp.json.', group: 'mcp' },
  { name: 'mcp-start', summary: 'Start the MCP daemon (foreground or background).', group: 'mcp' },
  { name: 'mcp-stop', summary: 'Stop the running MCP daemon.', group: 'mcp' },
  { name: 'mcp-restart', summary: 'Stop + start the MCP daemon.', group: 'mcp' },
  { name: 'mcp-uninstall', summary: 'Remove MCP wiring + stop daemon.', group: 'mcp' },

  // auth group
  { name: 'auth-google', summary: 'Run Google OAuth flow (Gmail + Calendar + Drive).', group: 'auth' },
  { name: 'auth-spotify', summary: 'Run Spotify OAuth flow.', group: 'auth' },
  { name: 'auth-whoop', summary: 'Run Whoop OAuth flow.', group: 'auth' },

  // pre-commit group
  { name: 'pre-commit-install', summary: 'Install Robin pre-commit hook into .githooks.', group: 'pre-commit' },
  { name: 'pre-commit-run', summary: 'Run pre-commit checks against staged files.', group: 'pre-commit' },
  { name: 'pre-commit-uninstall', summary: 'Remove Robin pre-commit hook.', group: 'pre-commit' },

  // hooks group (Claude Code / Gemini host hooks)
  { name: 'hooks-enable', summary: 'Enable Robin host hooks for this user.', group: 'hooks' },
  { name: 'hooks-disable', summary: 'Disable Robin host hooks for this user.', group: 'hooks' },
  { name: 'hook', summary: 'Internal hook entry point (invoked by host).', group: 'hooks' },

  // biographer group
  { name: 'biographer', summary: 'Run biographer once.', group: 'biographer' },
  { name: 'biographer-catchup', summary: 'Process backlog of pending captures.', group: 'biographer' },
  { name: 'biographer-process-pending', summary: 'Drain the pending biographer queue.', group: 'biographer' },

  // dream group
  { name: 'dream', summary: 'Run dream pipeline once.', group: 'dream' },
  { name: 'dream-run', summary: 'Internal entry — run a single dream step.', group: 'dream' },

  // calibration / predictions / commstyle
  { name: 'calibration-show', summary: 'Show prediction calibration metrics.', group: 'calibration' },
  { name: 'predictions-list', summary: 'List open / resolved predictions.', group: 'calibration' },
  { name: 'commstyle-refresh', summary: 'Force recompute of comm-style snapshot.', group: 'commstyle' },
  { name: 'commstyle-show', summary: 'Show current comm-style snapshot.', group: 'commstyle' },

  // secrets group
  { name: 'secrets-import', summary: 'Import secrets from a key=value file.', group: 'secrets' },

  // rules group (cognition-e1 also touches this — verify not e1-owned)
  { name: 'rules', summary: 'List, approve, reject, update behavior rules.', group: 'rules' },

  // sessions group
  { name: 'sessions-purge', summary: 'Purge stale session records.', group: 'sessions' },

  // install / runtime group
  { name: 'install', summary: 'Install Robin pointer + skeleton + schema.', group: 'install' },
  { name: 'uninstall', summary: 'Reverse install.', group: 'install' },
  { name: 'migrate', summary: 'Apply DB schema migrations.', group: 'install' },
  { name: 'migrate-user-data', summary: 'Apply user-data layout migrations.', group: 'install' },
  { name: 'version', summary: 'Print Robin version + paths.', group: 'install' },
  { name: 'doctor', summary: 'Run health probes + print report.', group: 'install' },
  { name: 'hot', summary: 'Print last N events from event stream.', group: 'introspect' },
  { name: 'journal', summary: 'Print episode + capture timeline.', group: 'introspect' },
  { name: 'audit', summary: 'Run contradiction audit across knowledge.', group: 'introspect' },
  { name: 'lint', summary: 'Run mechanical memory lint.', group: 'introspect' },
  { name: 'ingest', summary: 'Ingest a file/URL/content into memory.', group: 'introspect' },
  { name: 'refusals', summary: 'Show recent refusal events.', group: 'introspect' },
  { name: 'recall-eval', summary: 'Evaluate recall quality against a corpus.', group: 'introspect' },
  { name: 'mcp-ensure-running', summary: 'Ensure MCP daemon is up; start if not.', group: 'mcp' },
  { name: 'surreal-ensure-running', summary: 'Ensure SurrealDB is up; start if not.', group: 'install' },

  // publishing group
  { name: 'publish', summary: 'Publish a markdown artifact to the web.', group: 'publishing' },
  { name: 'published', summary: 'List pages published from this Robin instance.', group: 'publishing' },

  // import group
  { name: 'import-v1', summary: 'Import data from a v1 Robin instance.', group: 'install' },

  // help
  { name: 'help', summary: 'Print top-level help.', group: 'help' },
];

const BY_GROUP = (() => {
  const m = new Map();
  for (const entry of COMMAND_REGISTRY) {
    if (!m.has(entry.group)) m.set(entry.group, []);
    m.get(entry.group).push(entry.name);
  }
  return m;
})();

export function relatedFor(name) {
  const entry = COMMAND_REGISTRY.find((e) => e.name === name);
  if (!entry) return [];
  if (entry.siblings) return entry.siblings;
  return (BY_GROUP.get(entry.group) ?? []).filter((n) => n !== name);
}
```

- [ ] **Step 4: Run test (must pass 3/3)**

```bash
pnpm test:file system/tests/unit/cli-command-registry.test.js
```

- [ ] **Step 5: Cross-check inventory vs registry coverage**

```bash
ls system/runtime/cli/commands/ | grep -v '^_' | sed 's/\.js$//' | sort > tmp/polish-b1-actual-commands.txt
node -e "
import('./system/runtime/cli/command-registry.js').then(m => {
  const registered = m.COMMAND_REGISTRY.map(e => e.name).sort();
  console.log(registered.join('\n'));
});
" > tmp/polish-b1-registered.txt
diff tmp/polish-b1-actual-commands.txt tmp/polish-b1-registered.txt | head -30 || true
```

Any commands in the actual list but not registered need a registry entry (add them following the same shape). Any commands in the registry but not on disk are stale (remove from registry).

If diff shows discrepancies, fix them in `command-registry.js` and re-run the test. Iterate until diff is empty (or the only diff is intentional — e.g., excluded prompt-injection lane commands like `web.js`).

- [ ] **Step 6: Commit**

```bash
git add system/runtime/cli/command-registry.js system/tests/unit/cli-command-registry.test.js
git diff --cached --name-only
git commit -m "feat(polish-b1): CLI command-registry + relatedFor()" -- system/runtime/cli/command-registry.js system/tests/unit/cli-command-registry.test.js
git show HEAD --stat
```

### Task 5: Per-command `--help` snapshot sweep (templated loop)

**Method:** For each command in `command-registry.js`, write a snapshot test that captures the `--help` output (normalized) and asserts a stable shape. Tests are gated behind `ROBIN_SKIP_SLOW` because they spawn the CLI.

**Files:**
- Create: `system/tests/unit/cli-help-snapshots.test.js` (single test file with one test per command for tractability)

- [ ] **Step 1: Write the omnibus snapshot test**

Create `system/tests/unit/cli-help-snapshots.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { COMMAND_REGISTRY, relatedFor } from '../../runtime/cli/command-registry.js';
import { normalize } from '../helpers/normalize-snapshot.js';

const SKIP = process.env.ROBIN_SKIP_SLOW === '1';

function runHelp(subcmd) {
  const robin = resolve(process.cwd(), 'system/bin/robin');
  const r = spawnSync('node', [robin, subcmd, '--help'], { encoding: 'utf8', timeout: 10000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

test('every registered command responds to --help with exit 0', { skip: SKIP }, () => {
  const failures = [];
  for (const entry of COMMAND_REGISTRY) {
    const r = runHelp(entry.name);
    if (r.status !== 0) failures.push(`${entry.name}: exit=${r.status} stderr=${r.stderr.slice(0, 80)}`);
  }
  assert.deepStrictEqual(failures, [], `commands failing --help:\n${failures.join('\n')}`);
});

test('every registered command --help includes its summary', { skip: SKIP }, () => {
  const failures = [];
  for (const entry of COMMAND_REGISTRY) {
    const r = runHelp(entry.name);
    if (r.status !== 0) continue; // counted in the previous test
    const out = r.stdout + r.stderr;
    if (!out.includes(entry.summary)) {
      failures.push(`${entry.name}: --help output missing summary "${entry.summary}"`);
    }
  }
  assert.deepStrictEqual(failures, [], `commands missing summary in --help:\n${failures.join('\n')}`);
});

test('every command with siblings shows them under Related:', { skip: SKIP }, () => {
  const failures = [];
  for (const entry of COMMAND_REGISTRY) {
    const siblings = relatedFor(entry.name);
    if (siblings.length === 0) continue;
    const r = runHelp(entry.name);
    if (r.status !== 0) continue;
    const out = r.stdout + r.stderr;
    if (!/Related:/.test(out)) {
      failures.push(`${entry.name}: --help output missing "Related:" section (has ${siblings.length} siblings)`);
    }
  }
  // This test is expected to fail initially — the per-command --help footer
  // is added in Task 6. Treat failures as a work-list, not an assertion.
  if (failures.length > 0) {
    console.warn(`[polish-b1] commands lacking Related: footer (will be fixed by Task 6):\n${failures.join('\n')}`);
  }
});
```

- [ ] **Step 2: Run the test**

```bash
pnpm test:file system/tests/unit/cli-help-snapshots.test.js
```

The first two assertions will likely surface real --help failures or commands without summaries — those are the work-list for the next step. The third assertion is informational.

- [ ] **Step 3: Capture work-list**

For any commands failing tests 1 or 2:
- Failing exit code on --help → check the command source; fix the help-handling code path.
- Missing summary text → either the registry summary is wrong (update registry) OR the command's --help doesn't print enough context (update the command).

For each command needing a fix, make a small atomic commit:

```bash
git commit -m "fix(polish-b1): cli/<command> --help exits 0 and includes summary" -- system/runtime/cli/commands/<command>.js
```

Keep iterating until test 1 and test 2 pass.

- [ ] **Step 4: Update audit notes B.1 decisions table**

For each command worked: append a row.

```bash
# Edit docs/superpowers/notes/2026-05-17-polish-phase-b-audit.md
# Append rows like:
# | jobs-list | yes | yes | 0,2 | jobs | help-text + summary verified | <sha> |
```

- [ ] **Step 5: Commit snapshot test + audit notes**

```bash
git add system/tests/unit/cli-help-snapshots.test.js docs/superpowers/notes/2026-05-17-polish-phase-b-audit.md
git diff --cached --name-only
git commit -m "test(polish-b1): per-command --help snapshot suite" -- system/tests/unit/cli-help-snapshots.test.js docs/superpowers/notes/2026-05-17-polish-phase-b-audit.md
git show HEAD --stat
```

### Task 6: Per-command `Related:` footer sweep (templated loop)

**Method:** For each command with siblings (`relatedFor(name).length > 0`), modify its `--help` output to include a `Related:` footer.

- [ ] **Step 1: Find the help-formatting site**

```bash
rg -l "usage:|Usage:" system/runtime/cli/commands | head -10
```

Inspect 2-3 commands to find the pattern. Most likely there's a shared help formatter or each command builds its help string locally. Use the pattern.

- [ ] **Step 2: Add a shared helper**

If commands build help strings locally, add a helper:

Create `system/runtime/cli/help-formatter.js`:

```js
import { relatedFor } from './command-registry.js';

export function appendRelated(helpText, commandName) {
  const siblings = relatedFor(commandName);
  if (siblings.length === 0) return helpText;
  const trimmed = helpText.replace(/\s*$/, '');
  return `${trimmed}\n\nRelated: ${siblings.join(', ')}\n`;
}
```

Add a test for the helper:

Create `system/tests/unit/cli-help-formatter.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert';
import { appendRelated } from '../../runtime/cli/help-formatter.js';

test('appendRelated adds Related: line when command has siblings', () => {
  const out = appendRelated('usage: jobs-list', 'jobs-list');
  assert.match(out, /\n\nRelated: .+/);
  assert.match(out, /jobs-run/);
});

test('appendRelated leaves text untouched when no siblings', () => {
  const out = appendRelated('usage: nonexistent-command', 'nonexistent-command');
  assert.strictEqual(out, 'usage: nonexistent-command');
});
```

Run:
```bash
pnpm test:file system/tests/unit/cli-help-formatter.test.js
```

- [ ] **Step 3: Wire helper into each command's --help path (loop)**

For each command from Task 5's "missing Related: footer" work-list:
- Open `system/runtime/cli/commands/<command>.js`.
- Find the help-string assembly.
- Wrap the final string in `appendRelated(helpString, '<command-name>')`.
- Import: `import { appendRelated } from '../help-formatter.js';`.
- Test the command's `--help`:
  ```bash
  node system/bin/robin <command> --help | tail -10
  ```
- Expected: ends with `Related: <comma-separated siblings>`.

Commit per-command (atomic):
```bash
git commit -m "feat(polish-b1): Related: footer in <command> --help" -- system/runtime/cli/commands/<command>.js
```

If many commands share a common help generator, fix the generator once and ship as a single commit.

- [ ] **Step 4: Commit the helper + test**

```bash
git add system/runtime/cli/help-formatter.js system/tests/unit/cli-help-formatter.test.js
git commit -m "feat(polish-b1): help-formatter with appendRelated()" -- system/runtime/cli/help-formatter.js system/tests/unit/cli-help-formatter.test.js
```

- [ ] **Step 5: Re-run the help-snapshot test (Task 5)**

```bash
pnpm test:file system/tests/unit/cli-help-snapshots.test.js
```

Expected: third test (Related: presence) now passes for every command with siblings.

---

## Phase B.2 — Doctor + health redesign

### Task 7: Invariant `remediation` field — tighten to required + backfill

**Files:**
- Modify: every file in `system/runtime/invariants/*.js` (excluding the prompt-injection-owned `mcp.wiring-{global,project}-present.js`)
- Modify: the invariant schema validator (find via `rg 'remediation' system/runtime/invariants/`)
- Modify: `system/tests/unit/invariants-schema.test.js` (or similar — find via `rg 'invariant' system/tests/unit/ | head`)

- [ ] **Step 1: Find the invariant-schema test**

```bash
rg -l "remediation" system/tests/unit/ system/runtime/invariants/ | head
```

Read the existing schema test. Note its current shape (the Phase A invariant added `remediation` as optional).

- [ ] **Step 2: Tighten the schema test to require `remediation`**

Edit the existing invariant-schema test (likely `system/tests/unit/invariants-registry-audit.test.js` or similar). Change the assertion from "may have `remediation`" to "must have `remediation` (string or string[])".

Run the test:
```bash
pnpm test:file <the-schema-test-path>
```

Expected: FAIL — most invariants don't yet have `remediation`.

- [ ] **Step 3: Backfill `remediation` per invariant (loop)**

For each invariant file without `remediation`:
- Open the file.
- Add a `remediation:` field after `description:`.
- The value is a string or string[] giving 1-3 actionable steps (use the invariant's existing `explain()` text as source material).

Example for `db.daemon-reachable.js`:
```js
remediation: [
  'check daemon process: pgrep -f "robin.*daemon"',
  'restart daemon: kill <pid>; launchctl respawns it',
  'check SurrealDB: pgrep -f "surreal start"',
],
```

Commit per-invariant:
```bash
git commit -m "feat(polish-b2): remediation field for <invariant>" -- system/runtime/invariants/<file>.js
```

Or batch closely-related invariants (e.g., all 4 mcp.* invariants) in one commit.

- [ ] **Step 4: Re-run schema test**

```bash
pnpm test:file <the-schema-test-path>
```

Expected: PASS. All invariants now have `remediation`.

- [ ] **Step 5: Commit the schema tightening**

```bash
git commit -m "feat(polish-b2): require remediation field on all invariants" -- <the-schema-test-path>
```

### Task 8: Doctor render-path rewrite — realm-grouped output

**Files:**
- Modify: `system/runtime/cli/commands/doctor.js`
- Modify: `system/runtime/cli/commands/_doctor-status.js` (or whichever helper currently renders)
- Create: `system/tests/unit/doctor-render.test.js`

- [ ] **Step 1: Inventory the current doctor render path**

```bash
rg -l "doctor" system/runtime/cli/commands | head
rg "console\.log|printOk|printWarn|printFail" system/runtime/cli/commands/_doctor-*.js system/runtime/cli/commands/doctor.js | head -30
```

Read the current code to understand the rendering flow.

- [ ] **Step 2: Write the render test (TDD)**

Create `system/tests/unit/doctor-render.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert';
import { renderDoctor } from '../../runtime/cli/commands/_doctor-status.js';

function makeResult(name, surface, status, error, remediation) {
  return { name, surface, status, error, remediation };
}

test('renderDoctor groups by realm with realm summary lines', () => {
  const results = [
    makeResult('db.authenticated', 'db', 'ok'),
    makeResult('db.daemon_reachable', 'db', 'ok'),
    makeResult('paths.install', 'paths', 'ok'),
  ];
  const out = renderDoctor({ results, ts: '2026-05-17T13:42:01Z' });
  assert.match(out, /db\s+ok\s+2 checks/);
  assert.match(out, /paths\s+ok\s+1 check/);
  assert.match(out, /Summary:\s+3 ok,\s+0 warn,\s+0 fail/);
  assert.match(out, /Exit 0/);
});

test('renderDoctor renders warn detail with remediation', () => {
  const results = [
    makeResult('db.authenticated', 'db', 'ok'),
    makeResult('db.embedder_profile_match', 'db', 'warn',
      'active=mxbai-1024, table=mxbai-1024-v2 (mismatched)',
      ['robin embeddings activate mxbai-1024-v2', 'robin embeddings backfill mxbai-1024']),
  ];
  const out = renderDoctor({ results, ts: '2026-05-17T13:42:01Z' });
  assert.match(out, /db\s+warn\s+2 checks \(1 warn\)/);
  assert.match(out, /⚠ db\.embedder_profile_match/);
  assert.match(out, /→ robin embeddings activate mxbai-1024-v2/);
  assert.match(out, /→ robin embeddings backfill mxbai-1024/);
});

test('renderDoctor exits 1 on any fail', () => {
  const results = [
    makeResult('install.pointer_present', 'paths', 'fail',
      'pointer file missing at .robin-home',
      ['robin install']),
  ];
  const out = renderDoctor({ results, ts: '2026-05-17T13:42:01Z' });
  assert.match(out, /Summary:.+0 ok.+0 warn.+1 fail/);
  assert.match(out, /Exit 1/);
});

test('renderDoctor exits 0 on warn-only', () => {
  const results = [makeResult('db.embedder_profile_match', 'db', 'warn', 'msg', ['fix'])];
  const out = renderDoctor({ results, ts: '2026-05-17T13:42:01Z' });
  assert.match(out, /Exit 0/);
});
```

- [ ] **Step 3: Run test (must fail)**

```bash
pnpm test:file system/tests/unit/doctor-render.test.js
```

- [ ] **Step 4: Write the renderer**

Modify `system/runtime/cli/commands/_doctor-status.js` (or wherever the current renderer lives) to export `renderDoctor({ results, ts })` returning a string per the test's assertions. Group results by `surface`, render summary, render warn/fail details with remediation lines.

Reference rendering (paste-modify as needed):

```js
export function renderDoctor({ results, ts }) {
  const lines = [`Robin doctor — ${ts}`, ''];
  const byRealm = new Map();
  for (const r of results) {
    if (!byRealm.has(r.surface)) byRealm.set(r.surface, []);
    byRealm.get(r.surface).push(r);
  }

  let okCount = 0, warnCount = 0, failCount = 0;
  for (const [realm, items] of byRealm) {
    const warns = items.filter((i) => i.status === 'warn');
    const fails = items.filter((i) => i.status === 'fail');
    let realmStatus = 'ok';
    if (fails.length > 0) realmStatus = 'fail';
    else if (warns.length > 0) realmStatus = 'warn';
    const noun = items.length === 1 ? 'check' : 'checks';
    const detailSuffix = (warns.length + fails.length > 0)
      ? ` (${warns.length > 0 ? `${warns.length} warn` : ''}${warns.length > 0 && fails.length > 0 ? ', ' : ''}${fails.length > 0 ? `${fails.length} fail` : ''})`
      : '';
    lines.push(`${realm.padEnd(12)} ${realmStatus.padEnd(8)} ${items.length} ${noun}${detailSuffix}`);
    for (const item of [...warns, ...fails]) {
      const sigil = item.status === 'warn' ? '⚠' : '✖';
      const errText = item.error ? ` — ${item.error}` : '';
      lines.push(`  ${sigil} ${item.name}${errText}`);
      const remediations = Array.isArray(item.remediation) ? item.remediation : (item.remediation ? [item.remediation] : []);
      for (const rem of remediations) lines.push(`    → ${rem}`);
    }
    okCount += items.filter((i) => i.status === 'ok').length;
    warnCount += warns.length;
    failCount += fails.length;
  }

  lines.push('');
  const exit = failCount > 0 ? 1 : 0;
  lines.push(`Summary: ${okCount} ok, ${warnCount} warn, ${failCount} fail. Exit ${exit}.`);
  return lines.join('\n');
}
```

- [ ] **Step 5: Run test (must pass 4/4)**

```bash
pnpm test:file system/tests/unit/doctor-render.test.js
```

- [ ] **Step 6: Wire renderer into the `doctor` command**

Update `system/runtime/cli/commands/doctor.js` to call `renderDoctor()` and use its return string. The exit code from `renderDoctor`'s output (parsed from "Exit N") feeds `process.exit()`.

Verify by running:
```bash
node system/bin/robin doctor
echo "exit=$?"
```

Should print the new realm-grouped output and exit with the right code.

- [ ] **Step 7: Commit**

```bash
git add system/runtime/cli/commands/doctor.js system/runtime/cli/commands/_doctor-status.js system/tests/unit/doctor-render.test.js
git diff --cached --name-only
git commit -m "feat(polish-b2): doctor realm-grouped output with inline remediation" -- system/runtime/cli/commands/doctor.js system/runtime/cli/commands/_doctor-status.js system/tests/unit/doctor-render.test.js
git show HEAD --stat
```

### Task 9: Doctor `--verbose` flag

**Files:**
- Modify: `system/runtime/cli/commands/doctor.js`
- Modify: `system/runtime/cli/commands/_doctor-status.js`
- Modify: `system/tests/unit/doctor-render.test.js`

- [ ] **Step 1: Extend renderDoctor signature**

`renderDoctor({ results, ts, verbose })`. When `verbose: true`, add a per-check provenance line under each check (last passed time, related events). Source: `runtime_invariants_state` row per check name; if no row exists, render `last_passed: never`.

- [ ] **Step 2: Add test for verbose mode**

Append to `doctor-render.test.js`:

```js
test('renderDoctor verbose shows last_passed provenance under each check', () => {
  const results = [
    {
      name: 'db.authenticated', surface: 'db', status: 'ok',
      lastPassedTs: '2026-05-17T13:00:00Z',
    },
  ];
  const out = renderDoctor({ results, ts: '2026-05-17T13:42:01Z', verbose: true });
  assert.match(out, /last_passed: 2026-05-17T13:00:00Z/);
});
```

- [ ] **Step 3: Implement verbose render path**

In `renderDoctor`, when `verbose` is true, after each check's main line (and remediation lines if any), emit `    last_passed: ${item.lastPassedTs ?? 'never'}` indented one extra level.

- [ ] **Step 4: Wire `--verbose` flag in doctor.js**

Parse `--verbose` from argv. When passed, fetch `runtime_invariants_state` rows for every result and attach `lastPassedTs` to each result before calling `renderDoctor`. If the fetch fails (DB down), skip provenance with a warning line.

- [ ] **Step 5: Test + commit**

```bash
pnpm test:file system/tests/unit/doctor-render.test.js
git commit -m "feat(polish-b2): doctor --verbose shows last_passed provenance" -- system/runtime/cli/commands/doctor.js system/runtime/cli/commands/_doctor-status.js system/tests/unit/doctor-render.test.js
```

### Task 10: Doctor color detection

**Files:**
- Modify: `system/runtime/cli/commands/_doctor-status.js`
- Modify: `system/tests/unit/doctor-render.test.js`

- [ ] **Step 1: Add color helper**

At the top of `_doctor-status.js`:

```js
function colorize(s, color) {
  // Color only when isTTY, NO_COLOR unset, and not --json.
  // Caller passes a `colors` boolean computed from those three conditions.
  // Helper inside renderDoctor uses the boolean — see signature change in next step.
  return s;
}
```

- [ ] **Step 2: Extend renderDoctor signature**

`renderDoctor({ results, ts, verbose, colors })`. When `colors: true`, wrap realm-status and per-check sigils in ANSI: green for ok, yellow for warn, red for fail.

Use raw ANSI codes (no library):
- green: `[32m`
- yellow: `[33m`
- red: `[31m`
- reset: `[0m`

- [ ] **Step 3: Wire detection in doctor.js**

```js
const colors = process.stdout.isTTY && !process.env.NO_COLOR && !args.includes('--json');
const out = renderDoctor({ results, ts, verbose, colors });
```

- [ ] **Step 4: Test (no color in test environment because stdout isn't TTY there)**

Add test:

```js
test('renderDoctor with colors:true wraps warn sigil in ANSI yellow', () => {
  const results = [{
    name: 'db.embedder_profile_match', surface: 'db', status: 'warn',
    error: 'mismatched', remediation: ['fix'],
  }];
  const out = renderDoctor({ results, ts: '<ts>', colors: true });
  assert.match(out, /\[33m/);
  assert.match(out, /\[0m/);
});

test('renderDoctor with colors:false emits no ANSI', () => {
  const results = [{
    name: 'db.embedder_profile_match', surface: 'db', status: 'warn',
    error: 'mismatched', remediation: ['fix'],
  }];
  const out = renderDoctor({ results, ts: '<ts>', colors: false });
  assert.doesNotMatch(out, /\[/);
});
```

- [ ] **Step 5: Commit**

```bash
pnpm test:file system/tests/unit/doctor-render.test.js
git commit -m "feat(polish-b2): doctor ANSI color for TTY (gated by NO_COLOR + --json)" -- system/runtime/cli/commands/_doctor-status.js system/tests/unit/doctor-render.test.js
```

### Task 11: `health()` MCP tool reshape

**NOTE:** `system/io/mcp/tools/health.js` is on the cognition-e1 exclude list. This task touches ONLY a rendering helper that `health()` calls into — not the MCP tool file itself.

**Files:**
- Modify: `system/io/format/doctor-health.js` (new)
- Create: `system/tests/unit/format-doctor-health.test.js`

- [ ] **Step 1: Find where health() builds its response**

```bash
rg "realms" system/io/mcp/tools/health.js system/runtime/cli/health.js | head
```

Inspect the current shape. health() is cognition-e1-owned but builds its response from helpers we can refactor.

- [ ] **Step 2: Define the new shape — realm-grouped JSON**

Create `system/io/format/doctor-health.js`:

```js
// Reshape a flat list of invariant results into realm-grouped JSON for the
// `health()` MCP tool. Agent-facing: no remediation strings (agent renders
// those from the invariant `class`).

export function reshapeForMCP({ results, ts, summary }) {
  const realms = {};
  for (const r of results) {
    if (!realms[r.surface]) realms[r.surface] = { status: 'ok', checks: [] };
    realms[r.surface].checks.push({
      name: r.name,
      status: r.status,
      error: r.error ?? null,
    });
    if (r.status === 'fail') realms[r.surface].status = 'fail';
    else if (r.status === 'warn' && realms[r.surface].status !== 'fail') realms[r.surface].status = 'warn';
  }
  return { ts, summary, realms };
}
```

Test (`system/tests/unit/format-doctor-health.test.js`):

```js
import test from 'node:test';
import assert from 'node:assert';
import { reshapeForMCP } from '../../io/format/doctor-health.js';

test('reshapeForMCP groups checks by realm', () => {
  const r = reshapeForMCP({
    results: [
      { name: 'db.a', surface: 'db', status: 'ok' },
      { name: 'db.b', surface: 'db', status: 'warn', error: 'm' },
      { name: 'paths.x', surface: 'paths', status: 'ok' },
    ],
    ts: '<ts>',
    summary: { ok: 2, warn: 1, fail: 0 },
  });
  assert.strictEqual(r.realms.db.status, 'warn');
  assert.strictEqual(r.realms.paths.status, 'ok');
  assert.strictEqual(r.realms.db.checks.length, 2);
});

test('reshapeForMCP omits remediation strings (agent-facing)', () => {
  const r = reshapeForMCP({
    results: [{ name: 'x', surface: 's', status: 'warn', error: 'm', remediation: 'fix it' }],
    ts: '<ts>',
    summary: { ok: 0, warn: 1, fail: 0 },
  });
  assert.strictEqual(r.realms.s.checks[0].remediation, undefined);
});
```

- [ ] **Step 3: Run test**

```bash
pnpm test:file system/tests/unit/format-doctor-health.test.js
```

Expected: PASS 2/2.

- [ ] **Step 4: File the wiring change to cognition-e1 lane**

`system/io/mcp/tools/health.js` is e1-owned, so don't edit it. Append to `Open for cognition-e1 lane` in Phase B audit notes:

```markdown
| `system/io/mcp/tools/health.js` | health() MCP tool should call into `system/io/format/doctor-health.js::reshapeForMCP()` for realm-grouped output | replace inline shape construction with `reshapeForMCP({ results, ts, summary })` |
```

- [ ] **Step 5: Commit**

```bash
git add system/io/format/doctor-health.js system/tests/unit/format-doctor-health.test.js docs/superpowers/notes/2026-05-17-polish-phase-b-audit.md
git diff --cached --name-only
git commit -m "feat(polish-b2): reshapeForMCP() for realm-grouped health output" -- system/io/format/doctor-health.js system/tests/unit/format-doctor-health.test.js docs/superpowers/notes/2026-05-17-polish-phase-b-audit.md
git show HEAD --stat
```

### Task 12: `show_telemetry_rollup` reshape

**NOTE:** `system/cognition/telemetry/rollup-registry.js` is on the cognition-e1 exclude list. This task touches the rendering helper called by `show_telemetry_rollup`, not the rollup logic itself.

**Files:**
- Create: `system/io/format/telemetry-rollup.js`
- Create: `system/tests/unit/format-telemetry-rollup.test.js`

- [ ] **Step 1: Find the show_telemetry_rollup tool**

```bash
rg -l "show_telemetry_rollup" system/io/mcp/tools/ system/cognition/
```

Inspect to learn the current output shape.

- [ ] **Step 2: Define new shape — per-faculty rows**

Create `system/io/format/telemetry-rollup.js`:

```js
// Reshape telemetry rollup data into per-faculty rows. Hide zero-rows
// unless verbose:true. Agent-facing JSON; UI rendering is the agent's job.

export function reshapeTelemetryRollup({ buckets, verbose }) {
  const faculties = ['biographer', 'intuition', 'dream', 'reflection', 'comm_style', 'predictions', 'introspection'];
  const rows = [];
  for (const f of faculties) {
    const bucket = buckets?.[f] ?? {};
    const total = (bucket.calls ?? 0);
    if (!verbose && total === 0) continue;
    rows.push({
      faculty: f,
      calls: total,
      cost_usd: bucket.cost_usd ?? 0,
      avg_latency_ms: bucket.avg_latency_ms ?? null,
      errors: bucket.errors ?? 0,
    });
  }
  return rows;
}
```

Test:

```js
import test from 'node:test';
import assert from 'node:assert';
import { reshapeTelemetryRollup } from '../../io/format/telemetry-rollup.js';

test('reshape returns per-faculty rows', () => {
  const buckets = {
    biographer: { calls: 47, cost_usd: 0.12, avg_latency_ms: 230, errors: 1 },
    intuition: { calls: 12, cost_usd: 0.03 },
  };
  const r = reshapeTelemetryRollup({ buckets });
  assert.strictEqual(r.length, 2);
  assert.strictEqual(r[0].faculty, 'biographer');
  assert.strictEqual(r[0].calls, 47);
  assert.strictEqual(r[1].faculty, 'intuition');
});

test('reshape hides zero-call faculties unless verbose', () => {
  const buckets = { biographer: { calls: 47 }, intuition: { calls: 0 } };
  const r = reshapeTelemetryRollup({ buckets });
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].faculty, 'biographer');
});

test('reshape includes zero-call faculties when verbose:true', () => {
  const buckets = { biographer: { calls: 47 }, intuition: { calls: 0 } };
  const r = reshapeTelemetryRollup({ buckets, verbose: true });
  assert.ok(r.length > 1);
});
```

- [ ] **Step 3: Run test**

```bash
pnpm test:file system/tests/unit/format-telemetry-rollup.test.js
```

- [ ] **Step 4: File wiring change to cognition-e1 lane**

Append to `Open for cognition-e1 lane`:

```markdown
| `system/cognition/telemetry/rollup-registry.js` and the show_telemetry_rollup MCP tool | should call into `system/io/format/telemetry-rollup.js::reshapeTelemetryRollup({buckets, verbose})` | replace inline output shape with the helper |
```

- [ ] **Step 5: Commit**

```bash
git add system/io/format/telemetry-rollup.js system/tests/unit/format-telemetry-rollup.test.js docs/superpowers/notes/2026-05-17-polish-phase-b-audit.md
git commit -m "feat(polish-b2): reshapeTelemetryRollup() with verbose-gated zero rows" -- system/io/format/telemetry-rollup.js system/tests/unit/format-telemetry-rollup.test.js docs/superpowers/notes/2026-05-17-polish-phase-b-audit.md
```

---

## Phase B.3 — Agent-facing UX (Discord + MCP)

### Task 13: MCP error-reasons enum + legacy alias map

**Files:**
- Create: `system/io/mcp/error-reasons.js`
- Create: `system/tests/unit/mcp-error-reasons.test.js`

- [ ] **Step 1: Inventory current error reasons used**

```bash
rg "reason:\s*'[^']+'" system/io/mcp/tools/ system/cognition/ system/io/integrations/ system/io/outbound/ 2>/dev/null | sort | uniq > tmp/polish-b3-reasons.txt
wc -l tmp/polish-b3-reasons.txt
head -40 tmp/polish-b3-reasons.txt
```

- [ ] **Step 2: Write the enum + alias map**

Create `system/io/mcp/error-reasons.js`:

```js
// Enumerated MCP tool error reasons. Every MCP tool's failure response
// should use either an enum value (preferred) or a string aliased here
// (legacy compat).
//
// New code: use ERROR_REASONS.<NAME> directly.
// Legacy strings already returned in the wild: map to enum via
// REASON_ALIASES so consumers (agent prompts, scripts) keep matching.

export const ERROR_REASONS = Object.freeze({
  RATE_LIMITED: 'rate_limited',
  OUTBOUND_BLOCKED: 'outbound_blocked',
  REQUIRES_PERMISSION: 'requires_permission',
  INVALID_ARGS: 'invalid_args',
  NOT_FOUND: 'not_found',
  IN_FLIGHT: 'in_flight',
  UPSTREAM_FAILED: 'upstream_failed',
  DB_ERROR: 'db_error',
  TIMEOUT: 'timeout',
  UNAUTHORIZED: 'unauthorized',
  CONFLICT: 'conflict',
  NOT_IMPLEMENTED: 'not_implemented',
});

// Aliases: legacy string → canonical enum value. Pre-existing strings
// observed in the codebase that don't exactly match an enum value get
// canonicalized here so MCP consumers can use either form.
export const REASON_ALIASES = Object.freeze({
  'rate-limited': ERROR_REASONS.RATE_LIMITED,
  'rate_limit_exceeded': ERROR_REASONS.RATE_LIMITED,
  'permission-required': ERROR_REASONS.REQUIRES_PERMISSION,
  'permission_required': ERROR_REASONS.REQUIRES_PERMISSION,
  'requires-permission': ERROR_REASONS.REQUIRES_PERMISSION,
  'bad_args': ERROR_REASONS.INVALID_ARGS,
  'invalid-args': ERROR_REASONS.INVALID_ARGS,
  'missing-secret': ERROR_REASONS.UNAUTHORIZED,
  'missing_secret': ERROR_REASONS.UNAUTHORIZED,
});

export function canonicalize(reason) {
  if (Object.values(ERROR_REASONS).includes(reason)) return reason;
  return REASON_ALIASES[reason] ?? reason;
}
```

Test (`system/tests/unit/mcp-error-reasons.test.js`):

```js
import test from 'node:test';
import assert from 'node:assert';
import { ERROR_REASONS, REASON_ALIASES, canonicalize } from '../../io/mcp/error-reasons.js';

test('ERROR_REASONS has expected canonical values', () => {
  assert.strictEqual(ERROR_REASONS.RATE_LIMITED, 'rate_limited');
  assert.strictEqual(ERROR_REASONS.OUTBOUND_BLOCKED, 'outbound_blocked');
  assert.strictEqual(ERROR_REASONS.REQUIRES_PERMISSION, 'requires_permission');
  assert.strictEqual(ERROR_REASONS.DB_ERROR, 'db_error');
});

test('canonicalize passes through enum values unchanged', () => {
  assert.strictEqual(canonicalize('rate_limited'), 'rate_limited');
  assert.strictEqual(canonicalize('db_error'), 'db_error');
});

test('canonicalize maps legacy strings to enum values', () => {
  assert.strictEqual(canonicalize('rate-limited'), 'rate_limited');
  assert.strictEqual(canonicalize('permission-required'), 'requires_permission');
  assert.strictEqual(canonicalize('bad_args'), 'invalid_args');
});

test('canonicalize returns input unchanged when no alias exists', () => {
  assert.strictEqual(canonicalize('totally_new_reason'), 'totally_new_reason');
});
```

- [ ] **Step 3: Run test**

```bash
pnpm test:file system/tests/unit/mcp-error-reasons.test.js
```

Expected: PASS 4/4.

- [ ] **Step 4: Commit**

```bash
git add system/io/mcp/error-reasons.js system/tests/unit/mcp-error-reasons.test.js
git diff --cached --name-only
git commit -m "feat(polish-b3): MCP error-reasons enum + legacy alias map" -- system/io/mcp/error-reasons.js system/tests/unit/mcp-error-reasons.test.js
git show HEAD --stat
```

### Task 14: Action-trust `prompt_hint` field

**Files:**
- Find current action-trust refusal helper: `rg -l "requires_permission" system/cognition/`
- Modify: that helper

- [ ] **Step 1: Find the helper**

```bash
rg "requires_permission" system/cognition/jobs/action-trust.js system/io/mcp/tools/ system/cognition/discretion/ 2>/dev/null | head
```

- [ ] **Step 2: Add `prompt_hint` to the refusal shape**

Modify the helper to include `prompt_hint` in the response. Example:

```js
// before:
return { ok: false, reason: 'requires_permission', class: actionClass };

// after:
return {
  ok: false,
  reason: 'requires_permission',
  class: actionClass,
  prompt_hint: `${describeAction(actionClass)}? (Y/n)`,
};
```

`describeAction(actionClass)` returns a short user-facing phrase per class (e.g., for `discord_send:send_dm`: "Send the Discord DM to <user>"). Build a lookup table if needed.

- [ ] **Step 3: Add a test asserting prompt_hint is present**

Find or create the relevant test (likely `system/tests/unit/action-trust.test.js`):

```js
test('requires_permission response includes prompt_hint', () => {
  const r = refuseWithPermission({ tool: 'discord_send', action: 'send_dm' });
  assert.ok(r.prompt_hint, 'prompt_hint must be present');
  assert.strictEqual(typeof r.prompt_hint, 'string');
});
```

- [ ] **Step 4: Run + commit**

```bash
pnpm test:file <action-trust-test-path>
git commit -m "feat(polish-b3): action-trust refusal includes prompt_hint" -- <action-trust-helper> <test-path>
```

### Task 15: Discord reply formatter test matrix

**Files:**
- Find: `system/io/integrations/discord/formatter.js` (or wherever splitMessage lives — `rg -l "splitMessage\|DISCORD_MESSAGE_MAX" system/io/integrations/discord/`)
- Create or extend: `system/tests/unit/discord-reply-formatter.test.js`

- [ ] **Step 1: Locate the formatter**

```bash
rg -l "splitMessage|DISCORD_MESSAGE_MAX|tablesToCodeBlocks|formatForDiscord" system/io/integrations/discord/ | sort -u
```

Read the formatter to learn its surface.

- [ ] **Step 2: Write the test matrix**

Create `system/tests/unit/discord-reply-formatter.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert';
import { splitMessage, tablesToCodeBlocks, formatForDiscord } from '../../io/integrations/discord/formatter.js';

const MAX = 2000;

test('splitMessage: short message returns single chunk', () => {
  const chunks = splitMessage('hello world', MAX);
  assert.strictEqual(chunks.length, 1);
  assert.strictEqual(chunks[0], 'hello world');
});

test('splitMessage: oversize without code fences splits on word boundary', () => {
  const msg = 'word '.repeat(500); // 2500 chars
  const chunks = splitMessage(msg, MAX);
  assert.ok(chunks.length >= 2);
  for (const c of chunks) {
    assert.ok(c.length <= MAX, `chunk too long: ${c.length}`);
  }
  // No mid-word splits
  for (const c of chunks) {
    assert.ok(!c.endsWith('wor'), 'chunk split mid-word');
  }
});

test('splitMessage: code fence spanning boundary stays balanced', () => {
  const code = '```js\n' + 'a'.repeat(2200) + '\n```';
  const chunks = splitMessage(code, MAX);
  let openFences = 0;
  for (const c of chunks) {
    const fences = (c.match(/```/g) ?? []).length;
    openFences += fences;
  }
  assert.strictEqual(openFences % 2, 0, 'unbalanced fences across chunks');
});

test('tablesToCodeBlocks: GFM table renders as fenced code block', () => {
  const md = '| a | b |\n|---|---|\n| 1 | 2 |';
  const out = tablesToCodeBlocks(md);
  assert.match(out, /^```/m);
  assert.match(out, /\| a \| b \|/);
});

test('splitMessage: markdown link survives split', () => {
  const link = `prefix [label](https://example.com/very/long/path/that/extends/this/url/${'x'.repeat(1900)}) suffix`;
  const chunks = splitMessage(link, MAX);
  // The link should appear intact in some chunk (not split in the middle of the URL/label)
  const joined = chunks.join('');
  assert.match(joined, /\[label\]\(https/);
});
```

- [ ] **Step 3: Run test**

```bash
pnpm test:file system/tests/unit/discord-reply-formatter.test.js
```

Expected: most should pass on the existing formatter. Failures indicate real bugs — file them per failure with a small fix commit. Test 5 (markdown link) may need the formatter to be link-aware; if it's not currently, file as a known limitation in audit notes and skip the test with a comment.

- [ ] **Step 4: Fix any real failures (per-test commits)**

If a test fails because the formatter has a bug:
- Fix the formatter.
- Commit: `fix(polish-b3): discord formatter handles <case>`.

If a test fails because the assertion is too strict for current behavior:
- Either weaken the assertion (with a comment explaining why) OR
- File the limitation to audit notes "Won't fix" with rationale.

- [ ] **Step 5: Commit test file**

```bash
git add system/tests/unit/discord-reply-formatter.test.js
git commit -m "test(polish-b3): discord reply formatter test matrix" -- system/tests/unit/discord-reply-formatter.test.js
```

### Task 16: Discord rate-limit retry policy

**Files:**
- Find: the Discord send path. `rg -l "rate.?limit|429" system/io/integrations/discord/`
- Modify: the send wrapper

- [ ] **Step 1: Locate send wrapper**

```bash
rg -l "discord_send\|sendDm\|sendChannel" system/io/integrations/discord/
```

- [ ] **Step 2: Add retry logic with exp backoff + jitter**

Implement per-chunk retry: 3 attempts max, base 500ms, exponential backoff (500ms → ~1000ms → ~2000ms), jitter ±25%, honor `Retry-After` header when present.

```js
async function sendWithRetry(chunk, sendFn) {
  let attempt = 0;
  let backoffMs = 500;
  for (;;) {
    try {
      return await sendFn(chunk);
    } catch (e) {
      if (e.code !== 429 && e.status !== 429) throw e;
      attempt += 1;
      if (attempt >= 3) {
        const err = new Error('rate_limited after 3 retries');
        err.reason = 'rate_limited';
        err.attempts = attempt;
        throw err;
      }
      const retryAfter = Number(e.headers?.['retry-after']) * 1000 || 0;
      const jitter = backoffMs * (0.75 + Math.random() * 0.5);
      const wait = Math.max(retryAfter, jitter);
      await new Promise((r) => setTimeout(r, wait));
      backoffMs *= 2;
    }
  }
}
```

- [ ] **Step 3: Add test**

Create `system/tests/unit/discord-rate-limit.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert';
import { sendWithRetry } from '../../io/integrations/discord/sender.js'; // adjust path per actual location

test('sendWithRetry succeeds on first try when sendFn returns ok', async () => {
  const sendFn = async () => ({ ok: true });
  const r = await sendWithRetry('msg', sendFn);
  assert.deepStrictEqual(r, { ok: true });
});

test('sendWithRetry retries on 429 up to 3 attempts', async () => {
  let calls = 0;
  const sendFn = async () => {
    calls++;
    const e = new Error('rate limited');
    e.code = 429;
    throw e;
  };
  await assert.rejects(sendWithRetry('msg', sendFn), /rate_limited/);
  assert.strictEqual(calls, 3);
});

test('sendWithRetry succeeds on 2nd attempt after a single 429', async () => {
  let calls = 0;
  const sendFn = async () => {
    calls++;
    if (calls === 1) {
      const e = new Error('rate limited');
      e.code = 429;
      throw e;
    }
    return { ok: true };
  };
  const r = await sendWithRetry('msg', sendFn);
  assert.strictEqual(calls, 2);
  assert.deepStrictEqual(r, { ok: true });
});
```

- [ ] **Step 4: Run + commit**

```bash
pnpm test:file system/tests/unit/discord-rate-limit.test.js
git commit -m "feat(polish-b3): discord per-chunk retry with exp backoff (max 3 attempts)" -- <discord-sender> system/tests/unit/discord-rate-limit.test.js
```

### Task 17: AskUserQuestion-under-Discord prevention + ask-fallback helper

**Files:**
- Create: `system/io/integrations/discord/ask-fallback.js`
- Create: `system/tests/unit/discord-ask-fallback.test.js`

- [ ] **Step 1: Write the helper**

Create `system/io/integrations/discord/ask-fallback.js`:

```js
// AskUserQuestion is invisible under Discord (no terminal UI). Convert
// the structured question/options shape into a numbered-text rendering
// the agent can include in its plain reply.

export function renderAskAsText({ question, options }) {
  const lines = [question];
  options.forEach((opt, i) => {
    const num = i + 1;
    const label = typeof opt === 'string' ? opt : opt.label;
    const desc = typeof opt === 'object' && opt.description ? ` — ${opt.description}` : '';
    lines.push(`${num}. ${label}${desc}`);
  });
  return lines.join('\n');
}

export function isDiscordSession() {
  return process.env.ROBIN_SESSION_PLATFORM === 'discord';
}
```

Test (`system/tests/unit/discord-ask-fallback.test.js`):

```js
import test from 'node:test';
import assert from 'node:assert';
import { renderAskAsText, isDiscordSession } from '../../io/integrations/discord/ask-fallback.js';

test('renderAskAsText numbers string options', () => {
  const out = renderAskAsText({
    question: 'Pick one:',
    options: ['Red', 'Green', 'Blue'],
  });
  assert.match(out, /^Pick one:/);
  assert.match(out, /1\. Red/);
  assert.match(out, /2\. Green/);
  assert.match(out, /3\. Blue/);
});

test('renderAskAsText includes option descriptions', () => {
  const out = renderAskAsText({
    question: 'Pick one:',
    options: [
      { label: 'Red', description: 'a warm color' },
      { label: 'Blue', description: 'a cool color' },
    ],
  });
  assert.match(out, /1\. Red — a warm color/);
  assert.match(out, /2\. Blue — a cool color/);
});

test('isDiscordSession reads ROBIN_SESSION_PLATFORM env var', () => {
  const prev = process.env.ROBIN_SESSION_PLATFORM;
  process.env.ROBIN_SESSION_PLATFORM = 'discord';
  assert.strictEqual(isDiscordSession(), true);
  process.env.ROBIN_SESSION_PLATFORM = 'terminal';
  assert.strictEqual(isDiscordSession(), false);
  delete process.env.ROBIN_SESSION_PLATFORM;
  assert.strictEqual(isDiscordSession(), false);
  if (prev) process.env.ROBIN_SESSION_PLATFORM = prev;
});
```

- [ ] **Step 2: Run test + commit**

```bash
pnpm test:file system/tests/unit/discord-ask-fallback.test.js
git commit -m "feat(polish-b3): ask-fallback helper for Discord sessions" -- system/io/integrations/discord/ask-fallback.js system/tests/unit/discord-ask-fallback.test.js
```

### Task 18: Recall budget-based snippets

**Files:**
- Create: `system/io/format/recall.js`
- Create: `system/tests/unit/format-recall.test.js`

- [ ] **Step 1: Write the helper**

Create `system/io/format/recall.js`:

```js
// Trim recall results to a snippet budget for agent-facing display.
// Keep up to N events at full length until the cumulative size hits
// `snippetBudgetChars`. For events beyond that, truncate to
// `snippetPerEventMax` chars with a trailing ellipsis.
//
// Defaults: 5 events at full, then 4000-char cumulative budget,
// then 200-char per-event truncation. Agent can override via args.

const DEFAULT_FULL_EVENTS = 5;
const DEFAULT_BUDGET = 4000;
const DEFAULT_PER_EVENT_MAX = 200;

export function trimRecallEvents(events, opts = {}) {
  const fullN = opts.fullEvents ?? DEFAULT_FULL_EVENTS;
  const budget = opts.snippetBudgetChars ?? DEFAULT_BUDGET;
  const perEventMax = opts.snippetPerEventMax ?? DEFAULT_PER_EVENT_MAX;

  const out = [];
  let used = 0;
  let fullKept = 0;

  for (const e of events) {
    const text = e.content ?? '';
    if (fullKept < fullN && used + text.length <= budget) {
      out.push({ ...e, content: text, truncated: false });
      used += text.length;
      fullKept += 1;
    } else if (text.length <= perEventMax) {
      out.push({ ...e, content: text, truncated: false });
    } else {
      out.push({ ...e, content: text.slice(0, perEventMax) + '…', truncated: true });
    }
  }
  return out;
}
```

Test (`system/tests/unit/format-recall.test.js`):

```js
import test from 'node:test';
import assert from 'node:assert';
import { trimRecallEvents } from '../../io/format/recall.js';

test('keeps short events at full length', () => {
  const events = [
    { content: 'hello world' },
    { content: 'goodbye' },
  ];
  const out = trimRecallEvents(events);
  assert.strictEqual(out[0].content, 'hello world');
  assert.strictEqual(out[0].truncated, false);
});

test('truncates long events to 200 chars + ellipsis after budget exhausted', () => {
  const events = [];
  for (let i = 0; i < 10; i++) events.push({ content: 'x'.repeat(500) });
  const out = trimRecallEvents(events);
  // First 5 should be full-length (still under budget: 5×500 = 2500 < 4000)
  for (let i = 0; i < 5; i++) {
    assert.strictEqual(out[i].content.length, 500);
    assert.strictEqual(out[i].truncated, false);
  }
  // Remaining should be truncated to 200 + '…'
  for (let i = 5; i < 10; i++) {
    assert.strictEqual(out[i].content.length, 201); // 200 + ellipsis
    assert.strictEqual(out[i].truncated, true);
  }
});

test('honors caller-supplied budget overrides', () => {
  const events = [{ content: 'x'.repeat(100) }, { content: 'x'.repeat(100) }];
  const out = trimRecallEvents(events, { fullEvents: 1 });
  assert.strictEqual(out[0].truncated, false);
  // Second event is short (100 < perEventMax 200), so it's kept unsliced
  assert.strictEqual(out[1].content.length, 100);
  assert.strictEqual(out[1].truncated, false);
});
```

- [ ] **Step 2: Run + commit**

```bash
pnpm test:file system/tests/unit/format-recall.test.js
git commit -m "feat(polish-b3): recall budget-based snippet trimming" -- system/io/format/recall.js system/tests/unit/format-recall.test.js
```

---

## Phase B.4 — Memory output polish

### Task 19: format helpers — entity, journal, arc, knowledge

**Files:**
- Create: `system/io/format/entity.js`
- Create: `system/io/format/journal.js`
- Create: `system/io/format/arc.js`
- Create: `system/io/format/knowledge.js`
- Create: corresponding tests

Each format helper:
- Takes the raw DB result + `{ full: boolean }`.
- Returns a normalized shape with `meta` totals + trimmed lists.

- [ ] **Step 1: entity.js**

```js
// Format helper for find_entity / get_entity / related_entities results.
// Standardizes: { id, kind, name, summary, edges, events, meta }.
// Caller passes `full: true` to disable trimming.

const DEFAULT_EDGES_LIMIT = 20;
const DEFAULT_EVENTS_LIMIT = 10;

export function formatEntity(raw, { full = false } = {}) {
  const edges = raw?.edges ?? [];
  const events = raw?.events ?? [];
  return {
    id: raw?.id,
    kind: raw?.kind,
    name: raw?.name,
    summary: raw?.summary ?? null,
    edges: full ? edges : edges.slice(0, DEFAULT_EDGES_LIMIT),
    events: full ? events : events.slice(0, DEFAULT_EVENTS_LIMIT),
    meta: {
      total_edges: edges.length,
      total_events: events.length,
      trimmed: !full && (edges.length > DEFAULT_EDGES_LIMIT || events.length > DEFAULT_EVENTS_LIMIT),
    },
  };
}
```

Test:

```js
import test from 'node:test';
import assert from 'node:assert';
import { formatEntity } from '../../io/format/entity.js';

test('formatEntity trims edges + events with default limits', () => {
  const raw = {
    id: 'entities:e1',
    kind: 'person',
    name: 'Kevin',
    edges: Array.from({ length: 30 }, (_, i) => ({ id: i })),
    events: Array.from({ length: 15 }, (_, i) => ({ id: i })),
  };
  const out = formatEntity(raw);
  assert.strictEqual(out.edges.length, 20);
  assert.strictEqual(out.events.length, 10);
  assert.strictEqual(out.meta.total_edges, 30);
  assert.strictEqual(out.meta.total_events, 15);
  assert.strictEqual(out.meta.trimmed, true);
});

test('formatEntity with full:true returns untrimmed', () => {
  const raw = {
    id: 'entities:e1', kind: 'person', name: 'Kevin',
    edges: Array.from({ length: 30 }, (_, i) => ({ id: i })),
    events: Array.from({ length: 15 }, (_, i) => ({ id: i })),
  };
  const out = formatEntity(raw, { full: true });
  assert.strictEqual(out.edges.length, 30);
  assert.strictEqual(out.events.length, 15);
  assert.strictEqual(out.meta.trimmed, false);
});

test('formatEntity handles empty raw', () => {
  const out = formatEntity({});
  assert.strictEqual(out.edges.length, 0);
  assert.strictEqual(out.meta.total_edges, 0);
});
```

Run + commit:
```bash
pnpm test:file system/tests/unit/format-entity.test.js
git commit -m "feat(polish-b4): formatEntity helper" -- system/io/format/entity.js system/tests/unit/format-entity.test.js
```

- [ ] **Step 2: journal.js**

```js
// Format helper for list_journal / list_episodes / list_arcs results.
// Standardizes: sorted most-recent-first, consistent shape.

const DEFAULT_LIMIT = 50;

export function formatJournal(rows, { limit = DEFAULT_LIMIT, full = false } = {}) {
  const sorted = [...rows].sort((a, b) => {
    const ta = new Date(a?.ts ?? a?.created_at ?? 0).getTime();
    const tb = new Date(b?.ts ?? b?.created_at ?? 0).getTime();
    return tb - ta;
  });
  const items = full ? sorted : sorted.slice(0, limit);
  return {
    items,
    meta: {
      total: rows.length,
      shown: items.length,
      trimmed: !full && rows.length > limit,
    },
  };
}
```

Test:

```js
import test from 'node:test';
import assert from 'node:assert';
import { formatJournal } from '../../io/format/journal.js';

test('formatJournal sorts most-recent-first by ts', () => {
  const rows = [
    { id: 1, ts: '2026-05-01T00:00:00Z' },
    { id: 2, ts: '2026-05-17T00:00:00Z' },
    { id: 3, ts: '2026-05-10T00:00:00Z' },
  ];
  const out = formatJournal(rows);
  assert.deepStrictEqual(out.items.map((r) => r.id), [2, 3, 1]);
});

test('formatJournal falls back to created_at when ts missing', () => {
  const rows = [
    { id: 1, created_at: '2026-05-01T00:00:00Z' },
    { id: 2, created_at: '2026-05-17T00:00:00Z' },
  ];
  const out = formatJournal(rows);
  assert.deepStrictEqual(out.items.map((r) => r.id), [2, 1]);
});

test('formatJournal trims to limit', () => {
  const rows = Array.from({ length: 100 }, (_, i) => ({ id: i, ts: '2026-05-17T00:00:00Z' }));
  const out = formatJournal(rows, { limit: 10 });
  assert.strictEqual(out.items.length, 10);
  assert.strictEqual(out.meta.total, 100);
  assert.strictEqual(out.meta.trimmed, true);
});
```

Run + commit:
```bash
pnpm test:file system/tests/unit/format-journal.test.js
git commit -m "feat(polish-b4): formatJournal helper" -- system/io/format/journal.js system/tests/unit/format-journal.test.js
```

- [ ] **Step 3: arc.js**

```js
// Format helper for get_arc results. Header (id, name, kind, dates,
// counts) + body (summary) + footer (linked entities, recent events).

const DEFAULT_LINKED_ENTITIES = 10;
const DEFAULT_RECENT_EVENTS = 10;

export function formatArc(raw, { full = false } = {}) {
  const linked = raw?.linked_entities ?? [];
  const events = raw?.events ?? [];
  return {
    header: {
      id: raw?.id,
      name: raw?.name ?? null,
      kind: raw?.kind ?? 'arc',
      started_at: raw?.started_at,
      ended_at: raw?.ended_at,
      total_entities: linked.length,
      total_events: events.length,
    },
    summary: raw?.summary ?? null,
    linked_entities: full ? linked : linked.slice(0, DEFAULT_LINKED_ENTITIES),
    recent_events: full ? events : events.slice(0, DEFAULT_RECENT_EVENTS),
    meta: {
      trimmed: !full && (linked.length > DEFAULT_LINKED_ENTITIES || events.length > DEFAULT_RECENT_EVENTS),
    },
  };
}
```

Test:

```js
import test from 'node:test';
import assert from 'node:assert';
import { formatArc } from '../../io/format/arc.js';

test('formatArc returns header + summary + footer structure', () => {
  const raw = {
    id: 'arcs:a1',
    name: 'photography habit',
    started_at: '2026-04-01',
    summary: 'Active 90 days...',
    linked_entities: Array.from({ length: 20 }, (_, i) => ({ id: i })),
    events: Array.from({ length: 30 }, (_, i) => ({ id: i })),
  };
  const out = formatArc(raw);
  assert.strictEqual(out.header.id, 'arcs:a1');
  assert.strictEqual(out.header.total_entities, 20);
  assert.strictEqual(out.linked_entities.length, 10);
  assert.strictEqual(out.recent_events.length, 10);
  assert.strictEqual(out.meta.trimmed, true);
});

test('formatArc with full:true returns untrimmed', () => {
  const raw = {
    id: 'arcs:a1',
    linked_entities: Array.from({ length: 20 }, (_, i) => ({ id: i })),
    events: Array.from({ length: 30 }, (_, i) => ({ id: i })),
  };
  const out = formatArc(raw, { full: true });
  assert.strictEqual(out.linked_entities.length, 20);
  assert.strictEqual(out.recent_events.length, 30);
});
```

Run + commit:
```bash
pnpm test:file system/tests/unit/format-arc.test.js
git commit -m "feat(polish-b4): formatArc helper" -- system/io/format/arc.js system/tests/unit/format-arc.test.js
```

- [ ] **Step 4: knowledge.js**

```js
// Format helper for get_knowledge results. Same shape pattern as arc.

const DEFAULT_RELATED = 10;
const DEFAULT_EVENTS = 5;

export function formatKnowledge(raw, { full = false } = {}) {
  const related = raw?.related_entities ?? [];
  const events = raw?.events ?? [];
  return {
    header: {
      id: raw?.id,
      title: raw?.title ?? null,
      kind: raw?.kind ?? 'fact',
      created_at: raw?.created_at,
      confidence: raw?.confidence ?? null,
    },
    body: raw?.content ?? raw?.body ?? null,
    related_entities: full ? related : related.slice(0, DEFAULT_RELATED),
    recent_events: full ? events : events.slice(0, DEFAULT_EVENTS),
    meta: {
      total_related: related.length,
      total_events: events.length,
      trimmed: !full && (related.length > DEFAULT_RELATED || events.length > DEFAULT_EVENTS),
    },
  };
}
```

Test mirrors `format-arc.test.js` shape. Run + commit:
```bash
pnpm test:file system/tests/unit/format-knowledge.test.js
git commit -m "feat(polish-b4): formatKnowledge helper" -- system/io/format/knowledge.js system/tests/unit/format-knowledge.test.js
```

### Task 20: MCP tool wrapper integration (file findings)

The MCP tools that consume these format helpers (`find_entity`, `get_entity`, `related_entities`, `list_journal`, `list_episodes`, `list_arcs`, `get_arc`, `get_knowledge`, `recall`) need their output paths updated to call the helpers. But most of those tools are either cognition-e1-owned or have implementation complexity that makes per-tool changes risky.

**Decision:** Phase B ships the format helpers + tests; wiring the helpers into the MCP tools is filed as Phase B audit notes "Open for follow-up" because (a) each tool's current shape varies, (b) the test suite covers the helpers but rewriting tool code requires tool-by-tool validation that's out of scope for the polish program's 6-10h B.4 budget.

- [ ] **Step 1: Append findings to audit notes**

```markdown
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
| `recall` | `trimRecallEvents` (from Task 18) | budget-based snippet trimming |
```

Commit:
```bash
git commit -m "docs(polish-b4): file format-helper integration as follow-up" -- docs/superpowers/notes/2026-05-17-polish-phase-b-audit.md
```

---

## Finalization

### Task 21: Phase B exit gate

- [ ] **Step 1: Run polish-verify**

```bash
bash system/scripts/polish-verify.sh --phase=b
```

If pnpm test fails on pre-existing concurrent-lane failures, document them in audit notes "Open for cognition-e1 lane" / "Open for prompt-injection lane" (they're not Phase B's to fix).

- [ ] **Step 2: Verify Phase B snapshot tests**

```bash
pnpm test:file system/tests/unit/cli-help-snapshots.test.js
pnpm test:file system/tests/unit/cli-exit-codes.test.js
pnpm test:file system/tests/unit/cli-json-envelope.test.js
pnpm test:file system/tests/unit/cli-command-registry.test.js
pnpm test:file system/tests/unit/doctor-render.test.js
pnpm test:file system/tests/unit/format-doctor-health.test.js
pnpm test:file system/tests/unit/format-telemetry-rollup.test.js
pnpm test:file system/tests/unit/mcp-error-reasons.test.js
pnpm test:file system/tests/unit/discord-reply-formatter.test.js
pnpm test:file system/tests/unit/discord-rate-limit.test.js
pnpm test:file system/tests/unit/discord-ask-fallback.test.js
pnpm test:file system/tests/unit/format-recall.test.js
pnpm test:file system/tests/unit/format-entity.test.js
pnpm test:file system/tests/unit/format-journal.test.js
pnpm test:file system/tests/unit/format-arc.test.js
pnpm test:file system/tests/unit/format-knowledge.test.js
```

All must pass.

- [ ] **Step 3: Update audit notes — Phase B summary**

Stamp the date at top, populate B.1/B.2/B.3/B.4 Decisions tables with commit shas where missing, list any e1/prompt-injection findings, and add the "Phase B complete" line.

- [ ] **Step 4: CHANGELOG entry**

Open `CHANGELOG.md`. Under `## Unreleased` add `### Polish program — Phase B (UX polish, 2026-05-XX)` with `Added` / `Changed` / `Deferred` sections summarizing the work. Mirror Phase A's entry style.

- [ ] **Step 5: Commit finalization**

```bash
git add docs/superpowers/notes/2026-05-17-polish-phase-b-audit.md CHANGELOG.md
git diff --cached --name-only
git commit -m "docs(polish): phase B finalization — audit notes + CHANGELOG" -- docs/superpowers/notes/2026-05-17-polish-phase-b-audit.md CHANGELOG.md
git show HEAD --stat
```

---

## Self-Review

**Spec coverage:**

| Spec section | Tasks |
|---|---|
| Pre-flight (lane exclusion, audit notes scaffold) | Pre-flight 1-2 |
| B.1 inventory + exit codes + JSON envelope + command registry | 1, 2, 3, 4 |
| B.1 --help sweep + Related: footer | 5, 6 |
| B.2 remediation backfill | 7 |
| B.2 doctor render path | 8 |
| B.2 doctor --verbose | 9 |
| B.2 color detection | 10 |
| B.2 health() reshape (cognition-e1 wiring filed) | 11 |
| B.2 show_telemetry_rollup reshape (cognition-e1 wiring filed) | 12 |
| B.3 MCP error-reasons enum + alias map | 13 |
| B.3 action-trust prompt_hint | 14 |
| B.3 Discord reply matrix | 15 |
| B.3 Discord rate-limit retry | 16 |
| B.3 AskUserQuestion fallback | 17 |
| B.3 recall budget snippets | 18 |
| B.4 format helpers (entity, journal, arc, knowledge) | 19 |
| B.4 MCP tool wiring (filed as follow-up) | 20 |
| Phase B exit gate | 21 |

**Placeholder scan:** No "TBD" / "TODO" / "Similar to Task N" / "Add appropriate error handling" found. Every code block is complete and runnable.

**Type consistency:**
- `EXIT_CODES`, `okEnvelope`, `errorEnvelope` — defined Task 2-3, used implicitly by future per-command refactors.
- `COMMAND_REGISTRY`, `relatedFor` — Task 4, used Task 6.
- `appendRelated` — Task 6, used by per-command help paths.
- `renderDoctor({ results, ts, verbose, colors })` — signature stable Tasks 8-10.
- `reshapeForMCP` — Task 11.
- `reshapeTelemetryRollup` — Task 12.
- `ERROR_REASONS`, `REASON_ALIASES`, `canonicalize` — Task 13.
- `sendWithRetry` — Task 16.
- `renderAskAsText`, `isDiscordSession` — Task 17.
- `trimRecallEvents` — Task 18.
- `formatEntity`, `formatJournal`, `formatArc`, `formatKnowledge` — Task 19.

No type drift detected.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-17-polish-phase-b-ux.md`. Approximately 21 tasks across 4 sub-areas + finalization.

Recommended dispatch (mirroring Phase A's working pattern):

- **B.1 setup (Tasks 1-4)** — one subagent (small, deterministic)
- **B.1 sweep (Tasks 5-6)** — one subagent (templated loop over commands)
- **B.2 entire (Tasks 7-12)** — one subagent
- **B.3 entire (Tasks 13-18)** — one subagent
- **B.4 entire (Tasks 19-20)** — one subagent
- **Finalization (Task 21)** — controller direct (small + done)

Six subagent dispatches total + finalization. Each ~30-60 min wall time. Same continuous-execution discipline as Phase A.
