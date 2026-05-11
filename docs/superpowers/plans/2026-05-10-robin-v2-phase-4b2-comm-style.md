# Phase 4b.2 — Comm-Style Profile Inference — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Synthesize the user's communication-style preferences from correction events nightly; surface via MCP tool + AGENTS.md.

**Spec:** `docs/superpowers/specs/2026-05-10-robin-v2-phase-4b2-comm-style-design.md` (commit `25829e4`).

**Coordination note (every subagent):**
- Avoid 4f territory: `src/capture/`, `src/hooks/handlers/`, `src/daemon/sessions.js`, `runtime_sessions`, `runtime_auto_recall_telemetry`, `src/cli/commands/biographer-*`.
- Rename pass in working tree — stage by explicit path ONLY. Never `git add -A`. Run `git status` before staging.

---

## File map

**New:**
```
src/schema/migrations/0013-comm-style.surql
src/jobs/comm-style.js
src/dream/step-comm-style.js
src/mcp/tools/get-comm-style.js
src/cli/commands/commstyle-show.js
src/cli/commands/commstyle-refresh.js
tests/unit/comm-style-helpers.test.js
tests/unit/comm-style-synthesis.test.js
tests/unit/get-comm-style.test.js
tests/unit/commstyle-cli.test.js
tests/unit/agents-md-comm-style.test.js
tests/integration/comm-style-roundtrip.test.js
```

**Modified (additive only):**
```
src/dream/pipeline.js              # wire in step-comm-style
src/daemon/server.js               # register MCP tool + /internal/comm-style/refresh endpoint
src/cli/index.js                   # commstyle dispatcher branch
src/install/agents-md.js           # robin-comm-style block
src/cli/commands/mcp-install.js    # read commStyle at install time, pass to agentsMdContent
```

---

## Wave plan

| Wave | Tasks | Parallelism |
|---|---|---|
| 1 | 1 (migration + helpers) | 1 |
| 2 | 2 (synthesis), 4 (get_comm_style MCP) | 2 parallel |
| 3 | 3 (Dream wiring), 5 (CLI), 6 (AGENTS.md + daemon endpoint) | 3 parallel |
| 4 | 7 (integration roundtrip) | 1 |

---

## Task 1: Migration 0013 + helpers

**Files:** `src/schema/migrations/0013-comm-style.surql`, `src/jobs/comm-style.js`, `tests/unit/comm-style-helpers.test.js`.

- [ ] **Step 1: Migration**

```sql
-- 0013-comm-style.surql — extend profile with inferred communication style.
DEFINE FIELD comm_style ON profile TYPE option<object> FLEXIBLE;
UPSERT profile:singleton CONTENT { meta: {} } RETURN NONE;
```

- [ ] **Step 2: Helpers tests**

```js
// tests/unit/comm-style-helpers.test.js
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import {
  DEFAULTS,
  getCommStyle,
  setCommStyle,
  validateCommStyleShape,
} from '../../src/jobs/comm-style.js';

import { writeConfig as __wc } from '../../src/runtime/config.js';

const __h = join(tmpdir(), `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
mkdirSync(__h, { recursive: true });
process.env.ROBIN_HOME = __h;
await __wc({ embedder_profile: 'mxbai-1024' });

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  return db;
}

test('DEFAULTS shape', () => {
  assert.equal(DEFAULTS.tone, 'balanced');
  assert.equal(DEFAULTS.formality, 'balanced');
  assert.equal(DEFAULTS.emoji_ok, false);
  assert.equal(DEFAULTS.direct_feedback_ok, true);
  assert.equal(DEFAULTS.code_comment_density, 'minimal');
  assert.equal(DEFAULTS.summary_style, 'mixed');
});

test('getCommStyle returns null when unset', async () => {
  const db = await fresh();
  const r = await getCommStyle(db);
  assert.equal(r, null);
  await close(db);
});

test('setCommStyle persists + getCommStyle reads back', async () => {
  const db = await fresh();
  await setCommStyle(db, {
    tone: 'terse',
    formality: 'casual',
    emoji_ok: false,
    direct_feedback_ok: true,
    code_comment_density: 'minimal',
    summary_style: 'bullets',
    evidence: ['events:abc'],
    confidence: 0.7,
  });
  const r = await getCommStyle(db);
  assert.equal(r.tone, 'terse');
  assert.equal(r.summary_style, 'bullets');
  assert.equal(r.confidence, 0.7);
  assert.ok(r.last_synthesized_at instanceof Date);
  await close(db);
});

test('validateCommStyleShape accepts valid', () => {
  const r = validateCommStyleShape({
    tone: 'terse',
    formality: 'casual',
    emoji_ok: false,
    direct_feedback_ok: true,
    code_comment_density: 'minimal',
    summary_style: 'bullets',
    confidence: 0.5,
  });
  assert.equal(r.ok, true);
});

test('validateCommStyleShape rejects bad enum', () => {
  const r = validateCommStyleShape({
    tone: 'shouty',                    // invalid
    formality: 'casual',
    emoji_ok: false,
    direct_feedback_ok: true,
    code_comment_density: 'minimal',
    summary_style: 'bullets',
    confidence: 0.5,
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /tone/);
});

test('validateCommStyleShape clamps confidence out of range', () => {
  const r = validateCommStyleShape({
    tone: 'terse', formality: 'casual', emoji_ok: false,
    direct_feedback_ok: true, code_comment_density: 'minimal',
    summary_style: 'bullets',
    confidence: 1.7,                   // out of range
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /confidence/);
});

test('validateCommStyleShape rejects non-boolean booleans', () => {
  const r = validateCommStyleShape({
    tone: 'terse', formality: 'casual',
    emoji_ok: 'yes',                   // string not bool
    direct_feedback_ok: true,
    code_comment_density: 'minimal', summary_style: 'bullets',
    confidence: 0.5,
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /emoji_ok/);
});
```

- [ ] **Step 3: Run — fail (module not found)**

```
node --test --test-force-exit tests/unit/comm-style-helpers.test.js
```

- [ ] **Step 4: Implement `src/jobs/comm-style.js`**

```js
// src/jobs/comm-style.js
import { surql } from 'surrealdb';

export const DEFAULTS = {
  tone: 'balanced',
  formality: 'balanced',
  emoji_ok: false,
  direct_feedback_ok: true,
  code_comment_density: 'minimal',
  summary_style: 'mixed',
};

const TONE_VALUES = new Set(['terse', 'balanced', 'verbose']);
const FORMALITY_VALUES = new Set(['casual', 'balanced', 'formal']);
const DENSITY_VALUES = new Set(['minimal', 'moderate', 'verbose']);
const SUMMARY_VALUES = new Set(['bullets', 'prose', 'mixed']);

export function validateCommStyleShape(obj) {
  if (!obj || typeof obj !== 'object') return { ok: false, reason: 'not_object' };
  if (!TONE_VALUES.has(obj.tone)) return { ok: false, reason: `bad tone: ${obj.tone}` };
  if (!FORMALITY_VALUES.has(obj.formality))
    return { ok: false, reason: `bad formality: ${obj.formality}` };
  if (typeof obj.emoji_ok !== 'boolean') return { ok: false, reason: 'emoji_ok not boolean' };
  if (typeof obj.direct_feedback_ok !== 'boolean')
    return { ok: false, reason: 'direct_feedback_ok not boolean' };
  if (!DENSITY_VALUES.has(obj.code_comment_density))
    return { ok: false, reason: `bad code_comment_density: ${obj.code_comment_density}` };
  if (!SUMMARY_VALUES.has(obj.summary_style))
    return { ok: false, reason: `bad summary_style: ${obj.summary_style}` };
  if (typeof obj.confidence !== 'number' || obj.confidence < 0 || obj.confidence > 1)
    return { ok: false, reason: `confidence out of range: ${obj.confidence}` };
  return { ok: true, value: obj };
}

export async function getCommStyle(db) {
  const [rows] = await db.query(surql`SELECT comm_style FROM profile:singleton`).collect();
  const cs = rows?.[0]?.comm_style ?? null;
  if (!cs) return null;
  // SurrealDB returns datetimes as objects with toDate(); normalize.
  if (cs.last_synthesized_at && typeof cs.last_synthesized_at.toDate === 'function') {
    cs.last_synthesized_at = cs.last_synthesized_at.toDate();
  } else if (typeof cs.last_synthesized_at === 'string') {
    cs.last_synthesized_at = new Date(cs.last_synthesized_at);
  }
  return cs;
}

export async function setCommStyle(db, fields) {
  const persisted = {
    tone: fields.tone,
    formality: fields.formality,
    emoji_ok: fields.emoji_ok,
    direct_feedback_ok: fields.direct_feedback_ok,
    code_comment_density: fields.code_comment_density,
    summary_style: fields.summary_style,
    evidence: Array.isArray(fields.evidence) ? fields.evidence : [],
    confidence: typeof fields.confidence === 'number' ? fields.confidence : 0,
    last_synthesized_at: new Date(),
  };
  await db
    .query(surql`UPSERT profile:singleton MERGE ${{ comm_style: persisted }}`)
    .collect();
}
```

- [ ] **Step 5: Run — pass**

```
node --test --test-force-exit tests/unit/comm-style-helpers.test.js
```

Expected: 7 pass.

- [ ] **Step 6: Lint + commit (explicit paths)**

```
npm run lint
git add src/schema/migrations/0013-comm-style.surql src/jobs/comm-style.js tests/unit/comm-style-helpers.test.js
git commit -m "feat(4b.2): comm-style migration 0013 + helpers"
```

---

## Task 2: Synthesis function

**Files:** Add `synthesizeCommStyle` to `src/jobs/comm-style.js`. Create `tests/unit/comm-style-synthesis.test.js`.

- [ ] **Step 1: Implementer verification step** — read `src/mcp/tools/record-correction.js` to confirm corrections are written with `source: 'correction'`. If `'correction'` is correct, proceed. If the rename pass changed it to `'reflection'`, adapt all references to `'correction'` in the synthesis code.

- [ ] **Step 2: Write failing tests**

```js
// tests/unit/comm-style-synthesis.test.js
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createStubEmbedder } from '../../src/embed/embedder.js';
import { getCommStyle, synthesizeCommStyle } from '../../src/jobs/comm-style.js';

import { writeConfig as __wc } from '../../src/runtime/config.js';

const __h = join(tmpdir(), `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
mkdirSync(__h, { recursive: true });
process.env.ROBIN_HOME = __h;
await __wc({ embedder_profile: 'mxbai-1024' });

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  return { db, embedder: createStubEmbedder({ dimension: 1024 }) };
}

async function seedCorrection(db, embedder, content) {
  const emb = Array.from(await embedder.embed(content));
  const [rows] = await db
    .query(
      surql`CREATE events CONTENT ${{
        source: 'correction',
        content,
        content_hash: `h-${Math.random().toString(36).slice(2)}`,
        embedding: emb,
      }}`,
    )
    .collect();
  return rows[0].id;
}

const stubLLM = (output) => ({ invokeLLM: async () => ({ content: output }) });

test('synthesis — <3 signals persists defaults with confidence 0, no LLM call', async () => {
  const { db, embedder } = await fresh();
  await seedCorrection(db, embedder, 'too brief');
  let llmCalls = 0;
  const host = {
    invokeLLM: async () => {
      llmCalls++;
      return { content: '{}' };
    },
  };
  const r = await synthesizeCommStyle(db, host);
  assert.equal(r.ok, true);
  assert.equal(r.signals_used, 1);
  assert.equal(llmCalls, 0, 'LLM should not be called with <3 signals');
  const persisted = await getCommStyle(db);
  assert.equal(persisted.confidence, 0);
  assert.equal(persisted.tone, 'balanced');
  await close(db);
});

test('synthesis — 3+ signals with valid LLM output persisted', async () => {
  const { db, embedder } = await fresh();
  for (let i = 0; i < 4; i++) {
    await seedCorrection(db, embedder, `correction ${i}: be more terse`);
  }
  const llm = stubLLM(
    JSON.stringify({
      tone: 'terse',
      formality: 'casual',
      emoji_ok: false,
      direct_feedback_ok: true,
      code_comment_density: 'minimal',
      summary_style: 'bullets',
      confidence: 0.8,
      evidence_indices: [1, 2],
    }),
  );
  const r = await synthesizeCommStyle(db, llm);
  assert.equal(r.ok, true);
  assert.equal(r.signals_used, 4);
  const persisted = await getCommStyle(db);
  assert.equal(persisted.tone, 'terse');
  assert.equal(persisted.summary_style, 'bullets');
  assert.equal(persisted.confidence, 0.8);
  assert.equal(persisted.evidence.length, 2, 'two indices resolved to two event ids');
  await close(db);
});

test('synthesis — malformed LLM output leaves previous shape', async () => {
  const { db, embedder } = await fresh();
  for (let i = 0; i < 4; i++) {
    await seedCorrection(db, embedder, `correction ${i}`);
  }
  // First, persist a valid shape via a good LLM
  await synthesizeCommStyle(db, stubLLM(JSON.stringify({
    tone: 'verbose', formality: 'formal', emoji_ok: true,
    direct_feedback_ok: true, code_comment_density: 'moderate',
    summary_style: 'prose', confidence: 0.6, evidence_indices: [],
  })));
  // Now, malformed LLM
  const r = await synthesizeCommStyle(db, stubLLM('not json'));
  assert.equal(r.ok, false);
  assert.match(r.reason, /parse_failed|invalid/);
  // Previous shape preserved
  const persisted = await getCommStyle(db);
  assert.equal(persisted.tone, 'verbose');
  await close(db);
});

test('synthesis — invalid LLM shape rejected, previous preserved', async () => {
  const { db, embedder } = await fresh();
  for (let i = 0; i < 4; i++) {
    await seedCorrection(db, embedder, `correction ${i}`);
  }
  // Seed valid
  await synthesizeCommStyle(db, stubLLM(JSON.stringify({
    tone: 'terse', formality: 'casual', emoji_ok: false,
    direct_feedback_ok: true, code_comment_density: 'minimal',
    summary_style: 'bullets', confidence: 0.5, evidence_indices: [],
  })));
  // Now bad enum
  const r = await synthesizeCommStyle(db, stubLLM(JSON.stringify({
    tone: 'shouty',    // invalid
    formality: 'casual', emoji_ok: false, direct_feedback_ok: true,
    code_comment_density: 'minimal', summary_style: 'bullets',
    confidence: 0.5, evidence_indices: [],
  })));
  assert.equal(r.ok, false);
  const persisted = await getCommStyle(db);
  assert.equal(persisted.tone, 'terse');
  await close(db);
});
```

- [ ] **Step 3: Run — fail**

- [ ] **Step 4: Implement `synthesizeCommStyle`** — append to `src/jobs/comm-style.js`:

```js
// src/jobs/comm-style.js (additions)
const RECENCY_MS = 30 * 86_400_000;
const MIN_SIGNALS = 3;
const SIGNAL_CAP = 100;

function buildPrompt(corrections) {
  const numbered = corrections.map((c, i) => `${i + 1}. ${c.content}`).join('\n');
  return `You are inferring a user's communication-style preferences from their recent corrections to an AI assistant.

Recent corrections (last 30 days, newest first):
${numbered}

Respond with strict JSON only:

{
  "tone": "terse" | "balanced" | "verbose",
  "formality": "casual" | "balanced" | "formal",
  "emoji_ok": boolean,
  "direct_feedback_ok": boolean,
  "code_comment_density": "minimal" | "moderate" | "verbose",
  "summary_style": "bullets" | "prose" | "mixed",
  "confidence": <float 0..1, how confident are you?>,
  "evidence_indices": <[int], 1-indexed indices of corrections that most informed this>
}

If a field has no signal, pick "balanced" (or false for booleans). No commentary, no markdown fences.`;
}

export async function synthesizeCommStyle(db, host) {
  const cutoff = new Date(Date.now() - RECENCY_MS);
  const [rows] = await db
    .query(
      surql`SELECT id, content FROM events
            WHERE source = 'correction' AND created_at > ${cutoff}
            ORDER BY created_at DESC LIMIT ${SIGNAL_CAP}`,
    )
    .collect();
  const corrections = rows ?? [];

  if (corrections.length < MIN_SIGNALS) {
    await setCommStyle(db, { ...DEFAULTS, evidence: [], confidence: 0 });
    return { ok: true, comm_style: { ...DEFAULTS, confidence: 0 }, signals_used: corrections.length };
  }

  if (!host?.invokeLLM) return { ok: false, reason: 'no_host' };

  let parsed;
  try {
    const llm = await host.invokeLLM(
      [{ role: 'user', content: buildPrompt(corrections) }],
      { tier: 'balanced' },
    );
    parsed = JSON.parse(llm?.content ?? '');
  } catch (e) {
    return { ok: false, reason: 'parse_failed', detail: e.message };
  }

  const v = validateCommStyleShape(parsed);
  if (!v.ok) return { ok: false, reason: `invalid_shape: ${v.reason}` };

  const evidenceIds = [];
  for (const idx of parsed.evidence_indices ?? []) {
    const n = Number.parseInt(idx, 10);
    if (Number.isInteger(n) && n >= 1 && n <= corrections.length) {
      evidenceIds.push(String(corrections[n - 1].id));
    }
  }

  await setCommStyle(db, { ...v.value, evidence: evidenceIds });
  return {
    ok: true,
    comm_style: { ...v.value, evidence: evidenceIds },
    signals_used: corrections.length,
  };
}
```

- [ ] **Step 5: Run — pass**

Expected: 4 tests pass.

- [ ] **Step 6: Lint + commit (explicit paths)**

```
git add src/jobs/comm-style.js tests/unit/comm-style-synthesis.test.js
git commit -m "feat(4b.2): comm-style synthesis function (LLM-driven, threshold-guarded)"
```

---

## Task 3: Dream pipeline wiring

**Files:** Create `src/dream/step-comm-style.js`. Modify `src/dream/pipeline.js`.

- [ ] **Step 1: Read `src/dream/pipeline.js`** — find the existing step list. There may be a rename pass concern (`step-corrections.js` → `step-reflection.js`); use whatever names are currently committed. The step list ends with a final step; your new step goes AFTER all existing steps.

- [ ] **Step 2: Create `src/dream/step-comm-style.js`**

```js
// src/dream/step-comm-style.js — Dream pipeline step that synthesizes
// the user's communication-style preferences from recent corrections.
// FAIL-SOFT: an error here does not abort the Dream run.
import { synthesizeCommStyle } from '../jobs/comm-style.js';

export async function stepCommStyle({ db, host }) {
  try {
    const result = await synthesizeCommStyle(db, host);
    if (!result.ok) {
      console.warn(`[dream] step-comm-style: ${result.reason}`);
    }
    return result;
  } catch (e) {
    console.warn(`[dream] step-comm-style: ${e.message}`);
    return { ok: false, reason: e.message };
  }
}
```

- [ ] **Step 3: Wire into `src/dream/pipeline.js`**

Find the pipeline's step orchestration. There's likely an array of steps or sequential awaits. Add the import at the top:
```js
import { stepCommStyle } from './step-comm-style.js';
```

And invoke the step at the END of the pipeline (after all existing steps complete). Wrap in try/catch if the existing pattern doesn't already use fail-soft.

- [ ] **Step 4: Run the existing dream-full-cycle test (if present) to verify no regression**

```
node --test --test-force-exit tests/integration/dream-full-cycle.test.js
```

Expected: still passing. The new step adds a fail-soft no-op when there are no corrections in the test DB.

- [ ] **Step 5: Lint + commit (explicit paths)**

```
git add src/dream/pipeline.js src/dream/step-comm-style.js
git commit -m "feat(4b.2): Dream pipeline runs comm-style synthesis"
```

---

## Task 4: `get_comm_style` MCP tool

**Files:** `src/mcp/tools/get-comm-style.js`, `tests/unit/get-comm-style.test.js`.

- [ ] **Step 1: Tests**

```js
// tests/unit/get-comm-style.test.js
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { setCommStyle } from '../../src/jobs/comm-style.js';
import { createGetCommStyleTool } from '../../src/mcp/tools/get-comm-style.js';

import { writeConfig as __wc } from '../../src/runtime/config.js';

const __h = join(tmpdir(), `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
mkdirSync(__h, { recursive: true });
process.env.ROBIN_HOME = __h;
await __wc({ embedder_profile: 'mxbai-1024' });

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  return db;
}

test('get_comm_style — returns defaults with synthesized:false when unset', async () => {
  const db = await fresh();
  const t = createGetCommStyleTool({ db });
  const r = await t.handler({});
  assert.equal(r.tone, 'balanced');
  assert.equal(r.synthesized, false);
  assert.equal(r.confidence, 0);
  await close(db);
});

test('get_comm_style — returns persisted shape with synthesized:true', async () => {
  const db = await fresh();
  await setCommStyle(db, {
    tone: 'terse', formality: 'casual', emoji_ok: false,
    direct_feedback_ok: true, code_comment_density: 'minimal',
    summary_style: 'bullets', evidence: ['events:abc'], confidence: 0.7,
  });
  const t = createGetCommStyleTool({ db });
  const r = await t.handler({});
  assert.equal(r.tone, 'terse');
  assert.equal(r.synthesized, true);
  assert.equal(r.confidence, 0.7);
  await close(db);
});
```

- [ ] **Step 2: Run — fail**

- [ ] **Step 3: Implement**

```js
// src/mcp/tools/get-comm-style.js
import { DEFAULTS, getCommStyle } from '../../jobs/comm-style.js';

export function createGetCommStyleTool({ db }) {
  return {
    name: 'get_comm_style',
    description: 'Read the user\'s inferred communication-style preferences. Returns balanced defaults with confidence: 0 if never synthesized.',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      const row = await getCommStyle(db);
      if (!row) {
        return {
          ...DEFAULTS,
          evidence: [],
          confidence: 0,
          last_synthesized_at: null,
          synthesized: false,
        };
      }
      return { ...row, synthesized: true };
    },
  };
}
```

- [ ] **Step 4: Run — pass**

- [ ] **Step 5: Lint + commit**

```
git add src/mcp/tools/get-comm-style.js tests/unit/get-comm-style.test.js
git commit -m "feat(4b.2): get_comm_style MCP tool"
```

---

## Task 5: CLI `robin commstyle show` + `refresh`

**Files:** `src/cli/commands/commstyle-show.js`, `src/cli/commands/commstyle-refresh.js`, `tests/unit/commstyle-cli.test.js`. Modify `src/cli/index.js`.

- [ ] **Step 1: Tests**

```js
// tests/unit/commstyle-cli.test.js
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { writeConfig as __wc } from '../../src/runtime/config.js';

const __h = join(tmpdir(), `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
mkdirSync(__h, { recursive: true });
process.env.ROBIN_HOME = __h;
await __wc({ embedder_profile: 'mxbai-1024' });

const { commstyleShow } = await import('../../src/cli/commands/commstyle-show.js');
const { commstyleRefresh } = await import('../../src/cli/commands/commstyle-refresh.js');

function capture() {
  const lines = [];
  return { lines, fn: (s) => lines.push(s) };
}

test('commstyle show — null prints "(not synthesized)"', async () => {
  const out = capture();
  await commstyleShow([], { out: out.fn, getCommStyle: async () => null });
  assert.match(out.lines.join('\n'), /not synthesized/);
});

test('commstyle show — prints all fields when populated', async () => {
  const out = capture();
  await commstyleShow([], {
    out: out.fn,
    getCommStyle: async () => ({
      tone: 'terse', formality: 'casual', emoji_ok: false,
      direct_feedback_ok: true, code_comment_density: 'minimal',
      summary_style: 'bullets', evidence: ['e1', 'e2'], confidence: 0.7,
      last_synthesized_at: new Date('2026-05-10T04:00:00Z'),
    }),
  });
  const all = out.lines.join('\n');
  assert.match(all, /tone: terse/);
  assert.match(all, /confidence: 0\.7/);
});

test('commstyle refresh — POSTs to /internal/comm-style/refresh', async () => {
  const out = capture();
  let posted;
  await commstyleRefresh([], {
    out: out.fn,
    daemonRequest: async (path) => {
      posted = path;
      return { ok: true, signals_used: 5, comm_style: { tone: 'terse', confidence: 0.7 } };
    },
  });
  assert.equal(posted, '/internal/comm-style/refresh');
  assert.match(out.lines.join('\n'), /ok/);
});
```

- [ ] **Step 2: Run — fail**

- [ ] **Step 3: Implement**

```js
// src/cli/commands/commstyle-show.js
import { close, connect } from '../../db/client.js';
import { getCommStyle as defaultGet } from '../../jobs/comm-style.js';
import { ensureHome, paths } from '../../runtime/home.js';

export async function commstyleShow(_argv = [], deps = {}) {
  const out = deps.out ?? ((s) => console.log(s));
  const fetch = deps.getCommStyle ?? (async () => {
    await ensureHome();
    const p = paths();
    const db = await connect({ engine: `rocksdb://${p.db}` });
    try {
      return await defaultGet(db);
    } finally {
      await close(db);
    }
  });
  const row = await fetch();
  if (!row) {
    out('(not synthesized — too few corrections, or daemon never ran Dream)');
    return;
  }
  for (const k of ['tone', 'formality', 'emoji_ok', 'direct_feedback_ok',
                    'code_comment_density', 'summary_style', 'confidence',
                    'last_synthesized_at']) {
    const v = row[k];
    out(`${k}: ${v instanceof Date ? v.toISOString() : v}`);
  }
  out(`evidence: ${row.evidence?.length ?? 0} event(s)`);
}
```

```js
// src/cli/commands/commstyle-refresh.js
import { daemonRequest as defaultRequest } from '../daemon-request.js';

export async function commstyleRefresh(_argv = [], deps = {}) {
  const out = deps.out ?? ((s) => console.log(s));
  const err = deps.err ?? ((s) => console.error(s));
  const request = deps.daemonRequest ?? defaultRequest;
  const r = await request('/internal/comm-style/refresh');
  if (r?.ok) {
    out(`ok — signals_used=${r.signals_used ?? 0}, confidence=${r.comm_style?.confidence ?? '?'}`);
  } else {
    err(`refresh failed: ${r?.reason ?? 'unknown'}`);
    process.exitCode = 1;
  }
}
```

- [ ] **Step 4: Wire dispatcher in `src/cli/index.js`**

Add (after the existing `if (cmd === 'actions')` block):

```js
if (cmd === 'commstyle') {
  const sub = argv[1];
  if (sub === 'show') {
    const { commstyleShow } = await import('./commands/commstyle-show.js');
    return commstyleShow(argv.slice(2));
  }
  if (sub === 'refresh') {
    const { commstyleRefresh } = await import('./commands/commstyle-refresh.js');
    return commstyleRefresh(argv.slice(2));
  }
  console.error('usage: robin commstyle <show|refresh>');
  process.exit(1);
}
```

- [ ] **Step 5: Run — pass**

- [ ] **Step 6: Lint + commit**

```
git add src/cli/commands/commstyle-show.js src/cli/commands/commstyle-refresh.js src/cli/index.js tests/unit/commstyle-cli.test.js
git commit -m "feat(4b.2): robin commstyle show + refresh CLI"
```

---

## Task 6: AGENTS.md block + daemon endpoint + MCP tool registration

**Files:** Modify `src/install/agents-md.js`, `src/daemon/server.js`, `src/cli/commands/mcp-install.js`. Create `tests/unit/agents-md-comm-style.test.js`.

- [ ] **Step 1: Tests**

```js
// tests/unit/agents-md-comm-style.test.js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentsMdContent } from '../../src/install/agents-md.js';

test('robin-comm-style block exists', () => {
  const md = agentsMdContent({});
  assert.match(md, /<!-- robin-comm-style:start/);
  assert.match(md, /<!-- robin-comm-style:end -->/);
});

test('robin-comm-style — null shape shows "no comm-style inferred yet" fallback', () => {
  const md = agentsMdContent({ commStyle: null });
  assert.match(md, /no comm-style inferred yet/i);
});

test('robin-comm-style — populated shape shows fields', () => {
  const md = agentsMdContent({
    commStyle: {
      tone: 'terse', formality: 'casual', emoji_ok: false,
      direct_feedback_ok: true, code_comment_density: 'minimal',
      summary_style: 'bullets', confidence: 0.7,
      last_synthesized_at: new Date('2026-05-10T04:00:00Z'),
    },
  });
  assert.match(md, /tone:\s*"terse"/);
  assert.match(md, /confidence:\s*0\.7/);
});

test('robin-comm-style — mentions get_comm_style for re-read', () => {
  const md = agentsMdContent({});
  assert.match(md, /get_comm_style/);
});
```

- [ ] **Step 2: Run — fail**

- [ ] **Step 3: Modify `src/install/agents-md.js`**

Add exported function `commStyleSection(commStyle)`:

```js
export function commStyleSection(commStyle) {
  if (commStyle && commStyle.tone) {
    const ts = commStyle.last_synthesized_at
      ? new Date(commStyle.last_synthesized_at).toISOString()
      : 'unknown';
    return `<!-- robin-comm-style:start (auto-generated, do not hand-edit) -->
## Communication style

Inferred preferences (synthesized nightly from your corrections):
{
  tone: "${commStyle.tone}",
  formality: "${commStyle.formality}",
  emoji_ok: ${commStyle.emoji_ok},
  direct_feedback_ok: ${commStyle.direct_feedback_ok},
  code_comment_density: "${commStyle.code_comment_density}",
  summary_style: "${commStyle.summary_style}",
  confidence: ${commStyle.confidence},
  synthesized: ${ts}
}

If \`confidence\` is low (<0.4), treat these as soft hints; honor explicit
instructions in the current turn first. Use \`get_comm_style()\` to re-read
if something might have updated mid-session.
<!-- robin-comm-style:end -->`;
  }
  return `<!-- robin-comm-style:start (auto-generated, do not hand-edit) -->
## Communication style

No comm-style inferred yet — too few corrections, or Dream hasn't run.
Use balanced defaults. Use \`get_comm_style()\` once a session has produced
corrections to check whether enough signal has accumulated.
<!-- robin-comm-style:end -->`;
}
```

Modify `agentsMdContent({integrations, jobs, commStyle})` — add the new arg. In the template literal, insert `\n\n${commStyleSection(commStyle)}` after the actions block (or before, your choice — should be consistent).

- [ ] **Step 4: Modify `src/cli/commands/mcp-install.js`** to read commStyle at install time:

Add a helper alongside the existing `readJobsForAgentsMd`:

```js
async function readCommStyleForAgentsMd() {
  try {
    const { ensureHome, paths } = await import('../../runtime/home.js');
    const { connect, close } = await import('../../db/client.js');
    const { getCommStyle } = await import('../../jobs/comm-style.js');
    await ensureHome();
    const p = paths();
    const db = await connect({ engine: `rocksdb://${p.db}` });
    try {
      return await getCommStyle(db);
    } finally {
      await close(db);
    }
  } catch {
    return null;
  }
}
```

Modify `writeMergedAgentsMd` to accept commStyle alongside jobs (or extend the single-pass DB read to fetch both at once — preferred):

```js
async function writeMergedAgentsMd(path, jobs, commStyle) {
  await mkdir(dirname(path), { recursive: true });
  const existing = await readOrEmpty(path);
  const merged = mergeAgentsMdContent(existing, agentsMdContent({ jobs, commStyle }));
  await writeFile(path, merged, 'utf8');
  console.log(`updated ${path}`);
}
```

At the install call site, read both before writing:

```js
if (!noAgentsMd) {
  const claudePath = join(home, '.claude/CLAUDE.md');
  const geminiPath = join(home, '.gemini/GEMINI.md');
  const jobs = await readJobsForAgentsMd();
  const commStyle = await readCommStyleForAgentsMd();
  await writeMergedAgentsMd(claudePath, jobs, commStyle);
  await writeMergedAgentsMd(geminiPath, jobs, commStyle);
}
```

(Better: collapse the two read functions into one that opens the DB once and returns `{jobs, commStyle}`. Saves one rocksdb open+close. The current pattern already does two opens — keep parallel structure for now and refactor later.)

- [ ] **Step 5: Modify `src/daemon/server.js`** — register the MCP tool + add the endpoint:

Imports:
```js
import { createGetCommStyleTool } from '../mcp/tools/get-comm-style.js';
import { synthesizeCommStyle } from '../jobs/comm-style.js';
```

Tool registration (in the `tools` array, after the action-policy tools):
```js
createGetCommStyleTool({ db: dbHandle }),
```

HTTP endpoint (after `/internal/actions/reset`):
```js
if (req.method === 'POST' && req.url === '/internal/comm-style/refresh') {
  const result = await synthesizeCommStyle(dbHandle, host);
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(result));
  return;
}
```

- [ ] **Step 6: Run tests + daemon integration tests**

```
node --test --test-force-exit tests/unit/agents-md-comm-style.test.js tests/integration/mcp-end-to-end.test.js tests/integration/scheduler-multi-integration.test.js
```

- [ ] **Step 7: Lint + commit**

```
git add src/daemon/server.js src/cli/commands/mcp-install.js src/install/agents-md.js tests/unit/agents-md-comm-style.test.js
git commit -m "feat(4b.2): AGENTS.md comm-style block + daemon endpoint + MCP tool registration"
```

---

## Task 7: Integration roundtrip

**Files:** `tests/integration/comm-style-roundtrip.test.js`.

- [ ] **Step 1: Test**

```js
// tests/integration/comm-style-roundtrip.test.js
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createStubEmbedder } from '../../src/embed/embedder.js';
import { synthesizeCommStyle, getCommStyle } from '../../src/jobs/comm-style.js';
import { createGetCommStyleTool } from '../../src/mcp/tools/get-comm-style.js';

import { writeConfig as __wc } from '../../src/runtime/config.js';

const __h = join(tmpdir(), `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
mkdirSync(__h, { recursive: true });
process.env.ROBIN_HOME = __h;
await __wc({ embedder_profile: 'mxbai-1024' });

test('comm-style roundtrip: seed 5 corrections → synthesize → MCP tool reads', async () => {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  const embedder = createStubEmbedder({ dimension: 1024 });

  // Seed 5 correction events
  for (let i = 0; i < 5; i++) {
    const emb = Array.from(await embedder.embed(`be more terse ${i}`));
    await db.query(surql`CREATE events CONTENT ${{
      source: 'correction',
      content: `Be more terse on point ${i}. Skip preamble.`,
      content_hash: `c${i}`,
      embedding: emb,
    }}`).collect();
  }

  // Stub LLM emits a structured response
  const host = {
    invokeLLM: async () => ({
      content: JSON.stringify({
        tone: 'terse',
        formality: 'casual',
        emoji_ok: false,
        direct_feedback_ok: true,
        code_comment_density: 'minimal',
        summary_style: 'bullets',
        confidence: 0.85,
        evidence_indices: [1, 2, 3],
      }),
    }),
  };

  const r = await synthesizeCommStyle(db, host);
  assert.equal(r.ok, true);
  assert.equal(r.signals_used, 5);

  // MCP tool returns the populated shape
  const tool = createGetCommStyleTool({ db });
  const tr = await tool.handler({});
  assert.equal(tr.tone, 'terse');
  assert.equal(tr.confidence, 0.85);
  assert.equal(tr.synthesized, true);
  assert.equal(tr.evidence.length, 3);

  await close(db);
});
```

- [ ] **Step 2: Run — pass**

- [ ] **Step 3: Lint + commit**

```
git add tests/integration/comm-style-roundtrip.test.js
git commit -m "test(4b.2): integration roundtrip — corrections → synth → MCP read"
```

---

## Self-review

**Spec coverage:** All §3-§10 covered across Tasks 1-7. §11 tests broken into per-task. §13 risks → §11 tests verify mitigation.

**Placeholder scan:** Verification step in Task 2 step 1 is the only "look at code first" point — that's a real implementer action, not a placeholder.

**Type consistency:** `synthesizeCommStyle(db, host)` and `getCommStyle(db)` / `setCommStyle(db, fields)` and `createGetCommStyleTool({db})` shapes are identical across tasks.
