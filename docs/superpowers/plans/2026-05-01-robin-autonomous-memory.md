# Robin Autonomous Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move Robin's capture and recall from "model is supposed to" to "system enforces via Claude Code lifecycle hooks." Capture: Stop hook hard-walls turn-end if no memory write happened. Recall: UserPromptSubmit hook injects relevant memory based on entity matches.

**Architecture:** Two subsystems sharing a single `UserPromptSubmit` hook handler. Subsystem 1 (Capture Enforcement) tracks memory writes via existing `PreToolUse` hook into `turn-writes.log`, then verifies at Stop. Subsystem 2 (Recall) maintains an auto-generated `ENTITIES.md` and injects matched-entity context into the model's input. All retrieval is in-process Node-native (no `rg` dep, no API key). Fail-open everywhere.

**Tech Stack:** Node.js 18+ ESM, `node:test` (built-in test runner), `node:fs`/`node:path`/`node:child_process`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-05-01-robin-autonomous-memory-design.md`

---

## File Structure

**New files (libs):**
- `system/scripts/lib/turn-state.js` — read/write/atomic helpers for `turn.json`, `turn-writes.log`, `capture-retry.json`
- `system/scripts/lib/perf-log.js` — append helper for `hook-perf.log` with size cap
- `system/scripts/capture/lib/capture-keyword-scan.js` — keyword regex + tier classifier
- `system/scripts/memory/lib/recall.js` — Node-native in-process retrieval
- `system/scripts/memory/lib/entity-index.js` — read/write/incremental update of `ENTITIES.md`

**New files (CLI / scripts / tests):**
- `system/scripts/memory/index-entities.js` — bootstrap + regenerate CLI
- `system/scripts/migrations/0009-capture-enforcement-config.js` — one-time config migration
- `system/tests/turn-state.test.js`
- `system/tests/perf-log.test.js`
- `system/tests/capture-keyword-scan.test.js`
- `system/tests/recall.test.js`
- `system/tests/entity-index.test.js`
- `system/tests/index-entities.test.js`
- `system/tests/claude-code-hook-capture.test.js` — UserPromptSubmit + Stop verifyCapture + PreToolUse write-intent
- `system/tests/fixtures/mock-hook-events/user-prompt-submit.json`
- `system/tests/fixtures/mock-hook-events/stop.json`
- `system/tests/fixtures/mock-hook-events/pre-tool-use-write.json`
- `system/tests/fixtures/mock-hook-events/pre-tool-use-bash.json`
- `system/tests/fixtures/sample-memory/` (small markdown tree for entity tests)

**Modified files:**
- `system/scripts/hooks/claude-code.js` — new `--on-user-prompt-submit` mode; `verifyCapture()` integration in `--on-stop`; write-intent logging in `--on-pre-tool-use` and `--on-pre-bash`
- `bin/robin.js` — new `recall` subcommand
- `system/skeleton/robin.config.json` — add `memory.capture_enforcement` block
- `.claude/settings.json` — register UserPromptSubmit hook
- `AGENTS.md` — capture-checkpoint rewrite, recall instruction, ENTITIES.md in startup load order
- `system/rules/capture.md` — drop T1 sweep, add marker-protocol section
- `system/jobs/dream.md` — Phase 3.11.5, 4.17.6, 4.17.7
- `system/scripts/lib/manifest.js` (only if hook-shape conversion needs adjustment) — verify
- `CHANGELOG.md` — entry

**Generated at install/runtime (not in repo):**
- `user-data/memory/ENTITIES.md` (Dream-regenerated)
- `user-data/memory/ENTITIES-extended.md` (overflow)
- `user-data/state/turn.json`, `turn-writes.log`, `capture-retry.json`, `capture-enforcement.log`, `recall.log`, `hook-perf.log`, `entities-hash.txt`
- `user-data/security/manifest.json` (re-snapshotted)

---

## Conventions

- All new lib files use ESM, no bundler. Match style of existing `system/scripts/lib/*.js`.
- All file writes that must not be partially-visible: temp + `fsync` + `rename`.
- All new hook-side code wrapped in top-level `try/catch`; on error, exit 0 (fail-open) and append one line to `hook-errors.log` if possible.
- Tests use `node:test` (`describe`/`it`/`assert`). Each test creates its own `mkdtempSync` workspace under `tmpdir()`.
- Run all tests with `npm test`. Run a single file with `node --test system/tests/<file>.test.js`.
- Commit message style: match recent commits (`feat(scope): ...`, `fix(scope): ...`, `docs(scope): ...`, `test(scope): ...`).

---

## Task 1: `lib/turn-state.js` — turn-state helpers

**Files:**
- Create: `system/scripts/lib/turn-state.js`
- Test: `system/tests/turn-state.test.js`

- [ ] **Step 1: Write failing tests**

```javascript
// system/tests/turn-state.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  mintTurnId,
  writeTurnJson,
  readTurnJson,
  appendWriteIntent,
  readWriteIntents,
  pruneWriteIntents,
  readRetry,
  incrementRetry,
} from '../scripts/lib/turn-state.js';

function setup() {
  const ws = mkdtempSync(join(tmpdir(), 'turn-state-'));
  mkdirSync(join(ws, 'user-data/state'), { recursive: true });
  return ws;
}

describe('turn-state', () => {
  it('mintTurnId composes session-id and ms timestamp', () => {
    const id = mintTurnId('claude-code-abc', new Date('2026-05-01T12:00:00Z'));
    assert.equal(id, 'claude-code-abc:1777982400000');
  });

  it('writeTurnJson + readTurnJson round-trip', () => {
    const ws = setup();
    writeTurnJson(ws, { turn_id: 't1', user_words: 12, tier: 3, entities_matched: ['x'] });
    const got = readTurnJson(ws);
    assert.equal(got.turn_id, 't1');
    assert.equal(got.tier, 3);
    assert.deepEqual(got.entities_matched, ['x']);
  });

  it('readTurnJson returns null when missing', () => {
    const ws = setup();
    assert.equal(readTurnJson(ws), null);
  });

  it('readTurnJson returns null when corrupt', () => {
    const ws = setup();
    writeFileSync(join(ws, 'user-data/state/turn.json'), '{not-json');
    assert.equal(readTurnJson(ws), null);
  });

  it('appendWriteIntent appends one line per call', () => {
    const ws = setup();
    appendWriteIntent(ws, { turn_id: 't1', target: 'inbox.md', tool: 'Edit' });
    appendWriteIntent(ws, { turn_id: 't1', target: 'profile.md', tool: 'Write' });
    const lines = readWriteIntents(ws, 't1');
    assert.equal(lines.length, 2);
    assert.equal(lines[0].target, 'inbox.md');
    assert.equal(lines[1].tool, 'Write');
  });

  it('readWriteIntents filters by turn_id', () => {
    const ws = setup();
    appendWriteIntent(ws, { turn_id: 't1', target: 'a.md', tool: 'Edit' });
    appendWriteIntent(ws, { turn_id: 't2', target: 'b.md', tool: 'Edit' });
    assert.equal(readWriteIntents(ws, 't1').length, 1);
    assert.equal(readWriteIntents(ws, 't2').length, 1);
  });

  it('pruneWriteIntents drops entries older than cutoff', () => {
    const ws = setup();
    const now = Date.now();
    writeFileSync(join(ws, 'user-data/state/turn-writes.log'),
      `${new Date(now - 2 * 3600_000).toISOString()}\told\tinbox.md\tEdit\n` +
      `${new Date(now - 60_000).toISOString()}\trecent\tinbox.md\tEdit\n`,
    );
    pruneWriteIntents(ws, new Date(now - 3600_000));
    const text = readFileSync(join(ws, 'user-data/state/turn-writes.log'), 'utf8');
    assert.ok(!text.includes('old'));
    assert.ok(text.includes('recent'));
  });

  it('incrementRetry increments per turn_id and reads back', () => {
    const ws = setup();
    assert.equal(readRetry(ws, 't1'), 0);
    assert.equal(incrementRetry(ws, 't1'), 1);
    assert.equal(incrementRetry(ws, 't1'), 2);
    assert.equal(readRetry(ws, 't2'), 0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test system/tests/turn-state.test.js`
Expected: FAIL — module `../scripts/lib/turn-state.js` not found.

- [ ] **Step 3: Implement `lib/turn-state.js`**

```javascript
// system/scripts/lib/turn-state.js
//
// Per-turn state helpers used by the capture-enforcement hooks.
// All writes are atomic where corruption could mislead Stop verification.

import { readFileSync, writeFileSync, appendFileSync, existsSync, renameSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

const TURN_FILE = 'user-data/state/turn.json';
const WRITES_LOG = 'user-data/state/turn-writes.log';
const RETRY_FILE = 'user-data/state/capture-retry.json';

function ensureDir(file) {
  mkdirSync(dirname(file), { recursive: true });
}

function atomicWrite(file, content) {
  ensureDir(file);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, file);
}

export function mintTurnId(sessionId, when = new Date()) {
  return `${sessionId}:${when.getTime()}`;
}

export function writeTurnJson(workspaceDir, obj) {
  const file = join(workspaceDir, TURN_FILE);
  const payload = { ...obj, started_at: obj.started_at ?? new Date().toISOString() };
  atomicWrite(file, JSON.stringify(payload));
}

export function readTurnJson(workspaceDir) {
  const file = join(workspaceDir, TURN_FILE);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export function appendWriteIntent(workspaceDir, { turn_id, target, tool }) {
  const file = join(workspaceDir, WRITES_LOG);
  ensureDir(file);
  const ts = new Date().toISOString();
  appendFileSync(file, `${ts}\t${turn_id}\t${target}\t${tool}\n`);
}

export function readWriteIntents(workspaceDir, turnId) {
  const file = join(workspaceDir, WRITES_LOG);
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const out = [];
  for (const line of lines) {
    const [ts, tid, target, tool] = line.split('\t');
    if (tid === turnId) out.push({ ts, turn_id: tid, target, tool });
  }
  return out;
}

export function pruneWriteIntents(workspaceDir, cutoff = new Date(Date.now() - 3600_000)) {
  const file = join(workspaceDir, WRITES_LOG);
  if (!existsSync(file)) return;
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const cutoffMs = cutoff.getTime();
  const kept = lines.filter((line) => {
    const ts = line.split('\t')[0];
    const t = new Date(ts).getTime();
    return Number.isFinite(t) && t >= cutoffMs;
  });
  atomicWrite(file, kept.length ? kept.join('\n') + '\n' : '');
}

function readRetryFile(workspaceDir) {
  const file = join(workspaceDir, RETRY_FILE);
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

export function readRetry(workspaceDir, turnId) {
  const data = readRetryFile(workspaceDir);
  return data[turnId]?.attempts ?? 0;
}

export function incrementRetry(workspaceDir, turnId) {
  const file = join(workspaceDir, RETRY_FILE);
  const data = readRetryFile(workspaceDir);
  const cur = data[turnId]?.attempts ?? 0;
  data[turnId] = { attempts: cur + 1, last_at: new Date().toISOString() };
  atomicWrite(file, JSON.stringify(data));
  return cur + 1;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test system/tests/turn-state.test.js`
Expected: PASS — all 8 tests green.

- [ ] **Step 5: Commit**

```bash
git add system/scripts/lib/turn-state.js system/tests/turn-state.test.js
git commit -m "feat(memory/capture): turn-state helpers (turn.json, turn-writes.log, retry)"
```

---

## Task 2: `lib/perf-log.js` — slow-path telemetry

**Files:**
- Create: `system/scripts/lib/perf-log.js`
- Test: `system/tests/perf-log.test.js`

- [ ] **Step 1: Write failing tests**

```javascript
// system/tests/perf-log.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendPerfLog, capPerfLog } from '../scripts/lib/perf-log.js';

function setup() {
  const ws = mkdtempSync(join(tmpdir(), 'perf-log-'));
  mkdirSync(join(ws, 'user-data/state'), { recursive: true });
  return ws;
}

describe('perf-log', () => {
  it('appendPerfLog writes one TSV line', () => {
    const ws = setup();
    appendPerfLog(ws, { hook: 'UserPromptSubmit', duration_ms: 95, reason: 'timeout' });
    const text = readFileSync(join(ws, 'user-data/state/hook-perf.log'), 'utf8');
    const cols = text.trim().split('\t');
    assert.equal(cols.length, 4);
    assert.equal(cols[1], 'UserPromptSubmit');
    assert.equal(cols[2], '95');
    assert.equal(cols[3], 'timeout');
  });

  it('capPerfLog trims to N most recent lines', () => {
    const ws = setup();
    for (let i = 0; i < 10; i++) appendPerfLog(ws, { hook: 'h', duration_ms: i, reason: `r${i}` });
    capPerfLog(ws, 3);
    const lines = readFileSync(join(ws, 'user-data/state/hook-perf.log'), 'utf8').trim().split('\n');
    assert.equal(lines.length, 3);
    assert.ok(lines[2].includes('r9'));
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `node --test system/tests/perf-log.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `lib/perf-log.js`**

```javascript
// system/scripts/lib/perf-log.js
//
// Append one line per slow-path hook event. Cap file to N lines via Dream rotation.

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';

const PERF_LOG = 'user-data/state/hook-perf.log';

function ensureDir(file) {
  mkdirSync(dirname(file), { recursive: true });
}

export function appendPerfLog(workspaceDir, { hook, duration_ms, reason }) {
  const file = join(workspaceDir, PERF_LOG);
  ensureDir(file);
  const ts = new Date().toISOString();
  appendFileSync(file, `${ts}\t${hook}\t${duration_ms}\t${reason}\n`);
}

export function capPerfLog(workspaceDir, maxLines = 1000) {
  const file = join(workspaceDir, PERF_LOG);
  if (!existsSync(file)) return;
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
  if (lines.length <= maxLines) return;
  const kept = lines.slice(-maxLines).join('\n') + '\n';
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, kept);
  renameSync(tmp, file);
}
```

- [ ] **Step 4: Run test, verify pass**

Run: `node --test system/tests/perf-log.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add system/scripts/lib/perf-log.js system/tests/perf-log.test.js
git commit -m "feat(memory/capture): hook-perf.log helper"
```

---

## Task 3: `lib/capture-keyword-scan.js` — keyword scan + tier classifier

**Files:**
- Create: `system/scripts/capture/lib/capture-keyword-scan.js`
- Test: `system/tests/capture-keyword-scan.test.js`

- [ ] **Step 1: Write failing tests**

```javascript
// system/tests/capture-keyword-scan.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyTier, scanKeywords } from '../scripts/capture/lib/capture-keyword-scan.js';

describe('capture-keyword-scan', () => {
  it('tier 1 — fewer than 5 user words', () => {
    const r = classifyTier({ userMessage: 'thanks', entityAliases: [] });
    assert.equal(r.tier, 1);
    assert.equal(r.reason, 'short');
  });

  it('tier 1 — pure greeting', () => {
    const r = classifyTier({ userMessage: 'hey there', entityAliases: [] });
    assert.equal(r.tier, 1);
  });

  it('tier 2 — 5-19 words, no capture keywords', () => {
    const r = classifyTier({ userMessage: 'can you check the build status please', entityAliases: [] });
    assert.equal(r.tier, 2);
  });

  it('tier 3 — 20+ words', () => {
    const long = Array(25).fill('word').join(' ');
    const r = classifyTier({ userMessage: long, entityAliases: [] });
    assert.equal(r.tier, 3);
  });

  it('tier 3 — capture keyword present', () => {
    const r = classifyTier({ userMessage: 'remember my dentist is great', entityAliases: [] });
    assert.equal(r.tier, 3);
    assert.ok(r.keywords.includes('remember'));
  });

  it('tier 3 — date pattern', () => {
    const r = classifyTier({ userMessage: 'we leave on June 3rd next year', entityAliases: [] });
    assert.equal(r.tier, 3);
  });

  it('tier 3 — money amount', () => {
    const r = classifyTier({ userMessage: 'spent $1,200 on gear today', entityAliases: [] });
    assert.equal(r.tier, 3);
  });

  it('tier 3 — entity alias hit', () => {
    const r = classifyTier({ userMessage: 'meeting with dr. park tomorrow', entityAliases: ['Dr. Park'] });
    assert.equal(r.tier, 3);
    assert.ok(r.entitiesMatched.includes('Dr. Park'));
  });

  it('scanKeywords finds multiple matches', () => {
    const hits = scanKeywords('I decided to remember the meeting on Mar 5');
    assert.ok(hits.includes('decided'));
    assert.ok(hits.includes('remember'));
    assert.ok(hits.some((h) => /^date:/.test(h)));
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `node --test system/tests/capture-keyword-scan.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `lib/capture-keyword-scan.js`**

```javascript
// system/scripts/capture/lib/capture-keyword-scan.js
//
// Scans a user message and assigns a capture-enforcement tier.
//   tier 1 — trivial (skip enforcement)
//   tier 2 — light enforcement (marker accepted without justification)
//   tier 3 — full enforcement (marker requires reason)

const KEYWORDS = [
  'remember', 'decided', 'preferred', 'preference',
  'actually', 'no — ', 'no, ', "don't", 'do not',
  'correction', 'wrong', 'always', 'never',
];

const DATE_RE = /\b(?:\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?)\b/i;
const MONEY_RE = /\$[\d,]+(?:\.\d+)?/;
const PROPER_ATTR_RE = /\b[A-Z][a-z]+\s+(?:is|was|are|were|has|have|said|told)\b/;
const GREETING_RE = /^(?:hi|hey|hello|thanks|thank you|ok|okay|cool|nice|got it|sure|yes|no|sounds good)\b[\s.!?]*$/i;

export function scanKeywords(text) {
  const hits = [];
  const lower = text.toLowerCase();
  for (const kw of KEYWORDS) {
    if (lower.includes(kw)) hits.push(kw);
  }
  const dateMatch = text.match(DATE_RE);
  if (dateMatch) hits.push(`date:${dateMatch[0]}`);
  const moneyMatch = text.match(MONEY_RE);
  if (moneyMatch) hits.push(`money:${moneyMatch[0]}`);
  if (PROPER_ATTR_RE.test(text)) hits.push('proper-attribution');
  return hits;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function scanEntityAliases(text, aliases) {
  if (!aliases?.length) return [];
  const pattern = new RegExp(`\\b(${aliases.map(escapeRegex).join('|')})\\b`, 'gi');
  const found = new Set();
  let m;
  while ((m = pattern.exec(text)) !== null) {
    const original = aliases.find((a) => a.toLowerCase() === m[1].toLowerCase());
    if (original) found.add(original);
  }
  return [...found];
}

function wordCount(text) {
  return (text.trim().match(/\S+/g) || []).length;
}

export function classifyTier({ userMessage, entityAliases = [], thresholds = {} }) {
  const t2 = thresholds.tier2 ?? 5;
  const t3 = thresholds.tier3 ?? 20;
  const wc = wordCount(userMessage);
  const keywords = scanKeywords(userMessage);
  const entitiesMatched = scanEntityAliases(userMessage, entityAliases);

  if (wc < t2 || GREETING_RE.test(userMessage.trim())) {
    return { tier: 1, reason: 'short', wc, keywords, entitiesMatched };
  }
  if (wc >= t3 || keywords.length > 0 || entitiesMatched.length > 0) {
    return { tier: 3, reason: keywords.length ? 'keywords' : (entitiesMatched.length ? 'entity' : 'long'), wc, keywords, entitiesMatched };
  }
  return { tier: 2, reason: 'medium', wc, keywords, entitiesMatched };
}
```

- [ ] **Step 4: Run test, verify pass**

Run: `node --test system/tests/capture-keyword-scan.test.js`
Expected: PASS — 9 tests green.

- [ ] **Step 5: Commit**

```bash
git add system/scripts/capture/lib/capture-keyword-scan.js system/tests/capture-keyword-scan.test.js
git commit -m "feat(memory/capture): keyword scan and tier classifier"
```

---

## Task 4: `lib/recall.js` — Node-native in-process retrieval

**Files:**
- Create: `system/scripts/memory/lib/recall.js`
- Test: `system/tests/recall.test.js`

- [ ] **Step 1: Write failing tests**

```javascript
// system/tests/recall.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recall } from '../scripts/memory/lib/recall.js';

function setup() {
  const ws = mkdtempSync(join(tmpdir(), 'recall-'));
  const mem = join(ws, 'user-data/memory');
  mkdirSync(join(mem, 'profile'), { recursive: true });
  mkdirSync(join(mem, 'knowledge/medical'), { recursive: true });
  writeFileSync(join(mem, 'profile/people.md'), '---\ntype: entity\n---\n## Dr. Park\nDentist, JC.\n');
  writeFileSync(join(mem, 'knowledge/medical/providers.md'), '---\nlast_verified: 2026-01\n---\nDr. Park: appointment 2026-01.\n');
  return ws;
}

describe('recall', () => {
  it('returns hits across multiple files', () => {
    const ws = setup();
    const r = recall(ws, ['Dr. Park']);
    assert.ok(r.hits.length >= 2);
    assert.ok(r.hits.some((h) => h.file.endsWith('profile/people.md')));
    assert.ok(r.hits.some((h) => h.file.endsWith('knowledge/medical/providers.md')));
  });

  it('extracts last_verified from frontmatter when present', () => {
    const ws = setup();
    const r = recall(ws, ['Dr. Park']);
    const hit = r.hits.find((h) => h.file.endsWith('providers.md'));
    assert.equal(hit.last_verified, '2026-01');
  });

  it('caps to top-N hits', () => {
    const ws = setup();
    const mem = join(ws, 'user-data/memory');
    for (let i = 0; i < 20; i++) {
      writeFileSync(join(mem, `dup-${i}.md`), `---\n---\nDr. Park noted on row ${i}.\n`);
    }
    const r = recall(ws, ['Dr. Park'], { topN: 5 });
    assert.equal(r.hits.length, 5);
    assert.equal(r.truncated, true);
  });

  it('multi-pattern dedup', () => {
    const ws = setup();
    const r = recall(ws, ['Dr. Park', 'Park']);
    const lines = new Set(r.hits.map((h) => `${h.file}:${h.line}`));
    assert.equal(lines.size, r.hits.length);
  });

  it('returns empty hits + truncated=false on no match', () => {
    const ws = setup();
    const r = recall(ws, ['Nonexistent Entity']);
    assert.deepEqual(r.hits, []);
    assert.equal(r.truncated, false);
  });

  it('skips files outside user-data/memory', () => {
    const ws = setup();
    mkdirSync(join(ws, 'system'), { recursive: true });
    writeFileSync(join(ws, 'system/elsewhere.md'), 'Dr. Park not relevant.\n');
    const r = recall(ws, ['Dr. Park']);
    assert.ok(!r.hits.some((h) => h.file.includes('system/')));
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `node --test system/tests/recall.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `lib/recall.js`**

```javascript
// system/scripts/memory/lib/recall.js
//
// Node-native in-process retrieval over user-data/memory/.
// No ripgrep dependency; uses fs.readdir walk + compiled regex.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const DEFAULT_TOP_N = 5;

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function* walkMarkdown(dir) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.')) continue;
    const full = join(dir, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) {
      yield* walkMarkdown(full);
    } else if (name.endsWith('.md')) {
      yield full;
    }
  }
}

function parseFrontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return null;
  const fm = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^(\w+):\s*(.+)$/);
    if (kv) fm[kv[1].trim()] = kv[2].trim();
  }
  return fm;
}

export function recall(workspaceDir, patterns, opts = {}) {
  const topN = opts.topN ?? DEFAULT_TOP_N;
  const memDir = join(workspaceDir, 'user-data/memory');
  const re = new RegExp(`\\b(${patterns.map(escapeRegex).join('|')})\\b`, 'i');
  const hits = [];
  let truncated = false;

  outer: for (const file of walkMarkdown(memDir)) {
    let text;
    try { text = readFileSync(file, 'utf8'); } catch { continue; }
    const fm = parseFrontmatter(text);
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!re.test(line)) continue;
      hits.push({
        file: relative(workspaceDir, file),
        line: i + 1,
        text: line.trim(),
        last_verified: fm?.last_verified,
      });
      if (hits.length >= topN) {
        truncated = true;
        break outer;
      }
    }
  }

  return { hits, truncated };
}

export function formatRecallHits({ hits, truncated }) {
  if (!hits.length) return '';
  const lines = hits.map((h) => {
    const verified = h.last_verified ? ` (last_verified: ${h.last_verified})` : '';
    return `- ${h.file}:${h.line} — "${h.text}"${verified}`;
  });
  if (truncated) lines.push(`(more matches truncated; run "robin recall <term>" for full)`);
  return lines.join('\n');
}
```

- [ ] **Step 4: Run test, verify pass**

Run: `node --test system/tests/recall.test.js`
Expected: PASS — 6 tests green.

- [ ] **Step 5: Commit**

```bash
git add system/scripts/memory/lib/recall.js system/tests/recall.test.js
git commit -m "feat(memory/recall): in-process node-native retrieval"
```

---

## Task 5: `lib/entity-index.js` — ENTITIES.md helpers

**Files:**
- Create: `system/scripts/memory/lib/entity-index.js`
- Test: `system/tests/entity-index.test.js`

- [ ] **Step 1: Write failing tests**

```javascript
// system/tests/entity-index.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  collectEntities,
  renderEntitiesMarkdown,
  writeEntitiesAtomic,
  readEntities,
  detectUserEdit,
} from '../scripts/memory/lib/entity-index.js';

function setup() {
  const ws = mkdtempSync(join(tmpdir(), 'entity-index-'));
  const mem = join(ws, 'user-data/memory');
  mkdirSync(join(mem, 'profile'), { recursive: true });
  mkdirSync(join(mem, 'knowledge/finance'), { recursive: true });
  mkdirSync(join(ws, 'user-data/state'), { recursive: true });
  return { ws, mem };
}

describe('entity-index', () => {
  it('collectEntities picks up files with type:entity', () => {
    const { ws, mem } = setup();
    writeFileSync(join(mem, 'knowledge/finance/marcus.md'),
      '---\ntype: entity\ndescription: Marcus HYSA\naliases: [Marcus, GS HYSA]\n---\n# Marcus HYSA\n');
    const entities = collectEntities(ws);
    assert.equal(entities.length, 1);
    assert.equal(entities[0].name, 'Marcus HYSA');
    assert.deepEqual(entities[0].aliases, ['Marcus', 'GS HYSA']);
    assert.equal(entities[0].file, 'knowledge/finance/marcus.md');
  });

  it('collectEntities picks up files with aliases: but no type:entity', () => {
    const { ws, mem } = setup();
    writeFileSync(join(mem, 'profile/dentist.md'),
      '---\ndescription: dentist\naliases: [Dr. Park]\n---\n# Dr. Park\n');
    const entities = collectEntities(ws);
    assert.equal(entities.length, 1);
    assert.equal(entities[0].name, 'Dr. Park');
  });

  it('renderEntitiesMarkdown produces header + DO NOT EDIT marker + rows', () => {
    const md = renderEntitiesMarkdown([
      { name: 'Dr. Park', aliases: ['Park'], file: 'profile/dentist.md', section: null },
    ]);
    assert.ok(md.includes('---'));
    assert.ok(md.includes('# Entities'));
    assert.ok(md.includes('DO NOT EDIT'));
    assert.ok(md.includes('Dr. Park (Park) — profile/dentist.md'));
  });

  it('writeEntitiesAtomic + readEntities round-trip', () => {
    const { ws } = setup();
    writeEntitiesAtomic(ws, [{ name: 'X', aliases: [], file: 'a.md', section: null }]);
    const file = join(ws, 'user-data/memory/ENTITIES.md');
    assert.ok(existsSync(file));
    const data = readEntities(ws);
    assert.equal(data.entities.length, 1);
    assert.equal(data.entities[0].name, 'X');
  });

  it('detectUserEdit returns true when content hash differs from stored', () => {
    const { ws } = setup();
    writeEntitiesAtomic(ws, [{ name: 'X', aliases: [], file: 'a.md', section: null }]);
    const file = join(ws, 'user-data/memory/ENTITIES.md');
    const orig = readFileSync(file, 'utf8');
    writeFileSync(file, orig + '\n- Y (manual) — b.md\n');
    assert.equal(detectUserEdit(ws), true);
  });

  it('detectUserEdit returns false for unedited file', () => {
    const { ws } = setup();
    writeEntitiesAtomic(ws, [{ name: 'X', aliases: [], file: 'a.md', section: null }]);
    assert.equal(detectUserEdit(ws), false);
  });

  it('writeEntitiesAtomic splits hot/extended at cap', () => {
    const { ws } = setup();
    const many = [];
    for (let i = 0; i < 200; i++) many.push({ name: `E${i}`, aliases: [], file: `f${i}.md`, section: null });
    writeEntitiesAtomic(ws, many, { hotCap: 150 });
    const hot = readFileSync(join(ws, 'user-data/memory/ENTITIES.md'), 'utf8');
    const ext = readFileSync(join(ws, 'user-data/memory/ENTITIES-extended.md'), 'utf8');
    const hotRows = hot.split('\n').filter((l) => l.startsWith('- ')).length;
    const extRows = ext.split('\n').filter((l) => l.startsWith('- ')).length;
    assert.equal(hotRows, 150);
    assert.equal(extRows, 50);
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `node --test system/tests/entity-index.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `lib/entity-index.js`**

```javascript
// system/scripts/memory/lib/entity-index.js
//
// Read/write/incremental update of user-data/memory/ENTITIES.md.
// Edit-detection via content hash stored in user-data/state/entities-hash.txt.

import { readFileSync, readdirSync, statSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { createHash } from 'node:crypto';

const ENTITIES_FILE = 'user-data/memory/ENTITIES.md';
const EXTENDED_FILE = 'user-data/memory/ENTITIES-extended.md';
const HASH_FILE = 'user-data/state/entities-hash.txt';
const DO_NOT_EDIT_MARKER = '<!-- DO NOT EDIT — auto-generated by Dream Phase 4.17.6. Edit topic-file aliases instead. -->';

function ensureDir(file) {
  mkdirSync(dirname(file), { recursive: true });
}

function atomicWrite(file, content) {
  ensureDir(file);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, file);
}

function* walkMarkdown(dir) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.') || name === 'ENTITIES.md' || name === 'ENTITIES-extended.md') continue;
    const full = join(dir, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) yield* walkMarkdown(full);
    else if (name.endsWith('.md')) yield full;
  }
}

function parseFrontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return null;
  const fm = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^(\w+):\s*(.+)$/);
    if (kv) {
      let val = kv[2].trim();
      if (val.startsWith('[') && val.endsWith(']')) {
        val = val.slice(1, -1).split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
      }
      fm[kv[1].trim()] = val;
    }
  }
  return fm;
}

function deriveName(file, fm) {
  if (fm?.description) {
    const dash = fm.description.indexOf(' — ');
    if (dash > 0) return fm.description.slice(0, dash).trim();
  }
  // fallback: filename stem prettified
  const stem = file.split('/').pop().replace(/\.md$/, '');
  return stem.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export function collectEntities(workspaceDir) {
  const memDir = join(workspaceDir, 'user-data/memory');
  const out = [];
  for (const file of walkMarkdown(memDir)) {
    const text = readFileSync(file, 'utf8');
    const fm = parseFrontmatter(text);
    if (!fm) continue;
    const isEntity = fm.type === 'entity';
    const hasAliases = Array.isArray(fm.aliases) && fm.aliases.length > 0;
    if (!isEntity && !hasAliases) continue;
    out.push({
      name: deriveName(file, fm),
      aliases: Array.isArray(fm.aliases) ? fm.aliases : [],
      disambiguator: Array.isArray(fm.disambiguator) ? fm.disambiguator : [],
      file: relative(workspaceDir, file).replace(/^user-data\/memory\//, ''),
      section: null,
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export function renderEntitiesMarkdown(entities, opts = {}) {
  const generated = opts.generated ?? new Date().toISOString();
  const lines = [
    '---',
    'description: Auto-generated entity index for fast recall lookup',
    'type: reference',
    `generated: ${generated}`,
    '---',
    '# Entities',
    '',
    DO_NOT_EDIT_MARKER,
    '',
  ];
  for (const e of entities) {
    const aliases = e.aliases.length ? ` (${e.aliases.join(', ')})` : '';
    const section = e.section ? `#${e.section.toLowerCase().replace(/\s+/g, '-')}` : '';
    lines.push(`- ${e.name}${aliases} — ${e.file}${section}`);
  }
  lines.push('');
  return lines.join('\n');
}

function hashContent(content) {
  return createHash('sha256').update(content).digest('hex');
}

export function writeEntitiesAtomic(workspaceDir, entities, opts = {}) {
  const hotCap = opts.hotCap ?? 150;
  const generated = opts.generated ?? new Date().toISOString();
  const hot = entities.slice(0, hotCap);
  const extended = entities.slice(hotCap);

  const hotMd = renderEntitiesMarkdown(hot, { generated });
  atomicWrite(join(workspaceDir, ENTITIES_FILE), hotMd);
  atomicWrite(join(workspaceDir, HASH_FILE), hashContent(hotMd));

  if (extended.length > 0) {
    const extMd = renderEntitiesMarkdown(extended, { generated });
    atomicWrite(join(workspaceDir, EXTENDED_FILE), extMd);
  }
}

export function readEntities(workspaceDir) {
  const file = join(workspaceDir, ENTITIES_FILE);
  if (!existsSync(file)) return { entities: [], extended: 0 };
  const text = readFileSync(file, 'utf8');
  const entities = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^- (.+?)(?: \((.+?)\))? — (.+)$/);
    if (m) {
      entities.push({
        name: m[1],
        aliases: m[2] ? m[2].split(', ') : [],
        file: m[3].split('#')[0],
        section: m[3].split('#')[1] ?? null,
      });
    }
  }
  return { entities, extended: existsSync(join(workspaceDir, EXTENDED_FILE)) ? 1 : 0 };
}

export function detectUserEdit(workspaceDir) {
  const file = join(workspaceDir, ENTITIES_FILE);
  const hashFile = join(workspaceDir, HASH_FILE);
  if (!existsSync(file) || !existsSync(hashFile)) return false;
  const stored = readFileSync(hashFile, 'utf8').trim();
  const current = hashContent(readFileSync(file, 'utf8'));
  return stored !== current;
}
```

- [ ] **Step 4: Run test, verify pass**

Run: `node --test system/tests/entity-index.test.js`
Expected: PASS — 7 tests green.

- [ ] **Step 5: Commit**

```bash
git add system/scripts/memory/lib/entity-index.js system/tests/entity-index.test.js
git commit -m "feat(memory/recall): ENTITIES.md generation lib (atomic + edit-detect)"
```

---

## Task 6: `index-entities.js` — bootstrap + regenerate CLI

**Files:**
- Create: `system/scripts/memory/index-entities.js`
- Test: `system/tests/index-entities.test.js`

- [ ] **Step 1: Write failing tests**

```javascript
// system/tests/index-entities.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const SCRIPT = join(REPO_ROOT, 'system/scripts/memory/index-entities.js');

function setup() {
  const ws = mkdtempSync(join(tmpdir(), 'index-entities-'));
  mkdirSync(join(ws, 'user-data/memory/profile'), { recursive: true });
  mkdirSync(join(ws, 'user-data/state'), { recursive: true });
  writeFileSync(join(ws, 'user-data/memory/profile/dentist.md'),
    '---\ntype: entity\nallies: []\naliases: [Park]\n---\n# Dr. Park\n');
  return ws;
}

function run(ws, args) {
  return spawnSync('node', [SCRIPT, ...args], { cwd: ws, encoding: 'utf8', env: { ...process.env, ROBIN_WORKSPACE: ws } });
}

describe('index-entities CLI', () => {
  it('--regenerate writes ENTITIES.md', () => {
    const ws = setup();
    const r = run(ws, ['--regenerate']);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(existsSync(join(ws, 'user-data/memory/ENTITIES.md')));
  });

  it('--regenerate is idempotent (no-op when content unchanged)', () => {
    const ws = setup();
    run(ws, ['--regenerate']);
    const stat1 = readFileSync(join(ws, 'user-data/state/entities-hash.txt'), 'utf8');
    run(ws, ['--regenerate']);
    const stat2 = readFileSync(join(ws, 'user-data/state/entities-hash.txt'), 'utf8');
    assert.equal(stat1, stat2);
  });

  it('--regenerate aborts when user edited ENTITIES.md', () => {
    const ws = setup();
    run(ws, ['--regenerate']);
    const file = join(ws, 'user-data/memory/ENTITIES.md');
    writeFileSync(file, readFileSync(file, 'utf8') + '\n- Manual entry — x.md\n');
    const r = run(ws, ['--regenerate']);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /user-edited/i);
  });

  it('--bootstrap reports files needing aliases', () => {
    const ws = setup();
    const r = run(ws, ['--bootstrap']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Indexed/);
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `node --test system/tests/index-entities.test.js`
Expected: FAIL — script not found.

- [ ] **Step 3: Implement `index-entities.js`**

```javascript
#!/usr/bin/env node
// system/scripts/memory/index-entities.js
//
// Generates user-data/memory/ENTITIES.md from topic-file frontmatter.
//
// Modes:
//   --regenerate   refresh ENTITIES.md if content changed (Dream Phase 4.17.6)
//   --bootstrap    one-shot at install/upgrade; prints aliases backfill report
//   --json         machine-readable status for scripting

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectEntities, writeEntitiesAtomic, detectUserEdit, readEntities } from './lib/entity-index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');

function parseArgs(argv) {
  const args = { mode: null, json: false };
  for (const a of argv.slice(2)) {
    if (a === '--regenerate') args.mode = 'regenerate';
    else if (a === '--bootstrap') args.mode = 'bootstrap';
    else if (a === '--json') args.json = true;
  }
  return args;
}

function main() {
  const ws = process.env.ROBIN_WORKSPACE || REPO_ROOT;
  const args = parseArgs(process.argv);

  if (args.mode === 'regenerate') {
    if (detectUserEdit(ws)) {
      process.stderr.write(
        'index-entities: ENTITIES.md was user-edited since last regenerate; aborting to preserve manual changes. ' +
        'Restore the auto-generated content (or delete it) before retrying.\n',
      );
      process.exit(2);
    }
    const entities = collectEntities(ws);
    writeEntitiesAtomic(ws, entities);
    if (args.json) process.stdout.write(JSON.stringify({ entities: entities.length }) + '\n');
    else process.stdout.write(`Regenerated ENTITIES.md: ${entities.length} entities.\n`);
    process.exit(0);
  }

  if (args.mode === 'bootstrap') {
    const entities = collectEntities(ws);
    writeEntitiesAtomic(ws, entities);
    const noAlias = entities.filter((e) => e.aliases.length === 0).map((e) => e.file);
    process.stdout.write(`Indexed ${entities.length} entities.\n`);
    if (noAlias.length > 0) {
      process.stdout.write(`${noAlias.length} files would benefit from explicit \`aliases:\` frontmatter:\n`);
      for (const f of noAlias.slice(0, 20)) process.stdout.write(`  - ${f}\n`);
      if (noAlias.length > 20) process.stdout.write(`  ... and ${noAlias.length - 20} more\n`);
    }
    process.exit(0);
  }

  process.stderr.write('Usage: index-entities.js [--regenerate|--bootstrap] [--json]\n');
  process.exit(1);
}

main();
```

- [ ] **Step 4: Run test, verify pass**

Run: `node --test system/tests/index-entities.test.js`
Expected: PASS — 4 tests green.

- [ ] **Step 5: Commit**

```bash
git add system/scripts/memory/index-entities.js system/tests/index-entities.test.js
git commit -m "feat(memory/recall): index-entities CLI (bootstrap + regenerate)"
```

---

## Task 7: `bin/robin.js recall` subcommand

**Files:**
- Modify: `bin/robin.js`

- [ ] **Step 1: Inspect current `bin/robin.js` to understand subcommand pattern**

Run: `head -80 bin/robin.js`

Expected: A switch/dispatcher on `process.argv[2]`. Note the pattern (e.g., `case 'jobs': ...`).

- [ ] **Step 2: Add `recall` case to the dispatcher**

In `bin/robin.js`, add the import near the top:

```javascript
import { recall, formatRecallHits } from '../system/scripts/memory/lib/recall.js';
```

Add the new case to the dispatcher (near other top-level subcommands):

```javascript
case 'recall': {
  const query = process.argv.slice(3);
  if (query.length === 0) {
    console.error('Usage: robin recall <term> [<term> ...]');
    process.exit(1);
  }
  const wantsJson = query[0] === '--json' && query.shift();
  const result = recall(process.cwd(), query);
  if (wantsJson) {
    console.log(JSON.stringify(result));
  } else {
    const formatted = formatRecallHits(result);
    if (formatted) console.log(formatted);
    else console.log('No matches.');
  }
  break;
}
```

- [ ] **Step 3: Manual smoke test from a memory-bearing workspace**

Run (from `~/workspace/robin/robin-assistant`):
```sh
node bin/robin.js recall Park
```

Expected: lists hits across `user-data/memory/` (or "No matches." if Park isn't in current memory).

Run:
```sh
node bin/robin.js recall --json Park
```

Expected: JSON `{"hits":[...],"truncated":false}`.

- [ ] **Step 4: Commit**

```bash
git add bin/robin.js
git commit -m "feat(memory/recall): bin/robin.js recall subcommand"
```

---

## Task 8: PreToolUse — write-intent logging

**Files:**
- Modify: `system/scripts/hooks/claude-code.js` (extend `--on-pre-tool-use` and `--on-pre-bash`)
- Test: `system/tests/claude-code-hook-capture.test.js` (new)

- [ ] **Step 1: Write failing test for the new logging behavior**

```javascript
// system/tests/claude-code-hook-capture.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const HOOK = join(REPO_ROOT, 'system', 'scripts', 'claude-code-hook.js');

function makeWs() {
  const ws = mkdtempSync(join(tmpdir(), 'cc-hook-cap-'));
  mkdirSync(join(ws, 'user-data/state'), { recursive: true });
  mkdirSync(join(ws, 'user-data/memory'), { recursive: true });
  writeFileSync(join(ws, 'user-data/memory/inbox.md'), '');
  writeFileSync(join(ws, 'user-data/state/turn.json'),
    JSON.stringify({ turn_id: 't1', user_words: 30, tier: 3, entities_matched: [] }));
  return ws;
}

function runHook(ws, args, stdin = '') {
  return spawnSync('node', [HOOK, ...args], {
    cwd: ws,
    encoding: 'utf8',
    input: stdin,
    env: { ...process.env, ROBIN_WORKSPACE: ws },
  });
}

describe('PreToolUse write-intent logging', () => {
  it('appends to turn-writes.log when Edit targets user-data/memory/', () => {
    const ws = makeWs();
    const event = JSON.stringify({
      tool_name: 'Edit',
      tool_input: { file_path: join(ws, 'user-data/memory/inbox.md'), new_string: 'hello' },
    });
    const r = runHook(ws, ['--on-pre-tool-use'], event);
    assert.equal(r.exit ?? r.status, 0, r.stderr);
    const log = readFileSync(join(ws, 'user-data/state/turn-writes.log'), 'utf8');
    assert.match(log, /\tt1\t/);
    assert.match(log, /inbox\.md/);
    assert.match(log, /\tEdit\n/);
  });

  it('does NOT log writes outside user-data/memory/', () => {
    const ws = makeWs();
    const event = JSON.stringify({
      tool_name: 'Edit',
      tool_input: { file_path: join(ws, 'user-data/state/something.md'), new_string: 'x' },
    });
    runHook(ws, ['--on-pre-tool-use'], event);
    assert.equal(existsSync(join(ws, 'user-data/state/turn-writes.log')), false);
  });

  it('logs Bash redirections to user-data/memory/', () => {
    const ws = makeWs();
    const event = JSON.stringify({
      tool_name: 'Bash',
      tool_input: { command: 'echo "[fact] x" >> user-data/memory/inbox.md' },
    });
    const r = runHook(ws, ['--on-pre-bash'], event);
    assert.equal(r.status, 0, r.stderr);
    const log = readFileSync(join(ws, 'user-data/state/turn-writes.log'), 'utf8');
    assert.match(log, /\tt1\t/);
    assert.match(log, /\tbash\n/);
  });

  it('still blocks PII writes (existing behavior unchanged)', () => {
    const ws = makeWs();
    const event = JSON.stringify({
      tool_name: 'Write',
      tool_input: {
        file_path: join(ws, 'user-data/memory/inbox.md'),
        content: 'SSN 123-45-6789',
      },
    });
    const r = runHook(ws, ['--on-pre-tool-use'], event);
    // PII detection blocks before write-intent logging runs
    assert.equal(r.status, 2);
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `node --test system/tests/claude-code-hook-capture.test.js`
Expected: FAIL — write-intent log not created (existing hook doesn't log).

- [ ] **Step 3: Extend `claude-code-hook.js` PreToolUse handlers**

Open `system/scripts/hooks/claude-code.js`. At the top, add to existing imports:

```javascript
import { readTurnJson, appendWriteIntent } from './lib/turn-state.js';
```

In `onPreToolUse`, after the existing PII / high-stakes audit logic but before `process.exit(0)` at the end (only on the allow path), add:

```javascript
  // Cycle-3: write-intent log for capture enforcement.
  if (isMemoryWrite) {
    try {
      const turn = readTurnJson(ws);
      if (turn?.turn_id) {
        appendWriteIntent(ws, {
          turn_id: turn.turn_id,
          target: target.replace(/^.*user-data\/memory\//, 'user-data/memory/'),
          tool: toolName,
        });
      }
    } catch { /* fail-open */ }
  }

  process.exit(0);
```

For the `onPreBash` handler (separate function — read existing implementation first to find where the allow-path exit is), add a new check before allow-exit:

```javascript
  // Cycle-3: write-intent log for Bash redirections to user-data/memory/.
  try {
    const memWriteRe = />>?\s*[^\s]*user-data\/memory\//;
    if (memWriteRe.test(command)) {
      const turn = readTurnJson(ws);
      if (turn?.turn_id) {
        const m = command.match(/(user-data\/memory\/[^\s;|&)]+)/);
        appendWriteIntent(ws, {
          turn_id: turn.turn_id,
          target: m?.[1] ?? 'user-data/memory/',
          tool: 'bash',
        });
      }
    }
  } catch { /* fail-open */ }
```

Also ensure `ws` is computed in `onPreBash` the same way it is in `onPreToolUse` (`process.env.ROBIN_WORKSPACE || REPO_ROOT`).

- [ ] **Step 4: Run new tests, verify pass**

Run: `node --test system/tests/claude-code-hook-capture.test.js`
Expected: PASS — 4 tests green.

- [ ] **Step 5: Run existing hook tests to ensure no regression**

Run: `node --test system/tests/claude-code-hook.test.js system/tests/claude-code-hook-bash.test.js`
Expected: all existing tests still PASS.

- [ ] **Step 6: Commit**

```bash
git add system/scripts/hooks/claude-code.js system/tests/claude-code-hook-capture.test.js
git commit -m "feat(memory/capture): PreToolUse write-intent logging"
```

---

## Task 9: UserPromptSubmit handler

**Files:**
- Modify: `system/scripts/hooks/claude-code.js`
- Test: `system/tests/claude-code-hook-capture.test.js` (extend)

- [ ] **Step 1: Add tests for UserPromptSubmit**

Append to `system/tests/claude-code-hook-capture.test.js`:

```javascript
describe('UserPromptSubmit handler', () => {
  it('writes turn.json with computed tier on substantive message', () => {
    const ws = mkdtempSync(join(tmpdir(), 'cc-hook-ups-'));
    mkdirSync(join(ws, 'user-data/state'), { recursive: true });
    mkdirSync(join(ws, 'user-data/memory'), { recursive: true });
    mkdirSync(join(ws, 'user-data/state/sessions.md').replace(/\/[^/]+$/, ''), { recursive: true });
    writeFileSync(join(ws, 'user-data/state/sessions.md'),
      `| claude-code-abc | ${new Date().toISOString()} |\n`);

    const event = JSON.stringify({
      session_id: 'claude-code-abc',
      user_message: 'Remember that my new dentist is Dr. Park in Hoboken',
    });
    const r = runHook(ws, ['--on-user-prompt-submit'], event);
    assert.equal(r.status, 0, r.stderr);
    const turn = JSON.parse(readFileSync(join(ws, 'user-data/state/turn.json'), 'utf8'));
    assert.equal(turn.tier, 3);
    assert.ok(turn.turn_id.startsWith('claude-code-abc:'));
  });

  it('writes turn.json with tier 1 on trivial message', () => {
    const ws = mkdtempSync(join(tmpdir(), 'cc-hook-ups-'));
    mkdirSync(join(ws, 'user-data/state'), { recursive: true });
    mkdirSync(join(ws, 'user-data/memory'), { recursive: true });
    writeFileSync(join(ws, 'user-data/state/sessions.md'),
      `| claude-code-x | ${new Date().toISOString()} |\n`);
    const event = JSON.stringify({ session_id: 'claude-code-x', user_message: 'thanks' });
    const r = runHook(ws, ['--on-user-prompt-submit'], event);
    assert.equal(r.status, 0);
    const turn = JSON.parse(readFileSync(join(ws, 'user-data/state/turn.json'), 'utf8'));
    assert.equal(turn.tier, 1);
  });

  it('emits relevant-memory block when entity in ENTITIES.md matches', () => {
    const ws = mkdtempSync(join(tmpdir(), 'cc-hook-ups-'));
    mkdirSync(join(ws, 'user-data/state'), { recursive: true });
    mkdirSync(join(ws, 'user-data/memory/profile'), { recursive: true });
    writeFileSync(join(ws, 'user-data/state/sessions.md'),
      `| claude-code-x | ${new Date().toISOString()} |\n`);
    writeFileSync(join(ws, 'user-data/memory/ENTITIES.md'),
      '---\ntype: reference\n---\n# Entities\n\n- Dr. Park (Park) — profile/dentist.md\n');
    writeFileSync(join(ws, 'user-data/memory/profile/dentist.md'),
      '---\nlast_verified: 2026-01\n---\n# Dr. Park\nDentist, JC.\n');
    const event = JSON.stringify({
      session_id: 'claude-code-x',
      user_message: 'I have a meeting with Dr. Park tomorrow at 3pm please remind me',
    });
    const r = runHook(ws, ['--on-user-prompt-submit'], event);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /<!-- relevant memory/);
    assert.match(r.stdout, /Dr\. Park/);
    assert.match(r.stdout, /profile\/dentist\.md/);
  });

  it('fails open within 80ms hard timeout', { timeout: 2000 }, () => {
    const ws = mkdtempSync(join(tmpdir(), 'cc-hook-ups-'));
    mkdirSync(join(ws, 'user-data/state'), { recursive: true });
    mkdirSync(join(ws, 'user-data/memory'), { recursive: true });
    // Don't seed sessions.md → mostRecentSessionId returns null. Hook should still pass.
    const event = JSON.stringify({ session_id: 'claude-code-zzz', user_message: 'hello world test' });
    const r = runHook(ws, ['--on-user-prompt-submit'], event);
    assert.equal(r.status, 0);
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `node --test system/tests/claude-code-hook-capture.test.js`
Expected: new tests FAIL — `--on-user-prompt-submit` mode unknown.

- [ ] **Step 3: Implement the handler**

In `system/scripts/hooks/claude-code.js`, add to imports:

```javascript
import { mintTurnId, writeTurnJson } from './lib/turn-state.js';
import { appendPerfLog } from './lib/perf-log.js';
import { classifyTier, scanEntityAliases } from './lib/capture-keyword-scan.js';
import { readEntities } from './lib/entity-index.js';
import { recall, formatRecallHits } from './lib/recall.js';
```

Extend `parseArgs` to recognize the new mode:

```javascript
else if (a === '--on-user-prompt-submit') args.mode = 'on-user-prompt-submit';
```

Add a switch entry (or `if`-chain entry) in `main()` invoking a new handler:

```javascript
if (args.mode === 'on-user-prompt-submit') return onUserPromptSubmit(args);
```

Implement `onUserPromptSubmit`:

```javascript
async function onUserPromptSubmit(args) {
  const ws = args.workspace ?? process.env.ROBIN_WORKSPACE ?? REPO_ROOT;
  const start = Date.now();
  try {
    const stdin = await readStdin();
    let event = {};
    try { event = JSON.parse(stdin); } catch { /* fail-open */ }

    const sessionId = event.session_id ?? mostRecentSessionId(ws, 'claude-code') ?? 'unknown';
    const userMessage = event.user_message ?? event.prompt ?? '';

    const { entities: entityList } = readEntities(ws);
    const aliasIndex = [];
    for (const e of entityList) {
      aliasIndex.push(e.name);
      for (const a of e.aliases) aliasIndex.push(a);
    }

    const tierResult = classifyTier({ userMessage, entityAliases: aliasIndex });

    const turnId = mintTurnId(sessionId);
    writeTurnJson(ws, {
      turn_id: turnId,
      user_words: tierResult.wc,
      tier: tierResult.tier,
      entities_matched: tierResult.entitiesMatched,
    });

    if (tierResult.entitiesMatched.length > 0) {
      const matchedEntities = entityList
        .filter((e) => tierResult.entitiesMatched.includes(e.name) || e.aliases.some((a) => tierResult.entitiesMatched.includes(a)))
        .slice(0, 5);
      const patterns = matchedEntities.flatMap((e) => [e.name, ...e.aliases]);
      const r = recall(ws, patterns, { topN: matchedEntities.length * 3 });
      const formatted = formatRecallHits(r);
      if (formatted) {
        process.stdout.write(`<!-- relevant memory (auto-loaded based on entities in your message) -->\n${formatted}\n<!-- /relevant memory -->\n`);
      }
    }

    const elapsed = Date.now() - start;
    if (elapsed > 80) {
      appendPerfLog(ws, { hook: 'UserPromptSubmit', duration_ms: elapsed, reason: 'slow' });
    }
    process.exit(0);
  } catch (err) {
    try { appendPerfLog(ws, { hook: 'UserPromptSubmit', duration_ms: Date.now() - start, reason: `error:${err.message}` }); } catch { /* */ }
    process.exit(0); // fail-open
  }
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `node --test system/tests/claude-code-hook-capture.test.js`
Expected: all tests PASS, including the new UserPromptSubmit ones.

- [ ] **Step 5: Run full hook test suite for regression**

Run: `node --test system/tests/claude-code-hook.test.js system/tests/claude-code-hook-bash.test.js system/tests/claude-code-hook-capture.test.js`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add system/scripts/hooks/claude-code.js system/tests/claude-code-hook-capture.test.js
git commit -m "feat(memory/capture+recall): UserPromptSubmit handler (turn-state + auto-recall)"
```

---

## Task 10: Stop hook `verifyCapture` integration

**Files:**
- Modify: `system/scripts/hooks/claude-code.js`
- Test: `system/tests/claude-code-hook-capture.test.js` (extend)

- [ ] **Step 1: Add tests for verifyCapture**

Append to `system/tests/claude-code-hook-capture.test.js`:

```javascript
describe('Stop verifyCapture', () => {
  function setupTier3WithoutCapture() {
    const ws = mkdtempSync(join(tmpdir(), 'cc-hook-stop-'));
    mkdirSync(join(ws, 'user-data/state'), { recursive: true });
    mkdirSync(join(ws, 'user-data/memory/self-improvement'), { recursive: true });
    writeFileSync(join(ws, 'user-data/state/sessions.md'),
      `| claude-code-x | ${new Date().toISOString()} |\n`);
    writeFileSync(join(ws, 'user-data/memory/inbox.md'), '');
    writeFileSync(join(ws, 'user-data/state/turn.json'),
      JSON.stringify({ turn_id: 'claude-code-x:111', user_words: 25, tier: 3, entities_matched: [] }));
    return ws;
  }

  it('blocks (exit 2) when tier 3, no capture, no marker, retries available', () => {
    const ws = setupTier3WithoutCapture();
    // No transcript file — fall through to retry budget.
    const event = JSON.stringify({ session_id: 'claude-code-x' });
    const r = runHook(ws, ['--on-stop'], event);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /Capture before ending/);
  });

  it('passes (exit 0) when tier 3 + write-intent recorded', () => {
    const ws = setupTier3WithoutCapture();
    writeFileSync(join(ws, 'user-data/state/turn-writes.log'),
      `${new Date().toISOString()}\tclaude-code-x:111\tuser-data/memory/inbox.md\tEdit\n`);
    const event = JSON.stringify({ session_id: 'claude-code-x' });
    const r = runHook(ws, ['--on-stop'], event);
    assert.equal(r.status, 0, r.stderr);
  });

  it('passes (exit 0) when no-capture-needed marker found in transcript', () => {
    const ws = setupTier3WithoutCapture();
    const tx = join(ws, 'transcript.jsonl');
    writeFileSync(tx, JSON.stringify({ role: 'assistant', content: 'all done <!-- no-capture-needed: pure refactor of internal helper --> ok' }) + '\n');
    const event = JSON.stringify({ session_id: 'claude-code-x', transcript_path: tx });
    const r = runHook(ws, ['--on-stop'], event);
    assert.equal(r.status, 0, r.stderr);
  });

  it('passes (exit 0) on tier 1 trivial turn with no capture', () => {
    const ws = setupTier3WithoutCapture();
    writeFileSync(join(ws, 'user-data/state/turn.json'),
      JSON.stringify({ turn_id: 'claude-code-x:222', user_words: 2, tier: 1, entities_matched: [] }));
    const event = JSON.stringify({ session_id: 'claude-code-x' });
    const r = runHook(ws, ['--on-stop'], event);
    assert.equal(r.status, 0, r.stderr);
  });

  it('passes (exit 0) after retry budget exhausted', () => {
    const ws = setupTier3WithoutCapture();
    writeFileSync(join(ws, 'user-data/state/capture-retry.json'),
      JSON.stringify({ 'claude-code-x:111': { attempts: 1, last_at: new Date().toISOString() } }));
    const event = JSON.stringify({ session_id: 'claude-code-x' });
    const r = runHook(ws, ['--on-stop'], event);
    assert.equal(r.status, 0);
  });

  it('passes (exit 0) and skips enforcement when ROBIN_CAPTURE_ENFORCEMENT=off', () => {
    const ws = setupTier3WithoutCapture();
    const r = spawnSync('node', [HOOK, '--on-stop'], {
      cwd: ws, encoding: 'utf8',
      input: JSON.stringify({ session_id: 'claude-code-x' }),
      env: { ...process.env, ROBIN_WORKSPACE: ws, ROBIN_CAPTURE_ENFORCEMENT: 'off' },
    });
    assert.equal(r.status, 0);
  });

  it('appends a telemetry line per outcome', () => {
    const ws = setupTier3WithoutCapture();
    writeFileSync(join(ws, 'user-data/state/turn-writes.log'),
      `${new Date().toISOString()}\tclaude-code-x:111\tuser-data/memory/inbox.md\tEdit\n`);
    const event = JSON.stringify({ session_id: 'claude-code-x' });
    runHook(ws, ['--on-stop'], event);
    const log = readFileSync(join(ws, 'user-data/state/capture-enforcement.log'), 'utf8');
    assert.match(log, /captured/);
    assert.match(log, /claude-code-x:111/);
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `node --test system/tests/claude-code-hook-capture.test.js`
Expected: new Stop tests FAIL.

- [ ] **Step 3: Implement `verifyCapture` and integrate into `onStop`**

In `system/scripts/hooks/claude-code.js`, add to imports:

```javascript
import { readWriteIntents, pruneWriteIntents, readRetry, incrementRetry } from './lib/turn-state.js';
import { appendFileSync, statSync as _statSync } from 'node:fs';
```

Add a constant for the corrective stderr message:

```javascript
const CORRECTIVE_MSG =
  'Capture before ending the turn. Either (a) write a tagged line to user-data/memory/inbox.md per AGENTS.md capture-rules, or (b) emit "<!-- no-capture-needed: <one-line reason> -->" if nothing in this turn warrants capture. This is enforced; second pass is allowed once.\n';
```

Add config helper:

```javascript
function captureEnforcementEnabled(ws) {
  if ((process.env.ROBIN_CAPTURE_ENFORCEMENT ?? '').toLowerCase() === 'off') return false;
  try {
    const cfg = JSON.parse(readFileSync(join(ws, 'user-data/robin.config.json'), 'utf8'));
    return cfg?.memory?.capture_enforcement?.enabled !== false;
  } catch {
    return true; // default on
  }
}

function readRetryBudget(ws) {
  try {
    const cfg = JSON.parse(readFileSync(join(ws, 'user-data/robin.config.json'), 'utf8'));
    return cfg?.memory?.capture_enforcement?.retry_budget ?? 1;
  } catch { return 1; }
}
```

Add transcript-tail scanner:

```javascript
function tailScanForNoCaptureMarker(transcriptPath, maxBytes = 16 * 1024) {
  if (!transcriptPath || !existsSync(transcriptPath)) return null;
  try {
    const fd = readFileSync(transcriptPath); // for tests, simple read; OK for <few MB
    const buf = fd.length > maxBytes ? fd.subarray(fd.length - maxBytes) : fd;
    const text = buf.toString('utf8');
    const m = text.match(/<!--\s*no-capture-needed:\s*([^>]+?)\s*-->/);
    return m ? { reason: m[1].trim() } : null;
  } catch {
    return null;
  }
}
```

Add `verifyCapture` function:

```javascript
function appendEnforcementLog(ws, line) {
  try {
    const file = join(ws, 'user-data/state/capture-enforcement.log');
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, line);
  } catch { /* best-effort */ }
}

async function verifyCapture(ws, event) {
  if (!captureEnforcementEnabled(ws)) return { allow: true, outcome: 'disabled' };

  const turn = readTurnJson(ws);
  if (!turn?.turn_id) return { allow: true, outcome: 'no-turn-state' };

  if (turn.tier === 1) return { allow: true, outcome: 'skipped-trivial', turnId: turn.turn_id, tier: 1 };

  const intents = readWriteIntents(ws, turn.turn_id);
  if (intents.length > 0) return { allow: true, outcome: 'captured', turnId: turn.turn_id, tier: turn.tier };

  const marker = tailScanForNoCaptureMarker(event?.transcript_path);
  const tier = turn.tier;
  if (marker) {
    if (tier === 2 || (tier === 3 && marker.reason && marker.reason.length > 0)) {
      return { allow: true, outcome: 'marker-pass', turnId: turn.turn_id, tier };
    }
  }

  const budget = readRetryBudget(ws);
  const attempts = readRetry(ws, turn.turn_id);
  if (attempts < budget) {
    incrementRetry(ws, turn.turn_id);
    return { allow: false, outcome: 'retried', turnId: turn.turn_id, tier };
  }
  return { allow: true, outcome: 'retried-failed', turnId: turn.turn_id, tier };
}
```

Modify `onStop` to call `verifyCapture` first:

```javascript
async function onStop(args) {
  const ws = args.workspace ?? process.env.ROBIN_WORKSPACE ?? REPO_ROOT;

  // Read event from stdin (Claude Code passes session_id, transcript_path, ...).
  let event = {};
  try {
    const stdin = await readStdin();
    if (stdin) event = JSON.parse(stdin);
  } catch { /* keep event = {} */ }

  // Capture verification — gate before any other Stop-time work.
  let verifyResult = { allow: true, outcome: 'error' };
  try {
    verifyResult = await verifyCapture(ws, event);
  } catch { /* fail-open */ }

  appendEnforcementLog(ws,
    `${new Date().toISOString()}\t${verifyResult.turnId ?? '-'}\t${verifyResult.tier ?? '-'}\t${verifyResult.outcome}\n`);

  if (!verifyResult.allow) {
    process.stderr.write(CORRECTIVE_MSG);
    process.exit(2);
  }

  // Prune turn-writes.log to last hour.
  try { pruneWriteIntents(ws); } catch { /* */ }

  // ... existing writeAutoLine + drain logic stays exactly as is ...
```

Also: `onStop` previously did not consume stdin. Confirm `readStdin()` is non-blocking on no-input (it is, returns empty string). If existing `onStop` lacks stdin reading, only add the new `event = JSON.parse(stdin)` block — keep all other behavior identical.

- [ ] **Step 4: Run new tests, verify pass**

Run: `node --test system/tests/claude-code-hook-capture.test.js`
Expected: PASS.

- [ ] **Step 5: Run all hook tests for regression**

Run: `node --test system/tests/claude-code-hook.test.js system/tests/claude-code-hook-bash.test.js system/tests/claude-code-hook-capture.test.js`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add system/scripts/hooks/claude-code.js system/tests/claude-code-hook-capture.test.js
git commit -m "feat(memory/capture): Stop hook verifyCapture (hard wall + retry + telemetry)"
```

---

## Task 11: Register UserPromptSubmit hook + extend manifest

**Files:**
- Modify: `.claude/settings.json`
- Modify: `user-data/security/manifest.json` (Kevin's local instance — not in package)

- [ ] **Step 1: Inspect current `.claude/settings.json`**

Run: `cat .claude/settings.json`
Confirm shape: `{ "hooks": { "PreToolUse": [...], "Stop": [...], "SessionStart": [...] } }`.

- [ ] **Step 2: Add `UserPromptSubmit` hook entry**

Edit `.claude/settings.json`. Add to the `hooks` object (preserve existing entries):

```json
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node system/scripts/hooks/claude-code.js --on-user-prompt-submit"
          }
        ]
      }
    ]
```

- [ ] **Step 3: Re-snapshot the manifest**

Run:
```sh
node system/scripts/manifest-snapshot.js --apply --confirm-trust-current-state
```
Expected: writes updated `user-data/security/manifest.json` including the new `UserPromptSubmit` hook.

- [ ] **Step 4: Verify SessionStart manifest check passes**

Run:
```sh
node system/scripts/check-manifest.js
```
Expected: exit 0, no drift reported.

- [ ] **Step 5: Commit `.claude/settings.json` only (manifest.json is in user-data/, gitignored)**

```bash
git add .claude/settings.json
git commit -m "feat(memory/capture): register UserPromptSubmit hook in .claude/settings.json"
```

---

## Task 12: Skeleton config + migration

**Files:**
- Modify: `system/skeleton/robin.config.json`
- Create: `system/migrations/0009-capture-enforcement-config.js` (verify migrations dir exists; if not, create it)
- Test: ad hoc by running migration in a temp config

- [ ] **Step 1: Inspect existing migrations dir + the current skeleton config**

Run: `ls system/migrations/ 2>/dev/null; cat system/skeleton/robin.config.json`
Note: existing migrations should reveal the migration script signature and how they're invoked from `migrate.js`.

- [ ] **Step 2: Add `memory.capture_enforcement` to skeleton config**

Edit `system/skeleton/robin.config.json`. In the `memory` block, add:

```json
    "capture_enforcement": {
      "enabled": true,
      "min_user_words_tier2": 5,
      "min_user_words_tier3": 20,
      "retry_budget": 1
    }
```

So the file becomes:
```json
{
  "version": "3.0.0",
  ...
  "memory": {
    "split_threshold_lines": 200,
    "graph_exclude": ["knowledge/finance/lunch-money/transactions"],
    "startup_budget_lines": 500,
    "capture_enforcement": {
      "enabled": true,
      "min_user_words_tier2": 5,
      "min_user_words_tier3": 20,
      "retry_budget": 1
    }
  }
}
```

- [ ] **Step 3: Write migration script**

Create `system/migrations/0009-capture-enforcement-config.js` (match the pattern of any existing migration in that directory; if there are none, base this on the example below):

```javascript
// system/migrations/0009-capture-enforcement-config.js
//
// Adds memory.capture_enforcement block to existing user-data/robin.config.json
// for users upgrading from <previous version>.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const id = '0009-capture-enforcement-config';
export const description = 'Add memory.capture_enforcement defaults to robin.config.json';

export async function up(workspaceDir) {
  const file = join(workspaceDir, 'user-data/robin.config.json');
  if (!existsSync(file)) return { changed: false };
  const cfg = JSON.parse(readFileSync(file, 'utf8'));
  cfg.memory ??= {};
  if (cfg.memory.capture_enforcement) return { changed: false };
  cfg.memory.capture_enforcement = {
    enabled: true,
    min_user_words_tier2: 5,
    min_user_words_tier3: 20,
    retry_budget: 1,
  };
  writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
  return { changed: true };
}
```

If existing migrations use a different signature (e.g., a class, a different export), match theirs instead.

- [ ] **Step 4: Manually verify migration runs cleanly on a copy**

Run:
```sh
cp user-data/robin.config.json /tmp/robin.config.json.bak
node -e "import('./system/migrations/0009-capture-enforcement-config.js').then(m => m.up(process.cwd()).then(console.log))"
diff user-data/robin.config.json /tmp/robin.config.json.bak || echo 'config updated as expected'
```

Expected: shows the new `capture_enforcement` block added.

Restore: `cp /tmp/robin.config.json.bak user-data/robin.config.json` (we'll re-run migration via the proper flow during install).

- [ ] **Step 5: Commit**

```bash
git add system/skeleton/robin.config.json system/migrations/0009-capture-enforcement-config.js
git commit -m "feat(memory/capture): config defaults + migration"
```

---

## Task 13: AGENTS.md updates

**Files:**
- Modify: `AGENTS.md`

- [ ] **Step 1: Replace "Capture checkpoint" block**

In `AGENTS.md`, locate the `## Capture checkpoint (always-on)` section. Replace its body with:

```markdown
## Capture checkpoint (always-on)

After every response, scan for capturable signals.

- **Direct-write to file** (don't just acknowledge — actually save): corrections (e.g. "stop X-ing") → append to `user-data/memory/self-improvement/corrections.md`; "remember this" → append to the relevant file + confirm; updates that supersede an in-context fact → update in place.
- **Inbox-write** with `[tag|origin=...]` to `user-data/memory/inbox.md` for everything else (Dream routes within 24h).
- **Capture is enforced at turn-end.** Either (a) write to `inbox.md` / direct-write file, or (b) emit `<!-- no-capture-needed: <one-line reason> -->` in your response. Failing both blocks turn-end with one retry.
- **Tags:** `[fact|origin=...|preference|decision|correction|task|update|derived|journal|predict|?]`. Every captured line MUST include `origin=<user|sync:X|ingest:X|tool:X|derived>`. Set `origin=user` ONLY when the line text comes from the user's own message in the current turn (verbatim or paraphrased from the user's own statements). Captures from `trust:untrusted` files or UNTRUSTED-START blocks get the matching `origin=sync|ingest|tool` value. Dishonest origin attribution is a hard-rule violation. Direct-write exceptions also gate on `origin=user`.

Routing details: `system/rules/capture.md`.
```

- [ ] **Step 2: Add recall instruction to Operational Rules**

In the `## Operational Rules` section, add a new bullet:

```markdown
- **Recall.** For questions about a specific person/thing/topic, prefer `node bin/robin.js recall <term>` over guessing if the relevant file isn't already loaded. Auto-recall context blocks (`<!-- relevant memory -->`) are pre-populated for entities mentioned in the user message — read them first.
```

- [ ] **Step 3: Update startup load order in step 4**

In `## Session Startup` step 4, change the read order from:
```
... `user-data/memory/INDEX.md`, `user-data/memory/profile/identity.md`, ...
```
to:
```
... `user-data/memory/INDEX.md`, `user-data/memory/ENTITIES.md`, `user-data/memory/profile/identity.md`, ...
```

- [ ] **Step 4: Verify AGENTS.md still parses for Hard Rules hash**

Run:
```sh
node system/scripts/manifest-snapshot.js | grep hardRulesHash
```
Compare the hash to the current `user-data/security/manifest.json` value:
```sh
grep hardRulesHash user-data/security/manifest.json
```
If they differ AND the Hard Rules block was modified (it should NOT have been in this task), revert your edits and re-do them outside the Hard Rules section. If only non-Hard-Rules sections changed, the hash should still match.

If the hash legitimately changed (e.g., we accidentally touched Hard Rules), re-snapshot:
```sh
node system/scripts/manifest-snapshot.js --apply --confirm-trust-current-state
```

- [ ] **Step 5: Commit**

```bash
git add AGENTS.md
git commit -m "docs(memory): AGENTS.md — capture enforcement + recall + ENTITIES.md startup load"
```

---

## Task 14: capture-rules.md updates

**Files:**
- Modify: `system/rules/capture.md`

- [ ] **Step 1: Drop the T1 (~20-turn) sweep section**

In `system/rules/capture.md`, locate the `## Capture sweep (safety net)` section. Remove the `**Trigger 1 — long session.**` block. Keep `**Trigger 2 — graceful session end.**` and `**Trigger 3 — Stop-hook auto-line ...**` intact. Update the surrounding prose so it reads naturally without T1.

- [ ] **Step 2: Add "Marker protocol" subsection**

After the `## Direct-write exceptions` section, add a new section:

```markdown
## Marker protocol (capture-enforcement)

Capture is enforced at end-of-turn by `system/scripts/hooks/claude-code.js --on-stop`. The hook checks whether `user-data/memory/` was written during the turn (via `user-data/state/turn-writes.log`). If not, the model must declare a waiver inline:

    <!-- no-capture-needed: <one-line reason> -->

Tier semantics (from `lib/capture-keyword-scan.js`):

- **Tier 1** (trivial — `user_words < 5` or pure greeting): no enforcement; marker not required.
- **Tier 2** (`5 ≤ user_words < 20`, no capture keywords): marker accepted with empty reason.
- **Tier 3** (`user_words ≥ 20`, OR capture keyword detected, OR entity match): marker requires a one-line reason.

If neither a write nor a marker is present and retry budget allows, the hook exits 2 with a corrective stderr message; the model receives the message and re-emits with capture or marker. Default `retry_budget: 1` (configurable in `user-data/robin.config.json` → `memory.capture_enforcement`).

Disable enforcement: `ROBIN_CAPTURE_ENFORCEMENT=off` env var, or set `enabled: false` in the config block.
```

- [ ] **Step 3: Commit**

```bash
git add system/rules/capture.md
git commit -m "docs(memory/capture): drop T1 sweep, add marker protocol section"
```

---

## Task 15: dream.md updates

**Files:**
- Modify: `system/jobs/dream.md`

- [ ] **Step 1: Add Phase 3 step 11.5 (capture + recall telemetry)**

After Phase 3 step 11 (calibration update) in `system/jobs/dream.md`, insert:

```markdown
11.5. **Capture + recall telemetry review.** Read entries from `user-data/state/capture-enforcement.log` and `user-data/state/recall.log` since `last_dream_at`. Surface in escalation report:
   - Capture enforcement misfires this period: count by outcome (retried-passed, retried-failed, marker-malformed). If retried-failed > 5 OR marker-malformed > 3, flag for prompt-tuning review.
   - Auto-recall avg injection bytes; flag if trend is rising >2× compared to prior period.
   - Frequently-matched entities that route to nothing → suggest creating a topic file.
   - Aliases skipped due to missing disambiguator → list for backfill.
```

- [ ] **Step 2: Add Phase 4 step 17.6 (ENTITIES.md regeneration)**

After Phase 4 step 17 (LINKS.md maintenance) and before step 17.5 (compact-summary regeneration), insert:

```markdown
17.6. **ENTITIES.md regeneration.** Run `node system/scripts/memory/index-entities.js --regenerate`. Idempotent — exits clean if nothing changed. If it exits 2 ("user-edited"), include the warning in the dream summary and skip; do not retry until the user resolves.
```

- [ ] **Step 3: Add Phase 4 step 17.7 (telemetry log rotation)**

After step 17.6:

```markdown
17.7. **Telemetry log rotation.** Cap each file to its limit:
   - `user-data/state/capture-enforcement.log` → 5000 lines
   - `user-data/state/recall.log` → 5000 lines
   - `user-data/state/hook-perf.log` → 1000 lines

   Use `node -e "import('./system/scripts/lib/perf-log.js').then(m => m.capPerfLog(process.cwd(), 1000))"` for hook-perf; for the other two, simple `tail -n 5000 file > file.tmp && mv file.tmp file` (atomic enough at Dream cadence).
```

- [ ] **Step 4: Commit**

```bash
git add system/jobs/dream.md
git commit -m "docs(memory): dream.md — phase 11.5 telemetry, 17.6 entities regen, 17.7 log rotation"
```

---

## Task 16: Mock hook event fixtures + sample memory tree

**Files:**
- Create: `system/tests/fixtures/mock-hook-events/user-prompt-submit.json`
- Create: `system/tests/fixtures/mock-hook-events/stop.json`
- Create: `system/tests/fixtures/mock-hook-events/pre-tool-use-write.json`
- Create: `system/tests/fixtures/mock-hook-events/pre-tool-use-bash.json`
- Create: `system/tests/fixtures/sample-memory/profile/dentist.md`
- Create: `system/tests/fixtures/sample-memory/knowledge/finance/marcus.md`

- [ ] **Step 1: Create the fixture directory**

Run: `mkdir -p system/tests/fixtures/mock-hook-events system/tests/fixtures/sample-memory/profile system/tests/fixtures/sample-memory/knowledge/finance`

- [ ] **Step 2: Write each fixture file**

`system/tests/fixtures/mock-hook-events/user-prompt-submit.json`:
```json
{"session_id":"claude-code-fixture","user_message":"Remember that my new dentist is Dr. Park in Hoboken; first appointment is on June 3rd at 2pm","transcript_path":""}
```

`system/tests/fixtures/mock-hook-events/stop.json`:
```json
{"session_id":"claude-code-fixture","transcript_path":"system/tests/fixtures/mock-hook-events/transcript-with-marker.jsonl"}
```

`system/tests/fixtures/mock-hook-events/pre-tool-use-write.json`:
```json
{"tool_name":"Write","tool_input":{"file_path":"user-data/memory/inbox.md","content":"- [fact] sample inbox entry"}}
```

`system/tests/fixtures/mock-hook-events/pre-tool-use-bash.json`:
```json
{"tool_name":"Bash","tool_input":{"command":"echo \"[fact] direct-bash entry\" >> user-data/memory/inbox.md"}}
```

`system/tests/fixtures/sample-memory/profile/dentist.md`:
```markdown
---
type: entity
description: Dr. Park — primary dentist
aliases: [Park]
last_verified: 2026-01-15
---
# Dr. Park

Dentist, Hoboken NJ. Last visit 2026-01.
```

`system/tests/fixtures/sample-memory/knowledge/finance/marcus.md`:
```markdown
---
type: entity
description: Marcus HYSA — primary savings account
aliases: [Marcus, GS HYSA]
disambiguator: [hysa, savings, account, goldman]
last_verified: 2025-11-30
---
# Marcus HYSA

Goldman Sachs Marcus HYSA. ~$10k balance. 5.0% APY.
```

- [ ] **Step 3: Commit**

```bash
git add system/tests/fixtures/mock-hook-events/ system/tests/fixtures/sample-memory/
git commit -m "test(memory): mock hook event + sample memory fixtures"
```

---

## Task 17: Integration test (golden-session capture)

**Files:**
- Create: `system/tests/golden-session-capture.test.js`

- [ ] **Step 1: Write the integration test**

```javascript
// system/tests/golden-session-capture.test.js
//
// End-to-end: simulate a 4-turn session through the hook handler and verify
// capture enforcement + auto-recall produce the right state.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const HOOK = join(REPO_ROOT, 'system', 'scripts', 'claude-code-hook.js');
const SAMPLE_MEM = join(REPO_ROOT, 'system/tests/fixtures/sample-memory');

function makeWorkspace() {
  const ws = mkdtempSync(join(tmpdir(), 'golden-cap-'));
  mkdirSync(join(ws, 'user-data/state'), { recursive: true });
  mkdirSync(join(ws, 'user-data/memory'), { recursive: true });
  cpSync(SAMPLE_MEM, join(ws, 'user-data/memory'), { recursive: true });
  writeFileSync(join(ws, 'user-data/state/sessions.md'),
    `| claude-code-golden | ${new Date().toISOString()} |\n`);
  writeFileSync(join(ws, 'user-data/memory/inbox.md'), '');
  // Generate ENTITIES.md from sample fixtures.
  spawnSync('node', [join(REPO_ROOT, 'system/scripts/memory/index-entities.js'), '--regenerate'], {
    cwd: ws, env: { ...process.env, ROBIN_WORKSPACE: ws }, encoding: 'utf8',
  });
  return ws;
}

function runHook(ws, args, stdin) {
  return spawnSync('node', [HOOK, ...args], {
    cwd: ws, encoding: 'utf8', input: stdin,
    env: { ...process.env, ROBIN_WORKSPACE: ws },
  });
}

describe('golden-session-capture (E2E)', () => {
  it('full 4-turn flow: trivial → substantive-with-capture → substantive-without → recovery', () => {
    const ws = makeWorkspace();

    // Turn 1: trivial user message → tier 1 → Stop passes immediately.
    let r = runHook(ws, ['--on-user-prompt-submit'],
      JSON.stringify({ session_id: 'claude-code-golden', user_message: 'thanks' }));
    assert.equal(r.status, 0);
    r = runHook(ws, ['--on-stop'], JSON.stringify({ session_id: 'claude-code-golden' }));
    assert.equal(r.status, 0);

    // Turn 2: substantive + entity match → auto-recall fires; PreToolUse logs Edit; Stop passes.
    r = runHook(ws, ['--on-user-prompt-submit'],
      JSON.stringify({ session_id: 'claude-code-golden',
        user_message: 'I have a meeting with Dr. Park tomorrow at 3pm please confirm the address' }));
    assert.equal(r.status, 0);
    assert.match(r.stdout, /relevant memory/);
    assert.match(r.stdout, /Dr\. Park/);

    const turn2 = JSON.parse(readFileSync(join(ws, 'user-data/state/turn.json'), 'utf8'));
    r = runHook(ws, ['--on-pre-tool-use'], JSON.stringify({
      tool_name: 'Edit',
      tool_input: { file_path: join(ws, 'user-data/memory/inbox.md'), new_string: '- [task|origin=user] confirm dentist address' },
    }));
    assert.equal(r.status, 0);
    r = runHook(ws, ['--on-stop'], JSON.stringify({ session_id: 'claude-code-golden' }));
    assert.equal(r.status, 0);

    // Turn 3: substantive, no capture, no marker → Stop blocks (exit 2).
    r = runHook(ws, ['--on-user-prompt-submit'],
      JSON.stringify({ session_id: 'claude-code-golden',
        user_message: 'I decided to switch from Vanguard to Fidelity for the new account I opened last week' }));
    assert.equal(r.status, 0);
    r = runHook(ws, ['--on-stop'], JSON.stringify({ session_id: 'claude-code-golden' }));
    assert.equal(r.status, 2);
    assert.match(r.stderr, /Capture before ending/);

    // Turn 3 retry: marker present → Stop passes.
    const turn3 = JSON.parse(readFileSync(join(ws, 'user-data/state/turn.json'), 'utf8'));
    const tx = join(ws, 'transcript.jsonl');
    writeFileSync(tx, JSON.stringify({ role: 'assistant', content: 'noted <!-- no-capture-needed: superseded by next message --> done' }) + '\n');
    r = runHook(ws, ['--on-stop'], JSON.stringify({ session_id: 'claude-code-golden', transcript_path: tx }));
    assert.equal(r.status, 0);

    // capture-enforcement.log has at least 4 outcome lines.
    const log = readFileSync(join(ws, 'user-data/state/capture-enforcement.log'), 'utf8').trim().split('\n');
    assert.ok(log.length >= 4, `expected ≥4 enforcement lines, got ${log.length}`);
    assert.ok(log.some((l) => l.includes('skipped-trivial')));
    assert.ok(log.some((l) => l.includes('captured')));
    assert.ok(log.some((l) => l.includes('retried')));
    assert.ok(log.some((l) => l.includes('marker-pass')));
  });
});
```

- [ ] **Step 2: Run the integration test**

Run: `node --test system/tests/golden-session-capture.test.js`
Expected: PASS — full 4-turn flow validates all paths.

- [ ] **Step 3: Run the entire test suite for regression**

Run: `npm test`
Expected: all tests pass (existing + new).

- [ ] **Step 4: Commit**

```bash
git add system/tests/golden-session-capture.test.js
git commit -m "test(memory): golden-session E2E for capture enforcement + auto-recall"
```

---

## Task 18: Token baselines update

**Files:**
- Modify: `system/scripts/lib/token-baselines.json`

- [ ] **Step 1: Re-baseline tokens**

Run: `npm run measure-tokens`
This regenerates `system/scripts/lib/token-baselines.json` to reflect any new files (ENTITIES.md will not exist yet on the package side; the script handles missing files).

- [ ] **Step 2: Manually verify the baseline JSON includes (or has placeholders for) the new files**

Open `system/scripts/lib/token-baselines.json`. Confirm it has entries (or skipped/optional entries) for:
- `user-data/memory/ENTITIES.md` (optional_existence: true)
- `user-data/state/capture-enforcement.log` (out of scope for token measurement, skip)

If `measure-tokens.js` doesn't already enumerate ENTITIES.md, add a one-line entry to the source list (likely in `measure-tokens.js` near other Tier-1 file paths). Match the existing pattern.

- [ ] **Step 3: Commit**

```bash
git add system/scripts/lib/token-baselines.json system/scripts/measure-tokens.js
git commit -m "chore(memory): token baselines include ENTITIES.md slot"
```

---

## Task 19: CHANGELOG entry

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Read the latest changelog format**

Run: `head -40 CHANGELOG.md` to match the existing convention.

- [ ] **Step 2: Add an entry**

At the top of `CHANGELOG.md`, add (matching existing date / heading style):

```markdown
## 2026-05-01 — Autonomous memory: capture enforcement + recall

**Capture enforcement (cycle-3a).** Stop hook now hard-walls turn-end when a
substantive turn finished without writing to `user-data/memory/`. Model must
either write a tagged line to `inbox.md` (or direct-write a file) OR emit a
`<!-- no-capture-needed: <reason> -->` marker. Bounded retry (default 1).
Disable via `ROBIN_CAPTURE_ENFORCEMENT=off` or `memory.capture_enforcement.enabled = false`.
Removes the `T1` (~20-turn) sweep instruction from `capture-rules.md` (now redundant).

**Recall (cycle-3b).** New `UserPromptSubmit` hook auto-injects relevant memory
into the model's input based on entity matches in the user message. Entities
sourced from `user-data/memory/ENTITIES.md`, generated by Dream Phase 4.17.6
from any topic file with `aliases:` frontmatter or `type: entity`. Hot-cap 150
rows; overflow → `ENTITIES-extended.md`. New `bin/robin.js recall <term>`
subcommand for ad-hoc lookup.

**No external dependencies added.** All retrieval is in-process Node-native.
No API key required.

Migration: `system/migrations/0009-capture-enforcement-config.js` adds the
config block to existing installs. Run `node system/scripts/memory/index-entities.js
--bootstrap` after upgrade to seed `ENTITIES.md`.
```

- [ ] **Step 3: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs(changelog): autonomous memory cycle-3a/3b entry"
```

---

## Task 20: Bootstrap on Kevin's instance + smoke verification

**Files:** none (runtime only)

- [ ] **Step 1: Run the config migration explicitly**

Run:
```sh
node -e "import('./system/migrations/0009-capture-enforcement-config.js').then(m => m.up(process.cwd()).then(console.log))"
```
Expected: `{ changed: true }`. Verify `user-data/robin.config.json` now contains the `memory.capture_enforcement` block.

- [ ] **Step 2: Bootstrap ENTITIES.md from existing memory**

Run:
```sh
node system/scripts/memory/index-entities.js --bootstrap
```
Expected: prints "Indexed N entities" plus a list of files needing `aliases:`. Check `user-data/memory/ENTITIES.md` exists and looks reasonable.

- [ ] **Step 3: Re-snapshot the manifest**

Run:
```sh
node system/scripts/manifest-snapshot.js --apply --confirm-trust-current-state
```
Expected: writes the updated `user-data/security/manifest.json` covering the new UserPromptSubmit hook.

- [ ] **Step 4: Smoke-test in a fresh Claude Code session**

Open a new Claude Code session in this workspace. Send a substantive message that mentions an entity from ENTITIES.md (e.g., "remind me about my dentist appointment"). Verify:
- The transcript shows a `<!-- relevant memory -->` block in the model's input context (visible in the raw transcript at `~/.claude/projects/<slug>/<sid>.jsonl`).
- The model captures appropriately (or emits a marker).
- No errors in `user-data/state/hook-errors.log` (if it exists).

Check telemetry:
```sh
tail user-data/state/capture-enforcement.log
tail user-data/state/recall.log
```

- [ ] **Step 5: Final regression run**

Run: `npm test`
Expected: full test suite passes.

- [ ] **Step 6: Commit (if any tweaks were needed)**

```bash
# Only commit changes — bootstrap output and manifest are in user-data/ (gitignored).
git status
# If anything tracked changed, commit appropriately.
```

---

## Self-Review

Spec coverage check (each subsystem section in spec → mapped to task[s]):

- **S1.1 UserPromptSubmit handler** → Task 9
- **S1.2 Stop verifyCapture** → Task 10
- **S1.3 PreToolUse write-intent** → Task 8
- **S1.4 State files** → Tasks 1 (turn-state), 2 (perf-log), 10 (telemetry log)
- **S1.5 Triviality config** → Task 12
- **S1.6 AGENTS.md / capture-rules.md changes** → Tasks 13, 14
- **S1.7 .claude/settings.json registration** → Task 11
- **S1.8 install-hooks.js updates** → covered by Task 11 (manual settings.json edit + manifest re-snapshot is the upgrade path; install-hooks.js auto-registration of Claude Code hooks is not currently part of the codebase — that script handles git pre-commit only. Documented in CHANGELOG migration note.)
- **S1.9 manifest baseline update** → Task 11
- **S2.1 ENTITIES.md** → Tasks 5, 6
- **S2.2 Frontmatter conventions** → covered by lib in Task 5; documented in spec
- **S2.3 index-entities.js** → Task 6
- **S2.4 lib/recall.js** → Task 4
- **S2.5 bin/robin.js recall** → Task 7
- **S2.6 Auto-recall in UserPromptSubmit** → Task 9
- **S2.7 AGENTS.md recall instruction** → Task 13
- **S2.8 Startup load order** → Task 13
- **S2.9 Dream integration** → Task 15
- **Data flow** → exercised end-to-end by Task 17 integration test
- **Failure modes** → covered by individual tests (fail-open paths) + integration test
- **Testing strategy** → unit (Tasks 1–10) + integration (Task 17)
- **Migration / rollout** → Tasks 12, 19 (CHANGELOG), 20 (bootstrap)
- **Telemetry baselines** → Task 18

**No gaps identified in spec coverage.** One spec item I marked as covered-but-narrowed: S1.8 ("install-hooks.js updates") — the existing `install-hooks.js` only handles git pre-commit hooks, not `.claude/settings.json` registration. This plan handles `.claude/settings.json` as a one-time edit (Task 11). If a separate auto-installer is desired in the future, it's Phase 2 work; the CHANGELOG documents the migration path explicitly.

**Placeholder scan:** none. All steps include code, exact commands, expected output.

**Type/signature consistency:**
- `mintTurnId(sessionId, when)` used consistently across Tasks 1, 9.
- `readTurnJson(ws)` returns `{ turn_id, user_words, tier, entities_matched, started_at }` — used in Tasks 8, 9, 10 with matching shape.
- `appendWriteIntent(ws, { turn_id, target, tool })` matches usage in Tasks 8, 10.
- `recall(ws, patterns, opts) → { hits, truncated }` matches usage in Tasks 4, 7, 9, 17.
- `formatRecallHits({ hits, truncated })` used in Tasks 4, 7, 9.
- `collectEntities`, `writeEntitiesAtomic`, `readEntities`, `detectUserEdit` consistent across Tasks 5, 6, 9.
- `classifyTier({ userMessage, entityAliases }) → { tier, wc, keywords, entitiesMatched, reason }` matches usage in Tasks 3, 9.

All consistent.

---

**Plan complete and saved to `docs/superpowers/plans/2026-05-01-robin-autonomous-memory.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
