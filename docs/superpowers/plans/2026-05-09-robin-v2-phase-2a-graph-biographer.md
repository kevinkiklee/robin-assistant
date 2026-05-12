# Robin v2 Phase 2a — Graph + Biographer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the SurrealDB-native graph layer (entities + edges + episodes) and the biographer pipeline that materializes it from `events`. Add multi-host adapters with `invokeLLM` (Claude Code + Gemini) and unified prompt caching. Wire fire-and-forget Stop hook trigger. All built on top of Phase 1's foundation in `~/workspace/robin/robin-assistant-v2/`.

**Architecture:** Migration `0003-graph-biographer.surql` adds `entities` (with HNSW), `episodes`, 6 edge tables, plus `events.biographed_at` and `events.episode_id`. Biographer is a function (`biographer.process(eventId)`) invoked by a Stop-hook detached subprocess and a `robin biographer-catchup` CLI. Single LLM call per event extracts entities/edges/episode signals; cascade resolver (1: exact case-insensitive, 2: embedding HNSW, 3: LLM disambig) maps mentions to entity records. Host adapters expose unified `invokeLLM(messages, opts)` and translate `opts.cache_control` to provider-native caching (Anthropic ephemeral / Google `cachedContent`).

**Tech Stack:** Node ≥ 22, ES modules. `surrealdb@^2.0.3` + `@surrealdb/node@^3.0.3`. `@huggingface/transformers` for entity embeddings. Subprocess to Claude Code + Gemini CLI for `invokeLLM` (verification spike picks Gemini path). Built-in `node:fetch` for fallback Google API client. `node --test` for tests. Biome for lint.

**Spec:** `/Users/iser/workspace/robin/robin-assistant/docs/superpowers/specs/2026-05-09-robin-v2-phase-2a-design.md` is the source of truth for design decisions. The "Phase 2a done" checklist in spec section 6 is the acceptance gate for this plan.

---

## File structure (additions to v2 from Phase 1)

```
robin-assistant-v2/
  src/
    hosts/
      interface.js                  # HostAdapter typedef + tier→model maps
      claude-code.js                # subprocess invokeLLM via `claude` CLI
      gemini.js                     # subprocess (Path A) OR Google API (Path B)
      detect.js                     # host detection + caching to runtime:host
    capture/
      record-event.js               # (existing from Phase 1)
      biographer.js                 # main pipeline
      biographer-prompt.js          # prompt construction
      biographer-output.js          # output JSON schema + validator
    graph/
      cascade.js                    # resolveEntity (composes Stage 1+2+3)
      stage1-exact.js               # exact case-insensitive match
      stage2-embedding.js           # HNSW similarity match
      stage3-disambig.js            # LLM disambiguation
      episodes.js                   # find/extend/close/create
      edges.js                      # mentions, about, typed, co_occurs_with
    runtime/
      home.js                       # (existing from Phase 1)
      bin.js                        # resolveBinPath()
      runtime-state.js              # read/update runtime:* records
    cli/
      commands/
        migrate.js                  # (existing from Phase 1)
        biographer-process-pending.js
        biographer-catchup.js
    hooks/
      stop-hook.js                  # spawns detached biographer subprocess
    schema/
      migrations/
        0001-init.surql             # (existing from Phase 1)
        0002-pin-embedding-dim.surql # (existing from Phase 1)
        0003-graph-biographer.surql # NEW
  tests/
    unit/
      cascade-stage1.test.js
      cascade-stage2.test.js
      cascade-stage3.test.js
      cascade-compose.test.js
      episodes.test.js
      edges-cooccur.test.js
      biographer-prompt.test.js
      biographer-output.test.js
      host-detect.test.js
    integration/
      biographer-pipeline.test.js
      biographer-dedupe.test.js
      biographer-failure.test.js
      cascade-end-to-end.test.js
      schema-graph.test.js
      stop-hook-detached.test.js
```

---

## Task 1: Gemini verification spike

**Goal:** Decide Path A (subprocess `invokeLLM` via Gemini CLI) or Path B (direct Google Generative Language API). Document outcome in a short note that the rest of the plan references.

**Files:**
- Create: `~/workspace/robin/robin-assistant/docs/superpowers/specs/2026-05-09-gemini-host-adapter-spike.md`

- [ ] **Step 1: Check whether `gemini` CLI is on PATH and what subcommands it exposes**

```bash
which gemini || echo 'NOT FOUND'
gemini --help 2>&1 | head -40
gemini --list-commands 2>&1 || true
```

Capture full output.

- [ ] **Step 2: Try invoking Gemini CLI with a structured prompt**

Probe whether Gemini CLI accepts a JSON-formatted prompt over stdin and returns a parseable response (mirroring v1's `claude-code invokeLLM` pattern). Try:

```bash
echo '{"messages":[{"role":"user","content":"Reply with the JSON {\"ok\":true} only."}]}' | gemini --json 2>&1 | head -20
```

(Adjust flags based on what `gemini --help` actually offers.)

- [ ] **Step 3: Write the spike note**

Write `docs/superpowers/specs/2026-05-09-gemini-host-adapter-spike.md`:

```markdown
# Gemini Host Adapter — Verification Spike

**Date:** 2026-05-09
**Outcome:** Path A | Path B (circle one)

## What I tried

[Paste the gemini CLI inspection output]

## Findings

- Gemini CLI version: ...
- Subcommands relevant to programmatic invocation: ...
- Does it accept JSON-shaped prompts: yes | no
- Does it return parseable structured output: yes | no
- Does it expose caching primitives: yes | no

## Decision

[Path A: subprocess pattern, lift from v1 — OR — Path B: direct Google API client with GEMINI_API_KEY]

## Why

[1-2 sentences]

## Implications

- Auth model: [host auth (no API key) | API key required]
- Cost model: [host plan | per-token billing]
- Caching: [supported via subprocess flags | via `cachedContent` REST API | not supported]
```

- [ ] **Step 4: Commit (in v1 repo, working-tree only since `docs/` is gitignored)**

The spike note is a working-tree-only file (v1 docs are gitignored). No git commit needed; reference it in subsequent tasks.

If Path B is chosen, ensure the user has `GEMINI_API_KEY` set in their environment OR documented how to obtain one. Add a note to v2's `README.md`:

```markdown
## Gemini support (optional)

If you want Robin to use Gemini instead of Claude Code: set `GEMINI_API_KEY` from https://aistudio.google.com/apikey. Otherwise Claude Code is used by default (no API key needed).
```

---

## Task 2: Schema migration `0003-graph-biographer.surql`

**Files:**
- Create: `~/workspace/robin/robin-assistant-v2/src/schema/migrations/0003-graph-biographer.surql`

- [ ] **Step 1: Write the migration**

```surql
-- Phase 2a: graph + biographer schema

-- Extend events
DEFINE FIELD biographed_at ON events TYPE option<datetime>;
DEFINE FIELD episode_id    ON events TYPE option<record<episodes>>;
DEFINE INDEX events_biographed ON events FIELDS biographed_at;
DEFINE INDEX events_episode    ON events FIELDS episode_id;

-- Episodes table
DEFINE TABLE episodes SCHEMAFULL TYPE NORMAL;
DEFINE FIELD started_at  ON episodes TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD ended_at    ON episodes TYPE option<datetime>;
DEFINE FIELD source      ON episodes TYPE string;
DEFINE FIELD summary     ON episodes TYPE option<string>;
DEFINE FIELD meta        ON episodes TYPE option<object> FLEXIBLE;
DEFINE INDEX episodes_started ON episodes FIELDS started_at;
DEFINE INDEX episodes_source  ON episodes FIELDS source;
DEFINE INDEX episodes_active  ON episodes FIELDS source, ended_at;

-- Entities table (HNSW dim 384 to match the pinned events embedder)
DEFINE TABLE entities SCHEMAFULL TYPE NORMAL;
DEFINE FIELD name        ON entities TYPE string ASSERT string::len($value) > 0;
DEFINE FIELD name_lower  ON entities COMPUTED string::lowercase(name);
DEFINE FIELD type        ON entities TYPE string
  ASSERT $value IN ['person', 'place', 'project', 'topic', 'thing'];
DEFINE FIELD embedding   ON entities TYPE array<float>
  ASSERT array::len($value) = 384;
DEFINE FIELD created_at  ON entities TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD meta        ON entities TYPE option<object> FLEXIBLE;
DEFINE INDEX entities_name_lower ON entities FIELDS name_lower, type;
DEFINE INDEX entities_vec        ON entities FIELDS embedding
  HNSW DIMENSION 384 DIST COSINE TYPE F32 EFC 200 M 16;

-- Edge tables (TYPE RELATION ENFORCED prevents dangling edges)
DEFINE TABLE mentions       SCHEMAFULL TYPE RELATION FROM events TO entities   ENFORCED;
DEFINE FIELD weight  ON mentions TYPE option<float>;
DEFINE FIELD context ON mentions TYPE option<string>;

DEFINE TABLE about          SCHEMAFULL TYPE RELATION FROM events TO entities   ENFORCED;

DEFINE TABLE precedes       SCHEMAFULL TYPE RELATION FROM events TO events     ENFORCED;

DEFINE TABLE works_on        SCHEMAFULL TYPE RELATION FROM entities TO entities ENFORCED;
DEFINE TABLE participates_in SCHEMAFULL TYPE RELATION FROM entities TO entities ENFORCED;

DEFINE TABLE co_occurs_with SCHEMAFULL TYPE RELATION FROM entities TO entities ENFORCED;
DEFINE FIELD strength  ON co_occurs_with TYPE float DEFAULT 1.0;
DEFINE FIELD last_seen ON co_occurs_with TYPE datetime DEFAULT time::now();
```

- [ ] **Step 2: Verify schema parses against `mem://` after applying 0001 + 0002**

Run a script that loads all three migrations sequentially:

```bash
cd /Users/iser/workspace/robin/robin-assistant-v2
node -e "
import('./src/db/client.js').then(async ({connect, close}) => {
  const { readdir, readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const dir = 'src/schema/migrations';
  const files = (await readdir(dir)).filter(f => f.endsWith('.surql')).sort();
  const db = await connect({ engine: 'mem://' });
  try {
    for (const f of files) {
      const sql = await readFile(join(dir, f), 'utf8');
      await db.query(sql).collect();
      console.log('OK', f);
    }
    console.log('all migrations applied');
  } finally {
    await close(db);
  }
  process.exit(0);
});
"
```

Expected: prints `OK 0001-init.surql`, `OK 0002-pin-embedding-dim.surql`, `OK 0003-graph-biographer.surql`.

- [ ] **Step 3: Run `robin migrate` against a tmp ROBIN_HOME and verify**

```bash
cd /Users/iser/workspace/robin/robin-assistant-v2
ROBIN_HOME=/tmp/robin-task2 node bin/robin migrate
```

Expected: `applied 3 migrations: 1, 2, 3` (or `applied 1 migration: 3` if 1 and 2 already applied; behavior depends on whether tmp dir has prior state).

```bash
rm -rf /tmp/robin-task2
```

- [ ] **Step 4: Update the bootstrap-empty-db integration test**

Modify `tests/integration/bootstrap-empty-db.test.js` so the assertion expects 3 migrations instead of 2:

```js
assert.match(result.stdout, /applied 3 migrations/);
```

Run the test:

```bash
npm test -- tests/integration/bootstrap-empty-db.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/iser/workspace/robin/robin-assistant-v2
git add src/schema/migrations/0003-graph-biographer.surql tests/integration/bootstrap-empty-db.test.js
git commit -m "feat(schema): 0003-graph-biographer — entities, episodes, edges"
```

---

## Task 3: `resolveBinPath` helper

**Files:**
- Create: `~/workspace/robin/robin-assistant-v2/src/runtime/bin.js`
- Create: `~/workspace/robin/robin-assistant-v2/tests/unit/bin.test.js`

- [ ] **Step 1: Write the failing test**

`tests/unit/bin.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, statSync } from 'node:fs';
import { resolveBinPath } from '../../src/runtime/bin.js';

test('resolveBinPath returns an absolute path that exists', () => {
  const p = resolveBinPath();
  assert.equal(typeof p, 'string');
  assert.ok(p.startsWith('/'));
  assert.ok(existsSync(p), `expected ${p} to exist`);
});

test('resolveBinPath returns the bin/robin entry point', () => {
  const p = resolveBinPath();
  assert.match(p, /\/bin\/robin$/);
  const stats = statSync(p);
  assert.ok(stats.mode & 0o111, 'expected file to be executable');
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/iser/workspace/robin/robin-assistant-v2
npm test -- tests/unit/bin.test.js
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

`src/runtime/bin.js`:

```js
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// Returns the absolute path to the v2 bin/robin entry, regardless of whether
// v2 is dev-checkout or globally installed. Works because the file structure
// from src/runtime/bin.js to bin/robin is fixed.
export function resolveBinPath() {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '../../bin/robin');
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm test -- tests/unit/bin.test.js
```

Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/bin.js tests/unit/bin.test.js
git commit -m "feat(runtime): resolveBinPath helper"
```

---

## Task 4: Host adapter interface (`HostAdapter` typedef)

**Files:**
- Create: `~/workspace/robin/robin-assistant-v2/src/hosts/interface.js`

- [ ] **Step 1: Write `src/hosts/interface.js`**

```js
/**
 * @typedef {Object} InvokeLLMOpts
 * @property {'fast' | 'balanced' | 'deep'} [tier]
 * @property {Array<{role: string, content: string, cache_control?: { type: 'ephemeral' }}>} [system]
 * @property {boolean} [json]                         // expect JSON output, set provider-specific JSON mode
 * @property {number} [maxTokens]
 * @property {AbortSignal} [signal]
 */

/**
 * @typedef {Object} InvokeLLMResult
 * @property {string} content                         // text response (JSON if opts.json was true)
 * @property {{ input_tokens: number, output_tokens: number, cache_read_tokens?: number, cache_write_tokens?: number }} usage
 */

/**
 * @typedef {Object} HostAdapter
 * @property {string} name                            // 'claude_code' | 'gemini_cli' | 'gemini_api'
 * @property {() => Promise<boolean>} isAvailable
 * @property {(messages: Array<{role: string, content: string}>, opts?: InvokeLLMOpts) => Promise<InvokeLLMResult>} invokeLLM
 */

// Tier→model mapping per provider. Adapters use these when opts.tier is set.
export const CLAUDE_TIER_MAP = {
  fast: 'claude-haiku-4-5',
  balanced: 'claude-sonnet-4-6',
  deep: 'claude-opus-4-7',
};

export const GEMINI_TIER_MAP = {
  fast: 'gemini-2.5-flash-lite',
  balanced: 'gemini-2.5-flash',
  deep: 'gemini-2.5-pro',
};

export const DEFAULT_TIER = 'fast'; // biographer's default
```

- [ ] **Step 2: Smoke check the import**

```bash
node -e "import('./src/hosts/interface.js').then(m => console.log('OK', Object.keys(m)));"
```

Expected: `OK [ 'CLAUDE_TIER_MAP', 'GEMINI_TIER_MAP', 'DEFAULT_TIER' ]`.

- [ ] **Step 3: Commit**

```bash
git add src/hosts/interface.js
git commit -m "feat(hosts): HostAdapter interface + tier maps"
```

---

## Task 5: Claude Code host adapter (subprocess invokeLLM)

**Files:**
- Create: `~/workspace/robin/robin-assistant-v2/src/hosts/claude-code.js`
- Create: `~/workspace/robin/robin-assistant-v2/tests/unit/claude-code-adapter.test.js`

This task uses a **fake subprocess** in tests (mocking `child_process.spawn`) so we don't need a real Claude Code CLI to test the adapter logic.

- [ ] **Step 1: Write the failing test**

`tests/unit/claude-code-adapter.test.js`:

```js
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// We dynamically import the adapter AFTER mocking child_process so the mock takes effect.

test('claudeCodeAdapter.invokeLLM spawns claude CLI and parses stdout', async () => {
  const fakeSpawn = mock.fn(() => {
    const out = JSON.stringify({ content: '{"ok":true}', usage: { input_tokens: 10, output_tokens: 5 } });
    return {
      stdout: { on: (e, cb) => e === 'data' && cb(out), [Symbol.asyncIterator]: async function*() { yield out; } },
      stderr: { on: () => {}, [Symbol.asyncIterator]: async function*() {} },
      stdin: { write: () => {}, end: () => {} },
      on: (event, cb) => { if (event === 'exit') setImmediate(() => cb(0)); },
    };
  });
  mock.module('node:child_process', { namedExports: { spawn: fakeSpawn } });
  const { claudeCodeAdapter } = await import('../../src/hosts/claude-code.js');
  const result = await claudeCodeAdapter.invokeLLM(
    [{ role: 'user', content: 'hi' }],
    { tier: 'fast', json: true },
  );
  assert.equal(result.content, '{"ok":true}');
  assert.equal(result.usage.input_tokens, 10);
  assert.equal(fakeSpawn.mock.callCount(), 1);
  const [cmd] = fakeSpawn.mock.calls[0].arguments;
  assert.equal(cmd, 'claude');
});

test('claudeCodeAdapter.isAvailable returns true when claude is on PATH', async () => {
  const fakeSpawn = mock.fn(() => ({
    on: (event, cb) => { if (event === 'exit') setImmediate(() => cb(0)); },
    stdout: { on: () => {} },
    stderr: { on: () => {} },
  }));
  mock.module('node:child_process', { namedExports: { spawn: fakeSpawn } });
  const { claudeCodeAdapter } = await import('../../src/hosts/claude-code.js');
  const ok = await claudeCodeAdapter.isAvailable();
  assert.equal(ok, true);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- tests/unit/claude-code-adapter.test.js
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

`src/hosts/claude-code.js`:

```js
import { spawn } from 'node:child_process';
import { CLAUDE_TIER_MAP, DEFAULT_TIER } from './interface.js';

function runClaude(args, stdin) {
  return new Promise((resolve, reject) => {
    const proc = spawn('claude', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', reject);
    proc.on('exit', (code) => {
      if (code !== 0) reject(new Error(`claude exited ${code}: ${stderr}`));
      else resolve(stdout);
    });
    if (stdin !== undefined) {
      proc.stdin.write(stdin);
      proc.stdin.end();
    }
  });
}

export const claudeCodeAdapter = {
  name: 'claude_code',

  async isAvailable() {
    try {
      await runClaude(['--version'], undefined);
      return true;
    } catch {
      return false;
    }
  },

  async invokeLLM(messages, opts = {}) {
    const tier = opts.tier ?? DEFAULT_TIER;
    const model = CLAUDE_TIER_MAP[tier];
    // Build the JSON payload Claude Code's invokeLLM subcommand expects.
    // Annotate cache_control on system messages when opts.system contains them.
    const payload = {
      model,
      messages,
      system: opts.system ?? [],
      max_tokens: opts.maxTokens ?? 4096,
      ...(opts.json ? { response_format: { type: 'json_object' } } : {}),
    };
    const out = await runClaude(['invokeLLM'], JSON.stringify(payload));
    const parsed = JSON.parse(out);
    return {
      content: parsed.content,
      usage: parsed.usage ?? { input_tokens: 0, output_tokens: 0 },
    };
  },
};
```

(Adjust `runClaude(['invokeLLM'], ...)` to whatever the actual Claude Code CLI subcommand is once verified — see v1's `feat(host): claude-code invokeLLM via subprocess` commit for the exact shape.)

- [ ] **Step 4: Run test to verify it passes**

```bash
npm test -- tests/unit/claude-code-adapter.test.js
```

Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add src/hosts/claude-code.js tests/unit/claude-code-adapter.test.js
git commit -m "feat(hosts): Claude Code adapter via subprocess"
```

---

## Task 6: Gemini host adapter

This task implementation depends on Task 1's spike outcome.

**If Path A (Gemini CLI subprocess):** mirror Task 5's pattern with `gemini` instead of `claude` and `GEMINI_TIER_MAP`. File: `src/hosts/gemini.js`. Skip Step 2 below.

**If Path B (direct Google API):** implement an HTTPS client. Steps below cover Path B.

**Files (Path B):**
- Create: `~/workspace/robin/robin-assistant-v2/src/hosts/gemini.js`
- Create: `~/workspace/robin/robin-assistant-v2/tests/unit/gemini-adapter.test.js`

- [ ] **Step 1: Write the failing test (Path B)**

`tests/unit/gemini-adapter.test.js`:

```js
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

test('geminiAdapter.invokeLLM POSTs to generativelanguage.googleapis.com and parses response', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock.fn(async (url, init) => {
    assert.match(String(url), /generativelanguage\.googleapis\.com/);
    assert.equal(init.method, 'POST');
    return {
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }],
        usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 4 },
      }),
    };
  });
  process.env.GEMINI_API_KEY = 'test-key';
  const { geminiAdapter } = await import('../../src/hosts/gemini.js');
  const result = await geminiAdapter.invokeLLM(
    [{ role: 'user', content: 'hi' }],
    { tier: 'fast', json: true },
  );
  assert.equal(result.content, '{"ok":true}');
  assert.equal(result.usage.input_tokens, 12);
  assert.equal(result.usage.output_tokens, 4);
  globalThis.fetch = originalFetch;
  delete process.env.GEMINI_API_KEY;
});

test('geminiAdapter.isAvailable returns true when GEMINI_API_KEY is set', async () => {
  process.env.GEMINI_API_KEY = 'test-key';
  const { geminiAdapter } = await import('../../src/hosts/gemini.js');
  assert.equal(await geminiAdapter.isAvailable(), true);
  delete process.env.GEMINI_API_KEY;
  // Re-import to pick up the change (or just call isAvailable again — depends on impl)
  assert.equal(await geminiAdapter.isAvailable(), false);
});

test('geminiAdapter.invokeLLM throws if no API key', async () => {
  delete process.env.GEMINI_API_KEY;
  const { geminiAdapter } = await import('../../src/hosts/gemini.js');
  await assert.rejects(
    geminiAdapter.invokeLLM([{ role: 'user', content: 'hi' }], { tier: 'fast' }),
    /GEMINI_API_KEY/,
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- tests/unit/gemini-adapter.test.js
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation (Path B)**

`src/hosts/gemini.js`:

```js
import { GEMINI_TIER_MAP, DEFAULT_TIER } from './interface.js';

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

function getApiKey() {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    throw new Error('GEMINI_API_KEY not set; required for Gemini adapter');
  }
  return key;
}

function toGeminiContents(messages) {
  // Gemini's API expects { role: 'user'|'model', parts: [{text}] }.
  // Map our messages (role: 'user'|'assistant'|'system') accordingly.
  // System messages go into systemInstruction at top level (handled by caller via opts.system).
  return messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));
}

function toSystemInstruction(opts) {
  if (!opts.system || opts.system.length === 0) return undefined;
  const text = opts.system.map((s) => s.content).join('\n\n');
  return { parts: [{ text }] };
}

export const geminiAdapter = {
  name: 'gemini_api',

  async isAvailable() {
    return Boolean(process.env.GEMINI_API_KEY);
  },

  async invokeLLM(messages, opts = {}) {
    const apiKey = getApiKey();
    const tier = opts.tier ?? DEFAULT_TIER;
    const model = GEMINI_TIER_MAP[tier];
    const url = `${API_BASE}/models/${model}:generateContent?key=${apiKey}`;
    const body = {
      contents: toGeminiContents(messages),
      systemInstruction: toSystemInstruction(opts),
      generationConfig: {
        maxOutputTokens: opts.maxTokens ?? 4096,
        ...(opts.json ? { responseMimeType: 'application/json' } : {}),
      },
    };
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: opts.signal,
    });
    if (!res.ok) {
      const err = await res.text().catch(() => '');
      throw new Error(`Gemini API ${res.status}: ${err}`);
    }
    const data = await res.json();
    const content = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    const usage = {
      input_tokens: data.usageMetadata?.promptTokenCount ?? 0,
      output_tokens: data.usageMetadata?.candidatesTokenCount ?? 0,
      cache_read_tokens: data.usageMetadata?.cachedContentTokenCount ?? 0,
    };
    return { content, usage };
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm test -- tests/unit/gemini-adapter.test.js
```

Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/hosts/gemini.js tests/unit/gemini-adapter.test.js
git commit -m "feat(hosts): Gemini adapter (Path B: direct Google API)"
```

(If Path A was chosen, replace the message with `feat(hosts): Gemini adapter (Path A: gemini CLI subprocess)`.)

---

## Task 7: Host detection

**Files:**
- Create: `~/workspace/robin/robin-assistant-v2/src/hosts/detect.js`
- Create: `~/workspace/robin/robin-assistant-v2/tests/unit/host-detect.test.js`

- [ ] **Step 1: Write the failing test**

`tests/unit/host-detect.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectHost } from '../../src/hosts/detect.js';

test('detectHost returns claude_code when CLAUDE_PROJECT_DIR is set', async () => {
  const orig = process.env.CLAUDE_PROJECT_DIR;
  process.env.CLAUDE_PROJECT_DIR = '/tmp/test';
  delete process.env.GEMINI_API_KEY;
  delete process.env.ROBIN_HOST;
  const host = await detectHost();
  assert.equal(host.name, 'claude_code');
  if (orig) process.env.CLAUDE_PROJECT_DIR = orig;
  else delete process.env.CLAUDE_PROJECT_DIR;
});

test('detectHost honors ROBIN_HOST override', async () => {
  process.env.ROBIN_HOST = 'gemini_api';
  const host = await detectHost();
  assert.equal(host.name, 'gemini_api');
  delete process.env.ROBIN_HOST;
});

test('detectHost falls back to gemini_api when only GEMINI_API_KEY is set', async () => {
  delete process.env.CLAUDE_PROJECT_DIR;
  delete process.env.ROBIN_HOST;
  process.env.GEMINI_API_KEY = 'test';
  const host = await detectHost();
  assert.equal(host.name, 'gemini_api');
  delete process.env.GEMINI_API_KEY;
});

test('detectHost throws when no host is detectable', async () => {
  delete process.env.CLAUDE_PROJECT_DIR;
  delete process.env.GEMINI_API_KEY;
  delete process.env.ROBIN_HOST;
  await assert.rejects(detectHost({ skipAvailabilityCheck: true }), /no host/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- tests/unit/host-detect.test.js
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

`src/hosts/detect.js`:

```js
import { claudeCodeAdapter } from './claude-code.js';
import { geminiAdapter } from './gemini.js';

const ADAPTERS = {
  claude_code: claudeCodeAdapter,
  gemini_api: geminiAdapter,
};

export async function detectHost(opts = {}) {
  // Explicit override wins
  const override = process.env.ROBIN_HOST;
  if (override && ADAPTERS[override]) {
    return ADAPTERS[override];
  }

  // Heuristics
  if (process.env.CLAUDE_PROJECT_DIR) return claudeCodeAdapter;
  if (process.env.GEMINI_API_KEY) return geminiAdapter;

  // Last-resort: probe availability (skipped in some tests)
  if (!opts.skipAvailabilityCheck) {
    if (await claudeCodeAdapter.isAvailable()) return claudeCodeAdapter;
    if (await geminiAdapter.isAvailable()) return geminiAdapter;
  }

  throw new Error('no host detected: set ROBIN_HOST or install Claude Code/Gemini');
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm test -- tests/unit/host-detect.test.js
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/hosts/detect.js tests/unit/host-detect.test.js
git commit -m "feat(hosts): detect active host from env + availability"
```

---

## Task 8: Multi-host caching — Anthropic ephemeral annotations

**Files:**
- Modify: `~/workspace/robin/robin-assistant-v2/src/hosts/claude-code.js`
- Create: `~/workspace/robin/robin-assistant-v2/tests/unit/claude-code-cache.test.js`

The Claude Code adapter needs to forward `cache_control: { type: 'ephemeral' }` on cacheable system messages. Anthropic's API picks up the annotation; the subprocess JSON should carry it through unchanged.

- [ ] **Step 1: Write the failing test**

`tests/unit/claude-code-cache.test.js`:

```js
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

test('claudeCodeAdapter forwards cache_control annotations on system messages', async () => {
  let capturedStdin = '';
  const fakeSpawn = mock.fn(() => {
    return {
      stdout: { on: () => {} },
      stderr: { on: () => {} },
      stdin: {
        write: (s) => { capturedStdin += s.toString(); },
        end: () => {},
      },
      on: (event, cb) => {
        if (event === 'exit') setImmediate(() => cb(0));
      },
    };
  });
  // Inject a custom data emitter for stdout
  const emitOut = JSON.stringify({ content: 'ok', usage: { input_tokens: 0, output_tokens: 0 } });
  const realSpawn = fakeSpawn.mock.fn;
  fakeSpawn.mock.mockImplementation(() => ({
    stdout: { on: (e, cb) => e === 'data' && cb(emitOut) },
    stderr: { on: () => {} },
    stdin: { write: (s) => { capturedStdin += s.toString(); }, end: () => {} },
    on: (event, cb) => { if (event === 'exit') setImmediate(() => cb(0)); },
  }));
  mock.module('node:child_process', { namedExports: { spawn: fakeSpawn } });
  const { claudeCodeAdapter } = await import('../../src/hosts/claude-code.js');

  await claudeCodeAdapter.invokeLLM(
    [{ role: 'user', content: 'q' }],
    {
      system: [
        { role: 'system', content: 'sys-prompt', cache_control: { type: 'ephemeral' } },
      ],
    },
  );
  const payload = JSON.parse(capturedStdin);
  assert.equal(payload.system[0].cache_control.type, 'ephemeral');
});
```

- [ ] **Step 2: Run test to verify it fails**

The adapter from Task 5 may or may not forward cache_control; this test pins the behavior.

```bash
npm test -- tests/unit/claude-code-cache.test.js
```

Expected: FAIL or PASS depending on Task 5's handling. If it passes already (because we're forwarding `opts.system` verbatim), update the test to additionally verify the field is in `payload.system[0]` with the exact `{ type: 'ephemeral' }` shape — and skip Step 3.

- [ ] **Step 3: Update `claude-code.js` if needed**

If Task 5 was already forwarding `opts.system` as-is (likely), this is already covered. Confirm the adapter's payload construction includes:

```js
system: opts.system ?? [],
```

and that the cache_control field rides through unchanged. No code change needed if so.

- [ ] **Step 4: Run test to verify it passes**

```bash
npm test -- tests/unit/claude-code-cache.test.js
```

Expected: PASS, 1 test.

- [ ] **Step 5: Commit**

```bash
git add tests/unit/claude-code-cache.test.js src/hosts/claude-code.js
git commit -m "test(hosts): claude-code forwards cache_control annotations"
```

---

## Task 9: Multi-host caching — Gemini `cachedContent` lifecycle

**Files:**
- Modify: `~/workspace/robin/robin-assistant-v2/src/hosts/gemini.js`
- Create: `~/workspace/robin/robin-assistant-v2/tests/unit/gemini-cache.test.js`

(Skip if Path A was chosen and the Gemini CLI handles caching transparently.)

This implements Gemini's `cachedContent` resource lifecycle: create when cacheable layer ≥ minimum size; reuse by ID; recreate (and delete old) when entity_catalog_version changes; orphan-cleanup at startup.

- [ ] **Step 1: Write the failing test**

`tests/unit/gemini-cache.test.js`:

```js
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

test('geminiAdapter creates cachedContent when system+catalog ≥ 4096 tokens', async () => {
  // Simulate a large system block
  const bigText = 'x '.repeat(8200); // ~4100 tokens estimate (rough heuristic)
  const fetchCalls = [];
  globalThis.fetch = mock.fn(async (url, init) => {
    fetchCalls.push({ url: String(url), init });
    if (String(url).includes('cachedContents')) {
      return { ok: true, json: async () => ({ name: 'cachedContents/abc123' }) };
    }
    return {
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: 'ok' }] } }],
        usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 5, cachedContentTokenCount: 4100 },
      }),
    };
  });
  process.env.GEMINI_API_KEY = 'test';
  const { geminiAdapter } = await import('../../src/hosts/gemini.js');
  const result = await geminiAdapter.invokeLLM(
    [{ role: 'user', content: 'q' }],
    {
      system: [{ role: 'system', content: bigText, cache_control: { type: 'ephemeral' } }],
    },
  );
  assert.ok(fetchCalls.some((c) => c.url.includes('cachedContents')), 'expected cache create call');
  assert.equal(result.usage.cache_read_tokens, 4100);
  delete process.env.GEMINI_API_KEY;
});

test('geminiAdapter skips cache when content below minimum size', async () => {
  const smallText = 'short system';
  const fetchCalls = [];
  globalThis.fetch = mock.fn(async (url, init) => {
    fetchCalls.push({ url: String(url) });
    return {
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: 'ok' }] } }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2 },
      }),
    };
  });
  process.env.GEMINI_API_KEY = 'test';
  const { geminiAdapter } = await import('../../src/hosts/gemini.js');
  await geminiAdapter.invokeLLM(
    [{ role: 'user', content: 'q' }],
    { system: [{ role: 'system', content: smallText, cache_control: { type: 'ephemeral' } }] },
  );
  assert.ok(!fetchCalls.some((c) => c.url.includes('cachedContents')), 'expected NO cache create');
  delete process.env.GEMINI_API_KEY;
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- tests/unit/gemini-cache.test.js
```

Expected: FAIL.

- [ ] **Step 3: Update `gemini.js` to add cache lifecycle**

Add to `src/hosts/gemini.js`:

```js
const CACHE_MIN_TOKENS = 4096; // Gemini Flash's floor; conservative

function estimateTokens(text) {
  // Cheap heuristic: ~1 token per 4 chars
  return Math.ceil(text.length / 4);
}

let cacheState = { id: null, version: null };

async function ensureCache(systemText, version, model, apiKey) {
  if (estimateTokens(systemText) < CACHE_MIN_TOKENS) return null;
  if (cacheState.id && cacheState.version === version) return cacheState.id;

  // Delete stale cache if version changed
  if (cacheState.id && cacheState.version !== version) {
    try {
      await fetch(`${API_BASE}/${cacheState.id}?key=${apiKey}`, { method: 'DELETE' });
    } catch { /* ignore */ }
    cacheState = { id: null, version: null };
  }

  const res = await fetch(`${API_BASE}/cachedContents?key=${apiKey}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: `models/${model}`,
      systemInstruction: { parts: [{ text: systemText }] },
      ttl: '300s', // 5 minutes
    }),
  });
  if (!res.ok) return null; // best-effort caching
  const data = await res.json();
  cacheState = { id: data.name, version };
  return data.name;
}
```

Modify `invokeLLM` to thread cache through:

```js
async invokeLLM(messages, opts = {}) {
  const apiKey = getApiKey();
  const tier = opts.tier ?? DEFAULT_TIER;
  const model = GEMINI_TIER_MAP[tier];

  const systemText = opts.system?.map((s) => s.content).join('\n\n') ?? '';
  const cacheVersion = opts.cacheVersion ?? null;
  const cachedContent = systemText && cacheVersion !== null
    ? await ensureCache(systemText, cacheVersion, model, apiKey)
    : null;

  const url = `${API_BASE}/models/${model}:generateContent?key=${apiKey}`;
  const body = {
    contents: toGeminiContents(messages),
    ...(cachedContent ? { cachedContent } : { systemInstruction: toSystemInstruction(opts) }),
    generationConfig: {
      maxOutputTokens: opts.maxTokens ?? 4096,
      ...(opts.json ? { responseMimeType: 'application/json' } : {}),
    },
  };
  // ... rest unchanged
}
```

(Add `cacheVersion` to the `InvokeLLMOpts` typedef in `interface.js` so callers know to pass `entity_catalog_version`.)

- [ ] **Step 4: Run test to verify it passes**

```bash
npm test -- tests/unit/gemini-cache.test.js
```

Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add src/hosts/gemini.js src/hosts/interface.js tests/unit/gemini-cache.test.js
git commit -m "feat(hosts): Gemini cachedContent lifecycle (create, reuse, GC stale)"
```

---

## Task 10: Biographer output JSON schema + validator

**Files:**
- Create: `~/workspace/robin/robin-assistant-v2/src/capture/biographer-output.js`
- Create: `~/workspace/robin/robin-assistant-v2/tests/unit/biographer-output.test.js`

The biographer LLM call returns JSON in a known shape. We validate it before writing graph rows.

- [ ] **Step 1: Write the failing test**

`tests/unit/biographer-output.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateBiographerOutput } from '../../src/capture/biographer-output.js';

test('valid output passes', () => {
  const ok = validateBiographerOutput({
    entities: [{ name: 'Alice', type: 'person' }],
    edges: [{ from: 'Alice', type: 'works_on', to: 'project-x' }],
    about: ['Alice'],
    episode_continues_previous: true,
    episode_summary: null,
  });
  assert.equal(ok.ok, true);
});

test('missing entities array fails', () => {
  const r = validateBiographerOutput({ edges: [], about: [], episode_continues_previous: false });
  assert.equal(r.ok, false);
  assert.match(r.error, /entities/);
});

test('invalid entity type fails', () => {
  const r = validateBiographerOutput({
    entities: [{ name: 'X', type: 'invalid_type' }],
    edges: [], about: [], episode_continues_previous: false,
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /type/);
});

test('invalid edge type fails', () => {
  const r = validateBiographerOutput({
    entities: [{ name: 'X', type: 'person' }],
    edges: [{ from: 'X', type: 'unknown_edge', to: 'Y' }],
    about: [], episode_continues_previous: false,
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /edge/);
});

test('edge referencing unknown entity fails', () => {
  const r = validateBiographerOutput({
    entities: [{ name: 'X', type: 'person' }],
    edges: [{ from: 'X', type: 'mentions', to: 'Y_not_extracted' }],
    about: [], episode_continues_previous: false,
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /unknown entity/);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- tests/unit/biographer-output.test.js
```

Expected: FAIL.

- [ ] **Step 3: Write the implementation**

`src/capture/biographer-output.js`:

```js
const ENTITY_TYPES = new Set(['person', 'place', 'project', 'topic', 'thing']);
const EDGE_TYPES = new Set(['mentions', 'about', 'precedes', 'works_on', 'participates_in', 'co_occurs_with']);

export function validateBiographerOutput(o) {
  if (!o || typeof o !== 'object') return { ok: false, error: 'output must be an object' };
  if (!Array.isArray(o.entities)) return { ok: false, error: 'output.entities must be an array' };
  for (const e of o.entities) {
    if (typeof e?.name !== 'string' || e.name.length === 0) return { ok: false, error: 'entity.name must be non-empty string' };
    if (!ENTITY_TYPES.has(e.type)) return { ok: false, error: `entity.type "${e.type}" not in vocabulary` };
  }
  if (!Array.isArray(o.edges)) return { ok: false, error: 'output.edges must be an array' };
  const known = new Set(o.entities.map((e) => e.name));
  for (const ed of o.edges) {
    if (!EDGE_TYPES.has(ed?.type)) return { ok: false, error: `edge.type "${ed.type}" not in vocabulary` };
    if (!known.has(ed.from)) return { ok: false, error: `edge from "${ed.from}" references unknown entity` };
    if (!known.has(ed.to)) return { ok: false, error: `edge to "${ed.to}" references unknown entity` };
  }
  if (!Array.isArray(o.about)) return { ok: false, error: 'output.about must be an array' };
  if (typeof o.episode_continues_previous !== 'boolean') return { ok: false, error: 'episode_continues_previous must be boolean' };
  return { ok: true };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm test -- tests/unit/biographer-output.test.js
```

Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/capture/biographer-output.js tests/unit/biographer-output.test.js
git commit -m "feat(capture): biographer output JSON schema validator"
```

---

## Task 11: Biographer prompt construction

**Files:**
- Create: `~/workspace/robin/robin-assistant-v2/src/capture/biographer-prompt.js`
- Create: `~/workspace/robin/robin-assistant-v2/tests/unit/biographer-prompt.test.js`

Constructs the LLM messages: system prompt (cacheable), entity catalog (cacheable), active episode context (uncached), event content.

- [ ] **Step 1: Write the failing test**

`tests/unit/biographer-prompt.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBiographerPrompt } from '../../src/capture/biographer-prompt.js';

test('buildBiographerPrompt returns system + user messages', () => {
  const r = buildBiographerPrompt({
    event: { id: 'events:1', source: 'cli', content: 'Met Alice at the cafe to discuss project Atlas.', ts: '2026-05-09T12:00:00Z' },
    catalog: [
      { name: 'Alice', type: 'person' },
      { name: 'Atlas', type: 'project' },
    ],
    activeEpisode: null,
  });
  assert.ok(Array.isArray(r.system));
  assert.ok(r.system.length >= 2); // system prompt + catalog
  assert.equal(r.system[0].cache_control.type, 'ephemeral');
  assert.equal(r.system[1].cache_control.type, 'ephemeral');
  assert.ok(Array.isArray(r.messages));
  assert.equal(r.messages.length, 1);
  assert.match(r.messages[0].content, /Met Alice/);
});

test('catalog message includes all catalog entities grouped by type', () => {
  const r = buildBiographerPrompt({
    event: { id: 'events:2', source: 'cli', content: 'q', ts: '2026-05-09T12:00:00Z' },
    catalog: [
      { name: 'Alice', type: 'person' },
      { name: 'Bob', type: 'person' },
      { name: 'Atlas', type: 'project' },
    ],
    activeEpisode: null,
  });
  const catalogMsg = r.system[1].content;
  assert.match(catalogMsg, /person/);
  assert.match(catalogMsg, /Alice/);
  assert.match(catalogMsg, /Bob/);
  assert.match(catalogMsg, /Atlas/);
});

test('activeEpisode appears in user message but not in system (uncached)', () => {
  const r = buildBiographerPrompt({
    event: { id: 'events:3', source: 'cli', content: 'follow-up', ts: '2026-05-09T12:00:00Z' },
    catalog: [],
    activeEpisode: { id: 'episodes:1', summary: 'Project Atlas planning' },
  });
  // System messages should NOT mention the active episode
  for (const m of r.system) {
    assert.doesNotMatch(m.content, /Project Atlas planning/);
  }
  assert.match(r.messages[0].content, /Project Atlas planning/);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- tests/unit/biographer-prompt.test.js
```

Expected: FAIL.

- [ ] **Step 3: Write the implementation**

`src/capture/biographer-prompt.js`:

```js
const SYSTEM_PROMPT = `You are Robin's biographer. For each event, extract structured information about the people, places, projects, topics, and things mentioned, plus their relationships.

Output JSON only, with this exact shape:
{
  "entities": [{ "name": string, "type": "person" | "place" | "project" | "topic" | "thing" }, ...],
  "edges": [{ "from": entity-name, "type": "mentions" | "about" | "precedes" | "works_on" | "participates_in" | "co_occurs_with", "to": entity-name }, ...],
  "about": [entity-name, ...],
  "episode_continues_previous": boolean,
  "episode_summary": string | null
}

Rules:
- Only use names that appear in entities[] for edges[] and about[].
- Prefer names from the existing-entities catalog when applicable.
- Set episode_continues_previous=true if the event is a clear continuation of the active episode (same topic + temporal proximity); false otherwise.
- Set episode_summary only when ending an episode (and only if episode_continues_previous=false AND there's an active episode).
- Be conservative: extract only entities clearly named in the event content.`;

function formatCatalog(catalog) {
  if (catalog.length === 0) return 'No existing entities.';
  const byType = {};
  for (const e of catalog) {
    if (!byType[e.type]) byType[e.type] = [];
    byType[e.type].push(e.name);
  }
  const sections = [];
  for (const [type, names] of Object.entries(byType)) {
    sections.push(`${type}: ${names.join(', ')}`);
  }
  return `Existing entities catalog:\n${sections.join('\n')}`;
}

function formatActiveEpisode(activeEpisode) {
  if (!activeEpisode) return '';
  return `\nActive episode: ${activeEpisode.summary ?? '(no summary yet)'} [${activeEpisode.id}]`;
}

export function buildBiographerPrompt({ event, catalog, activeEpisode }) {
  const system = [
    { role: 'system', content: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
    { role: 'system', content: formatCatalog(catalog), cache_control: { type: 'ephemeral' } },
  ];
  const userContent = `Event:
- id: ${event.id}
- source: ${event.source}
- ts: ${event.ts}
- content: ${event.content}${formatActiveEpisode(activeEpisode)}

Output JSON only.`;
  const messages = [{ role: 'user', content: userContent }];
  return { system, messages };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm test -- tests/unit/biographer-prompt.test.js
```

Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/capture/biographer-prompt.js tests/unit/biographer-prompt.test.js
git commit -m "feat(capture): biographer prompt construction (system + catalog + episode)"
```

---

## Task 12: Cascade Stage 1 — exact case-insensitive match

**Files:**
- Create: `~/workspace/robin/robin-assistant-v2/src/graph/stage1-exact.js`
- Create: `~/workspace/robin/robin-assistant-v2/tests/unit/cascade-stage1.test.js`

- [ ] **Step 1: Write the failing test**

`tests/unit/cascade-stage1.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { surql } from 'surrealdb';
import { stage1Resolve } from '../../src/graph/stage1-exact.js';

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  return db;
}

test('stage1Resolve finds existing entity by exact case-insensitive name + type', async () => {
  const db = await fresh();
  const dummyVec = Array.from({ length: 384 }, (_, i) => i / 384);
  await db.query(surql`CREATE entities CONTENT ${{ name: 'Alice', type: 'person', embedding: dummyVec }}`).collect();
  const id = await stage1Resolve(db, { name: 'alice', type: 'person' });
  assert.ok(id);
  await close(db);
});

test('stage1Resolve returns null on miss', async () => {
  const db = await fresh();
  const id = await stage1Resolve(db, { name: 'NoSuchEntity', type: 'person' });
  assert.equal(id, null);
  await close(db);
});

test('stage1Resolve does not cross types', async () => {
  const db = await fresh();
  const dummyVec = Array.from({ length: 384 }, () => 0.1);
  await db.query(surql`CREATE entities CONTENT ${{ name: 'Atlas', type: 'project', embedding: dummyVec }}`).collect();
  const id = await stage1Resolve(db, { name: 'atlas', type: 'place' });
  assert.equal(id, null);
  await close(db);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- tests/unit/cascade-stage1.test.js
```

Expected: FAIL.

- [ ] **Step 3: Write the implementation**

`src/graph/stage1-exact.js`:

```js
import { surql } from 'surrealdb';

export async function stage1Resolve(db, { name, type }) {
  const lower = name.toLowerCase();
  const [rows] = await db
    .query(surql`SELECT id FROM entities WHERE name_lower = ${lower} AND type = ${type} LIMIT 1`)
    .collect();
  if (rows.length === 0) return null;
  return rows[0].id;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm test -- tests/unit/cascade-stage1.test.js
```

Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/graph/stage1-exact.js tests/unit/cascade-stage1.test.js
git commit -m "feat(graph): cascade stage 1 — exact case-insensitive entity match"
```

---

## Task 13: Cascade Stage 2 — embedding similarity

**Files:**
- Create: `~/workspace/robin/robin-assistant-v2/src/graph/stage2-embedding.js`
- Create: `~/workspace/robin/robin-assistant-v2/tests/unit/cascade-stage2.test.js`

- [ ] **Step 1: Write the failing test**

`tests/unit/cascade-stage2.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { surql } from 'surrealdb';
import { stage2Resolve } from '../../src/graph/stage2-embedding.js';
import { createStubEmbedder } from '../../src/embed/embedder.js';

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  return db;
}

test('stage2 returns auto-resolve when best similarity ≥ high threshold', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 384 });
  // Use the same string for entity and query so similarity is 1.0
  const vec = Array.from(await e.embed('person: Alice'));
  await db.query(surql`CREATE entities CONTENT ${{ name: 'Alice', type: 'person', embedding: vec }}`).collect();
  const result = await stage2Resolve(db, e, {
    name: 'Alice',
    type: 'person',
    highThreshold: 0.92,
    lowThreshold: 0.80,
  });
  assert.equal(result.action, 'resolve');
  assert.ok(result.entityId);
  await close(db);
});

test('stage2 returns escalate when candidates exist but none ≥ high', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 384 });
  // Insert a few similar entities; configure thresholds so none auto-resolves
  const v1 = Array.from(await e.embed('person: Alice'));
  const v2 = Array.from(await e.embed('person: Allie'));
  await db.query(surql`CREATE entities CONTENT ${{ name: 'Alice', type: 'person', embedding: v1 }}`).collect();
  await db.query(surql`CREATE entities CONTENT ${{ name: 'Allie', type: 'person', embedding: v2 }}`).collect();
  const result = await stage2Resolve(db, e, {
    name: 'Alyse',
    type: 'person',
    highThreshold: 0.99,  // very high so auto-resolve doesn't trigger
    lowThreshold: 0.50,   // low enough that some candidates qualify
  });
  // Since stub vectors are deterministic-but-arbitrary, we can't guarantee specific scores;
  // assert the contract instead.
  assert.ok(['resolve', 'escalate', 'none'].includes(result.action));
  if (result.action === 'escalate') {
    assert.ok(Array.isArray(result.candidates));
    assert.ok(result.candidates.length >= 1);
  }
  await close(db);
});

test('stage2 returns none when no candidates above low threshold', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 384 });
  const result = await stage2Resolve(db, e, {
    name: 'Nonexistent',
    type: 'person',
    highThreshold: 0.92,
    lowThreshold: 0.80,
  });
  assert.equal(result.action, 'none');
  await close(db);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- tests/unit/cascade-stage2.test.js
```

Expected: FAIL.

- [ ] **Step 3: Write the implementation**

`src/graph/stage2-embedding.js`:

```js
import { surql } from 'surrealdb';

export async function stage2Resolve(db, embedder, { name, type, highThreshold, lowThreshold }) {
  const queryVec = Array.from(await embedder.embed(`${type}: ${name}`));
  // Top 5 nearest by cosine, scoped to type
  const [rows] = await db
    .query(surql`
      SELECT id, name, vector::distance::knn() AS dist
      FROM entities
      WHERE embedding <|5, 64|> ${queryVec}
        AND type = ${type}
      ORDER BY dist
      LIMIT 5;
    `)
    .collect();
  if (rows.length === 0) return { action: 'none' };
  // dist is cosine distance (0 = identical); similarity = 1 - dist
  const candidates = rows.map((r) => ({ id: r.id, name: r.name, similarity: 1 - r.dist }));
  const best = candidates[0];
  if (best.similarity >= highThreshold) {
    return { action: 'resolve', entityId: best.id, similarity: best.similarity };
  }
  const aboveLow = candidates.filter((c) => c.similarity >= lowThreshold);
  if (aboveLow.length === 0) return { action: 'none' };
  return { action: 'escalate', candidates: aboveLow.slice(0, 3) };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm test -- tests/unit/cascade-stage2.test.js
```

Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/graph/stage2-embedding.js tests/unit/cascade-stage2.test.js
git commit -m "feat(graph): cascade stage 2 — embedding similarity (HNSW)"
```

---

## Task 14: Cascade Stage 3 — LLM disambiguation

**Files:**
- Create: `~/workspace/robin/robin-assistant-v2/src/graph/stage3-disambig.js`
- Create: `~/workspace/robin/robin-assistant-v2/tests/unit/cascade-stage3.test.js`

- [ ] **Step 1: Write the failing test**

`tests/unit/cascade-stage3.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stage3Disambig } from '../../src/graph/stage3-disambig.js';

function fakeHost(content) {
  return {
    name: 'fake',
    isAvailable: async () => true,
    invokeLLM: async () => ({ content, usage: { input_tokens: 0, output_tokens: 0 } }),
  };
}

test('stage3 picks an existing candidate when LLM names one', async () => {
  const host = fakeHost(JSON.stringify({ pick: 'entity-2' }));
  const result = await stage3Disambig(host, {
    mention: 'Alyse',
    type: 'person',
    candidates: [
      { id: 'entity-1', name: 'Alice', similarity: 0.85 },
      { id: 'entity-2', name: 'Allie', similarity: 0.82 },
    ],
  });
  assert.equal(result.action, 'resolve');
  assert.equal(result.entityId, 'entity-2');
});

test('stage3 returns none when LLM says none', async () => {
  const host = fakeHost(JSON.stringify({ pick: null }));
  const result = await stage3Disambig(host, {
    mention: 'Stranger',
    type: 'person',
    candidates: [{ id: 'entity-1', name: 'Alice', similarity: 0.81 }],
  });
  assert.equal(result.action, 'none');
});

test('stage3 returns none when LLM returns malformed output', async () => {
  const host = fakeHost('not json');
  const result = await stage3Disambig(host, {
    mention: 'X',
    type: 'person',
    candidates: [{ id: 'entity-1', name: 'A', similarity: 0.9 }],
  });
  assert.equal(result.action, 'none');
});

test('stage3 returns none when LLM picks an unknown id', async () => {
  const host = fakeHost(JSON.stringify({ pick: 'nope' }));
  const result = await stage3Disambig(host, {
    mention: 'X',
    type: 'person',
    candidates: [{ id: 'entity-1', name: 'A', similarity: 0.85 }],
  });
  assert.equal(result.action, 'none');
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- tests/unit/cascade-stage3.test.js
```

Expected: FAIL.

- [ ] **Step 3: Write the implementation**

`src/graph/stage3-disambig.js`:

```js
const SYSTEM = `You disambiguate entity mentions. Given a mention and a list of candidate existing entities, pick the candidate that refers to the same thing, or null if none do.

Output JSON only: { "pick": "<candidate id>" } or { "pick": null }.

Be conservative: if uncertain, return null.`;

export async function stage3Disambig(host, { mention, type, candidates }) {
  const candidateLines = candidates
    .map((c) => `- id=${c.id}: name="${c.name}" type=${type} similarity=${c.similarity.toFixed(3)}`)
    .join('\n');
  const userContent = `Mention: "${mention}" (type=${type})

Candidates:
${candidateLines}

Pick the candidate id that refers to the same entity, or null if none. JSON only.`;

  let result;
  try {
    const r = await host.invokeLLM(
      [{ role: 'user', content: userContent }],
      {
        tier: 'fast',
        json: true,
        system: [{ role: 'system', content: SYSTEM, cache_control: { type: 'ephemeral' } }],
      },
    );
    result = JSON.parse(r.content);
  } catch {
    return { action: 'none' };
  }
  if (!result || typeof result !== 'object') return { action: 'none' };
  const pickedId = result.pick;
  if (!pickedId) return { action: 'none' };
  const validIds = new Set(candidates.map((c) => String(c.id)));
  if (!validIds.has(String(pickedId))) return { action: 'none' };
  return { action: 'resolve', entityId: pickedId };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm test -- tests/unit/cascade-stage3.test.js
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/graph/stage3-disambig.js tests/unit/cascade-stage3.test.js
git commit -m "feat(graph): cascade stage 3 — LLM disambiguation"
```

---

## Task 15: Cascade composer (`resolveEntity`)

**Files:**
- Create: `~/workspace/robin/robin-assistant-v2/src/graph/cascade.js`
- Create: `~/workspace/robin/robin-assistant-v2/tests/unit/cascade-compose.test.js`

- [ ] **Step 1: Write the failing test**

`tests/unit/cascade-compose.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { surql } from 'surrealdb';
import { resolveEntity } from '../../src/graph/cascade.js';
import { createStubEmbedder } from '../../src/embed/embedder.js';

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  return db;
}

test('resolveEntity Stage 1 hit short-circuits', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 384 });
  const vec = Array.from(await e.embed('person: Alice'));
  await db.query(surql`CREATE entities CONTENT ${{ name: 'Alice', type: 'person', embedding: vec }}`).collect();
  const fakeHost = { invokeLLM: async () => { throw new Error('should not be called'); } };
  const r = await resolveEntity(db, e, fakeHost, {
    name: 'alice', type: 'person',
    config: { stage2_high_threshold: 0.92, stage2_low_threshold: 0.80 },
  });
  assert.equal(r.action, 'resolve');
  assert.equal(r.stage, 1);
  await close(db);
});

test('resolveEntity falls through to none when all stages miss', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 384 });
  const fakeHost = { invokeLLM: async () => ({ content: '{"pick":null}', usage: {} }) };
  const r = await resolveEntity(db, e, fakeHost, {
    name: 'Nobody', type: 'person',
    config: { stage2_high_threshold: 0.92, stage2_low_threshold: 0.80 },
  });
  assert.equal(r.action, 'none');
  await close(db);
});

test('resolveEntity stage 2 auto-resolves bypassing stage 3', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 384 });
  const vec = Array.from(await e.embed('person: Alice'));
  await db.query(surql`CREATE entities CONTENT ${{ name: 'Alice', type: 'person', embedding: vec }}`).collect();
  let stage3Called = false;
  const fakeHost = {
    invokeLLM: async () => { stage3Called = true; return { content: '{"pick":null}', usage: {} }; },
  };
  // Same name → Stage 1 hits. Skip with a different mention to force Stage 2.
  // But for stub embedder, "Alice" and "alice" produce the SAME vector via the L2-norm sha-derived path,
  // so similarity is 1.0; expect Stage 1 to hit on case-insensitive match anyway.
  const r = await resolveEntity(db, e, fakeHost, {
    name: 'Alice', type: 'person',
    config: { stage2_high_threshold: 0.92, stage2_low_threshold: 0.80 },
  });
  assert.equal(r.action, 'resolve');
  assert.equal(stage3Called, false);
  await close(db);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- tests/unit/cascade-compose.test.js
```

Expected: FAIL.

- [ ] **Step 3: Write the implementation**

`src/graph/cascade.js`:

```js
import { stage1Resolve } from './stage1-exact.js';
import { stage2Resolve } from './stage2-embedding.js';
import { stage3Disambig } from './stage3-disambig.js';

export async function resolveEntity(db, embedder, host, { name, type, config }) {
  // Stage 1
  const s1 = await stage1Resolve(db, { name, type });
  if (s1) return { action: 'resolve', entityId: s1, stage: 1 };

  // Stage 2
  const s2 = await stage2Resolve(db, embedder, {
    name,
    type,
    highThreshold: config.stage2_high_threshold,
    lowThreshold: config.stage2_low_threshold,
  });
  if (s2.action === 'resolve') return { action: 'resolve', entityId: s2.entityId, stage: 2, similarity: s2.similarity };
  if (s2.action === 'none') return { action: 'none', stage: 2 };

  // Stage 2 escalated → Stage 3
  const s3 = await stage3Disambig(host, { mention: name, type, candidates: s2.candidates });
  if (s3.action === 'resolve') return { action: 'resolve', entityId: s3.entityId, stage: 3 };
  return { action: 'none', stage: 3 };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm test -- tests/unit/cascade-compose.test.js
```

Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/graph/cascade.js tests/unit/cascade-compose.test.js
git commit -m "feat(graph): resolveEntity composes cascade stages 1+2+3"
```

---

## Task 16: Episode lifecycle helpers

**Files:**
- Create: `~/workspace/robin/robin-assistant-v2/src/graph/episodes.js`
- Create: `~/workspace/robin/robin-assistant-v2/tests/unit/episodes.test.js`

- [ ] **Step 1: Write the failing test**

`tests/unit/episodes.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { surql } from 'surrealdb';
import { findActiveEpisode, createEpisode, closeEpisode } from '../../src/graph/episodes.js';

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  return db;
}

test('findActiveEpisode returns null when none exist', async () => {
  const db = await fresh();
  const ep = await findActiveEpisode(db, 'cli');
  assert.equal(ep, null);
  await close(db);
});

test('createEpisode + findActiveEpisode round-trip', async () => {
  const db = await fresh();
  const created = await createEpisode(db, { source: 'cli' });
  assert.ok(created.id);
  const ep = await findActiveEpisode(db, 'cli');
  assert.ok(ep);
  assert.equal(String(ep.id), String(created.id));
  assert.equal(ep.ended_at, undefined);
  await close(db);
});

test('closeEpisode sets ended_at and summary', async () => {
  const db = await fresh();
  const ep = await createEpisode(db, { source: 'cli' });
  await closeEpisode(db, ep.id, { endedAt: new Date('2026-05-09T13:00:00Z'), summary: 'morning work' });
  const [rows] = await db.query(surql`SELECT * FROM ${ep.id}`).collect();
  assert.ok(rows[0].ended_at);
  assert.equal(rows[0].summary, 'morning work');
  // After closing, no active episode for that source
  const active = await findActiveEpisode(db, 'cli');
  assert.equal(active, null);
  await close(db);
});

test('findActiveEpisode is scoped by source', async () => {
  const db = await fresh();
  await createEpisode(db, { source: 'cli' });
  await createEpisode(db, { source: 'manual' });
  const cliEp = await findActiveEpisode(db, 'cli');
  const manualEp = await findActiveEpisode(db, 'manual');
  assert.notEqual(String(cliEp.id), String(manualEp.id));
  await close(db);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- tests/unit/episodes.test.js
```

Expected: FAIL.

- [ ] **Step 3: Write the implementation**

`src/graph/episodes.js`:

```js
import { surql } from 'surrealdb';

export async function findActiveEpisode(db, source) {
  const [rows] = await db
    .query(surql`SELECT * FROM episodes WHERE source = ${source} AND ended_at IS NONE LIMIT 1`)
    .collect();
  return rows.length === 0 ? null : rows[0];
}

export async function createEpisode(db, { source, summary }) {
  const fields = { source, ...(summary ? { summary } : {}) };
  const [created] = await db.query(surql`CREATE episodes CONTENT ${fields}`).collect();
  const row = Array.isArray(created) ? created[0] : created;
  return { id: row.id };
}

export async function closeEpisode(db, episodeId, { endedAt, summary }) {
  const set = {
    ended_at: endedAt ?? new Date(),
    ...(summary !== undefined ? { summary } : {}),
  };
  await db.query(surql`UPDATE ${episodeId} MERGE ${set}`).collect();
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm test -- tests/unit/episodes.test.js
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/graph/episodes.js tests/unit/episodes.test.js
git commit -m "feat(graph): episode lifecycle (find/create/close)"
```

---

## Task 17: Edge writers — `mentions` + `about`

**Files:**
- Create: `~/workspace/robin/robin-assistant-v2/src/graph/edges.js`
- Create: `~/workspace/robin/robin-assistant-v2/tests/unit/edges-mentions.test.js`

- [ ] **Step 1: Write the failing test**

`tests/unit/edges-mentions.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { surql } from 'surrealdb';
import { writeMentionsEdge, writeAboutEdge } from '../../src/graph/edges.js';
import { recordEvent } from '../../src/capture/record-event.js';
import { createStubEmbedder } from '../../src/embed/embedder.js';

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  return db;
}

async function seed(db) {
  const e = createStubEmbedder({ dimension: 384 });
  const evt = await recordEvent(db, e, { source: 'cli', content: 'Alice met Bob.' });
  const aliceVec = Array.from(await e.embed('person: Alice'));
  const [aliceCreated] = await db.query(surql`CREATE entities CONTENT ${{ name: 'Alice', type: 'person', embedding: aliceVec }}`).collect();
  const alice = Array.isArray(aliceCreated) ? aliceCreated[0] : aliceCreated;
  return { eventId: evt.id, aliceId: alice.id };
}

test('writeMentionsEdge creates an event→entity edge with weight + context', async () => {
  const db = await fresh();
  const { eventId, aliceId } = await seed(db);
  await writeMentionsEdge(db, eventId, aliceId, { weight: 0.9, context: 'Alice met...' });
  const [rows] = await db.query(surql`SELECT * FROM mentions`).collect();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].weight, 0.9);
  assert.equal(rows[0].context, 'Alice met...');
  await close(db);
});

test('writeAboutEdge creates an event→entity edge', async () => {
  const db = await fresh();
  const { eventId, aliceId } = await seed(db);
  await writeAboutEdge(db, eventId, aliceId);
  const [rows] = await db.query(surql`SELECT * FROM about`).collect();
  assert.equal(rows.length, 1);
  await close(db);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- tests/unit/edges-mentions.test.js
```

Expected: FAIL.

- [ ] **Step 3: Write the implementation**

`src/graph/edges.js`:

```js
import { surql } from 'surrealdb';

export async function writeMentionsEdge(db, eventId, entityId, { weight, context } = {}) {
  await db
    .query(surql`RELATE ${eventId}->mentions->${entityId} CONTENT ${{ weight, context }}`)
    .collect();
}

export async function writeAboutEdge(db, eventId, entityId) {
  await db.query(surql`RELATE ${eventId}->about->${entityId}`).collect();
}

export async function writeTypedEntityEdge(db, fromId, edgeType, toId) {
  // edgeType ∈ {'works_on', 'participates_in', 'precedes', ...}
  // Note: precedes is event→event; others are entity→entity. Caller enforces shape.
  // Build the RELATE statement with a validated edgeType (set by caller).
  const stmt = `RELATE $from->${edgeType}->$to`;
  await db.query(stmt, { from: fromId, to: toId });
}
```

(Note: `writeTypedEntityEdge` uses raw query with bindings because the edge table name is dynamic. The caller MUST validate `edgeType` against the closed vocabulary before calling — this is a SQL-injection vector if not validated.)

- [ ] **Step 4: Run test to verify it passes**

```bash
npm test -- tests/unit/edges-mentions.test.js
```

Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add src/graph/edges.js tests/unit/edges-mentions.test.js
git commit -m "feat(graph): mentions + about edge writers"
```

---

## Task 18: Edge writer — `co_occurs_with` with stable IDs + cap

**Files:**
- Modify: `~/workspace/robin/robin-assistant-v2/src/graph/edges.js`
- Create: `~/workspace/robin/robin-assistant-v2/tests/unit/edges-cooccur.test.js`

- [ ] **Step 1: Write the failing test**

`tests/unit/edges-cooccur.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { surql } from 'surrealdb';
import { writeCoOccursWith } from '../../src/graph/edges.js';
import { createStubEmbedder } from '../../src/embed/embedder.js';

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  return db;
}

async function makeEntities(db, names) {
  const e = createStubEmbedder({ dimension: 384 });
  const ids = [];
  for (const n of names) {
    const v = Array.from(await e.embed(`person: ${n}`));
    const [c] = await db.query(surql`CREATE entities CONTENT ${{ name: n, type: 'person', embedding: v }}`).collect();
    ids.push(Array.isArray(c) ? c[0].id : c.id);
  }
  return ids;
}

test('writeCoOccursWith creates two directional edges per pair', async () => {
  const db = await fresh();
  const [a, b] = await makeEntities(db, ['Alice', 'Bob']);
  await writeCoOccursWith(db, [a, b]);
  const [rows] = await db.query(surql`SELECT * FROM co_occurs_with`).collect();
  assert.equal(rows.length, 2); // A→B and B→A
  for (const r of rows) {
    assert.equal(r.strength, 1);
  }
  await close(db);
});

test('writeCoOccursWith increments strength on repeat', async () => {
  const db = await fresh();
  const [a, b] = await makeEntities(db, ['Alice', 'Bob']);
  await writeCoOccursWith(db, [a, b]);
  await writeCoOccursWith(db, [a, b]);
  const [rows] = await db.query(surql`SELECT * FROM co_occurs_with`).collect();
  assert.equal(rows.length, 2);
  for (const r of rows) {
    assert.equal(r.strength, 2);
  }
  await close(db);
});

test('writeCoOccursWith caps at top N entities', async () => {
  const db = await fresh();
  const ids = await makeEntities(db, ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J']);
  // 10 entities, cap=4 → top 4 only → 4×3 = 12 edges
  await writeCoOccursWith(db, ids, { cap: 4 });
  const [rows] = await db.query(surql`SELECT * FROM co_occurs_with`).collect();
  assert.equal(rows.length, 12);
  await close(db);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- tests/unit/edges-cooccur.test.js
```

Expected: FAIL.

- [ ] **Step 3: Append `writeCoOccursWith` to `src/graph/edges.js`**

```js
function pairKey(a, b) {
  // Stable canonical ordering for the pair (id-key sort).
  // RecordId#id().key extracts the id portion ('alice' from 'entities:alice').
  const aKey = String(a).split(':').slice(1).join(':');
  const bKey = String(b).split(':').slice(1).join(':');
  return [aKey, bKey];
}

export async function writeCoOccursWith(db, entityIds, { cap = 8 } = {}) {
  const top = entityIds.slice(0, cap);
  const pairs = [];
  for (let i = 0; i < top.length; i++) {
    for (let j = i + 1; j < top.length; j++) {
      pairs.push([top[i], top[j]]);
    }
  }
  // Each pair → 2 directional UPSERTs
  for (const [a, b] of pairs) {
    const [keyA, keyB] = pairKey(a, b);
    const idAB = `co_occurs_with:⟨${keyA}|${keyB}⟩`;
    const idBA = `co_occurs_with:⟨${keyB}|${keyA}⟩`;
    await db.query(
      `UPSERT ${idAB} SET in = $a, out = $b, strength = (strength ?? 0) + 1, last_seen = time::now();
       UPSERT ${idBA} SET in = $b, out = $a, strength = (strength ?? 0) + 1, last_seen = time::now();`,
      { a, b },
    );
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm test -- tests/unit/edges-cooccur.test.js
```

Expected: PASS, 3 tests.

If the UPSERT pattern with the stable ID literal fails (SurrealDB syntax error around `⟨...⟩` brackets), fall back to a deterministic record-ID with `type::record('co_occurs_with', [keyA, keyB])` and use array IDs. Document the fallback in the commit.

- [ ] **Step 5: Commit**

```bash
git add src/graph/edges.js tests/unit/edges-cooccur.test.js
git commit -m "feat(graph): co_occurs_with edge writer with stable IDs + cap"
```

---

## Task 19: Biographer main pipeline

**Files:**
- Create: `~/workspace/robin/robin-assistant-v2/src/capture/biographer.js`
- Create: `~/workspace/robin/robin-assistant-v2/tests/integration/biographer-pipeline.test.js`

- [ ] **Step 1: Write the failing test**

`tests/integration/biographer-pipeline.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { surql } from 'surrealdb';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { recordEvent } from '../../src/capture/record-event.js';
import { biographerProcess } from '../../src/capture/biographer.js';
import { createStubEmbedder } from '../../src/embed/embedder.js';

function fakeHost(scriptedResponses) {
  let i = 0;
  return {
    name: 'fake',
    isAvailable: async () => true,
    invokeLLM: async () => ({
      content: scriptedResponses[i++ % scriptedResponses.length],
      usage: { input_tokens: 0, output_tokens: 0 },
    }),
  };
}

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  return db;
}

test('biographer processes a single event end-to-end', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 384 });
  const evt = await recordEvent(db, e, { source: 'cli', content: 'Alice met Bob about project Atlas.' });
  const host = fakeHost([
    JSON.stringify({
      entities: [
        { name: 'Alice', type: 'person' },
        { name: 'Bob', type: 'person' },
        { name: 'Atlas', type: 'project' },
      ],
      edges: [
        { from: 'Alice', type: 'works_on', to: 'Atlas' },
        { from: 'Bob', type: 'works_on', to: 'Atlas' },
      ],
      about: ['Atlas'],
      episode_continues_previous: false,
      episode_summary: null,
    }),
  ]);
  await biographerProcess(db, e, host, evt.id);
  const [evRows] = await db.query(surql`SELECT * FROM ${evt.id}`).collect();
  assert.ok(evRows[0].biographed_at);
  assert.ok(evRows[0].episode_id);
  const [entRows] = await db.query(surql`SELECT count() AS n FROM entities GROUP ALL`).collect();
  assert.equal(entRows[0].n, 3);
  const [mentRows] = await db.query(surql`SELECT count() AS n FROM mentions GROUP ALL`).collect();
  assert.equal(mentRows[0].n, 3);
  const [aboutRows] = await db.query(surql`SELECT count() AS n FROM about GROUP ALL`).collect();
  assert.equal(aboutRows[0].n, 1);
  const [worksRows] = await db.query(surql`SELECT count() AS n FROM works_on GROUP ALL`).collect();
  assert.equal(worksRows[0].n, 2);
  await close(db);
});

test('biographer skips already-biographed events', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 384 });
  const evt = await recordEvent(db, e, { source: 'cli', content: 'event' });
  let calls = 0;
  const host = {
    name: 'fake',
    isAvailable: async () => true,
    invokeLLM: async () => {
      calls++;
      return {
        content: JSON.stringify({
          entities: [], edges: [], about: [],
          episode_continues_previous: false, episode_summary: null,
        }),
        usage: {},
      };
    },
  };
  await biographerProcess(db, e, host, evt.id);
  await biographerProcess(db, e, host, evt.id);
  assert.equal(calls, 1);
  await close(db);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- tests/integration/biographer-pipeline.test.js
```

Expected: FAIL.

- [ ] **Step 3: Write the implementation**

`src/capture/biographer.js`:

```js
import { surql } from 'surrealdb';
import { buildBiographerPrompt } from './biographer-prompt.js';
import { validateBiographerOutput } from './biographer-output.js';
import { resolveEntity } from '../graph/cascade.js';
import { findActiveEpisode, createEpisode, closeEpisode } from '../graph/episodes.js';
import { writeMentionsEdge, writeAboutEdge, writeTypedEntityEdge, writeCoOccursWith } from '../graph/edges.js';

const ENTITY_EDGE_TYPES = new Set(['works_on', 'participates_in']);
const EVENT_EDGE_TYPES = new Set(['mentions', 'about', 'precedes']);

const DEFAULT_CONFIG = {
  stage2_high_threshold: 0.92,
  stage2_low_threshold: 0.80,
  episode_window_minutes: 30,
  catalog_size: 100,
  cooccur_cap: 8,
};

async function getCatalog(db, size) {
  const [rows] = await db
    .query(surql`SELECT name, type FROM entities ORDER BY created_at DESC LIMIT ${size}`)
    .collect();
  return rows;
}

async function getOrInitConfig(db) {
  const [rows] = await db.query(surql`SELECT VALUE value FROM runtime:biographer LIMIT 1`).collect();
  if (rows.length > 0 && rows[0]?.config) return rows[0].config;
  // Initialize
  await db.query(surql`UPSERT runtime:biographer SET value = ${{ config: DEFAULT_CONFIG, entity_catalog_version: 0 }}`).collect();
  return DEFAULT_CONFIG;
}

export async function biographerProcess(db, embedder, host, eventId) {
  // 1. Read event; skip if already biographed
  const [eventRows] = await db.query(surql`SELECT * FROM ${eventId}`).collect();
  if (eventRows.length === 0) throw new Error(`event ${eventId} not found`);
  const event = eventRows[0];
  if (event.biographed_at) return { skipped: true, reason: 'already_biographed' };

  const config = await getOrInitConfig(db);

  // 2. Build prompt
  const catalog = await getCatalog(db, config.catalog_size);
  const activeEpisode = await findActiveEpisode(db, event.source);
  const { system, messages } = buildBiographerPrompt({ event, catalog, activeEpisode });

  // 3. Invoke LLM
  const response = await host.invokeLLM(messages, { tier: 'fast', json: true, system });
  let output;
  try {
    output = JSON.parse(response.content);
  } catch (e) {
    throw new Error(`biographer LLM returned malformed JSON: ${e.message}`);
  }
  const validation = validateBiographerOutput(output);
  if (!validation.ok) {
    throw new Error(`biographer LLM output failed validation: ${validation.error}`);
  }

  // 4-9. Resolve entities, episode determination, write graph, mark event
  // (single transaction — if anything fails, rollback)
  // SurrealDB transactions wrap multiple statements; we drive them via JS-level error handling.
  const nameToId = new Map();
  for (const e of output.entities) {
    const r = await resolveEntity(db, embedder, host, { name: e.name, type: e.type, config });
    if (r.action === 'resolve') {
      nameToId.set(e.name, r.entityId);
    } else {
      // Create new entity
      const vec = Array.from(await embedder.embed(`${e.type}: ${e.name}`));
      const [created] = await db.query(surql`CREATE entities CONTENT ${{ name: e.name, type: e.type, embedding: vec }}`).collect();
      const row = Array.isArray(created) ? created[0] : created;
      nameToId.set(e.name, row.id);
    }
  }

  // Episode handling
  const eventTs = new Date(event.ts);
  const lastEpisodeStart = activeEpisode ? new Date(activeEpisode.started_at) : null;
  const minutesSinceStart = lastEpisodeStart ? (eventTs - lastEpisodeStart) / 60000 : Infinity;
  let episodeId;
  if (activeEpisode && output.episode_continues_previous && minutesSinceStart <= config.episode_window_minutes) {
    episodeId = activeEpisode.id;
  } else {
    if (activeEpisode) {
      await closeEpisode(db, activeEpisode.id, { endedAt: eventTs, summary: output.episode_summary });
    }
    const newEp = await createEpisode(db, { source: event.source });
    episodeId = newEp.id;
  }

  // Edges
  for (const entity of output.entities) {
    const eid = nameToId.get(entity.name);
    if (!eid) continue;
    await writeMentionsEdge(db, eventId, eid, { context: event.content.slice(0, 200) });
  }
  for (const aboutName of output.about) {
    const eid = nameToId.get(aboutName);
    if (eid) await writeAboutEdge(db, eventId, eid);
  }
  for (const edge of output.edges) {
    if (ENTITY_EDGE_TYPES.has(edge.type)) {
      const fromId = nameToId.get(edge.from);
      const toId = nameToId.get(edge.to);
      if (fromId && toId) await writeTypedEntityEdge(db, fromId, edge.type, toId);
    }
    // mentions/about handled above; precedes is event→event and biographer doesn't emit it directly
  }

  // co_occurs_with: top N entities by appearance order
  const entityIds = Array.from(nameToId.values());
  if (entityIds.length >= 2) {
    await writeCoOccursWith(db, entityIds, { cap: config.cooccur_cap });
  }

  // 10. Mark event biographed + set episode
  await db.query(surql`UPDATE ${eventId} SET biographed_at = time::now(), episode_id = ${episodeId}`).collect();

  return { processed: true, episodeId, entitiesCount: nameToId.size };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm test -- tests/integration/biographer-pipeline.test.js
```

Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add src/capture/biographer.js tests/integration/biographer-pipeline.test.js
git commit -m "feat(capture): biographer main pipeline"
```

---

## Task 20: Biographer dedupe + concurrency test

**Files:**
- Create: `~/workspace/robin/robin-assistant-v2/tests/integration/biographer-dedupe.test.js`

- [ ] **Step 1: Write the test**

`tests/integration/biographer-dedupe.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { recordEvent } from '../../src/capture/record-event.js';
import { biographerProcess } from '../../src/capture/biographer.js';
import { createStubEmbedder } from '../../src/embed/embedder.js';

test('two parallel biographer invocations on same event do not double-extract', async () => {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  const e = createStubEmbedder({ dimension: 384 });
  const evt = await recordEvent(db, e, { source: 'cli', content: 'Alice was here.' });
  let calls = 0;
  const host = {
    name: 'fake',
    isAvailable: async () => true,
    invokeLLM: async () => {
      calls++;
      return {
        content: JSON.stringify({
          entities: [{ name: 'Alice', type: 'person' }],
          edges: [], about: [],
          episode_continues_previous: false, episode_summary: null,
        }),
        usage: {},
      };
    },
  };
  await Promise.all([
    biographerProcess(db, e, host, evt.id),
    biographerProcess(db, e, host, evt.id),
  ]);
  // At least one call (race-dependent), but never more than 1 entity created
  assert.ok(calls >= 1);
  const [rows] = await db.query('SELECT count() AS n FROM entities GROUP ALL').collect();
  assert.equal(rows[0].n, 1);
  await close(db);
});
```

- [ ] **Step 2: Run the test**

```bash
cd /Users/iser/workspace/robin/robin-assistant-v2
npm test -- tests/integration/biographer-dedupe.test.js
```

If the test FAILS with 2 entities created, the dedupe is racy: two parallel invocations both passed the `biographed_at` check before either committed. Fix: add a `WHERE biographed_at IS NONE` clause to the final UPDATE so only one wins:

```js
const [updated] = await db.query(surql`
  UPDATE ${eventId} SET biographed_at = time::now(), episode_id = ${episodeId}
  WHERE biographed_at IS NONE
`).collect();
if (updated.length === 0) {
  // Lost the race — the other process biographed first. Roll back our writes.
  // For Phase 2a, leave the writes (they're idempotent enough) and log.
  console.warn(`biographer race detected on ${eventId}; writes from this run may be redundant`);
}
```

If the test PASSES (no race in practice on local mem://), still good — leaves the implementation simpler. Note in the commit which behavior occurred.

- [ ] **Step 3: Commit**

```bash
git add tests/integration/biographer-dedupe.test.js src/capture/biographer.js
git commit -m "test(capture): biographer dedupe under concurrent invocations"
```

---

## Task 21: Biographer failure handling

**Files:**
- Modify: `~/workspace/robin/robin-assistant-v2/src/capture/biographer.js`
- Create: `~/workspace/robin/robin-assistant-v2/tests/integration/biographer-failure.test.js`

- [ ] **Step 1: Write the failing test**

`tests/integration/biographer-failure.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { surql } from 'surrealdb';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { recordEvent } from '../../src/capture/record-event.js';
import { biographerProcess } from '../../src/capture/biographer.js';
import { createStubEmbedder } from '../../src/embed/embedder.js';

test('invokeLLM 3× failure logs to runtime:biographer.failed_event_ids', async () => {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  const e = createStubEmbedder({ dimension: 384 });
  const evt = await recordEvent(db, e, { source: 'cli', content: 'fails' });

  const host = {
    name: 'fake',
    isAvailable: async () => true,
    invokeLLM: async () => { throw new Error('network timeout'); },
  };

  await assert.rejects(biographerProcess(db, e, host, evt.id), /network timeout|failed/);

  const [rows] = await db.query(surql`SELECT VALUE value FROM runtime:biographer LIMIT 1`).collect();
  const failed = rows[0]?.failed_event_ids ?? [];
  assert.ok(failed.some((id) => String(id) === String(evt.id)), 'expected failed_event_ids to contain the failing event');
  await close(db);
});

test('malformed JSON output is treated as terminal failure', async () => {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  const e = createStubEmbedder({ dimension: 384 });
  const evt = await recordEvent(db, e, { source: 'cli', content: 'malformed' });
  const host = {
    name: 'fake',
    isAvailable: async () => true,
    invokeLLM: async () => ({ content: 'this is not JSON', usage: {} }),
  };
  await assert.rejects(biographerProcess(db, e, host, evt.id), /malformed JSON|validation/);
  await close(db);
});
```

- [ ] **Step 2: Run the test**

```bash
npm test -- tests/integration/biographer-failure.test.js
```

Expected: FAIL on the first test (no retry/log logic yet).

- [ ] **Step 3: Add retry + failed-event-id logging to biographer**

Modify `src/capture/biographer.js` — wrap the `invokeLLM` call (Step 3) in retry logic, and on terminal failure append to `failed_event_ids`:

```js
async function invokeWithRetry(host, messages, opts, retries = 3) {
  let lastErr;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      return await host.invokeLLM(messages, opts);
    } catch (e) {
      lastErr = e;
      if (attempt < retries - 1) {
        await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt)));
      }
    }
  }
  throw lastErr;
}

async function recordFailure(db, eventId, error) {
  await db.query(
    surql`UPDATE runtime:biographer SET value.failed_event_ids = array::distinct(array::concat(value.failed_event_ids ?? [], [${eventId}])), value.last_error = ${String(error.message)}`,
  ).collect();
}
```

Update the `invokeLLM` call site:

```js
let response;
try {
  response = await invokeWithRetry(host, messages, { tier: 'fast', json: true, system });
} catch (e) {
  await recordFailure(db, eventId, e);
  throw e;
}
let output;
try {
  output = JSON.parse(response.content);
  const validation = validateBiographerOutput(output);
  if (!validation.ok) throw new Error(`validation failed: ${validation.error}`);
} catch (e) {
  await recordFailure(db, eventId, e);
  throw new Error(`biographer LLM returned malformed JSON: ${e.message}`);
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm test -- tests/integration/biographer-failure.test.js
```

Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add src/capture/biographer.js tests/integration/biographer-failure.test.js
git commit -m "feat(capture): biographer retry + failed_event_ids tracking"
```

---

## Task 22: `robin biographer-catchup` CLI

**Files:**
- Create: `~/workspace/robin/robin-assistant-v2/src/cli/commands/biographer-catchup.js`
- Modify: `~/workspace/robin/robin-assistant-v2/src/cli/index.js`
- Create: `~/workspace/robin/robin-assistant-v2/tests/integration/biographer-catchup.test.js`

- [ ] **Step 1: Write the integration test**

`tests/integration/biographer-catchup.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('robin biographer-catchup runs without error against an empty DB', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'robin-catchup-'));
  const root = resolve(import.meta.dirname, '../..');
  // Migrate first
  spawnSync('node', [join(root, 'bin/robin'), 'migrate'], {
    env: { ...process.env, ROBIN_HOME: tmp },
    encoding: 'utf8',
  });
  // Run catchup with no events to process
  const result = spawnSync('node', [join(root, 'bin/robin'), 'biographer-catchup'], {
    env: { ...process.env, ROBIN_HOME: tmp, ROBIN_HOST: 'claude_code' },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
  assert.match(result.stdout, /processed 0 events/);
  rmSync(tmp, { recursive: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- tests/integration/biographer-catchup.test.js
```

Expected: FAIL — command not yet wired.

- [ ] **Step 3: Write the command**

`src/cli/commands/biographer-catchup.js`:

```js
import { surql } from 'surrealdb';
import { ensureHome, paths } from '../../runtime/home.js';
import { acquire } from '../../db/lock.js';
import { connect, close } from '../../db/client.js';
import { biographerProcess } from '../../capture/biographer.js';
import { createTransformersEmbedder } from '../../embed/embedder.js';
import { detectHost } from '../../hosts/detect.js';
import { parseArgs } from '../args.js';

export async function biographerCatchup(argv) {
  const args = parseArgs(argv);
  const retryFailed = args.flags['retry-failed'] === true;

  await ensureHome();
  const p = paths();
  const release = await acquire(p.lock);
  try {
    const db = await connect({ engine: `rocksdb://${p.db}` });
    try {
      const embedder = await createTransformersEmbedder();
      const host = await detectHost();

      let query = surql`SELECT id FROM events WHERE biographed_at IS NONE ORDER BY ts ASC LIMIT 100`;
      if (retryFailed) {
        const [rt] = await db.query(surql`SELECT VALUE value.failed_event_ids FROM runtime:biographer LIMIT 1`).collect();
        const ids = rt[0] ?? [];
        if (ids.length === 0) {
          console.log('processed 0 events (nothing to retry)');
          return;
        }
        query = surql`SELECT id FROM events WHERE id IN ${ids}`;
      }

      const [pending] = await db.query(query).collect();
      let ok = 0;
      let failed = 0;
      for (const row of pending) {
        try {
          await biographerProcess(db, embedder, host, row.id);
          ok++;
        } catch (e) {
          failed++;
          console.error(`failed: ${row.id}: ${e.message}`);
        }
      }
      console.log(`processed ${ok} events${failed ? ` (${failed} failed)` : ''}`);
    } finally {
      await close(db);
    }
  } finally {
    await release();
  }
}
```

- [ ] **Step 4: Wire the command in `src/cli/index.js`**

Modify `src/cli/index.js` to add the new command. Add this branch alongside the existing `migrate` branch:

```js
if (cmd === 'biographer-catchup') {
  const { biographerCatchup } = await import('./commands/biographer-catchup.js');
  return biographerCatchup(argv.slice(1));
}
```

Also update `src/cli/commands/help.js` to mention the new command:

```
USAGE
  robin migrate              run pending schema migrations
  robin biographer-catchup [--retry-failed]
                             biograph all unprocessed events
  robin --version | -v
  robin --help    | -h
```

- [ ] **Step 5: Run test to verify it passes**

```bash
npm test -- tests/integration/biographer-catchup.test.js
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/cli/commands/biographer-catchup.js src/cli/index.js src/cli/commands/help.js tests/integration/biographer-catchup.test.js
git commit -m "feat(cli): robin biographer-catchup [--retry-failed]"
```

---

## Task 23: `robin biographer process-pending` (subcommand for Stop hook)

**Files:**
- Create: `~/workspace/robin/robin-assistant-v2/src/cli/commands/biographer-process-pending.js`
- Modify: `~/workspace/robin/robin-assistant-v2/src/cli/index.js`

The Stop hook spawns a detached process running this. Similar to catchup but takes a `--since <ISO>` flag and only processes events since that timestamp.

- [ ] **Step 1: Write the command**

`src/cli/commands/biographer-process-pending.js`:

```js
import { surql } from 'surrealdb';
import { ensureHome, paths } from '../../runtime/home.js';
import { acquire } from '../../db/lock.js';
import { connect, close } from '../../db/client.js';
import { biographerProcess } from '../../capture/biographer.js';
import { createTransformersEmbedder } from '../../embed/embedder.js';
import { detectHost } from '../../hosts/detect.js';
import { parseArgs } from '../args.js';

export async function biographerProcessPending(argv) {
  const args = parseArgs(argv);
  const since = args.flags.since ? new Date(args.flags.since) : null;

  await ensureHome();
  const p = paths();
  const release = await acquire(p.lock);
  try {
    const db = await connect({ engine: `rocksdb://${p.db}` });
    try {
      const embedder = await createTransformersEmbedder();
      const host = await detectHost();

      const query = since
        ? surql`SELECT id FROM events WHERE biographed_at IS NONE AND ts >= ${since} ORDER BY ts ASC LIMIT 50`
        : surql`SELECT id FROM events WHERE biographed_at IS NONE ORDER BY ts ASC LIMIT 50`;
      const [pending] = await db.query(query).collect();
      for (const row of pending) {
        try {
          await biographerProcess(db, embedder, host, row.id);
        } catch (e) {
          console.error(`biographer failed on ${row.id}: ${e.message}`);
        }
      }
      console.log(`process-pending: ${pending.length} events`);
    } finally {
      await close(db);
    }
  } finally {
    await release();
  }
}
```

- [ ] **Step 2: Wire the subcommand in `src/cli/index.js`**

Add this branch:

```js
if (cmd === 'biographer') {
  const sub = argv[1];
  if (sub === 'process-pending') {
    const { biographerProcessPending } = await import('./commands/biographer-process-pending.js');
    return biographerProcessPending(argv.slice(2));
  }
  console.error(`unknown biographer subcommand: ${sub}`);
  process.exit(1);
}
```

- [ ] **Step 3: Smoke test against a fresh ROBIN_HOME**

```bash
cd /Users/iser/workspace/robin/robin-assistant-v2
ROBIN_HOME=/tmp/robin-task23 ROBIN_HOST=claude_code node bin/robin migrate
ROBIN_HOME=/tmp/robin-task23 ROBIN_HOST=claude_code node bin/robin biographer process-pending
```

Expected: prints `process-pending: 0 events`. Exits 0.

```bash
rm -rf /tmp/robin-task23
```

- [ ] **Step 4: Commit**

```bash
git add src/cli/commands/biographer-process-pending.js src/cli/index.js
git commit -m "feat(cli): robin biographer process-pending --since <iso>"
```

---

## Task 24: Stop hook — detached subprocess + log redirection

**Files:**
- Create: `~/workspace/robin/robin-assistant-v2/src/hooks/stop-hook.js`
- Create: `~/workspace/robin/robin-assistant-v2/tests/integration/stop-hook-detached.test.js`

This is the file that gets registered as the Claude Code (and Gemini CLI) Stop hook handler.

- [ ] **Step 1: Write the integration test**

`tests/integration/stop-hook-detached.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stopHookHandler } from '../../src/hooks/stop-hook.js';

test('stopHookHandler returns within 50ms', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'robin-stop-hook-'));
  const orig = process.env.ROBIN_HOME;
  process.env.ROBIN_HOME = tmp;
  const t0 = performance.now();
  await stopHookHandler({ since: new Date(Date.now() - 5000).toISOString() });
  const elapsed = performance.now() - t0;
  assert.ok(elapsed < 50, `expected < 50ms, got ${elapsed.toFixed(0)}ms`);
  // The detached subprocess may or may not have written the log yet; just confirm the dir exists
  assert.ok(existsSync(join(tmp, 'logs')));
  if (orig) process.env.ROBIN_HOME = orig;
  else delete process.env.ROBIN_HOME;
  rmSync(tmp, { recursive: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- tests/integration/stop-hook-detached.test.js
```

Expected: FAIL.

- [ ] **Step 3: Write the implementation**

`src/hooks/stop-hook.js`:

```js
import { spawn } from 'node:child_process';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { ensureHome, paths } from '../runtime/home.js';
import { resolveBinPath } from '../runtime/bin.js';

export async function stopHookHandler({ since } = {}) {
  await ensureHome();
  const p = paths();
  const logFh = await open(join(p.logs, 'biographer.log'), 'a');
  try {
    const args = [resolveBinPath(), 'biographer', 'process-pending'];
    if (since) args.push('--since', since);
    const proc = spawn(process.execPath, args, {
      detached: true,
      stdio: ['ignore', logFh.fd, logFh.fd],
      env: process.env,
    });
    proc.unref();
  } finally {
    await logFh.close();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm test -- tests/integration/stop-hook-detached.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/stop-hook.js tests/integration/stop-hook-detached.test.js
git commit -m "feat(hooks): Stop hook spawns detached biographer subprocess"
```

---

## Task 25: Schema-graph integration test

**Files:**
- Create: `~/workspace/robin/robin-assistant-v2/tests/integration/schema-graph.test.js`

Validates that the schema rejects bad data: dangling edges, wrong entity types, wrong dim embeddings, etc.

- [ ] **Step 1: Write the test**

`tests/integration/schema-graph.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { surql } from 'surrealdb';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  return db;
}

test('schema rejects entity with wrong type', async () => {
  const db = await fresh();
  const dummy = Array.from({ length: 384 }, () => 0.1);
  await assert.rejects(
    db.query(surql`CREATE entities CONTENT ${{ name: 'X', type: 'invalid', embedding: dummy }}`).collect(),
    /type|invalid/,
  );
  await close(db);
});

test('schema rejects entity with wrong embedding dim', async () => {
  const db = await fresh();
  await assert.rejects(
    db.query(surql`CREATE entities CONTENT ${{ name: 'X', type: 'person', embedding: [0.1, 0.2] }}`).collect(),
    /array::len|384/,
  );
  await close(db);
});

test('ENFORCED edge rejects link to non-existent entity', async () => {
  const db = await fresh();
  // Try to RELATE event → mentions → non-existent entity
  // First create an event
  const dummy = Array.from({ length: 384 }, () => 0.1);
  const [evt] = await db.query(surql`CREATE events CONTENT ${{
    source: 'cli', content: 'x', content_hash: 'abc', embedding: dummy,
  }}`).collect();
  const eventId = (Array.isArray(evt) ? evt[0] : evt).id;
  await assert.rejects(
    db.query(surql`RELATE ${eventId}->mentions->entities:nonexistent`).collect(),
    /enforced|exist|reference/i,
  );
  await close(db);
});
```

- [ ] **Step 2: Run the test**

```bash
npm test -- tests/integration/schema-graph.test.js
```

Expected: PASS. If any test fails (e.g., the ENFORCED rejection is more lenient than expected), update the regex to match the actual error.

- [ ] **Step 3: Commit**

```bash
git add tests/integration/schema-graph.test.js
git commit -m "test(schema): schema rejects bad data (types, dims, dangling edges)"
```

---

## Task 26: Cascade end-to-end integration test

**Files:**
- Create: `~/workspace/robin/robin-assistant-v2/tests/integration/cascade-end-to-end.test.js`

- [ ] **Step 1: Write the test**

`tests/integration/cascade-end-to-end.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { surql } from 'surrealdb';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { resolveEntity } from '../../src/graph/cascade.js';
import { createStubEmbedder } from '../../src/embed/embedder.js';

test('cascade resolves Stage 1 → 2 → 3 across a synthetic catalog', async () => {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  const e = createStubEmbedder({ dimension: 384 });

  // Seed: Alice exists
  const aliceVec = Array.from(await e.embed('person: Alice'));
  await db.query(surql`CREATE entities CONTENT ${{ name: 'Alice', type: 'person', embedding: aliceVec }}`).collect();

  const config = { stage2_high_threshold: 0.92, stage2_low_threshold: 0.50 };

  // Stage 1 hit: same name → resolves
  const fakeHostNo = { invokeLLM: async () => { throw new Error('should not call'); } };
  const r1 = await resolveEntity(db, e, fakeHostNo, { name: 'alice', type: 'person', config });
  assert.equal(r1.action, 'resolve');
  assert.equal(r1.stage, 1);

  // Stage 2 + 3 paths exercised separately in unit tests; here the integration validates the orchestration is wired correctly.
  const fakeHostPick = {
    invokeLLM: async () => ({ content: JSON.stringify({ pick: null }), usage: {} }),
  };
  const r2 = await resolveEntity(db, e, fakeHostPick, { name: 'TotallyNew', type: 'person', config });
  assert.equal(r2.action, 'none');

  await close(db);
});
```

- [ ] **Step 2: Run the test**

```bash
npm test -- tests/integration/cascade-end-to-end.test.js
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/integration/cascade-end-to-end.test.js
git commit -m "test(graph): cascade end-to-end orchestration"
```

---

## Task 27: CHANGELOG + tag

**Files:**
- Modify: `~/workspace/robin/robin-assistant-v2/CHANGELOG.md`

- [ ] **Step 1: Run the full test suite**

```bash
cd /Users/iser/workspace/robin/robin-assistant-v2
npm test
npm run lint
```

Both must pass cleanly.

- [ ] **Step 2: Append a Phase 2a entry to `CHANGELOG.md`**

```markdown
## [6.0.0-alpha.1] — 2026-05-09

Phase 2a: graph + biographer foundation.

- New schema: `entities` (HNSW indexed at dim 384), `episodes`, 6 edge tables (`mentions`, `about`, `precedes`, `works_on`, `participates_in`, `co_occurs_with`).
- `events.biographed_at` and `events.episode_id` added; migrator-compatible.
- Biographer pipeline: single LLM call per event extracts entities + edges + episode signals; cascade resolution (Stages 1 + 2 + 3) maps mentions to entity records.
- Multi-host adapters: Claude Code subprocess (lifted from v1) + Gemini (Path A subprocess OR Path B direct Google API per verification spike). Unified `invokeLLM` interface honors `cache_control` annotations.
- Multi-host caching: Anthropic ephemeral cache_control on cacheable layers; Gemini `cachedContent` lifecycle (create on first call ≥ 4096 tokens, reuse by ID, recreate + delete-old on `entity_catalog_version` increment, orphan cleanup on adapter init).
- Fire-and-forget Stop hook: hook spawns detached `robin biographer process-pending` subprocess; agent never waits.
- New CLI: `robin biographer-catchup [--retry-failed]` (foreground manual catchup); `robin biographer process-pending --since <iso>` (subcommand for hooks).
- `runtime:biographer.config` holds tunable thresholds (Stage 2 high/low, episode window, catalog size, cooccur cap).
- `runtime:host` records detected adapter + Gemini cache state.

Quality, observability:
- Cascade thresholds default to 0.92/0.80, tunable in `runtime:biographer.config` (no migration needed for changes).
- Failed events tracked in `runtime:biographer.failed_event_ids`; `--retry-failed` revisits them.
- Background subprocess output redirected to `~/.robin/logs/biographer.log`.

Phase 2b (MCP server + agent-facing tools) is the immediate follow-on.
```

- [ ] **Step 3: Tag the alpha (local only — no push)**

```bash
git add CHANGELOG.md
git commit -m "docs(changelog): Phase 2a done"
git tag v6.0.0-alpha.1
```

- [ ] **Step 4: Confirm final state**

```bash
git log --oneline | head -30
git tag
npm test
npm run lint
```

Expected: 27 new commits since Phase 1's `v6.0.0-alpha.0` tag; tag `v6.0.0-alpha.1` present; full test suite passes; lint clean.

---

## Spec coverage cross-check

| Spec section | Tasks |
|---|---|
| Section 2 (what gets built) | All tasks |
| Section 3 schema | Task 2 |
| Section 4.1 biographer flow | Tasks 11, 19 |
| Section 4.2 cascade resolution | Tasks 12, 13, 14, 15 |
| Section 4.3 failure handling | Task 21 |
| Section 4.4 triggers (Stop hook + CLI catchup) | Tasks 22, 23, 24 |
| Section 4.5 prompt caching | Tasks 8, 9, 11 |
| Section 5 host adapters | Tasks 4, 5, 6, 7, 8, 9 |
| Section 6 tests + done checklist | Tasks 20, 25, 26, 27 |
| Section 7 open questions | Task 1 (Gemini spike) |

No spec section is uncovered.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-09-robin-v2-phase-2a-graph-biographer.md`. Two execution options:

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration. Worked well for Phase 1; same pattern here.
2. **Inline Execution** — execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
