# Polish Phase A — Sanitation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Execute Phase A of the polish program: silent-failure hunt, dead-code purge, test gaps + slow-test cleanup, observability + invariant hardening — producing landed commits + a reviewed audit notes file that seeds Phase B.

**Architecture:** Audit-driven sweep. Plan provides full code for scaffolding (helpers, tools, new invariants, logger module, githook extension) and structured per-finding loops with concrete templates. Per-finding fixes are not pre-enumerable — they emerge from the scan steps — so this plan formalizes the loop shape rather than enumerating fixes. Audit notes file is the authoritative record of every finding's decision and commit sha.

**Tech Stack:** Node.js 24.14.1 (pinned via `.npmrc` `use-node-version`), pnpm, ESM modules, SurrealDB embedded (`@surrealdb/node` v3), Node's built-in test runner (`node --test`), ripgrep, madge (added as dev dep), `mock.timers` for deterministic time, `assert.strictEqual` for snapshot tests.

**Spec:** `docs/superpowers/specs/2026-05-17-polish-phase-a-sanitation-design.md`

**Sibling spec:** `docs/superpowers/specs/2026-05-17-polish-phase-b-ux-design.md` (NOT covered by this plan; awaits Phase A audit notes)

---

## Pre-flight

Before starting any task: confirm the cognition-e1 exclude list (Section "Cognition-e1 conflict policy" in the spec) and the current `git status` to detect any newly-added cognition-e1 WIP files that should be added to the exclude set.

- [ ] **Pre-flight 1: Re-snapshot cognition-e1 exclude list**

Run:
```bash
git status --short | grep -E "^(M|\\?\\?) system/cognition/|^M system/io/mcp/tools/(health|remember)\\.js|^M system/data/(db/client|embed/factory)\\.js|^M system/io/capture/session-capture\\.js" > /tmp/polish-phase-a-e1-snapshot.txt
cat /tmp/polish-phase-a-e1-snapshot.txt
```

Expected: a list of cognition-e1 WIP files. If any file appears that is NOT in the spec's exclude list, append it to the local working copy of the exclude list and surface to the user. Do NOT edit the committed spec yet — track deltas in `tmp/polish-phase-a-e1-delta.txt` for spec amendment at audit-notes write-up time.

- [ ] **Pre-flight 2: Verify clean working tree relative to polish scope**

Run:
```bash
git status --short | grep -v "^?? user-data/" | grep -v "^?? .claude/" | grep -v "^?? tmp/"
```

Expected: lists only cognition-e1 WIP files. No polish-related files should be uncommitted at start. If there are unexpected entries, ask the user before proceeding.

- [ ] **Pre-flight 3: Confirm full test suite green at baseline**

Run:
```bash
pnpm test
```

Expected: all tests pass, exit 0. If any tests fail at baseline, the failures are recorded as a Phase A entry under "Open for cognition-e1 lane" or "Open for user" — Phase A does not fix tests that were broken before it started, but it does record them.

---

## Setup tasks

### Task 1: Create audit notes scaffold

**Files:**
- Create: `docs/superpowers/notes/2026-05-17-polish-phase-a-audit.md`

- [ ] **Step 1: Write the scaffold**

Create the file with this content:

````markdown
# Polish Phase A — Audit Notes

**Date range:** 2026-05-17 → <end>
**Phase A complete:** <date>

## A.1 Silent-failure hunt

### Inventory

(populated by A.1 tasks)

### Decisions

| Site | Classification | Rationale | Commit |
|---|---|---|---|

## A.2 Dead-code + unused-file purge

### Inventory

(populated by A.2 tasks)

### Decisions

| Item | Decision | Rationale | Commit |
|---|---|---|---|

## A.3 Test gaps + slow-test cleanup

### Inventory

(populated by A.3 tasks)

### Decisions

| Module / Test | Decision | Rationale | Commit |
|---|---|---|---|

## A.4 Observability + invariant hardening

### Baseline metrics

See `docs/superpowers/notes/2026-05-17-polish-phase-a-log-baseline.md`

### Log noise decisions

| Pattern | Count | Classification | Action | Commit |
|---|---|---|---|---|

### Invariant coverage decisions

(populated by A.4 tasks; mirror the table from the spec)

## Open for cognition-e1 lane

| File | Finding | Suggested fix |
|---|---|---|

## Open for prompt-injection lane

(Authorized by the user's "path 3" decision at execution time: a third lane —
prompt-injection hardening — was discovered active on main after the spec/plan
were committed. Phase A defers any files that lane is actively modifying; findings
against them file here for that lane to triage.)

| File | Finding | Suggested fix |
|---|---|---|

## Open for user

| Item | Question | Recommended action |
|---|---|---|

## Won't fix

| Item | Rationale |
|---|---|

## Bridge to Phase B

_Priority enum: `high` (blocker for Phase B) / `med` (do early) / `low` (do later)._

| Phase B target | Type | Provenance | Priority |
|---|---|---|---|
````

- [ ] **Step 2: Commit the scaffold**

```bash
git add docs/superpowers/notes/2026-05-17-polish-phase-a-audit.md
git diff --cached --name-only
git commit -m "docs(polish): phase A audit notes scaffold" -- docs/superpowers/notes/2026-05-17-polish-phase-a-audit.md
git show HEAD --stat
```

Expected: one file added; no other paths swept up.

---

### Task 2: Create snapshot-test normalization helper

**Files:**
- Create: `system/tests/helpers/normalize-snapshot.js`
- Test: `system/tests/unit/normalize-snapshot.test.js`

- [ ] **Step 1: Write the failing test**

Create `system/tests/unit/normalize-snapshot.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert';
import { normalize, normalizeDoctorOutput } from '../helpers/normalize-snapshot.js';

test('normalize replaces ISO timestamps with <TIMESTAMP>', () => {
  const input = 'started at 2026-05-17T13:42:01.123Z and ended at 2026-05-17T13:43:00Z';
  const out = normalize(input);
  assert.strictEqual(out, 'started at <TIMESTAMP> and ended at <TIMESTAMP>');
});

test('normalize replaces surreal record ids with <ID>', () => {
  const input = 'fetched events:abc123def and events:9_xyz';
  const out = normalize(input);
  assert.strictEqual(out, 'fetched events:<ID> and events:<ID>');
});

test('normalize replaces pids', () => {
  const input = 'pid=12345 running; pid=9 idle';
  const out = normalize(input);
  assert.strictEqual(out, 'pid=<PID> running; pid=<PID> idle');
});

test('normalize replaces took_ms durations', () => {
  const input = '{ "took_ms": 47, "other": 12 }';
  const out = normalize(input);
  assert.strictEqual(out, '{ "took_ms": <MS>, "other": 12 }');
});

test('normalizeDoctorOutput strips dynamic header timestamp line', () => {
  const input = [
    'Robin doctor — 2026-05-17 13:42:01',
    '',
    'paths        ok        3 checks',
  ].join('\n');
  const out = normalizeDoctorOutput(input);
  assert.match(out, /Robin doctor — <TIMESTAMP>/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:file system/tests/unit/normalize-snapshot.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Create `system/tests/helpers/normalize-snapshot.js`:

```js
const ISO_TIMESTAMP = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z/g;
const SURREAL_ID = /([a-z_][a-z0-9_]*):([A-Za-z0-9_]{2,})/g;
const PID = /pid=\d+/g;
const TOOK_MS = /"took_ms":\s*\d+/g;
const HUMAN_TIMESTAMP = /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/g;

export function normalize(s) {
  return s
    .replace(ISO_TIMESTAMP, '<TIMESTAMP>')
    .replace(SURREAL_ID, '$1:<ID>')
    .replace(PID, 'pid=<PID>')
    .replace(TOOK_MS, '"took_ms": <MS>');
}

export function normalizeDoctorOutput(s) {
  return s.replace(HUMAN_TIMESTAMP, '<TIMESTAMP>');
}

export function normalizeRecallEvents(s) {
  return normalize(s);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:file system/tests/unit/normalize-snapshot.test.js`
Expected: PASS — 5 tests passing.

- [ ] **Step 5: Commit**

```bash
git add system/tests/helpers/normalize-snapshot.js system/tests/unit/normalize-snapshot.test.js
git diff --cached --name-only
git commit -m "test(polish): snapshot normalization helper" -- system/tests/helpers/normalize-snapshot.js system/tests/unit/normalize-snapshot.test.js
git show HEAD --stat
```

Expected: two files added; no other paths swept up.

---

### Task 3: Create polish-verify script

**Files:**
- Create: `system/scripts/polish-verify.sh`

- [ ] **Step 1: Write the script**

Create `system/scripts/polish-verify.sh`:

```bash
#!/usr/bin/env bash
# Polish program exit-gate verifier. Usage: polish-verify.sh --phase=a|--phase=b
set -euo pipefail

phase="${1:-}"
if [[ "$phase" != "--phase=a" && "$phase" != "--phase=b" ]]; then
  echo "usage: $0 --phase=a|--phase=b" >&2
  exit 2
fi

echo "[polish-verify $phase] pnpm test"
pnpm test

echo "[polish-verify $phase] pnpm test:integration (if present)"
if pnpm run | grep -q "^  test:integration"; then
  pnpm test:integration
else
  echo "  (no test:integration script; skipping)"
fi

echo "[polish-verify $phase] robin doctor --json"
node system/bin/robin doctor --json | tee /tmp/polish-doctor.json >/dev/null
if ! jq -e '.exit_code == 0' /tmp/polish-doctor.json > /dev/null; then
  echo "  doctor returned non-zero exit_code" >&2
  jq '.' /tmp/polish-doctor.json >&2
  exit 1
fi

echo "[polish-verify $phase] robin --help"
node system/bin/robin --help > /dev/null

echo "[polish-verify $phase] mcp tool inventory"
if [[ -f system/scripts/list-mcp-tools.js ]]; then
  node system/scripts/list-mcp-tools.js > /tmp/polish-mcp-tools.txt
  echo "  ok ($(wc -l < /tmp/polish-mcp-tools.txt) tools listed)"
fi

echo "[polish-verify $phase] git status clean (excluding user-data, .claude, tmp)"
if git status --porcelain | grep -v "^?? user-data/" | grep -v "^?? .claude/" | grep -v "^?? tmp/" | grep -q "."; then
  echo "  unexpected uncommitted changes:" >&2
  git status --porcelain | grep -v "^?? user-data/" | grep -v "^?? .claude/" | grep -v "^?? tmp/" >&2
  exit 1
fi

echo "[polish-verify $phase] PASS"
```

- [ ] **Step 2: Make executable**

Run:
```bash
chmod +x system/scripts/polish-verify.sh
```

- [ ] **Step 3: Smoke-test the script** (don't expect all gates to pass yet — it's a baseline run)

Run:
```bash
bash system/scripts/polish-verify.sh --phase=a || true
```

Expected: runs through gates; some may fail (e.g. doctor exit_code may not be 0 if any invariant is warn). Record the current failing gates as input for the rest of Phase A.

- [ ] **Step 4: Commit**

```bash
git add system/scripts/polish-verify.sh
git diff --cached --name-only
git commit -m "test(polish): phase-A/B exit-gate verifier script" -- system/scripts/polish-verify.sh
git show HEAD --stat
```

Expected: one file added.

---

### Task 4: Create MCP tools inventory script

**Files:**
- Create: `system/scripts/list-mcp-tools.js`

- [ ] **Step 1: Write the script**

Create `system/scripts/list-mcp-tools.js`:

```js
#!/usr/bin/env node
// Lists MCP tools registered by the live daemon (if running) and the
// on-disk inventory under system/io/mcp/tools/. Exits non-zero if the
// two diverge — used by polish-verify and dead-code-purge smoke tests.

import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const toolsDir = resolve(here, '..', 'io', 'mcp', 'tools');

async function listFromDisk() {
  const entries = await readdir(toolsDir);
  return entries
    .filter((e) => e.endsWith('.js') && !e.startsWith('_') && e !== 'index.js')
    .map((e) => e.replace(/\.js$/, ''))
    .sort();
}

async function main() {
  const disk = await listFromDisk();
  for (const t of disk) console.log(t);
  // Future: when an "introspect" MCP endpoint exists, cross-check live registration.
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

- [ ] **Step 2: Make executable + smoke-test**

```bash
chmod +x system/scripts/list-mcp-tools.js
node system/scripts/list-mcp-tools.js | head -20
```

Expected: prints tool names like `audit`, `calendar_get_event`, etc., one per line.

- [ ] **Step 3: Commit**

```bash
git add system/scripts/list-mcp-tools.js
git diff --cached --name-only
git commit -m "test(polish): MCP tools inventory script" -- system/scripts/list-mcp-tools.js
git show HEAD --stat
```

---

## A.4 Step 0 — Log baseline (run FIRST, before any logger changes)

Captures the current daemon log volume so A.4's deltas are measurable.

### Task 5: Create log baseline harness

**Files:**
- Create: `system/scripts/log-baseline.js`

- [ ] **Step 1: Write the harness**

Create `system/scripts/log-baseline.js`:

```js
#!/usr/bin/env node
// Capture daemon log volume baseline. Two modes:
//   --idle 10m   : passive 10-minute observation
//   --active 10m : same duration, but drive `recall` + `remember` traffic
//
// Reads ${HOME}/<user-data>/runtime/logs/daemon.log via tail -F.
// Writes raw lines + tokenized pattern counts to stdout.

import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import process from 'node:process';

const args = process.argv.slice(2);
const mode = args[0]; // --idle or --active
const duration = args[1] || '10m';
if (!['--idle', '--active'].includes(mode)) {
  console.error('usage: log-baseline.js --idle|--active 10m');
  process.exit(2);
}

const durationMs = parseDuration(duration);

function parseDuration(s) {
  const m = /^(\d+)([smh])$/.exec(s);
  if (!m) throw new Error(`bad duration: ${s}`);
  const mult = { s: 1000, m: 60_000, h: 3_600_000 }[m[2]];
  return Number(m[1]) * mult;
}

function tokenize(line) {
  return line
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z/g, '<TS>')
    .replace(/\b\d+ms\b/g, '<MS>ms')
    .replace(/\b\d{3,}\b/g, '<N>')
    .replace(/[a-z_]+:[A-Za-z0-9_]{4,}/g, '<ID>')
    .trim();
}

async function run() {
  // Resolve log path via the install pointer
  const home = await resolveRobinHome();
  const logPath = resolve(home, 'runtime', 'logs', 'daemon.log');

  const lines = [];
  const startOffset = await fileSize(logPath);

  if (mode === '--active') {
    spawnActiveTraffic(durationMs);
  }

  await sleep(durationMs);

  const endOffset = await fileSize(logPath);
  const fresh = await readRange(logPath, startOffset, endOffset);
  for (const l of fresh.split('\n').filter(Boolean)) lines.push(l);

  const patterns = new Map();
  for (const l of lines) {
    const t = tokenize(l);
    patterns.set(t, (patterns.get(t) ?? 0) + 1);
  }

  const sorted = [...patterns.entries()].sort((a, b) => b[1] - a[1]);
  console.log(`# Log baseline (${mode}, ${duration})`);
  console.log(`# Total lines: ${lines.length}`);
  console.log(`# Unique patterns: ${patterns.size}`);
  console.log(`# Top 10 patterns:`);
  for (const [p, c] of sorted.slice(0, 10)) {
    console.log(`${c.toString().padStart(6)}  ${p}`);
  }
}

async function resolveRobinHome() {
  const { readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const candidates = [
    resolve(process.cwd(), '.robin-home'),
    join(process.env.HOME, 'Library', 'Application Support', 'Robin', 'install.json'),
  ];
  for (const path of candidates) {
    try {
      const txt = await readFile(path, 'utf8');
      const parsed = JSON.parse(txt);
      if (parsed?.home) return parsed.home;
    } catch {}
  }
  throw new Error('cannot resolve robin home from .robin-home or install.json');
}

async function fileSize(path) {
  const { stat } = await import('node:fs/promises');
  return (await stat(path)).size;
}

async function readRange(path, start, end) {
  const { open } = await import('node:fs/promises');
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(end - start);
    await fh.read(buf, 0, end - start, start);
    return buf.toString('utf8');
  } finally {
    await fh.close();
  }
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function spawnActiveTraffic(ms) {
  const trafficScript = resolve(process.cwd(), 'system/scripts/log-baseline-traffic.js');
  const proc = spawn('node', [trafficScript, String(ms)], {
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  proc.unref();
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

- [ ] **Step 2: Write the active-traffic helper**

Create `system/scripts/log-baseline-traffic.js`:

```js
#!/usr/bin/env node
// Drive recall + remember + integration_status traffic for the given duration.
// Used by log-baseline.js --active.

import { spawn } from 'node:child_process';
import process from 'node:process';

const durationMs = Number(process.argv[2] || '600000');
const start = Date.now();

const queries = [
  'what did I eat yesterday',
  'photography projects',
  'recent corrections',
  'whoop sleep',
  'gmail subscriptions',
];
const remembers = [
  'baseline test note 1',
  'baseline test note 2',
];

async function callTool(name, args) {
  return new Promise((resolve) => {
    const proc = spawn('node', ['system/bin/robin', name, JSON.stringify(args)], {
      stdio: 'ignore',
    });
    proc.on('exit', () => resolve());
    proc.on('error', () => resolve());
  });
}

async function run() {
  let i = 0;
  while (Date.now() - start < durationMs) {
    const q = queries[i % queries.length];
    await callTool('recall', { query: q, limit: 10 });
    if (i % 5 === 0) {
      const c = remembers[Math.floor(Math.random() * remembers.length)];
      await callTool('remember', { content: c });
    }
    i += 1;
    await new Promise((r) => setTimeout(r, 5000));
  }
}

run();
```

- [ ] **Step 3: Make executable + commit harness**

```bash
chmod +x system/scripts/log-baseline.js system/scripts/log-baseline-traffic.js
git add system/scripts/log-baseline.js system/scripts/log-baseline-traffic.js
git diff --cached --name-only
git commit -m "test(polish): log baseline + active-traffic harness" -- system/scripts/log-baseline.js system/scripts/log-baseline-traffic.js
git show HEAD --stat
```

- [ ] **Step 4: Capture idle baseline**

Run:
```bash
node system/scripts/log-baseline.js --idle 10m > /tmp/polish-idle-baseline.txt
```

Expected: blocks for 10 minutes, then writes a file with total lines, unique patterns, top 10.

- [ ] **Step 5: Capture active baseline**

Run:
```bash
node system/scripts/log-baseline.js --active 10m > /tmp/polish-active-baseline.txt
```

Expected: blocks for 10 minutes while traffic runs in background, then writes file.

- [ ] **Step 6: Write baseline-metrics file**

Create `docs/superpowers/notes/2026-05-17-polish-phase-a-log-baseline.md`:

```markdown
# Polish Phase A — Log baseline

**Captured:** 2026-05-17

## Idle baseline (10 min, no traffic)

<paste contents of /tmp/polish-idle-baseline.txt>

## Active baseline (10 min, scripted recall + remember traffic)

<paste contents of /tmp/polish-active-baseline.txt>

## Deltas measured against this file:
- A.4 idle target: ≥50% reduction in total lines.
- A.4 idle: no pattern repeating >2× per minute (10-min window: ≤20 occurrences per pattern).
- A.4 active: no pattern repeating >5× per minute (10-min window: ≤50 occurrences per pattern).
- A.4 active: total volume ≤2× idle.
```

Replace `<paste contents …>` with the actual output captured.

- [ ] **Step 7: Commit baseline**

```bash
git add docs/superpowers/notes/2026-05-17-polish-phase-a-log-baseline.md
git diff --cached --name-only
git commit -m "docs(polish): phase A log baseline (idle + active)" -- docs/superpowers/notes/2026-05-17-polish-phase-a-log-baseline.md
git show HEAD --stat
```

---

## A.1 — Silent-failure hunt

### Task 6: Scan static seed patterns

**Files:**
- Output: `tmp/polish-a1-seed.txt` (gitignored, ephemeral)

- [ ] **Step 1: Run grep seed patterns**

Run:
```bash
mkdir -p tmp
{
  echo "## EMPTY_CATCHES"
  rg -nUP 'catch\s*\([^)]*\)\s*\{\s*\}' system/ --glob '!system/tests/**' --glob '!system/cognition/dream/**' --glob '!system/cognition/introspection/**' --glob '!system/cognition/intuition/{reinforcement,correction-inference,playbook-inject}.js' --glob '!system/cognition/jobs/{comm-style.js,internal/**}' --glob '!system/cognition/telemetry/rollup-registry.js' --glob '!system/cognition/memory/arcs.js' --glob '!system/cognition/biographer/pipeline.js' --glob '!system/io/mcp/tools/{health,remember}.js' --glob '!system/data/db/migrations/{0017-telemetry-umbrella,0026-telemetry-add-faculties}.surql' --glob '!system/data/embed/factory.js' --glob '!system/data/db/client.js' --glob '!system/io/capture/session-capture.js' || true

  echo ""; echo "## COMMENTED_CATCHES"
  rg -nUP 'catch\s*\([^)]*\)\s*\{\s*//' system/ --glob '!system/tests/**' || true

  echo ""; echo "## CATCH_RETURN_FALLBACK"
  rg -nUP 'catch[^\n]*\n[^}]*return\s+(null|undefined|\[\]|\{\}|false|0)' system/ --glob '!system/tests/**' || true

  echo ""; echo "## PROMISE_CATCH_FALLBACK"
  rg -nUP '\.catch\(\s*\(?[^)]*\)?\s*=>\s*(null|undefined|\{\}|\[\]|false|0)' system/ --glob '!system/tests/**' || true

  echo ""; echo "## LOG_AND_SWALLOW"
  rg -nUP 'console\.(warn|error)\([^)]*\);?\s*\n?\s*return' system/ --glob '!system/tests/**' || true

  echo ""; echo "## PROMISE_ALLSETTLED_DISCARDED"
  rg -nUP 'Promise\.allSettled' system/ --glob '!system/tests/**' || true
} > tmp/polish-a1-seed.txt
wc -l tmp/polish-a1-seed.txt
head -30 tmp/polish-a1-seed.txt
```

Expected: writes seed file with categorized hits. Inspect the first few lines.

- [ ] **Step 2: Confirm cognition-e1 exclusions worked**

Run:
```bash
grep -E "(dream/dag\\.js|step-(knowledge|profile|reflection|registry|telemetry|calibration-bucket|outcome-grading|playbook-synthesis|prediction-taxonomy|self-improvement-rollup))\\.js|introspection/|intuition/(reinforcement|correction-inference|playbook-inject)\\.js|jobs/comm-style\\.js|jobs/internal/|rollup-registry\\.js|memory/arcs\\.js|biographer/pipeline\\.js|mcp/tools/(health|remember)\\.js|migrations/00(17|26)|embed/factory\\.js|db/client\\.js|capture/session-capture\\.js" tmp/polish-a1-seed.txt && echo "FAIL: seed file contains cognition-e1-owned files" || echo "OK: no cognition-e1 leakage"
```

Expected: `OK: no cognition-e1 leakage`. If FAIL, adjust the glob excludes in Step 1 and re-run.

- [ ] **Step 3: Append seed counts to audit notes**

Manually append a `### A1-Inventory` subsection to `docs/superpowers/notes/2026-05-17-polish-phase-a-audit.md` with the per-category counts from `tmp/polish-a1-seed.txt`.

```bash
{
  echo ""
  echo "### A1-Inventory (seed scan)"
  echo ""
  for cat in EMPTY_CATCHES COMMENTED_CATCHES CATCH_RETURN_FALLBACK PROMISE_CATCH_FALLBACK LOG_AND_SWALLOW PROMISE_ALLSETTLED_DISCARDED; do
    n=$(grep -A100000 "## $cat" tmp/polish-a1-seed.txt | grep -B100000 -m1 "^## " | grep -c "^system/" || true)
    echo "- $cat: $n hits"
  done
  echo ""
} >> docs/superpowers/notes/2026-05-17-polish-phase-a-audit.md
```

Then commit:
```bash
git add docs/superpowers/notes/2026-05-17-polish-phase-a-audit.md
git diff --cached --name-only
git commit -m "docs(polish): A.1 seed scan inventory" -- docs/superpowers/notes/2026-05-17-polish-phase-a-audit.md
git show HEAD --stat
```

---

### Task 7: Per-module manual sweep loop (TEMPLATE — repeats per module)

**Per-module loop instructions.** For each module in the A.1 in-scope list (see spec Section "A.1 Silent-failure hunt"), run this exact loop. Modules to sweep:

```
system/runtime/daemon/server.js
system/runtime/daemon/lifecycle.js
system/runtime/daemon/job-hot-reload.js
system/runtime/cli/commands/*.js              # excluding _doctor-*
system/runtime/cli/bin.js
system/runtime/cli/index.js
system/runtime/cli/health.js
system/runtime/cli/daemon-request.js
system/runtime/invariants/*.js                # excluding new ones we add in A.4
system/io/mcp/server.js
system/io/mcp/tools/*.js                      # excluding health.js, remember.js
system/io/integrations/*/index.js
system/io/integrations/*/sync.js              # if present per adapter
system/io/integrations/*/tools/*.js
system/io/capture/record-event.js             # NOT session-capture.js (e1-owned)
system/data/db/migrations.js
system/data/db/manifest.js
system/cognition/jobs/runner.js
system/cognition/jobs/scheduler.js
system/cognition/jobs/db.js
system/cognition/memory/events.js
system/cognition/memory/entities.js
system/cognition/memory/edges.js
system/cognition/memory/knowledge.js
```

**For each module M:**

- [ ] **Step 1: Read the module fully**

Open the file. Read every line. Look beyond the static seed patterns — also flag:
- `if (!result) return null` patterns where `result` came from async I/O
- `value ?? defaultValue` masking async failures
- `try`/`catch` where catch logs only at debug/info level
- Private functions never called (dead-code-within-module subsweep)

- [ ] **Step 2: Classify each suspect site**

For every site, decide one of:
- `fix` — rethrow, log structured (use logger from Task 24 once landed), surface to caller, propagate to MCP error reason
- `keep` — fallback is correct and obvious
- `document` — correct fallback, add a one-line comment explaining why
- `defer` — file under "Open for cognition-e1 lane"

**`fix` decisions require a one-line "why this catch should surface" justification.** Reviewed against CLAUDE.md "Memory writes — resilient by design" rule before landing.

- [ ] **Step 3: Apply fixes (one commit per module)**

If the module has any `fix` decisions: make the edits. For sites flagged `document`, add the one-line comment.

Smoke-test:
```bash
pnpm test:fast
```

If green, commit:
```bash
git add <M>
git diff --cached --name-only
git commit -m "fix(polish-a1): surface silent failures in <module>" -- <M>
git show HEAD --stat
```

If any test fails:
1. Inspect the failure.
2. Either fix the test (if the silent failure was masking a real bug the test relied on) and commit both together.
3. Or revert the change and reclassify the site as `keep` with a justification in audit notes.

Three consecutive `pnpm test:fast` greens before commit (flakiness regression check).

- [ ] **Step 4: Append to audit notes (per module)**

Append a row to A1-Decisions:
```markdown
| `<path>:<line>` | fix | <one-line justification> | <commit-sha> |
| `<path>:<line>` | keep | <reason> | — |
| `<path>:<line>` | document | <comment-text> | <commit-sha> |
| `<path>:<line>` | defer | filed to "Open for cognition-e1 lane" | — |
```

Commit:
```bash
git add docs/superpowers/notes/2026-05-17-polish-phase-a-audit.md
git diff --cached --name-only
git commit -m "docs(polish): A.1 decisions for <module>" -- docs/superpowers/notes/2026-05-17-polish-phase-a-audit.md
git show HEAD --stat
```

- [ ] **Step 5: Dead-code-within-module subsweep**

If any private function/const was flagged as unused while reading: delete it. Run `pnpm test:fast` and `node system/scripts/list-mcp-tools.js`. If green, separate commit:
```bash
git add <M>
git diff --cached --name-only
git commit -m "refactor(polish-a1): remove unused private <fn-or-const> in <module>" -- <M>
git show HEAD --stat
```

**Abort condition:** if any module's manual sweep exceeds 2× its slot in the time-box, mark the remaining sites `defer` with a note in audit notes and move on.

---

### Task 8: A.1 finalization

- [ ] **Step 1: Confirm every module in the list has either decisions or a "skipped" note in audit notes**

Read `docs/superpowers/notes/2026-05-17-polish-phase-a-audit.md`. Verify A1-Decisions table has entries for every module in Task 7's loop.

- [ ] **Step 2: Run polish-verify --phase=a (partial gate)**

```bash
bash system/scripts/polish-verify.sh --phase=a
```

Expected: gates pass except possibly the doctor exit_code if any newly-surfaced error is rendered as a warning. Document any surfaced doctor warnings in audit notes under "Open for cognition-e1 lane" if they touch e1-owned state.

---

## A.2 — Dead-code + unused-file purge

### Task 9: Install madge

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install madge as dev dep**

Run:
```bash
pnpm add -D madge
```

Verify it landed:
```bash
grep -A1 '"madge"' package.json
```

Expected: madge listed under devDependencies.

- [ ] **Step 2: Smoke-test madge**

```bash
pnpm exec madge --orphans --extensions js system/ | head -20
```

Expected: list of orphan modules (may be empty; may include false positives — those go on the allowlist next).

- [ ] **Step 3: Commit**

```bash
git add package.json pnpm-lock.yaml
git diff --cached --name-only
git commit -m "build(polish): add madge for dead-code graph" -- package.json pnpm-lock.yaml
git show HEAD --stat
```

---

### Task 10: Create dead-code allowlist

**Files:**
- Create: `system/scripts/dead-code-allowlist.json`

- [ ] **Step 1: Write the allowlist**

Create `system/scripts/dead-code-allowlist.json`:

```json
{
  "comment": "Modules referenced by reflection or dynamic import. Madge sees these as orphans but they are loaded at runtime via reflection. Hand-maintained.",
  "patterns": [
    "system/io/mcp/tools/*.js",
    "system/runtime/cli/commands/*.js",
    "system/io/integrations/*/index.js",
    "system/data/db/migrations/*.surql",
    "system/scripts/pre-commit/*.js",
    "system/cognition/dream/step-*.js",
    "system/runtime/invariants/*.js"
  ]
}
```

- [ ] **Step 2: Commit**

```bash
git add system/scripts/dead-code-allowlist.json
git diff --cached --name-only
git commit -m "build(polish): dead-code allowlist for reflection-loaded modules" -- system/scripts/dead-code-allowlist.json
git show HEAD --stat
```

---

### Task 11: Run module-graph orphan scan

**Files:**
- Output: `tmp/polish-a2-orphans.txt` (gitignored, ephemeral)

- [ ] **Step 1: Run madge + filter allowlist**

```bash
pnpm exec madge --orphans --extensions js --json system/ > tmp/polish-a2-orphans-raw.json
node -e "
import('node:fs').then(({ readFileSync, writeFileSync }) => {
  const raw = JSON.parse(readFileSync('tmp/polish-a2-orphans-raw.json', 'utf8'));
  const allowlist = JSON.parse(readFileSync('system/scripts/dead-code-allowlist.json', 'utf8')).patterns;
  const isAllowlisted = (p) => allowlist.some(pat => {
    const re = new RegExp('^' + pat.replace(/\\./g, '\\\\.').replace(/\\*/g, '[^/]+').replace(/\\//g, '\\\\/') + '$');
    return re.test(p);
  });
  const filtered = raw.filter(p => !isAllowlisted(p));
  writeFileSync('tmp/polish-a2-orphans.txt', filtered.join('\\n') + '\\n');
  console.log(\`raw orphans: \${raw.length}, after allowlist: \${filtered.length}\`);
});
"
cat tmp/polish-a2-orphans.txt
```

Expected: filtered list (may be empty — good). If non-empty, each entry is a candidate for deletion.

- [ ] **Step 2: Append orphan inventory to audit notes**

```bash
{
  echo ""
  echo "### A2-Inventory (orphan modules)"
  echo ""
  if [[ -s tmp/polish-a2-orphans.txt ]]; then
    echo "| Module | Decision | Commit |"
    echo "|---|---|---|"
    while IFS= read -r line; do
      echo "| \`$line\` | TBD | — |"
    done < tmp/polish-a2-orphans.txt
  else
    echo "(no orphans after allowlist)"
  fi
} >> docs/superpowers/notes/2026-05-17-polish-phase-a-audit.md
```

Then for each TBD row, replace `TBD` with `delete` / `keep` / `flag-to-user` decision as the loop in Task 12 progresses.

---

### Task 12: Per-orphan deletion loop (TEMPLATE)

**For each orphan O in `tmp/polish-a2-orphans.txt`:**

- [ ] **Step 1: Verify true orphan**

Run:
```bash
rg "from\\s+['\"][^'\"]*$(basename O .js)['\"]" system/ --glob '!'$O
rg "import\\s*\\(\\s*['\"][^'\"]*$(basename O .js)" system/ --glob '!'$O
```

Expected: no hits — confirms the module is truly unimported. If hits appear (dynamic import the allowlist missed), update `system/scripts/dead-code-allowlist.json` instead and re-run Task 11.

- [ ] **Step 2: Check skeleton + package.json exports**

```bash
grep -F "$(basename O .js)" package.json || true
```

If hit: this module is exposed as a public package surface. Mark `flag-to-user` in audit notes; do not delete.

- [ ] **Step 3: Delete (stages deletion atomically)**

```bash
git rm $O
```

- [ ] **Step 4: Smoke battery**

```bash
pnpm test
node system/bin/robin --help > /dev/null
node system/bin/robin doctor --json | jq -e '.exit_code == 0' > /dev/null
node system/scripts/list-mcp-tools.js > /dev/null
```

All four must succeed. If any fails, restore the file (`git checkout HEAD -- $O`) and reclassify as `keep` in audit notes.

- [ ] **Step 5: Commit (deletion already staged by git rm)**

```bash
git diff --cached --name-only
git commit -m "refactor(polish-a2): remove orphan module $O" -- $O
git show HEAD --stat
```

- [ ] **Step 6: Update audit-notes row**

In `docs/superpowers/notes/2026-05-17-polish-phase-a-audit.md`, set the A2-Inventory row's Decision to `delete` and Commit to the sha.

---

### Task 13: Exported-but-unused symbol scan

**Files:**
- Output: `tmp/polish-a2-unused-exports.txt`

- [ ] **Step 1: Write scan script**

Create `tmp/polish-a2-scan-exports.sh`:

```bash
#!/usr/bin/env bash
# Find named exports with zero references outside their defining file.
set -euo pipefail

while IFS= read -r file; do
  # Skip allowlist directories
  case "$file" in
    system/io/mcp/tools/*) continue ;;
    system/runtime/cli/commands/*) continue ;;
    system/io/integrations/*/index.js) continue ;;
    system/runtime/invariants/*) continue ;;
    system/cognition/dream/step-*) continue ;;
  esac
  # Extract export names
  rg -oP '^export\s+(?:async\s+)?(?:function|const|class)\s+\K[A-Za-z_][A-Za-z0-9_]*' "$file" | while IFS= read -r name; do
    # Count references outside the defining file
    refs=$(rg -lU "\\b$name\\b" system/ --glob "!$file" --glob '!system/tests/**' 2>/dev/null | wc -l | tr -d ' ')
    if [[ "$refs" == "0" ]]; then
      echo "$file:$name"
    fi
  done
done < <(find system -name '*.js' -not -path '*/tests/*')
```

Make executable, run, capture:
```bash
chmod +x tmp/polish-a2-scan-exports.sh
tmp/polish-a2-scan-exports.sh > tmp/polish-a2-unused-exports.txt
wc -l tmp/polish-a2-unused-exports.txt
head -20 tmp/polish-a2-unused-exports.txt
```

- [ ] **Step 2: Append inventory to audit notes** (mirror Task 11 Step 2 shape).

- [ ] **Step 3: Per-symbol loop**

For each `<file>:<symbol>` line:
- Confirm zero refs (cross-check with broader rg, including `system/tests/`).
- If used by tests but no production code: file `flag-to-user` ("test-only export — keep or remove?").
- If truly zero refs: edit the file to remove the export (or convert `export function X` → `function X` if still used internally). `pnpm test:fast`. Commit per file.

Commit message format:
```
refactor(polish-a2): remove unused export <symbol> from <module>
```

---

### Task 14: Stale-fixtures scan

- [ ] **Step 1: Identify unreferenced fixtures**

```bash
{
  for f in $(find system/tests/fixtures -type f); do
    name=$(basename "$f")
    if ! rg -q "fixtures/.*$name" system/tests --glob '!system/tests/fixtures/**'; then
      echo "$f"
    fi
  done
} > tmp/polish-a2-fixtures.txt
cat tmp/polish-a2-fixtures.txt
```

- [ ] **Step 2: Delete unreferenced fixtures**

For each fixture path:
```bash
git rm <path>
pnpm test
```

If green: `git commit -m "refactor(polish-a2): remove unused fixture <path>" -- <path>`. If red: `git restore --staged --worktree <path>` and reclassify as `keep`.

- [ ] **Step 3: Append decisions to audit notes**

---

### Task 15: Abandoned-migrations + orphan-scripts flag

- [ ] **Step 1: Find .surql files not in manifest**

```bash
ls system/data/db/migrations/*.surql | while IFS= read -r f; do
  name=$(basename "$f")
  if ! grep -q "$name" system/data/db/migrations.js system/data/db/manifest*.js 2>/dev/null; then
    echo "$f"
  fi
done > tmp/polish-a2-orphan-migrations.txt
cat tmp/polish-a2-orphan-migrations.txt
```

- [ ] **Step 2: File to "Open for user"**

For each unreferenced migration: do NOT delete (DB schema deletions need explicit approval). Append to audit notes "Open for user" section:
```markdown
| `<path>` | Migration not in manifest — orphan or intentional? | User decides delete vs. keep |
```

- [ ] **Step 3: Find unreferenced scripts**

```bash
for f in system/scripts/*.js system/scripts/*.sh; do
  [[ -f "$f" ]] || continue
  name=$(basename "$f")
  if ! grep -qE "$name|$(echo $name | sed 's/\.[^.]*$//')" package.json .github/workflows/*.yml CLAUDE.md README.md docs/ 2>/dev/null; then
    echo "$f"
  fi
done > tmp/polish-a2-orphan-scripts.txt
cat tmp/polish-a2-orphan-scripts.txt
```

Exclude `polish-verify.sh`, `list-mcp-tools.js`, `log-baseline.js`, `log-baseline-traffic.js`, `polish-a2-scan-exports.sh` — those were created during this plan.

- [ ] **Step 4: File to "Open for user"** for each unreferenced script.

- [ ] **Step 5: Commit audit notes** (single commit per file path to audit notes).

---

### Task 16: A.2 finalization

- [ ] **Step 1: Run polish-verify**

```bash
bash system/scripts/polish-verify.sh --phase=a
```

Expected: green except doctor exit_code (which awaits A.4's invariant changes).

- [ ] **Step 2: Confirm A2-Inventory and A2-Decisions are complete**

Read audit notes; verify every orphan/symbol/fixture has a Decision row.

---

## A.3 — Test gaps + slow-test cleanup

### Task 17: Behavior-coverage inventory script

**Files:**
- Create: `tmp/polish-a3-coverage.js` (ephemeral; produces a coverage map)

- [ ] **Step 1: Write the inventory script**

Create `tmp/polish-a3-coverage.js`:

```js
#!/usr/bin/env node
// For each non-trivial module in scope, extract primary exported names and
// count references in system/tests/. Output: module|exports|test_refs.

import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const SCOPE = [
  'system/cognition/jobs',
  'system/cognition/memory',
  'system/io/integrations',
  'system/io/capture',
  'system/data/db',
  'system/runtime/daemon',
  'system/runtime/cli',
  'system/runtime/invariants',
  'system/runtime/log',  // may not exist yet
];

const EXCLUDE = new Set([
  'system/cognition/dream/dag.js',
  'system/cognition/dream/step-knowledge.js',
  'system/cognition/dream/step-profile.js',
  'system/cognition/dream/step-reflection.js',
  'system/cognition/dream/telemetry.js',
  'system/cognition/dream/step-registry.js',
  'system/cognition/dream/step-calibration-bucket.js',
  'system/cognition/dream/step-outcome-grading.js',
  'system/cognition/dream/step-playbook-synthesis.js',
  'system/cognition/dream/step-prediction-taxonomy.js',
  'system/cognition/dream/step-self-improvement-rollup.js',
  'system/cognition/intuition/reinforcement.js',
  'system/cognition/intuition/correction-inference.js',
  'system/cognition/intuition/playbook-inject.js',
  'system/cognition/jobs/comm-style.js',
  'system/cognition/telemetry/rollup-registry.js',
  'system/cognition/memory/arcs.js',
  'system/cognition/biographer/pipeline.js',
  'system/io/mcp/tools/health.js',
  'system/io/mcp/tools/remember.js',
  'system/data/embed/factory.js',
  'system/data/db/client.js',
  'system/io/capture/session-capture.js',
]);

function rg(args) {
  const r = spawnSync('rg', args, { encoding: 'utf8' });
  return r.stdout.trim();
}

async function isNonTrivial(path) {
  const txt = await readFile(path, 'utf8');
  if (txt.split('\n').length < 50) return false;
  // has branches or async I/O
  return /\b(if|switch|await|async)\b/.test(txt);
}

async function exportsOf(path) {
  const txt = await readFile(path, 'utf8');
  const names = [];
  for (const m of txt.matchAll(/^export\s+(?:async\s+)?(?:function|const|class|default)\s+(\w+)/gm)) {
    names.push(m[1]);
  }
  return names;
}

async function main() {
  const filesRaw = rg(['-l', '--no-heading', '--type', 'js', '', ...SCOPE]);
  const files = filesRaw.split('\n').filter((f) => f && !EXCLUDE.has(f) && !f.includes('/internal/'));
  const rows = [];
  for (const f of files) {
    if (!(await isNonTrivial(f))) continue;
    const exps = await exportsOf(f);
    if (exps.length === 0) continue;
    const totalRefs = exps.reduce((acc, n) => {
      const r = rg(['-l', `\\b${n}\\b`, 'system/tests/']);
      return acc + (r ? r.split('\n').filter(Boolean).length : 0);
    }, 0);
    rows.push({ file: f, exports: exps.join(','), test_refs: totalRefs });
  }
  rows.sort((a, b) => a.test_refs - b.test_refs);
  for (const r of rows) {
    console.log(`${r.test_refs}\t${r.file}\t[${r.exports}]`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Run + capture output**

```bash
node tmp/polish-a3-coverage.js > tmp/polish-a3-coverage.txt
head -20 tmp/polish-a3-coverage.txt
```

Modules with `0` in column 1 are uncovered.

- [ ] **Step 3: Append A3-Inventory to audit notes**

```markdown
### A3-Inventory (behavior coverage)

| File | Exports | Test refs | Decision |
|---|---|---|---|
```

Populate from `tmp/polish-a3-coverage.txt`. Sort by test_refs ASC so untested modules surface first.

---

### Task 18: Slow-test scan

- [ ] **Step 1: Find tests with real setTimeout**

```bash
rg -n 'setTimeout\(' system/tests/unit --glob '!**/*.skip.*' -B1 -A1 | grep -v '\.unref\|clearTimeout\|mock\.timers' > tmp/polish-a3-real-timers.txt
wc -l tmp/polish-a3-real-timers.txt
```

- [ ] **Step 2: Find tests with await sleep(N) where N > 50**

```bash
rg -nP 'await\s+sleep\(\s*([5-9]\d|\d{3,})' system/tests/unit > tmp/polish-a3-sleep.txt
```

- [ ] **Step 3: Find subprocess spawns**

```bash
rg -n "spawn\\(['\"](node|pnpm|robin)" system/tests/unit > tmp/polish-a3-subproc.txt
```

- [ ] **Step 4: Time every unit test**

```bash
pnpm test:unit --reporter=spec 2>&1 | grep -E "^# duration_ms" -B1 > tmp/polish-a3-timings.txt
# Or, more granular:
for f in $(find system/tests/unit -name '*.test.js'); do
  start=$(date +%s%N)
  if node --test --test-force-exit --test-timeout=20000 "$f" >/dev/null 2>&1; then
    end=$(date +%s%N)
    ms=$(( (end - start) / 1000000 ))
    if [[ $ms -gt 300 ]]; then
      gated=$(grep -l "ROBIN_SKIP_SLOW" "$f" || echo "")
      echo "$ms $f $gated"
    fi
  fi
done | sort -rn > tmp/polish-a3-slow.txt
head -20 tmp/polish-a3-slow.txt
```

Files >300ms without `ROBIN_SKIP_SLOW` are violations.

- [ ] **Step 5: Find mem:// without paired close**

```bash
for f in $(rg -l "mem://" system/tests/unit); do
  opens=$(rg -c "connect.*mem://" "$f" || echo 0)
  closes=$(rg -c "await close" "$f" || echo 0)
  if [[ $opens -gt $closes ]]; then
    echo "$f opens=$opens closes=$closes"
  fi
done > tmp/polish-a3-mem-leak.txt
cat tmp/polish-a3-mem-leak.txt
```

- [ ] **Step 6: Append to A3-Inventory**

Add per-violation rows to the audit notes table. Decision column will be filled by Task 19's loop.

---

### Task 19: Per-finding test fix loop (TEMPLATE)

**For each finding from Task 17 (uncovered module) and Task 18 (slow-test violation):**

**Branch A — uncovered module:**

- [ ] **Step 1: Assess testability**

Read the module. Decide:
- `add-test` — write a unit test exercising the primary exports.
- `document-thin` — module is a thin re-export or IO wrapper with no logic; add a row to audit notes "thin re-export" with rationale, no test required.
- `document-helper` — module is a helper exercised by consumer tests; verify by reading the consumer test, document the linkage.

- [ ] **Step 2: Write test (if `add-test`)**

Create `system/tests/unit/<module>.test.js` following the patterns in existing tests. Use `mem://` for DB; pair with `await close(db)`. Use `mock.timers` for any time-dependent assertions.

- [ ] **Step 3: Run test (3 consecutive greens)**

```bash
for i in 1 2 3; do pnpm test:file system/tests/unit/<module>.test.js || break; done
```

Expected: PASS three times in a row. If fails: either bug found (file under "Open for user") or test is wrong (fix the test).

- [ ] **Step 4: Commit**

```bash
git add system/tests/unit/<module>.test.js
git diff --cached --name-only
git commit -m "test(polish-a3): cover <module>" -- system/tests/unit/<module>.test.js
git show HEAD --stat
```

**Branch B — slow-test violation:**

- [ ] **Step 1: Diagnose the slowness**

Read the test. Identify which lines cause the wall-clock cost (real timers? real subprocesses? real network? real model load?).

- [ ] **Step 2: Refactor or gate**

- Real timers → replace with `mock.timers.enable({ apis: ['Date'], now: ... })`.
- `mem://` not closed → add `await close(db)` in `after()` hook.
- Subprocess spawn → either refactor logic so it can be called directly, or move the test to `system/tests/integration/`.
- Embedder load / install flow / large fixture → wrap test body in `test('...', { skip: process.env.ROBIN_SKIP_SLOW === '1' }, async () => { ... })`.

- [ ] **Step 3: Re-run + measure**

```bash
time pnpm test:file <path>
```

Expected: <300ms (or correctly gated with `ROBIN_SKIP_SLOW`).

- [ ] **Step 4: Verify total fast suite hasn't regressed**

```bash
time pnpm test:fast
```

Expected: ≤7s total (current floor ~5s + 2s allowance per spec threshold).

- [ ] **Step 5: Commit**

```bash
git add <path>
git diff --cached --name-only
git commit -m "test(polish-a3): refactor slow <test-name> to use mock.timers" -- <path>
# or:
git commit -m "test(polish-a3): gate slow <test-name> behind ROBIN_SKIP_SLOW" -- <path>
git show HEAD --stat
```

- [ ] **Step 6: Update audit-notes row.**

---

### Task 20: A.3 finalization

- [ ] **Step 1: Confirm `pnpm test:fast` stays under 7s**

```bash
time pnpm test:fast
```

- [ ] **Step 2: Confirm `pnpm test` green**

```bash
pnpm test
```

- [ ] **Step 3: Verify every A3-Inventory row has a Decision**

Read audit notes.

---

## A.4 — Observability + invariant hardening

### Task 21: Logger module

**Files:**
- Create: `system/runtime/log/index.js`
- Test: `system/tests/unit/runtime-log.test.js`

- [ ] **Step 1: Write the failing test**

Create `system/tests/unit/runtime-log.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert';
import { log, setSink } from '../../runtime/log/index.js';

test('log.info emits structured JSON with event + fields', () => {
  const lines = [];
  setSink((line) => lines.push(line));
  log.info({ event: 'test.ok', count: 42, name: 'kevin' });
  setSink(null); // restore default
  assert.strictEqual(lines.length, 1);
  const parsed = JSON.parse(lines[0]);
  assert.strictEqual(parsed.event, 'test.ok');
  assert.strictEqual(parsed.level, 'info');
  assert.strictEqual(parsed.count, 42);
  assert.strictEqual(parsed.name, 'kevin');
  assert.ok(parsed.ts);
});

test('log.warn / log.error / log.debug share the shape', () => {
  const lines = [];
  setSink((line) => lines.push(line));
  log.warn({ event: 'w' });
  log.error({ event: 'e' });
  log.debug({ event: 'd' });
  setSink(null);
  assert.strictEqual(lines.length, 3);
  assert.strictEqual(JSON.parse(lines[0]).level, 'warn');
  assert.strictEqual(JSON.parse(lines[1]).level, 'error');
  assert.strictEqual(JSON.parse(lines[2]).level, 'debug');
});

test('log requires an event field', () => {
  setSink(() => {});
  assert.throws(() => log.info({ count: 1 }), /event/);
  setSink(null);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm test:file system/tests/unit/runtime-log.test.js
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `system/runtime/log/index.js`:

```js
let _sink = (line) => process.stdout.write(line + '\n');

export function setSink(fn) {
  _sink = fn ?? ((line) => process.stdout.write(line + '\n'));
}

function emit(level, payload) {
  if (!payload || typeof payload.event !== 'string') {
    throw new Error('log: payload.event is required');
  }
  const line = JSON.stringify({ ts: new Date().toISOString(), level, ...payload });
  _sink(line);
}

export const log = {
  info: (payload) => emit('info', payload),
  warn: (payload) => emit('warn', payload),
  error: (payload) => emit('error', payload),
  debug: (payload) => {
    if (process.env.ROBIN_DEBUG === '1') emit('debug', payload);
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm test:file system/tests/unit/runtime-log.test.js
```

Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add system/runtime/log/index.js system/tests/unit/runtime-log.test.js
git diff --cached --name-only
git commit -m "feat(polish-a4): structured logger module" -- system/runtime/log/index.js system/tests/unit/runtime-log.test.js
git show HEAD --stat
```

---

### Task 22: Convert known-noisy sites to logger (TEMPLATE)

**Target sites** (from spec A.4):
- Reauth (proactive + reactive) — `system/data/db/client.js` (cognition-e1-owned; **file finding to e1 lane, do not edit**)
- Rate-limit refusals — `system/io/outbound/*.js` (find by `rg "rate.?limit" system/io`)
- Embedder failure paths — `system/data/embed/factory.js` (e1-owned; file finding)
- Scheduler tick failure — `system/cognition/jobs/scheduler.js` (NOT e1-owned)
- Integration sync result — `system/io/integrations/*/sync.js`

**For each non-e1 site:**

- [ ] **Step 1: Read site**

Identify the `console.warn`/`error` call. Note the event class name (e.g., `scheduler.tick_failed`, `integration.sync_failed`).

- [ ] **Step 2: Replace with structured log call**

```js
// before
console.warn(`[scheduler/dispatcher] tick failed:`, e.message);

// after
import { log } from '../../runtime/log/index.js';
log.warn({ event: 'scheduler.tick_failed', message: e.message, error: e.code ?? e.name });
```

- [ ] **Step 3: Verify**

```bash
pnpm test
```

Green: commit.

- [ ] **Step 4: Commit (per site)**

```bash
git commit -m "refactor(polish-a4): structured log for <event-name>" -- <file>
```

- [ ] **Step 5: Note in audit notes** under A4 log-noise decisions.

---

### Task 23: New invariant — daemon.embedder_load_age

**Files:**
- Create: `system/runtime/invariants/daemon.embedder-load-age.js`
- Test: `system/tests/unit/invariant-embedder-load-age.test.js`

- [ ] **Step 1: Write the test**

Create `system/tests/unit/invariant-embedder-load-age.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert';
import invariant from '../../runtime/invariants/daemon.embedder-load-age.js';

function makeCtx({ lastSuccessTs }) {
  return {
    db: {
      query: () => ({
        collect: async () => [{ last_success_ts: lastSuccessTs }],
      }),
    },
  };
}

test('ok when synthetic embed succeeded within 24h', async () => {
  const recent = new Date(Date.now() - 12 * 3600 * 1000).toISOString();
  const r = await invariant.check(makeCtx({ lastSuccessTs: recent }));
  assert.strictEqual(r.ok, true);
});

test('warn when synthetic embed has not succeeded in >24h', async () => {
  const stale = new Date(Date.now() - 36 * 3600 * 1000).toISOString();
  const r = await invariant.check(makeCtx({ lastSuccessTs: stale }));
  assert.strictEqual(r.ok, false);
  assert.match(r.error ?? '', /stale|24h/);
});

test('warn when no synthetic embed row exists', async () => {
  const r = await invariant.check({ db: { query: () => ({ collect: async () => [] }) } });
  assert.strictEqual(r.ok, false);
});

test('runs in detect-only mode for 7 days after install (no repair)', () => {
  assert.strictEqual(invariant.repair, undefined);
});
```

- [ ] **Step 2: Verify failing**

```bash
pnpm test:file system/tests/unit/invariant-embedder-load-age.test.js
```

Expected: FAIL — invariant not found.

- [ ] **Step 3: Write the invariant**

Create `system/runtime/invariants/daemon.embedder-load-age.js`:

```js
// daemon.embedder_load_age
//
// Warn if the synthetic daily embed probe row has not been refreshed in >24h.
// Distinguishes "embedder broken" from "no traffic" (the probe runs daily
// regardless of memory traffic).
//
// Detect-only for 7 days after install. After that, auto-repair (run the
// probe immediately) becomes available via per-invariant config flag.

const STALE_THRESHOLD_MS = 24 * 3600 * 1000;

export default {
  name: 'daemon.embedder_load_age',
  level: 'warn',
  surface: 'runtime',
  phase: 'runtime',
  description:
    'Synthetic embed probe has completed within the last 24h (proves the embedder is alive even under low traffic).',
  detectOnly: true,
  detectOnlyUntilDays: 7,

  remediation: [
    'robin embeddings list  # confirm active profile and dimension',
    'robin embeddings backfill <profile>  # if the active profile is broken',
    'tail -200 user-data/runtime/logs/daemon.log | grep "embed"',
  ],

  runWhen: {
    boot: { enabled: true },
    heartbeat: { enabled: true, cooldownMs: 3_600_000 }, // hourly
    doctor: { enabled: true },
  },

  async check(ctx) {
    if (!ctx?.db) return { ok: false, error: 'no_db_handle' };
    try {
      const builder = ctx.db.query(
        'SELECT last_success_ts FROM runtime_state WHERE id = "runtime:embed_probe";'
      );
      const rows = await builder.collect();
      const lastTs = rows?.[0]?.last_success_ts;
      if (!lastTs) {
        return { ok: false, error: 'no_probe_record', evidence: { hint: 'probe has never run' } };
      }
      const ageMs = Date.now() - new Date(lastTs).getTime();
      if (ageMs > STALE_THRESHOLD_MS) {
        return {
          ok: false,
          error: 'stale_embed_probe',
          evidence: {
            age_ms: ageMs,
            last_success_ts: lastTs,
            threshold_ms: STALE_THRESHOLD_MS,
          },
        };
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message ?? 'probe_check_failed' };
    }
  },

  explain() {
    return [
      '### `daemon.embedder_load_age`',
      '',
      '**Symptom.** Recall returns sparse results even for known-recent topics; daemon log shows embedding failures.',
      '',
      '**Cause.** Embedder loaded successfully at boot but a profile mismatch, dimension mismatch, or NAPI handle drop is silently failing every embed since.',
      '',
      '**Fix.** Run `robin embeddings list` to see the active profile and configured dimension; if mismatched, `robin embeddings activate <correct-profile>` or `robin embeddings backfill <profile>` to repair.',
    ].join('\n');
  },
};
```

- [ ] **Step 4: Register in invariants index**

Open `system/runtime/invariants/index.js`. Add:
```js
import embedderLoadAge from './daemon.embedder-load-age.js';
```
And include in the exported list.

- [ ] **Step 5: Add the probe writer**

The probe must run daily and write `runtime_state` row id `runtime:embed_probe` with `last_success_ts`. Add it as a job in `system/cognition/jobs/internal/` would conflict with cognition-e1 (which owns that dir). Instead, add the probe to the daemon's heartbeat at a 24h cooldown:

Open `system/runtime/daemon/server.js`. After daemon boot, register a daily synthetic-embed probe (use the existing scheduler if available; otherwise add a `setInterval` with `.unref()` and a 24h interval).

The probe writes a 1-line embed via the existing embed factory (filing finding for e1 lane on integration; for now, the probe falls back to no-op + warn until e1 wires it).

**Implementation note:** since `system/data/embed/factory.js` is e1-owned, the probe wrapper goes in `system/runtime/log/embed-probe.js` (new) and calls into the embedder via the public daemon interface. If wiring is blocked, the probe file scaffolds the signature but leaves a clear stub that e1 lane fills in. Document this in "Open for cognition-e1 lane".

- [ ] **Step 6: Run test**

```bash
pnpm test:file system/tests/unit/invariant-embedder-load-age.test.js
```

Expected: PASS.

- [ ] **Step 7: Run full test suite**

```bash
pnpm test
```

Green: commit.

- [ ] **Step 8: Commit**

```bash
git add system/runtime/invariants/daemon.embedder-load-age.js system/tests/unit/invariant-embedder-load-age.test.js system/runtime/invariants/index.js
git diff --cached --name-only
git commit -m "feat(polish-a4): daemon.embedder_load_age invariant (detect-only)" -- system/runtime/invariants/daemon.embedder-load-age.js system/tests/unit/invariant-embedder-load-age.test.js system/runtime/invariants/index.js
git show HEAD --stat
```

---

### Task 24: New invariant — runtime.hot_reload_watcher_active

**Files:**
- Create: `system/runtime/invariants/runtime.hot-reload-watcher-active.js`
- Test: `system/tests/unit/invariant-hot-reload-watcher.test.js`

- [ ] **Step 1: Write the test**

Create `system/tests/unit/invariant-hot-reload-watcher.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert';
import invariant from '../../runtime/invariants/runtime.hot-reload-watcher-active.js';

test('ok when watcher state row exists with active=true', async () => {
  const ctx = {
    db: {
      query: () => ({
        collect: async () => [{ active: true, registered_at: new Date().toISOString() }],
      }),
    },
  };
  const r = await invariant.check(ctx);
  assert.strictEqual(r.ok, true);
});

test('warn when watcher state row missing', async () => {
  const ctx = { db: { query: () => ({ collect: async () => [] }) } };
  const r = await invariant.check(ctx);
  assert.strictEqual(r.ok, false);
});

test('warn when active=false', async () => {
  const ctx = {
    db: {
      query: () => ({
        collect: async () => [{ active: false, registered_at: new Date().toISOString() }],
      }),
    },
  };
  const r = await invariant.check(ctx);
  assert.strictEqual(r.ok, false);
});
```

- [ ] **Step 2: Write the invariant**

Create `system/runtime/invariants/runtime.hot-reload-watcher-active.js`:

```js
// runtime.hot_reload_watcher_active
//
// Detects: hot-reload watcher (system/runtime/daemon/job-hot-reload.js) was
// not registered at daemon boot, OR was registered and subsequently torn down
// without being restored. Symptom: edits to user-data/jobs/**/*.js stop
// taking effect (ESM cache drift, CLAUDE.md "recurring bugs" entry).

export default {
  name: 'runtime.hot_reload_watcher_active',
  level: 'warn',
  surface: 'runtime',
  phase: 'runtime',
  description:
    'Hot-reload watcher is registered and active (else edits to user-data/jobs/* require manual daemon restart).',
  detectOnly: true,
  detectOnlyUntilDays: 7,

  remediation: [
    'kill <daemon-pid>  # launchctl will respawn with a fresh watcher',
    'check: ROBIN_DISABLE_HOT_RELOAD environment variable not set',
    'verify "[hot-reload] watching" lines appear in daemon.log on boot',
  ],

  runWhen: {
    boot: { enabled: true },
    heartbeat: { enabled: true, cooldownMs: 300_000 }, // 5m
    doctor: { enabled: true },
  },

  async check(ctx) {
    if (!ctx?.db) return { ok: false, error: 'no_db_handle' };
    try {
      const builder = ctx.db.query(
        'SELECT active, registered_at FROM runtime_state WHERE id = "runtime:hot_reload_watcher";'
      );
      const rows = await builder.collect();
      if (!rows?.[0]) {
        return { ok: false, error: 'watcher_not_registered' };
      }
      if (rows[0].active !== true) {
        return { ok: false, error: 'watcher_inactive', evidence: { row: rows[0] } };
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message ?? 'check_failed' };
    }
  },

  explain() {
    return [
      '### `runtime.hot_reload_watcher_active`',
      '',
      '**Symptom.** Edits to `user-data/jobs/**/*.js` (e.g., daily-briefing render logic) do not take effect after save. Cron-fired jobs continue using the old code.',
      '',
      '**Cause.** Node ESM cache pins imported modules for the daemon\'s lifetime. The hot-reload watcher SIGTERMs the daemon on `.js` changes so launchd respawns with a fresh module graph. If the watcher is not active, edits silently no-op.',
      '',
      '**Fix.** Restart the daemon (kill pid; launchd respawns). If the watcher does not re-register, check `ROBIN_DISABLE_HOT_RELOAD` env var and the daemon boot log for `[hot-reload] watching` lines.',
    ].join('\n');
  },
};
```

- [ ] **Step 3: Wire the watcher to write state**

Open `system/runtime/daemon/job-hot-reload.js`. On `start()`, write a row to `runtime_state` with id `runtime:hot_reload_watcher` and `active: true, registered_at: <now>`. On `stop()`, write `active: false`.

If `system/runtime/daemon/job-hot-reload.js` doesn't currently expose start/stop in this way, add the writes inline at the existing watcher-registration site.

- [ ] **Step 4: Register in invariants index**

Edit `system/runtime/invariants/index.js` to import + include the new invariant.

- [ ] **Step 5: Run + commit**

```bash
pnpm test:file system/tests/unit/invariant-hot-reload-watcher.test.js
pnpm test
git add system/runtime/invariants/runtime.hot-reload-watcher-active.js system/tests/unit/invariant-hot-reload-watcher.test.js system/runtime/invariants/index.js system/runtime/daemon/job-hot-reload.js
git diff --cached --name-only
git commit -m "feat(polish-a4): runtime.hot_reload_watcher_active invariant (detect-only)" -- system/runtime/invariants/runtime.hot-reload-watcher-active.js system/tests/unit/invariant-hot-reload-watcher.test.js system/runtime/invariants/index.js system/runtime/daemon/job-hot-reload.js
git show HEAD --stat
```

---

### Task 25: New invariant — mcp.daemon_authenticated_after_reconnect

**Files:**
- Create: `system/runtime/invariants/mcp.daemon-authenticated-after-reconnect.js`
- Test: `system/tests/unit/invariant-daemon-reauth.test.js`

- [ ] **Step 1: Write the failing test**

Create `system/tests/unit/invariant-daemon-reauth.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert';
import invariant from '../../runtime/invariants/mcp.daemon-authenticated-after-reconnect.js';

function makeCtx({ activeQueryCount = 0, reconnectThrows = null, probeSucceeds = true }) {
  let reconnected = false;
  return {
    activeQueryCount,
    db: {
      close: async () => {},
      connect: async () => {
        reconnected = true;
        if (reconnectThrows) throw reconnectThrows;
      },
      query: () => ({
        collect: async () => {
          if (!probeSucceeds) {
            const e = new Error('Anonymous access not allowed');
            e.code = 'ANON';
            throw e;
          }
          return [{ v: 1 }];
        },
      }),
    },
    _wasReconnected: () => reconnected,
  };
}

test('skips when active queries in flight', async () => {
  const ctx = makeCtx({ activeQueryCount: 3 });
  const r = await invariant.check(ctx);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.skipped, 'workload_active');
});

test('ok when reconnect + probe succeed', async () => {
  const ctx = makeCtx({ activeQueryCount: 0, probeSucceeds: true });
  const r = await invariant.check(ctx);
  assert.strictEqual(r.ok, true);
});

test('warn when probe surfaces anonymous-access after reconnect', async () => {
  const ctx = makeCtx({ activeQueryCount: 0, probeSucceeds: false });
  const r = await invariant.check(ctx);
  assert.strictEqual(r.ok, false);
  assert.match(r.error ?? '', /anonymous|reauth/);
});

test('warn when reconnect throws', async () => {
  const ctx = makeCtx({ activeQueryCount: 0, reconnectThrows: new Error('conn refused') });
  const r = await invariant.check(ctx);
  assert.strictEqual(r.ok, false);
});

test('weekly cadence configured', () => {
  assert.strictEqual(invariant.runWhen.heartbeat.cooldownMs, 7 * 24 * 3600 * 1000);
});

test('detectOnly is true', () => {
  assert.strictEqual(invariant.detectOnly, true);
});
```

- [ ] **Step 2: Verify failing**

```bash
pnpm test:file system/tests/unit/invariant-daemon-reauth.test.js
```

Expected: FAIL — invariant module not found.

- [ ] **Step 3: Write the invariant**

Create `system/runtime/invariants/mcp.daemon-authenticated-after-reconnect.js`:

```js
// mcp.daemon_authenticated_after_reconnect
//
// Weekly synthetic disconnect-reconnect cycle to verify the proactive reauth
// handler is still registered. Distinguished from `db.authenticated` which
// covers in-the-moment regressions via the reactive installQueryRetry layer.
// This invariant catches the case where the handler was silently torn down.
//
// Skips during active workload (activeQueryCount > 0) to avoid disturbing
// real traffic.

const QUIESCENCE_TIMEOUT_MS = 30_000;
const PROBE_SQL = 'RETURN 1;';

export default {
  name: 'mcp.daemon_authenticated_after_reconnect',
  level: 'warn',
  surface: 'mcp',
  phase: 'mcp',
  description:
    'Weekly probe: synthetic WS disconnect-reconnect followed by SELECT returns without anonymous-access error.',
  detectOnly: true,
  detectOnlyUntilDays: 7,

  remediation: [
    'restart daemon: kill <daemon-pid> (launchctl respawns with fresh wiring)',
    'verify proactive reauth handler is subscribed to client connected event',
    'check db client for `installQueryRetry` wiring',
  ],

  runWhen: {
    boot: { enabled: false }, // too disruptive at boot
    heartbeat: { enabled: true, cooldownMs: 7 * 24 * 3600 * 1000 }, // weekly
    doctor: { enabled: true },
  },

  async check(ctx) {
    if (!ctx?.db) return { ok: false, error: 'no_db_handle' };

    // Skip during active workload to avoid disturbing real traffic.
    if ((ctx.activeQueryCount ?? 0) > 0) {
      return { ok: true, skipped: 'workload_active' };
    }

    try {
      await ctx.db.close();
      await ctx.db.connect();
    } catch (e) {
      return {
        ok: false,
        error: 'reconnect_failed',
        evidence: { message: e.message ?? String(e) },
      };
    }

    try {
      const builder = ctx.db.query(PROBE_SQL);
      const rows = await builder.collect();
      if (!rows || rows.length === 0) {
        return { ok: false, error: 'probe_empty' };
      }
      return { ok: true };
    } catch (e) {
      const msg = e.message ?? String(e);
      if (/anonymous/i.test(msg)) {
        return {
          ok: false,
          error: 'anonymous_after_reauth',
          evidence: { message: msg },
        };
      }
      return { ok: false, error: 'probe_failed', evidence: { message: msg } };
    }
  },

  explain() {
    return [
      '### `mcp.daemon_authenticated_after_reconnect`',
      '',
      '**Symptom.** Daemon log fills with `Anonymous access not allowed` after a network blip or laptop sleep. The reactive retry layer (`installQueryRetry`) usually recovers; this invariant catches the case where the proactive reauth handler was silently torn down.',
      '',
      '**Cause.** The `connected` event listener that re-applies `signin()` + `use()` after a WS reconnect was either never registered or was removed. Existing reactive retry catches most cases but adds latency per query.',
      '',
      '**Fix.** Restart the daemon via `kill <pid>` (launchctl respawns it). The proactive handler re-registers at boot. If symptom recurs, audit `system/data/db/client.js` for handler-subscribe logic.',
      '',
      '**Cadence:** weekly heartbeat — chosen to avoid disturbing live workload. Probe is skipped when `activeQueryCount > 0`.',
    ].join('\n');
  },
};
```

- [ ] **Step 4: Register in invariants index**

Edit `system/runtime/invariants/index.js` to import + include the new invariant. Pattern:
```js
import daemonAuthAfterReconnect from './mcp.daemon-authenticated-after-reconnect.js';
// ...add to exported list
```

- [ ] **Step 5: Surface activeQueryCount to ctx**

The invariant context needs `activeQueryCount`. Check whether `system/runtime/invariants/ctx.js` already exposes it; if not, add a counter wired through `system/data/db/client.js` (read-only — `client.js` is e1-owned, so if extension is needed, file a finding to "Open for cognition-e1 lane" with the proposed extension. For now, the invariant treats missing `activeQueryCount` as 0, which means it WILL probe — acceptable for weekly cadence).

- [ ] **Step 6: Run test**

```bash
pnpm test:file system/tests/unit/invariant-daemon-reauth.test.js
pnpm test
```

Both green: commit.

- [ ] **Step 7: Commit**

```bash
git add system/runtime/invariants/mcp.daemon-authenticated-after-reconnect.js system/tests/unit/invariant-daemon-reauth.test.js system/runtime/invariants/index.js
git diff --cached --name-only
git commit -m "feat(polish-a4): mcp.daemon_authenticated_after_reconnect invariant (detect-only, weekly)" -- system/runtime/invariants/mcp.daemon-authenticated-after-reconnect.js system/tests/unit/invariant-daemon-reauth.test.js system/runtime/invariants/index.js
git show HEAD --stat
```

---

### Task 26: Backfill `remediation` field for existing invariants (Phase A part)

Spec calls for Phase B to backfill all `remediation` fields, but Phase A's invariant schema extension must precede it. In Phase A:

- [ ] **Step 1: Add `remediation` to the invariant schema test**

If a typed schema test exists (e.g., `system/tests/unit/invariant-schema.test.js`), extend it to allow (but not require) a `remediation: string | string[] | undefined` field. Phase B will enforce required.

- [ ] **Step 2: Document the schema extension**

Add a comment block at the top of `system/runtime/invariants/index.js` documenting the optional `remediation` field. Phase B will make it required and backfill all existing invariants.

- [ ] **Step 3: Commit**

```bash
git commit -m "feat(polish-a4): allow optional remediation field on invariant schema" -- system/runtime/invariants/index.js
```

(Phase B's spec covers backfilling all existing invariants. Phase A only opens the schema door.)

---

### Task 27: Doctor `--json` schema snapshot test

**Files:**
- Create: `system/tests/unit/doctor-json-schema.test.js`

- [ ] **Step 1: Capture current schema**

```bash
node system/bin/robin doctor --json > /tmp/doctor-current.json
jq '.' /tmp/doctor-current.json | head -40
```

- [ ] **Step 2: Write the snapshot test**

Create `system/tests/unit/doctor-json-schema.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

test('doctor --json output has stable top-level shape', () => {
  const robin = resolve(process.cwd(), 'system/bin/robin');
  const r = spawnSync('node', [robin, 'doctor', '--json'], {
    encoding: 'utf8',
    timeout: 30000,
  });
  assert.strictEqual(r.status, 0, `doctor exited ${r.status}: ${r.stderr}`);
  const parsed = JSON.parse(r.stdout);

  // Top-level keys
  assert.ok('exit_code' in parsed, 'exit_code field present');
  assert.ok('summary' in parsed, 'summary field present');
  assert.ok('realms' in parsed || 'checks' in parsed, 'realms or checks present');
  assert.ok('ts' in parsed || 'timestamp' in parsed, 'ts/timestamp present');

  // exit_code is a number
  assert.strictEqual(typeof parsed.exit_code, 'number');

  // Summary has ok/warn/fail counts
  if (parsed.summary) {
    assert.strictEqual(typeof parsed.summary.ok, 'number');
    assert.strictEqual(typeof parsed.summary.warn, 'number');
    assert.strictEqual(typeof parsed.summary.fail, 'number');
  }
});

test('every check entry has name + status', () => {
  const robin = resolve(process.cwd(), 'system/bin/robin');
  const r = spawnSync('node', [robin, 'doctor', '--json'], { encoding: 'utf8', timeout: 30000 });
  const parsed = JSON.parse(r.stdout);
  const checks = parsed.checks ?? Object.values(parsed.realms ?? {}).flatMap((r) => r.checks ?? []);
  assert.ok(checks.length > 0, 'has at least one check');
  for (const c of checks) {
    assert.ok(typeof c.name === 'string', `check ${JSON.stringify(c)} has name string`);
    assert.ok(['ok', 'warn', 'fail'].includes(c.status), `check ${c.name} status valid`);
  }
});
```

- [ ] **Step 3: Run the test**

```bash
pnpm test:file system/tests/unit/doctor-json-schema.test.js
```

If FAIL: the test reveals what the current shape actually looks like; either fix the test (relax assertions to match reality) or fix the producer in `system/runtime/cli/commands/doctor.js` / `_doctor-status.js` (if the bug is real). Phase A only locks in the current shape; Phase B may redesign it.

- [ ] **Step 4: Gate behind ROBIN_SKIP_SLOW**

Because it spawns the CLI, this test is >300ms. Wrap the test bodies with `{ skip: process.env.ROBIN_SKIP_SLOW === '1' }`.

- [ ] **Step 5: Commit**

```bash
git add system/tests/unit/doctor-json-schema.test.js
git diff --cached --name-only
git commit -m "test(polish-a4): doctor --json schema snapshot" -- system/tests/unit/doctor-json-schema.test.js
git show HEAD --stat
```

---

### Task 28: Extend .githooks/pre-commit for atomic-commit enforcement

**Files:**
- Modify: `.githooks/pre-commit`

- [ ] **Step 1: Read current hook**

```bash
cat .githooks/pre-commit
```

Note the existing runbook-regeneration logic.

- [ ] **Step 2: Add atomic-commit checks**

Append to `.githooks/pre-commit` (before the final exit):

```bash
# Atomic-commit enforcement (CLAUDE.md multi-agent git hygiene)
# Refuse commits invoked via `git commit -a` or `-am` — they sweep up other
# sessions' staged files.

# git exposes the invocation via GIT_REFLOG_ACTION or by checking the index
# state vs working tree.

# Heuristic: if there are unstaged modifications to tracked files that ALSO
# appear in the staged set, warn. This catches the case where `git commit -a`
# would have included additional files but `git commit -- file1 file2` did
# not — we want to flag this for human review.

staged_files=$(git diff --cached --name-only --diff-filter=ACMR)
unstaged_modified=$(git diff --name-only --diff-filter=M)

drift=$(comm -12 <(echo "$staged_files" | sort) <(echo "$unstaged_modified" | sort))
if [[ -n "$drift" ]]; then
  echo "[robin precommit] WARN: staged files have unstaged modifications:" >&2
  echo "$drift" | sed 's/^/  /' >&2
  echo "[robin precommit] continuing — review the diff after commit with: git show HEAD --stat" >&2
fi
```

(Note: rejecting `-a`/`-am` from inside pre-commit is hard because by that point the staging has already happened. The above warns instead.)

- [ ] **Step 3: Smoke-test**

```bash
echo "// test" >> system/tests/unit/normalize-snapshot.test.js
git diff --name-only
# Try a commit with explicit file
git restore system/tests/unit/normalize-snapshot.test.js
```

- [ ] **Step 4: Commit**

```bash
git add .githooks/pre-commit
git diff --cached --name-only
git commit -m "build(polish-a4): pre-commit hook warns on staged/unstaged drift" -- .githooks/pre-commit
git show HEAD --stat
```

---

### Task 29: A.4 log noise reduction pass

For each pattern from the baseline (top 10) that classifies as `silence` or `reduce`:

- [ ] **Step 1: Locate emitting site**

```bash
rg "<pattern-fragment>" system/ --type js
```

- [ ] **Step 2: Apply classification**

- `silence` → change `console.warn`/`console.error` to `log.debug({event: 'x', ...})` (requires `ROBIN_DEBUG=1` to surface).
- `reduce` → wrap with `if (counter++ % N === 0)` per-1-of-N sampling.
- `keep` → no change, but document in audit notes why.
- `promote` → noop here; surface as audit-notes recommendation for Phase B/cognition-e1 to convert into an invariant.

- [ ] **Step 3: Smoke**

```bash
pnpm test
```

- [ ] **Step 4: Commit per site**

```bash
git commit -m "refactor(polish-a4): silence|reduce <event-name>" -- <file>
```

---

### Task 30: A.4 finalization — re-baseline + delta check

- [ ] **Step 1: Re-capture idle baseline**

```bash
node system/scripts/log-baseline.js --idle 10m > /tmp/polish-idle-after.txt
```

- [ ] **Step 2: Compare**

```bash
diff /tmp/polish-idle-baseline.txt /tmp/polish-idle-after.txt | head -40
```

Threshold: idle daemon total lines should be ≤50% of baseline. Any single pattern repeating >2× per minute (= 20 occurrences in 10-min window) is a regression.

- [ ] **Step 3: Re-capture active baseline + compare**

Same for `--active 10m`.

- [ ] **Step 4: Record final metrics in audit notes**

Append a "Post-A.4 metrics" section to `docs/superpowers/notes/2026-05-17-polish-phase-a-log-baseline.md` with before/after counts.

If thresholds not met: identify the remaining noisy pattern, do another Task 29 pass.

---

## Finalization

### Task 31: Audit notes review + bridge table

- [ ] **Step 1: Read audit notes top-to-bottom**

```bash
cat docs/superpowers/notes/2026-05-17-polish-phase-a-audit.md
```

Verify every section has entries (no empty tables; every Inventory has matching Decisions; every fix has a commit sha).

- [ ] **Step 2: Populate "Bridge to Phase B" table**

For each finding that informs Phase B work, add a row. Examples:

```markdown
| Phase B target | Type | Provenance | Priority |
|---|---|---|---|
| Add user-facing error message at `cli/commands/<x>.js:<line>` | error-message | A.1 §<file>:<line> | high |
| Drop `<command>` from B.1 inventory (deleted in A.2) | scope-reduction | A.2 §orphan-scripts | — |
| Doctor must render invariant `daemon.embedder_load_age` | doctor-display | A.4 §invariants | high |
| MCP tool `<name>` error path now structured via logger | mcp-contract | A.1 §<site> | med |
| Daemon log event `scheduler.tick_failed` structured; surface last-N in doctor | observability | A.4 §log-noise | low |
```

- [ ] **Step 3: Commit final audit notes**

```bash
git add docs/superpowers/notes/2026-05-17-polish-phase-a-audit.md
git diff --cached --name-only
git commit -m "docs(polish): phase A audit notes finalized + bridge table" -- docs/superpowers/notes/2026-05-17-polish-phase-a-audit.md
git show HEAD --stat
```

---

### Task 32: Phase A exit gate

- [ ] **Step 1: Run polish-verify**

```bash
bash system/scripts/polish-verify.sh --phase=a
```

Expected: PASS.

- [ ] **Step 2: Run full daemon start/stop cycle**

```bash
node system/bin/robin daemon-start &
sleep 5
node system/bin/robin doctor
node system/bin/robin daemon-stop
sleep 2
pgrep -f "robin.*daemon" && echo "FAIL: daemon orphan" || echo "OK: no orphan"
```

Expected: doctor exits clean; no orphan after stop.

- [ ] **Step 3: Run every subcommand --help**

```bash
for sub in $(ls system/runtime/cli/commands/ | grep -v '^_' | sed 's/\.js$//'); do
  node system/bin/robin "$sub" --help > /dev/null || echo "FAIL: $sub"
done
echo "all subcommand --help OK"
```

Expected: every subcommand `--help` exits 0.

- [ ] **Step 4: Verify CLAUDE.md "recurring bugs" coverage**

Open audit notes A4 invariant coverage table. Confirm every CLAUDE.md "recurring bugs" entry has either an invariant or a documented not-invariant-able rationale.

- [ ] **Step 5: Surface to user for review**

Print the final audit-notes file path and the bridge table:

```bash
echo "Phase A complete. Audit notes: docs/superpowers/notes/2026-05-17-polish-phase-a-audit.md"
echo "Bridge table follows:"
sed -n '/^## Bridge to Phase B$/,/^## /p' docs/superpowers/notes/2026-05-17-polish-phase-a-audit.md
```

Ask the user:
- Review the audit notes file.
- Confirm Phase B scope reductions.
- Approve before Phase B plan generation begins.

---

## Self-review (run after writing this plan; fix inline)

**1. Spec coverage.**

| Spec section | Plan task(s) |
|---|---|
| Pre-flight + cognition-e1 conflict policy | Pre-flight 1-3 |
| Audit notes file structure | Task 1 |
| Snapshot test convention | Task 2 |
| Polish-verify script | Task 3 |
| MCP tools inventory | Task 4 |
| A.4 Step 0 baseline | Tasks 5 |
| A.1 silent-failure hunt | Tasks 6, 7, 8 |
| A.2 dead-code purge | Tasks 9-16 |
| A.3 test gaps + slow-test | Tasks 17-20 |
| A.4 logger module | Task 21 |
| A.4 log noise conversions | Task 22 |
| A.4 new invariants (3) | Tasks 23, 24, 25 |
| A.4 invariant schema extension | Task 26 |
| A.4 doctor JSON snapshot | Task 27 |
| A.4 .githooks extension | Task 28 |
| A.4 log noise pass | Task 29 |
| A.4 re-baseline + delta | Task 30 |
| Audit notes finalize + bridge | Task 31 |
| Exit gate verification | Task 32 |
| CHANGELOG (Phase A entries) | NOT yet — defer until Phase A complete; add at end of Task 32 |

CHANGELOG amendment: at end of Task 32 Step 5, add a Step 6:

> - [ ] **Step 6: Update CHANGELOG.md**
>
> If `CHANGELOG.md` does not yet exist at the package root, create it:
> ```markdown
> # Changelog
> All notable changes to this project will be documented in this file.
> Format: Keep a Changelog (https://keepachangelog.com/).
>
> ## [unreleased] - Phase A
>
> ### Added
> - Snapshot-test normalization helper (`system/tests/helpers/normalize-snapshot.js`).
> - Polish-verify script (`system/scripts/polish-verify.sh`).
> - MCP tools inventory script (`system/scripts/list-mcp-tools.js`).
> - Log baseline harness (`system/scripts/log-baseline.js` + `-traffic.js`).
> - Structured logger module (`system/runtime/log/index.js`).
> - Invariant `daemon.embedder_load_age` (detect-only).
> - Invariant `runtime.hot_reload_watcher_active` (detect-only).
> - Invariant `mcp.daemon_authenticated_after_reconnect` (detect-only).
> - Doctor `--json` schema snapshot test.
> - Pre-commit drift warning in `.githooks/pre-commit`.
> - Madge as devDependency.
> - Dead-code allowlist (`system/scripts/dead-code-allowlist.json`).
>
> ### Changed
> - Silent-failure sites: <count> sites surfaced (commits in audit notes).
> - Log noise: idle daemon -X%, active daemon -Y%.
>
> ### Removed
> - Orphan modules: <list from A.2>
> - Unused exports: <list from A.2>
> - Stale fixtures: <list from A.2>
>
> ### Open for user
> - Abandoned migrations: <list>
> - Orphan scripts: <list>
> ```
>
> Commit: `git commit -m "docs(polish): CHANGELOG for phase A" -- CHANGELOG.md`

**2. Placeholder scan.**

- All "Per-finding" / "Per-module" tasks are structured TEMPLATES with full instructions for each iteration. Not placeholders — they're loops over scan output.
- All code blocks contain real, runnable code.
- No "TODO" / "TBD" / "fill in later" text in any step.
- Bridge table example rows in Task 31 are illustrative; the actual rows are populated from audit notes contents.

**3. Type consistency.**

- `log.info`, `log.warn`, `log.error`, `log.debug` — consistent across Tasks 21, 22, 23, 24, 25.
- `setSink` — defined in Task 21, used by Task 21 test only.
- `normalize`, `normalizeDoctorOutput`, `normalizeRecallEvents` — defined in Task 2, available for Task 27 (doctor snapshot) and any Phase B snapshot tests.
- `polish-verify.sh --phase=a` — Task 3 (create), Task 8 (run), Task 16 (run), Task 32 (run). Consistent.
- Invariant shape (`name`, `level`, `surface`, `phase`, `description`, `runWhen`, `check`, `explain`, `remediation?`, `detectOnly?`) — consistent across Tasks 23, 24, 25; matches existing invariant style in `system/runtime/invariants/db.authenticated.js`.

No type drift detected.

---

## Execution handoff

**Plan complete and saved to `docs/superpowers/plans/2026-05-17-polish-phase-a-sanitation.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration. Best for the per-finding loop tasks (Tasks 7, 12, 19, 22, 29) because each iteration is independent and a subagent can be re-spawned per finding with a focused prompt.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints. Best for the scaffolding tasks (1-5, 9-11, 17, 21, 23-28, 31-32) where momentum across closely-related code keeps context warm.

**Hybrid is also viable:** inline for scaffolding (Tasks 1-5, 9-11, 17, 21, 23-28), subagent-driven for the audit loops (Tasks 6-8, 12-16, 18-20, 22, 29-30), inline for finalization (Tasks 31-32).

**Which approach?**
