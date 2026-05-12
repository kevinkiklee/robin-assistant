# Robin v2 Phase 2c — Dream + Memory Shapes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build the dream agent (periodic LLM-driven synthesis), 4 new memory tables (knowledge/patterns/profile/threads), 2 derived views (journal/hot), the heuristic correction loop (rule_candidates + rules with MCP+CLI approval), 9 new MCP tools, 8 CLI commands, heartbeat-based scheduler, and AGENTS.md update — all on top of Phase 2b's MCP daemon.

**Architecture:** Dream runs inside the existing daemon process, triggered by heartbeat scheduler (nightly cron at 4 AM via `process.env.TZ`) or event-count overflow. Pipeline: knowledge synthesis → pattern detection → correction clustering (30-day rolling window with overlap dedupe) → profile inference (surfaces as candidates, never auto-applies) → thread updates → mark events dreamed. All LLM calls flow through `host.invokeLLM` subprocess (no direct API). Rules have `kind`+`payload` for replayability. MCP surface consolidated to 9 tools (`update_rule(id, action)` and `list_rules(status)` instead of 6 separate rule tools).

**Tech Stack:** Same as 2b — Node ≥ 22, ES modules, surrealdb@^2.0.3, @surrealdb/node@^3.0.3, @huggingface/transformers, @modelcontextprotocol/sdk, claude/gemini subprocess for LLM. node --test, Biome.

**Spec:** `/Users/iser/workspace/robin/robin-assistant/docs/superpowers/specs/2026-05-09-robin-v2-phase-2c-design.md` is the source of truth.

---

## File structure

```
robin-assistant-v2/
  src/
    daemon/
      scheduler.js                  # NEW: heartbeat scheduler
    dream/
      pipeline.js                   # NEW: dreamProcess orchestrator
      step-knowledge.js             # NEW: step 2 — knowledge synthesis
      step-patterns.js              # NEW: step 3 — pattern detection
      step-corrections.js           # NEW: step 4 — correction clustering
      step-profile.js               # NEW: step 5 — profile candidate surfacing
      step-threads.js               # NEW: step 6 — thread updates
      prompts.js                    # NEW: dream LLM prompts (knowledge, patterns, corrections, profile)
    memory/
      knowledge.js                  # NEW: read/write helpers
      patterns.js                   # NEW
      profile.js                    # NEW
      threads.js                    # NEW
      journal.js                    # NEW: derived view
      hot.js                        # NEW: derived view
    rules/
      candidates.js                 # NEW: rule_candidates CRUD + dedupe
      rules.js                      # NEW: rules CRUD + apply (incl. profile_update payload)
    mcp/tools/
      get-knowledge.js              # NEW MCP tool
      list-patterns.js              # NEW
      get-profile.js                # NEW
      list-threads.js               # NEW
      list-journal.js               # NEW
      get-hot.js                    # NEW
      list-rules.js                 # NEW (consolidated)
      update-rule.js                # NEW (consolidated)
      run-dream.js                  # NEW
    cli/commands/
      dream-run.js                  # NEW: robin dream run
      rules-pending.js              # NEW: robin rules pending
      rules-approve.js              # NEW: robin rules approve <id>
      rules-reject.js               # NEW: robin rules reject <id> [reason]
      rules-list.js                 # NEW: robin rules list
      rules-deactivate.js           # NEW: robin rules deactivate <id>
      journal.js                    # NEW: robin journal
      hot.js                        # NEW: robin hot
    schema/migrations/
      0005-dream-and-memory.surql   # NEW
    install/
      agents-md.js                  # MODIFY: add active-rules + pending-rules sections
    hosts/
      claude-code.js                # MODIFY (Task 0): real `claude -p` args + JSON output
  tests/
    unit/
      scheduler-heartbeat.test.js
      dream-step-knowledge.test.js
      dream-step-patterns.test.js
      dream-step-corrections.test.js
      dream-step-profile.test.js
      dream-step-threads.test.js
      memory-knowledge.test.js
      memory-patterns.test.js
      memory-profile.test.js
      memory-threads.test.js
      memory-journal.test.js
      memory-hot.test.js
      rules-candidates.test.js
      rules-apply.test.js
      tool-get-knowledge.test.js
      tool-list-patterns.test.js
      tool-get-profile.test.js
      tool-list-threads.test.js
      tool-list-journal.test.js
      tool-get-hot.test.js
      tool-list-rules.test.js
      tool-update-rule.test.js
      tool-run-dream.test.js
      claude-code-real-args.test.js  # Task 0
    integration/
      dream-full-cycle.test.js
      rule-approval-roundtrip.test.js
      profile-candidate-flow.test.js
      scheduler-overflow.test.js
      agents-md-rules.test.js
```

---

## Task 0: Fix Phase 2a Claude Code adapter args (real `claude -p`)

**Files:**
- Modify: `src/hosts/claude-code.js`
- Update: `tests/unit/claude-code-adapter.test.js` (existing) — assertions should reflect real args
- Create: `tests/unit/claude-code-real-args.test.js` — pinned-args test

This is a prerequisite per spec section 1's pre-2c fix. The Phase 2a adapter passes `['invokeLLM']` as args and JSON on stdin; the real `claude` CLI uses `claude -p <prompt>` (matches Gemini's pattern from the spike).

- [ ] **Step 1: Inspect real Claude Code CLI flags**

```bash
claude --help 2>&1 | grep -iE 'print|json|model|output|format' | head -20
```

Capture relevant flags. The expected pattern (matching v1 + Gemini spike) is `claude -p <prompt>` with JSON output flag — likely `--output-format=json` or `-o json` based on common CLI patterns.

- [ ] **Step 2: Write failing pinned-args test**

`tests/unit/claude-code-real-args.test.js`:

```js
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { createClaudeCodeAdapter } from '../../src/hosts/claude-code.js';

function captureSpawn(stdout) {
  const calls = [];
  const fakeSpawn = mock.fn((cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return {
      stdout: { on: (e, cb) => e === 'data' && setImmediate(() => cb(Buffer.from(stdout))) },
      stderr: { on: () => {} },
      stdin: { write: () => {}, end: () => {} },
      on: (event, cb) => { if (event === 'exit') setImmediate(() => cb(0)); },
    };
  });
  return { fakeSpawn, calls };
}

test('claude adapter spawns `claude -p <prompt>` with JSON output flag', async () => {
  // Real claude CLI returns a JSON envelope similar to Gemini's: { result, usage, ... }
  const envelope = JSON.stringify({
    type: 'result',
    result: '{"ok":true}',
    usage: { input_tokens: 12, output_tokens: 4 },
  });
  const { fakeSpawn, calls } = captureSpawn(envelope);
  const adapter = createClaudeCodeAdapter({ spawn: fakeSpawn });
  const r = await adapter.invokeLLM(
    [{ role: 'user', content: 'hi' }],
    { tier: 'fast', json: true },
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'claude');
  // -p with prompt + JSON output flag
  assert.ok(calls[0].args.includes('-p'), `args missing -p: ${calls[0].args}`);
  assert.ok(
    calls[0].args.includes('--output-format=json') || calls[0].args.includes('-o') || calls[0].args.includes('json'),
    `args missing JSON output flag: ${calls[0].args}`,
  );
  assert.equal(r.content, '{"ok":true}');
  assert.equal(r.usage.input_tokens, 12);
  assert.equal(r.usage.output_tokens, 4);
});
```

- [ ] **Step 3: Run test to confirm failure**

```bash
cd /Users/iser/workspace/robin/robin-assistant-v2
npm test -- tests/unit/claude-code-real-args.test.js
```

Expected: FAIL — current adapter uses `['invokeLLM']` not `['-p', ...]`.

- [ ] **Step 4: Update `src/hosts/claude-code.js`**

Read the current file first. Replace the `invokeLLM` body so it builds args like:

```js
import { spawn as nodeSpawn } from 'node:child_process';
import { CLAUDE_TIER_MAP, DEFAULT_TIER } from './interface.js';

function runClaude(spawnFn, args, stdin) {
  return new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawnFn('claude', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) { reject(e); return; }
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', reject);
    proc.on('exit', (code) => {
      if (code !== 0) reject(new Error(`claude exited ${code}: ${stderr}`));
      else resolve(stdout);
    });
    if (stdin !== undefined && proc.stdin) {
      proc.stdin.write(stdin);
      proc.stdin.end();
    }
  });
}

function messagesToPrompt(messages, system) {
  const sysText = (system ?? []).map((s) => s.content).join('\n\n');
  const conv = messages.map((m) => `${m.role.toUpperCase()}: ${m.content}`).join('\n');
  return sysText ? `${sysText}\n\n${conv}` : conv;
}

function summarizeUsage(envelope) {
  const u = envelope?.usage ?? {};
  return {
    input_tokens: u.input_tokens ?? u.prompt_tokens ?? 0,
    output_tokens: u.output_tokens ?? u.candidates_tokens ?? 0,
    cache_read_tokens: u.cache_read_tokens ?? u.cache_read_input_tokens ?? 0,
  };
}

export function createClaudeCodeAdapter(deps = {}) {
  const spawnFn = deps.spawn ?? nodeSpawn;
  return {
    name: 'claude_code',
    async isAvailable() {
      try { await runClaude(spawnFn, ['--version'], undefined); return true; }
      catch { return false; }
    },
    async invokeLLM(messages, opts = {}) {
      const tier = opts.tier ?? DEFAULT_TIER;
      const model = CLAUDE_TIER_MAP[tier];
      const prompt = messagesToPrompt(messages, opts.system);
      const args = ['-p', prompt, '--output-format=json', '--model', model];
      const out = await runClaude(spawnFn, args, undefined);
      let parsed;
      try { parsed = JSON.parse(out); }
      catch (e) { throw new Error(`claude stdout was not valid JSON: ${e.message}`); }
      // Real envelope: { type: 'result', result: '...', usage: {...} }
      const content = parsed.result ?? parsed.content ?? '';
      return { content, usage: summarizeUsage(parsed) };
    },
  };
}

export const claudeCodeAdapter = createClaudeCodeAdapter();
```

- [ ] **Step 5: Update existing `tests/unit/claude-code-adapter.test.js`**

Read it first. Update the existing assertions about `args[0] === 'invokeLLM'` to expect the new `-p` form. Adjust fake stdout to envelope shape `{ type: 'result', result: '...', usage: {...} }`.

- [ ] **Step 6: Run all claude-related tests**

```bash
npm test -- tests/unit/claude-code-adapter.test.js tests/unit/claude-code-cache.test.js tests/unit/claude-code-real-args.test.js
```

Expected: all pass. (Cache test still passes because `system` arg flows through `messagesToPrompt` which preserves the content.)

- [ ] **Step 7: Run full suite + lint**

```bash
npm test
npm run lint
```

Expected: 189 (unchanged) tests pass. If anything breaks, the cache test may need a small update to assert against the prompt shape rather than `payload.system[0]`.

- [ ] **Step 8: Commit**

```bash
git add src/hosts/claude-code.js tests/unit/claude-code-adapter.test.js tests/unit/claude-code-cache.test.js tests/unit/claude-code-real-args.test.js
git commit -m "fix(hosts): claude adapter uses real \`claude -p\` args + JSON envelope"
```

---

## Task 1: Schema migration `0005-dream-and-memory.surql`

**Files:**
- Create: `src/schema/migrations/0005-dream-and-memory.surql`
- Modify: `tests/integration/bootstrap-empty-db.test.js` (5 migrations now)

- [ ] **Step 1: Write the migration**

`src/schema/migrations/0005-dream-and-memory.surql`:

```surql
-- Phase 2c: dream + memory shapes + heuristic loop

-- Extend events
DEFINE FIELD dreamed_at ON events TYPE option<datetime>;
DEFINE INDEX events_dreamed ON events FIELDS dreamed_at;

-- knowledge
DEFINE TABLE knowledge SCHEMAFULL TYPE NORMAL;
DEFINE FIELD content         ON knowledge TYPE string ASSERT string::len($value) > 0;
DEFINE FIELD content_hash    ON knowledge TYPE string;
DEFINE FIELD subject_id      ON knowledge TYPE option<record<entities>>;
DEFINE FIELD confidence      ON knowledge TYPE float ASSERT $value >= 0 AND $value <= 1;
DEFINE FIELD source_events   ON knowledge TYPE array<record<events>>;
DEFINE FIELD source_episodes ON knowledge TYPE array<record<episodes>>;
DEFINE FIELD created_at      ON knowledge TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD updated_at      ON knowledge TYPE datetime VALUE time::now();
DEFINE FIELD embedding       ON knowledge TYPE array<float> ASSERT array::len($value) = 384;
DEFINE FIELD meta            ON knowledge TYPE option<object> FLEXIBLE;
DEFINE INDEX knowledge_subject ON knowledge FIELDS subject_id;
DEFINE INDEX knowledge_chash   ON knowledge FIELDS content_hash;
DEFINE INDEX knowledge_vec     ON knowledge FIELDS embedding HNSW DIMENSION 384 DIST COSINE TYPE F32 EFC 200 M 16;

-- patterns
DEFINE TABLE patterns SCHEMAFULL TYPE NORMAL;
DEFINE FIELD name          ON patterns TYPE string ASSERT string::len($value) > 0;
DEFINE FIELD description   ON patterns TYPE string;
DEFINE FIELD signal_count  ON patterns TYPE int DEFAULT 1;
DEFINE FIELD last_signal   ON patterns TYPE datetime DEFAULT time::now();
DEFINE FIELD strength      ON patterns TYPE float DEFAULT 1.0;
DEFINE FIELD source_events ON patterns TYPE array<record<events>>;
DEFINE FIELD created_at    ON patterns TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD meta          ON patterns TYPE option<object> FLEXIBLE;
DEFINE INDEX patterns_name ON patterns FIELDS name;

-- profile
DEFINE TABLE profile SCHEMAFULL TYPE NORMAL;
DEFINE FIELD name         ON profile TYPE option<string>;
DEFINE FIELD display_name ON profile TYPE option<string>;
DEFINE FIELD pronouns     ON profile TYPE option<string>;
DEFINE FIELD timezone     ON profile TYPE option<string>;
DEFINE FIELD interests    ON profile TYPE option<array<string>>;
DEFINE FIELD updated_at   ON profile TYPE datetime VALUE time::now();
DEFINE FIELD meta         ON profile TYPE option<object> FLEXIBLE;

-- threads
DEFINE TABLE threads SCHEMAFULL TYPE NORMAL;
DEFINE FIELD title       ON threads TYPE option<string>;
DEFINE FIELD started_at  ON threads TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD last_active ON threads TYPE datetime DEFAULT time::now();
DEFINE FIELD episode_ids ON threads TYPE array<record<episodes>>;
DEFINE FIELD entity_ids  ON threads TYPE array<record<entities>>;
DEFINE FIELD summary     ON threads TYPE option<string>;
DEFINE FIELD meta        ON threads TYPE option<object> FLEXIBLE;
DEFINE INDEX threads_last_active ON threads FIELDS last_active;

-- rule_candidates
DEFINE TABLE rule_candidates SCHEMAFULL TYPE NORMAL;
DEFINE FIELD content          ON rule_candidates TYPE string;
DEFINE FIELD kind             ON rule_candidates TYPE string
  ASSERT $value IN ['behavior', 'profile_update', 'conflict_warning'];
DEFINE FIELD signal_events    ON rule_candidates TYPE array<record<events>>;
DEFINE FIELD payload          ON rule_candidates TYPE option<object> FLEXIBLE;
DEFINE FIELD confidence       ON rule_candidates TYPE float ASSERT $value >= 0 AND $value <= 1;
DEFINE FIELD status           ON rule_candidates TYPE string
  ASSERT $value IN ['pending', 'approved', 'rejected', 'expired'];
DEFINE FIELD created_at       ON rule_candidates TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD reviewed_at      ON rule_candidates TYPE option<datetime>;
DEFINE FIELD rejected_reason  ON rule_candidates TYPE option<string>;
DEFINE INDEX rule_candidates_status  ON rule_candidates FIELDS status;
DEFINE INDEX rule_candidates_created ON rule_candidates FIELDS created_at;

-- rules
DEFINE TABLE rules SCHEMAFULL TYPE NORMAL;
DEFINE FIELD content          ON rules TYPE string;
DEFINE FIELD kind             ON rules TYPE string
  ASSERT $value IN ['behavior', 'profile_update'];
DEFINE FIELD payload          ON rules TYPE option<object> FLEXIBLE;
DEFINE FIELD source_candidate ON rules TYPE option<record<rule_candidates>>;
DEFINE FIELD priority         ON rules TYPE int DEFAULT 50;
DEFINE FIELD active           ON rules TYPE bool DEFAULT true;
DEFINE FIELD created_at       ON rules TYPE datetime DEFAULT time::now() READONLY;
DEFINE FIELD updated_at       ON rules TYPE datetime VALUE time::now();
DEFINE FIELD meta             ON rules TYPE option<object> FLEXIBLE;
DEFINE INDEX rules_active     ON rules FIELDS active, priority;
```

- [ ] **Step 2: Verify all 5 migrations parse sequentially**

```bash
cd /Users/iser/workspace/robin/robin-assistant-v2
node -e "
import('./src/db/client.js').then(async ({connect, close}) => {
  const { readdir, readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const dir = 'src/schema/migrations';
  const files = (await readdir(dir)).filter(f => f.endsWith('.surql')).sort();
  const db = await connect({ engine: 'mem://' });
  for (const f of files) {
    await db.query(await readFile(join(dir, f), 'utf8')).collect();
    console.log('OK', f);
  }
  await close(db);
  process.exit(0);
});
"
```

Expected: prints OK for all 5 migrations including 0005.

- [ ] **Step 3: Update bootstrap test for 5 migrations**

Modify `tests/integration/bootstrap-empty-db.test.js` — change `/applied 4 migrations/` to `/applied 5 migrations/`.

- [ ] **Step 4: Run full suite**

```bash
npm test
```

Expected: 189 (unchanged count; bootstrap test now expects 5).

- [ ] **Step 5: Commit**

```bash
git add src/schema/migrations/0005-dream-and-memory.surql tests/integration/bootstrap-empty-db.test.js
git commit -m "feat(schema): 0005-dream-and-memory — knowledge, patterns, profile, threads, rules"
```

---

## Task 2: Memory shapes — knowledge + patterns

**Files:**
- Create: `src/memory/knowledge.js`
- Create: `src/memory/patterns.js`
- Create: `tests/unit/memory-knowledge.test.js`
- Create: `tests/unit/memory-patterns.test.js`

- [ ] **Step 1: Write tests for knowledge**

`tests/unit/memory-knowledge.test.js`:

```js
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createStubEmbedder } from '../../src/embed/embedder.js';
import { createKnowledge, getKnowledgeByContentHash, listKnowledge, searchKnowledge } from '../../src/memory/knowledge.js';

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  return db;
}

test('createKnowledge writes a row with content_hash', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 384 });
  const r = await createKnowledge(db, e, {
    content: 'Alice works on Atlas',
    confidence: 0.9,
    source_events: [],
    source_episodes: [],
  });
  assert.ok(r.id);
  const [rows] = await db.query(surql`SELECT count() AS n FROM knowledge GROUP ALL`).collect();
  assert.equal(rows[0].n, 1);
  await close(db);
});

test('getKnowledgeByContentHash dedupes', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 384 });
  await createKnowledge(db, e, { content: 'fact', confidence: 0.9, source_events: [], source_episodes: [] });
  const existing = await getKnowledgeByContentHash(db, 'fact');
  assert.ok(existing);
  await close(db);
});

test('searchKnowledge returns vector-similar results', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 384 });
  await createKnowledge(db, e, { content: 'apple is red', confidence: 0.9, source_events: [], source_episodes: [] });
  await createKnowledge(db, e, { content: 'banana is yellow', confidence: 0.9, source_events: [], source_episodes: [] });
  const hits = await searchKnowledge(db, e, 'apple', { limit: 1 });
  assert.ok(hits.length >= 1);
  assert.match(hits[0].content, /apple/);
  await close(db);
});

test('listKnowledge filters by subject_id when provided', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 384 });
  // Create a fake entity
  const v = Array.from(await e.embed('person: Alice'));
  const [created] = await db.query(surql`CREATE entities CONTENT ${{ name: 'Alice', type: 'person', embedding: v }}`).collect();
  const aliceId = (Array.isArray(created) ? created[0] : created).id;
  await createKnowledge(db, e, { content: 'fact about alice', subject_id: aliceId, confidence: 0.9, source_events: [], source_episodes: [] });
  await createKnowledge(db, e, { content: 'unrelated fact', confidence: 0.9, source_events: [], source_episodes: [] });
  const filtered = await listKnowledge(db, { subject_id: aliceId });
  assert.equal(filtered.length, 1);
  await close(db);
});
```

- [ ] **Step 2: Write `src/memory/knowledge.js`**

```js
import { surql } from 'surrealdb';
import { sha256 } from '../embed/hash.js';

export async function createKnowledge(db, embedder, input) {
  const { content, subject_id, confidence, source_events, source_episodes, meta } = input;
  if (!content || content.length === 0) throw new Error('content required');
  const content_hash = sha256(content);
  // Dedupe
  const existing = await getKnowledgeByContentHash(db, content);
  if (existing) {
    return { id: existing.id, deduped: true };
  }
  const embedding = Array.from(await embedder.embed(content));
  const fields = {
    content,
    content_hash,
    confidence,
    source_events,
    source_episodes,
    embedding,
    ...(subject_id ? { subject_id } : {}),
    ...(meta ? { meta } : {}),
  };
  const [created] = await db.query(surql`CREATE knowledge CONTENT ${fields}`).collect();
  const row = Array.isArray(created) ? created[0] : created;
  return { id: row.id };
}

export async function getKnowledgeByContentHash(db, content) {
  const hash = sha256(content);
  const [rows] = await db
    .query(surql`SELECT id FROM knowledge WHERE content_hash = ${hash} LIMIT 1`)
    .collect();
  return rows[0] ?? null;
}

export async function listKnowledge(db, { subject_id, limit = 50 } = {}) {
  const sql = subject_id
    ? `SELECT id, content, subject_id, confidence, created_at FROM knowledge WHERE subject_id = $sid ORDER BY created_at DESC LIMIT ${limit}`
    : `SELECT id, content, subject_id, confidence, created_at FROM knowledge ORDER BY created_at DESC LIMIT ${limit}`;
  const [rows] = await db.query(sql, subject_id ? { sid: subject_id } : {}).collect();
  return rows;
}

export async function searchKnowledge(db, embedder, query, { limit = 10 } = {}) {
  const queryVec = Array.from(await embedder.embed(query));
  const sql = `
    SELECT id, content, subject_id, confidence, vector::distance::knn() AS dist
    FROM knowledge
    WHERE embedding <|${limit}, 64|> $qvec
    ORDER BY dist
    LIMIT ${limit}
  `;
  const [rows] = await db.query(sql, { qvec: queryVec }).collect();
  return rows;
}
```

- [ ] **Step 3: Run knowledge tests**

```bash
npm test -- tests/unit/memory-knowledge.test.js
```

Expected: 4 pass.

- [ ] **Step 4: Write tests for patterns**

`tests/unit/memory-patterns.test.js`:

```js
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createPattern, listPatterns, upsertPatternByName } from '../../src/memory/patterns.js';

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  return db;
}

test('createPattern writes a row', async () => {
  const db = await fresh();
  const r = await createPattern(db, {
    name: 'morning-atlas-work',
    description: 'User works on Atlas in the morning',
    source_events: [],
  });
  assert.ok(r.id);
  await close(db);
});

test('upsertPatternByName updates existing', async () => {
  const db = await fresh();
  const r1 = await upsertPatternByName(db, {
    name: 'p1',
    description: 'first',
    source_events: [],
  });
  const r2 = await upsertPatternByName(db, {
    name: 'p1',
    description: 'updated',
    source_events: [],
  });
  assert.equal(String(r1.id), String(r2.id));
  const [rows] = await db.query(surql`SELECT signal_count FROM ${r2.id}`).collect();
  assert.equal(rows[0].signal_count, 2);
  await close(db);
});

test('listPatterns returns recent patterns', async () => {
  const db = await fresh();
  await createPattern(db, { name: 'a', description: 'a', source_events: [] });
  await createPattern(db, { name: 'b', description: 'b', source_events: [] });
  const list = await listPatterns(db);
  assert.ok(list.length >= 2);
  await close(db);
});
```

- [ ] **Step 5: Write `src/memory/patterns.js`**

```js
import { surql } from 'surrealdb';

export async function createPattern(db, input) {
  const { name, description, source_events, meta } = input;
  const fields = {
    name,
    description,
    source_events,
    ...(meta ? { meta } : {}),
  };
  const [created] = await db.query(surql`CREATE patterns CONTENT ${fields}`).collect();
  const row = Array.isArray(created) ? created[0] : created;
  return { id: row.id };
}

export async function upsertPatternByName(db, input) {
  const { name, description, source_events, meta } = input;
  const [existing] = await db
    .query(surql`SELECT id, signal_count FROM patterns WHERE name = ${name} LIMIT 1`)
    .collect();
  if (existing.length > 0) {
    const id = existing[0].id;
    await db
      .query(surql`UPDATE ${id} SET description = ${description}, signal_count = signal_count + 1, last_signal = time::now(), source_events = array::union(source_events, ${source_events})`)
      .collect();
    return { id };
  }
  return await createPattern(db, { name, description, source_events, meta });
}

export async function listPatterns(db, { activeOnly = false, limit = 50 } = {}) {
  const where = activeOnly ? 'WHERE strength > 0' : '';
  const sql = `SELECT id, name, description, signal_count, strength, last_signal FROM patterns ${where} ORDER BY last_signal DESC LIMIT ${limit}`;
  const [rows] = await db.query(sql).collect();
  return rows;
}
```

- [ ] **Step 6: Run patterns tests + lint + commit**

```bash
npm test -- tests/unit/memory-patterns.test.js
npm run lint
git add src/memory/knowledge.js src/memory/patterns.js tests/unit/memory-knowledge.test.js tests/unit/memory-patterns.test.js
git commit -m "feat(memory): knowledge + patterns CRUD helpers"
```

---

## Task 3: Memory shapes — profile + threads

**Files:**
- Create: `src/memory/profile.js`
- Create: `src/memory/threads.js`
- Create: `tests/unit/memory-profile.test.js`
- Create: `tests/unit/memory-threads.test.js`

- [ ] **Step 1: Write tests + implementation for profile**

`tests/unit/memory-profile.test.js`:

```js
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { getProfile, updateProfileFields } from '../../src/memory/profile.js';

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  return db;
}

test('getProfile returns null for fresh DB', async () => {
  const db = await fresh();
  const p = await getProfile(db);
  assert.equal(p, null);
  await close(db);
});

test('updateProfileFields creates singleton on first call', async () => {
  const db = await fresh();
  await updateProfileFields(db, { name: 'Kevin', pronouns: 'he/him' });
  const p = await getProfile(db);
  assert.equal(p.name, 'Kevin');
  assert.equal(p.pronouns, 'he/him');
  await close(db);
});

test('updateProfileFields merges into existing singleton', async () => {
  const db = await fresh();
  await updateProfileFields(db, { name: 'Kevin' });
  await updateProfileFields(db, { timezone: 'America/New_York' });
  const p = await getProfile(db);
  assert.equal(p.name, 'Kevin');
  assert.equal(p.timezone, 'America/New_York');
  await close(db);
});
```

`src/memory/profile.js`:

```js
import { surql } from 'surrealdb';

export async function getProfile(db) {
  const [rows] = await db
    .query(surql`SELECT * FROM type::record('profile', 'singleton') LIMIT 1`)
    .collect();
  return rows[0] ?? null;
}

export async function updateProfileFields(db, fields) {
  await db
    .query(surql`UPSERT type::record('profile', 'singleton') MERGE ${fields}`)
    .collect();
}
```

- [ ] **Step 2: Write tests + implementation for threads**

`tests/unit/memory-threads.test.js`:

```js
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createEpisode } from '../../src/graph/episodes.js';
import { createThread, listThreads } from '../../src/memory/threads.js';

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  return db;
}

test('createThread writes a row', async () => {
  const db = await fresh();
  const ep1 = await createEpisode(db, { source: 'cli' });
  const ep2 = await createEpisode(db, { source: 'cli' });
  const r = await createThread(db, {
    title: 'Atlas project',
    episode_ids: [ep1.id, ep2.id],
    entity_ids: [],
  });
  assert.ok(r.id);
  await close(db);
});

test('listThreads returns recent threads', async () => {
  const db = await fresh();
  const ep = await createEpisode(db, { source: 'cli' });
  await createThread(db, { title: 't1', episode_ids: [ep.id], entity_ids: [] });
  await createThread(db, { title: 't2', episode_ids: [ep.id], entity_ids: [] });
  const list = await listThreads(db);
  assert.ok(list.length >= 2);
  await close(db);
});
```

`src/memory/threads.js`:

```js
import { surql } from 'surrealdb';

export async function createThread(db, input) {
  const { title, episode_ids, entity_ids, summary, meta } = input;
  const fields = {
    episode_ids,
    entity_ids,
    ...(title ? { title } : {}),
    ...(summary ? { summary } : {}),
    ...(meta ? { meta } : {}),
  };
  const [created] = await db.query(surql`CREATE threads CONTENT ${fields}`).collect();
  const row = Array.isArray(created) ? created[0] : created;
  return { id: row.id };
}

export async function listThreads(db, { since, limit = 20 } = {}) {
  const where = since ? `WHERE last_active >= $since` : '';
  const sql = `SELECT id, title, started_at, last_active, episode_ids, entity_ids, summary FROM threads ${where} ORDER BY last_active DESC LIMIT ${limit}`;
  const [rows] = await db.query(sql, since ? { since: new Date(since) } : {}).collect();
  return rows;
}
```

- [ ] **Step 3: Run + lint + commit**

```bash
npm test -- tests/unit/memory-profile.test.js tests/unit/memory-threads.test.js
npm run lint
git add src/memory/profile.js src/memory/threads.js tests/unit/memory-profile.test.js tests/unit/memory-threads.test.js
git commit -m "feat(memory): profile singleton + threads CRUD helpers"
```

---

## Task 4: Derived views — journal + hot

**Files:**
- Create: `src/memory/journal.js`
- Create: `src/memory/hot.js`
- Create: `tests/unit/memory-journal.test.js`
- Create: `tests/unit/memory-hot.test.js`

- [ ] **Step 1: Write `src/memory/journal.js`**

```js
import { surql } from 'surrealdb';

export async function listJournalEntries(db, { since, until, limit = 50, minContentLen = 50 } = {}) {
  const filters = ['biographed_at IS NOT NONE'];
  const bindings = {};
  if (since) {
    filters.push('ts >= $since');
    bindings.since = new Date(since);
  }
  if (until) {
    filters.push('ts <= $until');
    bindings.until = new Date(until);
  }
  // Significance: correction OR length >= minContentLen
  const sigFilter = `(meta.kind = 'correction' OR string::len(content) >= ${minContentLen})`;
  filters.push(sigFilter);
  const sql = `SELECT id, source, content, ts, episode_id, meta FROM events WHERE ${filters.join(' AND ')} ORDER BY ts DESC LIMIT ${limit}`;
  const [rows] = await db.query(sql, bindings).collect();
  return rows;
}
```

- [ ] **Step 2: Write `src/memory/hot.js`**

```js
import { surql } from 'surrealdb';

export async function getHotContext(db, { source, windowMinutes = 30 } = {}) {
  // Active episodes
  const epWhere = source ? `WHERE source = $source AND ended_at IS NONE` : `WHERE ended_at IS NONE`;
  const [eps] = await db
    .query(`SELECT id, source, started_at, summary FROM episodes ${epWhere} ORDER BY started_at DESC LIMIT 5`, source ? { source } : {})
    .collect();
  // Recent events from those episodes
  const cutoff = new Date(Date.now() - windowMinutes * 60_000);
  const epIds = eps.map((e) => e.id);
  if (epIds.length === 0) return { episodes: [], recent_events: [], entities: [] };
  const [evs] = await db
    .query(surql`SELECT id, source, content, ts, episode_id FROM events WHERE episode_id IN ${epIds} AND ts >= ${cutoff} ORDER BY ts DESC LIMIT 30`)
    .collect();
  return { episodes: eps, recent_events: evs, entities: [] };
}
```

- [ ] **Step 3: Write tests**

`tests/unit/memory-journal.test.js`:

```js
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { recordEvent } from '../../src/capture/record-event.js';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createStubEmbedder } from '../../src/embed/embedder.js';
import { listJournalEntries } from '../../src/memory/journal.js';

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  return db;
}

test('listJournalEntries returns only biographed + significant events', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 384 });
  const evt1 = await recordEvent(db, e, { source: 'cli', content: 'short' });  // not significant
  const evt2 = await recordEvent(db, e, { source: 'cli', content: 'a much longer event content that should pass the significance threshold easily' });
  // Mark biographed
  await db.query(surql`UPDATE ${evt2.id} SET biographed_at = time::now()`).collect();
  const entries = await listJournalEntries(db);
  assert.equal(entries.length, 1);
  assert.match(entries[0].content, /longer/);
  await close(db);
});
```

`tests/unit/memory-hot.test.js`:

```js
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createEpisode } from '../../src/graph/episodes.js';
import { getHotContext } from '../../src/memory/hot.js';

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  return db;
}

test('getHotContext returns active episodes', async () => {
  const db = await fresh();
  await createEpisode(db, { source: 'cli' });
  const r = await getHotContext(db);
  assert.equal(r.episodes.length, 1);
  await close(db);
});

test('getHotContext returns empty when no active episodes', async () => {
  const db = await fresh();
  const r = await getHotContext(db);
  assert.deepEqual(r.episodes, []);
  assert.deepEqual(r.recent_events, []);
  await close(db);
});
```

- [ ] **Step 4: Run + lint + commit**

```bash
npm test -- tests/unit/memory-journal.test.js tests/unit/memory-hot.test.js
npm run lint
git add src/memory/journal.js src/memory/hot.js tests/unit/memory-journal.test.js tests/unit/memory-hot.test.js
git commit -m "feat(memory): journal + hot derived views"
```

---

## Task 5: Rules — candidates + apply

**Files:**
- Create: `src/rules/candidates.js`
- Create: `src/rules/rules.js`
- Create: `tests/unit/rules-candidates.test.js`
- Create: `tests/unit/rules-apply.test.js`

- [ ] **Step 1: Write `src/rules/candidates.js`**

```js
import { surql } from 'surrealdb';

export async function createCandidate(db, input) {
  const { content, kind, signal_events, payload, confidence = 0.7, meta } = input;
  const fields = {
    content,
    kind,
    signal_events,
    confidence,
    status: 'pending',
    ...(payload ? { payload } : {}),
    ...(meta ? { meta } : {}),
  };
  const [created] = await db.query(surql`CREATE rule_candidates CONTENT ${fields}`).collect();
  const row = Array.isArray(created) ? created[0] : created;
  return { id: row.id };
}

export async function listCandidates(db, { status = 'pending', limit = 50 } = {}) {
  const where = status === 'all' ? '' : `WHERE status = '${status}'`;
  const sql = `SELECT id, content, kind, payload, confidence, status, created_at, signal_events FROM rule_candidates ${where} ORDER BY created_at DESC LIMIT ${limit}`;
  const [rows] = await db.query(sql).collect();
  return rows;
}

export async function updateCandidateStatus(db, id, status, reason) {
  const idRef = String(id).startsWith('rule_candidates:') ? String(id) : `rule_candidates:${id}`;
  const fields = { status, reviewed_at: new Date() };
  if (reason) fields.rejected_reason = reason;
  await db.query(surql`UPDATE type::record('rule_candidates', $key) MERGE ${fields}`, {
    key: idRef.replace('rule_candidates:', ''),
  }).collect();
}

// Dedupe helper: returns true if a pending or rejected candidate already exists with
// signal_events overlapping `events` by ≥ overlapThreshold (default 0.5).
export async function findOverlappingPendingCandidate(db, kind, signalEventIds, overlapThreshold = 0.5) {
  const [rows] = await db
    .query(surql`SELECT id, signal_events FROM rule_candidates WHERE kind = ${kind} AND status IN ['pending', 'rejected']`)
    .collect();
  for (const r of rows) {
    const existing = (r.signal_events ?? []).map(String);
    const proposed = signalEventIds.map(String);
    const intersection = existing.filter((id) => proposed.includes(id));
    const overlap = intersection.length / Math.max(1, Math.min(existing.length, proposed.length));
    if (overlap >= overlapThreshold) return r.id;
  }
  return null;
}

// Check if a profile_update candidate with identical fields already exists
export async function findIdenticalProfileCandidate(db, fields) {
  const [rows] = await db
    .query(surql`SELECT id, payload FROM rule_candidates WHERE kind = 'profile_update' AND status IN ['pending', 'rejected']`)
    .collect();
  const target = JSON.stringify(fields);
  for (const r of rows) {
    if (JSON.stringify(r.payload?.fields ?? {}) === target) return r.id;
  }
  return null;
}
```

- [ ] **Step 2: Write `src/rules/rules.js`**

```js
import { surql } from 'surrealdb';
import { updateProfileFields } from '../memory/profile.js';
import { updateCandidateStatus } from './candidates.js';

export async function approveCandidate(db, candidateId) {
  const idRef = String(candidateId).startsWith('rule_candidates:')
    ? String(candidateId)
    : `rule_candidates:${candidateId}`;
  const [rows] = await db
    .query(surql`SELECT id, content, kind, payload FROM type::record('rule_candidates', $key)`, {
      key: idRef.replace('rule_candidates:', ''),
    })
    .collect();
  if (!rows[0]) throw new Error(`candidate not found: ${candidateId}`);
  const cand = rows[0];

  // Apply side-effects per kind
  if (cand.kind === 'profile_update' && cand.payload?.fields) {
    await updateProfileFields(db, cand.payload.fields);
  }

  // For all kinds (incl. profile_update), create rules row to preserve history + replayability
  const [created] = await db
    .query(surql`CREATE rules CONTENT ${{
      content: cand.content,
      kind: cand.kind === 'conflict_warning' ? 'behavior' : cand.kind,
      payload: cand.payload ?? null,
      source_candidate: cand.id,
      active: true,
    }}`)
    .collect();
  const ruleRow = Array.isArray(created) ? created[0] : created;

  await updateCandidateStatus(db, candidateId, 'approved');
  return { id: ruleRow.id };
}

export async function rejectCandidate(db, candidateId, reason) {
  await updateCandidateStatus(db, candidateId, 'rejected', reason);
}

export async function listRules(db, { activeOnly = true, limit = 100 } = {}) {
  const where = activeOnly ? 'WHERE active = true' : '';
  const sql = `SELECT id, content, kind, priority, active, created_at FROM rules ${where} ORDER BY priority DESC, created_at DESC LIMIT ${limit}`;
  const [rows] = await db.query(sql).collect();
  return rows;
}

export async function deactivateRule(db, ruleId) {
  const idRef = String(ruleId).startsWith('rules:') ? String(ruleId) : `rules:${ruleId}`;
  await db.query(surql`UPDATE type::record('rules', $key) SET active = false`, {
    key: idRef.replace('rules:', ''),
  }).collect();
}

export async function setRulePriority(db, ruleId, priority) {
  if (!Number.isInteger(priority) || priority < 1 || priority > 100) {
    throw new Error(`priority must be int 1..100; got ${priority}`);
  }
  const idRef = String(ruleId).startsWith('rules:') ? String(ruleId) : `rules:${ruleId}`;
  await db.query(surql`UPDATE type::record('rules', $key) SET priority = ${priority}`, {
    key: idRef.replace('rules:', ''),
  }).collect();
}
```

- [ ] **Step 3: Write tests**

`tests/unit/rules-candidates.test.js`:

```js
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createCandidate, findIdenticalProfileCandidate, findOverlappingPendingCandidate, listCandidates, updateCandidateStatus } from '../../src/rules/candidates.js';

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  return db;
}

test('createCandidate writes a pending row', async () => {
  const db = await fresh();
  const r = await createCandidate(db, {
    content: 'prefer concise',
    kind: 'behavior',
    signal_events: [],
    confidence: 0.8,
  });
  assert.ok(r.id);
  const list = await listCandidates(db);
  assert.equal(list.length, 1);
  assert.equal(list[0].status, 'pending');
  await close(db);
});

test('updateCandidateStatus moves to rejected', async () => {
  const db = await fresh();
  const r = await createCandidate(db, { content: 'x', kind: 'behavior', signal_events: [], confidence: 0.5 });
  await updateCandidateStatus(db, r.id, 'rejected', 'not relevant');
  const list = await listCandidates(db, { status: 'rejected' });
  assert.equal(list.length, 1);
  assert.equal(list[0].rejected_reason, 'not relevant');
  await close(db);
});

test('findIdenticalProfileCandidate returns existing match', async () => {
  const db = await fresh();
  await createCandidate(db, {
    content: 'set name',
    kind: 'profile_update',
    signal_events: [],
    payload: { fields: { name: 'Kevin' } },
    confidence: 0.9,
  });
  const id = await findIdenticalProfileCandidate(db, { name: 'Kevin' });
  assert.ok(id);
  const id2 = await findIdenticalProfileCandidate(db, { name: 'Different' });
  assert.equal(id2, null);
  await close(db);
});
```

`tests/unit/rules-apply.test.js`:

```js
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { getProfile } from '../../src/memory/profile.js';
import { createCandidate } from '../../src/rules/candidates.js';
import { approveCandidate, deactivateRule, listRules, rejectCandidate, setRulePriority } from '../../src/rules/rules.js';

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  return db;
}

test('approveCandidate (behavior) creates active rule', async () => {
  const db = await fresh();
  const c = await createCandidate(db, { content: 'be concise', kind: 'behavior', signal_events: [], confidence: 0.9 });
  const r = await approveCandidate(db, c.id);
  assert.ok(r.id);
  const rules = await listRules(db);
  assert.equal(rules.length, 1);
  assert.equal(rules[0].active, true);
  assert.equal(rules[0].kind, 'behavior');
  await close(db);
});

test('approveCandidate (profile_update) applies payload to profile', async () => {
  const db = await fresh();
  const c = await createCandidate(db, {
    content: 'name is Kevin',
    kind: 'profile_update',
    signal_events: [],
    payload: { fields: { name: 'Kevin' } },
    confidence: 0.9,
  });
  await approveCandidate(db, c.id);
  const p = await getProfile(db);
  assert.equal(p.name, 'Kevin');
  await close(db);
});

test('rejectCandidate marks rejected; no rules row created', async () => {
  const db = await fresh();
  const c = await createCandidate(db, { content: 'x', kind: 'behavior', signal_events: [], confidence: 0.5 });
  await rejectCandidate(db, c.id, 'no thanks');
  const rules = await listRules(db);
  assert.equal(rules.length, 0);
  await close(db);
});

test('setRulePriority updates and lists order', async () => {
  const db = await fresh();
  const c = await createCandidate(db, { content: 'r', kind: 'behavior', signal_events: [], confidence: 0.9 });
  const r = await approveCandidate(db, c.id);
  await setRulePriority(db, r.id, 90);
  const rules = await listRules(db);
  assert.equal(rules[0].priority, 90);
  await close(db);
});

test('deactivateRule sets active=false', async () => {
  const db = await fresh();
  const c = await createCandidate(db, { content: 'r', kind: 'behavior', signal_events: [], confidence: 0.9 });
  const r = await approveCandidate(db, c.id);
  await deactivateRule(db, r.id);
  const rules = await listRules(db, { activeOnly: true });
  assert.equal(rules.length, 0);
  await close(db);
});
```

- [ ] **Step 4: Run + lint + commit**

```bash
npm test -- tests/unit/rules-candidates.test.js tests/unit/rules-apply.test.js
npm run lint
git add src/rules/ tests/unit/rules-candidates.test.js tests/unit/rules-apply.test.js
git commit -m "feat(rules): rule_candidates + rules CRUD with approval side-effects"
```

---

## Task 6: Dream pipeline — orchestrator + 5 step modules

This is a single bundled task that creates the orchestrator + all 5 step modules + their tests. Big task; commit per file.

**Files:**
- Create: `src/dream/prompts.js`
- Create: `src/dream/step-knowledge.js`
- Create: `src/dream/step-patterns.js`
- Create: `src/dream/step-corrections.js`
- Create: `src/dream/step-profile.js`
- Create: `src/dream/step-threads.js`
- Create: `src/dream/pipeline.js`
- Create: `tests/unit/dream-step-knowledge.test.js`
- Create: `tests/unit/dream-step-patterns.test.js`
- Create: `tests/unit/dream-step-corrections.test.js`
- Create: `tests/unit/dream-step-profile.test.js`
- Create: `tests/unit/dream-step-threads.test.js`
- Create: `tests/integration/dream-full-cycle.test.js`

- [ ] **Step 1: Write `src/dream/prompts.js`**

```js
export const KNOWLEDGE_SYNTHESIS_SYSTEM = `You decide whether to promote recent observations about an entity into long-term knowledge.

Output JSON only:
{ "promote": boolean, "knowledge_text": string | null, "confidence": number (0-1) }

Rules:
- Promote only if the observation is a stable fact about the entity (preference, role, relationship, attribute).
- Don't promote one-off events or temporary state.
- Be concise: knowledge_text is one sentence.
- If existing knowledge already covers this, return promote=false.
`;

export const PATTERN_CONFIRM_SYSTEM = `You confirm whether a candidate pattern in the user's data is a real recurring observation worth tracking.

Output JSON only:
{ "confirm": boolean, "name": string, "description": string }

Rules:
- Confirm only if the pattern reflects a meaningful recurring user behavior or relationship.
- name is a short slug-like identifier (e.g., "morning-atlas-work").
- description is one sentence.
`;

export const CORRECTION_RULE_SYSTEM = `You distill a cluster of related user corrections into a single behavioral rule.

Output JSON only:
{ "propose": boolean, "rule_text": string | null, "confidence": number (0-1) }

Rules:
- Propose only if the corrections cluster around a clear preference.
- rule_text is one sentence in second person describing how to behave (e.g., "Prefer concise answers; aim for 2-3 sentences unless asked for detail").
- Be conservative: if the cluster is mixed, return propose=false.
`;

export const PROFILE_INFERENCE_SYSTEM = `You identify possible profile updates from recent user activity. Profile fields are: name, display_name, pronouns, timezone, interests.

Output JSON only:
{ "candidates": [{ "field": string, "value": any, "confidence": number, "rationale": string }, ...] }

Rules:
- Only propose updates with confidence >= 0.8.
- Be conservative on sensitive fields (name, pronouns).
- For interests, return an array of strings.
`;
```

- [ ] **Step 2: Write `src/dream/step-knowledge.js`**

```js
import { surql } from 'surrealdb';
import { createKnowledge } from '../memory/knowledge.js';
import { KNOWLEDGE_SYNTHESIS_SYSTEM } from './prompts.js';

const DEFAULT_MIN_SIGNALS = 3;

export async function dreamStepKnowledge(db, host, embedder, { minSignals = DEFAULT_MIN_SIGNALS } = {}) {
  // Find entities with new mentions count >= minSignals (un-dreamed events)
  const [counts] = await db.query(`
    SELECT out AS entity_id, count() AS mention_count
    FROM mentions
    WHERE in.dreamed_at IS NONE
    GROUP BY entity_id
  `).collect();

  const eligible = counts.filter((c) => c.mention_count >= minSignals);
  let promoted = 0;

  for (const c of eligible) {
    const entityId = c.entity_id;
    const [evRows] = await db
      .query(surql`SELECT id, content, ts FROM events WHERE id IN (SELECT VALUE in FROM mentions WHERE out = ${entityId}) AND dreamed_at IS NONE LIMIT 20`)
      .collect();
    if (evRows.length < minSignals) continue;
    const [entRows] = await db.query(surql`SELECT name, type FROM ${entityId}`).collect();
    if (!entRows[0]) continue;
    const ent = entRows[0];

    const userPrompt = `Entity: ${ent.type}/${ent.name}

Recent observations:
${evRows.map((e) => `- ${e.content}`).join('\n')}

Decide whether to promote knowledge.`;

    let result;
    try {
      const r = await host.invokeLLM(
        [{ role: 'user', content: userPrompt }],
        { tier: 'fast', json: true, system: [{ role: 'system', content: KNOWLEDGE_SYNTHESIS_SYSTEM, cache_control: { type: 'ephemeral' } }] },
      );
      result = JSON.parse(r.content);
    } catch {
      continue;
    }

    if (result?.promote && result.knowledge_text) {
      await createKnowledge(db, embedder, {
        content: result.knowledge_text,
        subject_id: entityId,
        confidence: Math.min(1, Math.max(0, result.confidence ?? 0.7)),
        source_events: evRows.map((e) => e.id),
        source_episodes: [],
      });
      promoted++;
    }
  }

  return { eligible: eligible.length, promoted };
}
```

- [ ] **Step 3: Write `src/dream/step-corrections.js`**

```js
import { surql } from 'surrealdb';
import { createCandidate, findOverlappingPendingCandidate } from '../rules/candidates.js';
import { CORRECTION_RULE_SYSTEM } from './prompts.js';

const DEFAULT_LOOKBACK_DAYS = 30;
const DEFAULT_MIN_CLUSTER = 3;
const DEFAULT_SIM_THRESHOLD = 0.85;
const DEFAULT_OVERLAP_THRESHOLD = 0.5;

function cosine(a, b) {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

function clusterEvents(events, threshold) {
  // Single-link agglomerative on event embeddings
  const clusters = events.map((e) => ({ ids: [e.id], embeds: [e.embedding] }));
  let merged = true;
  while (merged) {
    merged = false;
    outer: for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        // Single-link: any pair similarity exceeds threshold
        for (const ea of clusters[i].embeds) {
          for (const eb of clusters[j].embeds) {
            if (cosine(ea, eb) >= threshold) {
              clusters[i].ids.push(...clusters[j].ids);
              clusters[i].embeds.push(...clusters[j].embeds);
              clusters.splice(j, 1);
              merged = true;
              break outer;
            }
          }
        }
      }
    }
  }
  return clusters;
}

export async function dreamStepCorrections(db, host, {
  lookbackDays = DEFAULT_LOOKBACK_DAYS,
  minCluster = DEFAULT_MIN_CLUSTER,
  similarityThreshold = DEFAULT_SIM_THRESHOLD,
  overlapThreshold = DEFAULT_OVERLAP_THRESHOLD,
} = {}) {
  const cutoff = new Date(Date.now() - lookbackDays * 86400_000);
  const [rows] = await db
    .query(surql`SELECT id, content, embedding FROM events WHERE meta.kind = 'correction' AND ts >= ${cutoff}`)
    .collect();
  if (rows.length < minCluster) return { clusters: 0, proposed: 0 };

  const clusters = clusterEvents(rows, similarityThreshold).filter((c) => c.ids.length >= minCluster);
  let proposed = 0;

  for (const cluster of clusters) {
    const overlap = await findOverlappingPendingCandidate(db, 'behavior', cluster.ids, overlapThreshold);
    if (overlap) continue;

    const [evRows] = await db.query(surql`SELECT content FROM events WHERE id IN ${cluster.ids}`).collect();
    const userPrompt = `Cluster of corrections:
${evRows.map((e) => `- ${e.content}`).join('\n')}

Distill into a behavioral rule.`;

    let result;
    try {
      const r = await host.invokeLLM(
        [{ role: 'user', content: userPrompt }],
        { tier: 'fast', json: true, system: [{ role: 'system', content: CORRECTION_RULE_SYSTEM, cache_control: { type: 'ephemeral' } }] },
      );
      result = JSON.parse(r.content);
    } catch {
      continue;
    }

    if (result?.propose && result.rule_text) {
      await createCandidate(db, {
        content: result.rule_text,
        kind: 'behavior',
        signal_events: cluster.ids,
        confidence: Math.min(1, Math.max(0, result.confidence ?? 0.7)),
      });
      proposed++;
    }
  }
  return { clusters: clusters.length, proposed };
}
```

- [ ] **Step 4: Write `src/dream/step-profile.js`**

```js
import { surql } from 'surrealdb';
import { getProfile } from '../memory/profile.js';
import { createCandidate, findIdenticalProfileCandidate } from '../rules/candidates.js';
import { PROFILE_INFERENCE_SYSTEM } from './prompts.js';

const DEFAULT_MIN_CONFIDENCE = 0.8;

export async function dreamStepProfile(db, host, { minConfidence = DEFAULT_MIN_CONFIDENCE } = {}) {
  const cutoff = new Date(Date.now() - 30 * 86400_000);
  const [evRows] = await db
    .query(surql`SELECT content FROM events WHERE ts >= ${cutoff} AND biographed_at IS NOT NONE LIMIT 200`)
    .collect();
  if (evRows.length === 0) return { proposed: 0 };

  const existing = await getProfile(db);
  const userPrompt = `Existing profile:
${JSON.stringify(existing ?? {})}

Recent activity:
${evRows.slice(0, 50).map((e) => `- ${e.content}`).join('\n')}

Identify possible profile updates.`;

  let result;
  try {
    const r = await host.invokeLLM(
      [{ role: 'user', content: userPrompt }],
      { tier: 'fast', json: true, system: [{ role: 'system', content: PROFILE_INFERENCE_SYSTEM, cache_control: { type: 'ephemeral' } }] },
    );
    result = JSON.parse(r.content);
  } catch {
    return { proposed: 0 };
  }

  let proposed = 0;
  for (const c of result?.candidates ?? []) {
    if (!c.field || c.value === undefined) continue;
    if ((c.confidence ?? 0) < minConfidence) continue;
    const fields = { [c.field]: c.value };
    const existingId = await findIdenticalProfileCandidate(db, fields);
    if (existingId) continue;
    await createCandidate(db, {
      content: `${c.field}: ${JSON.stringify(c.value)}`,
      kind: 'profile_update',
      signal_events: [],
      payload: { fields, rationale: c.rationale },
      confidence: c.confidence,
    });
    proposed++;
  }
  return { proposed };
}
```

- [ ] **Step 5: Write `src/dream/step-patterns.js` and `src/dream/step-threads.js` (lighter — heuristic only)**

`src/dream/step-patterns.js`:

```js
import { surql } from 'surrealdb';
import { upsertPatternByName } from '../memory/patterns.js';

export async function dreamStepPatterns(db, host) {
  // Heuristic: co_occurs_with edges with strength jumps in last 7 days
  const cutoff = new Date(Date.now() - 7 * 86400_000);
  const [strong] = await db
    .query(surql`SELECT in, out, strength FROM co_occurs_with WHERE last_seen >= ${cutoff} AND strength >= 5 LIMIT 10`)
    .collect();
  let upserted = 0;
  for (const edge of strong) {
    const [a] = await db.query(surql`SELECT name FROM ${edge.in}`).collect();
    const [b] = await db.query(surql`SELECT name FROM ${edge.out}`).collect();
    if (!a[0] || !b[0]) continue;
    await upsertPatternByName(db, {
      name: `co-occur-${a[0].name}-${b[0].name}`,
      description: `${a[0].name} and ${b[0].name} co-occur frequently (strength ${edge.strength})`,
      source_events: [],
    });
    upserted++;
  }
  return { upserted };
}
```

`src/dream/step-threads.js`:

```js
import { surql } from 'surrealdb';
import { createThread } from '../memory/threads.js';

export async function dreamStepThreads(db, { recencyDays = 7 } = {}) {
  const cutoff = new Date(Date.now() - recencyDays * 86400_000);
  // Find entities mentioned in 2+ episodes within window
  const [groups] = await db.query(`
    SELECT out AS entity_id, array::distinct(in.episode_id) AS episodes
    FROM mentions
    WHERE in.ts >= $cutoff AND in.episode_id IS NOT NONE
    GROUP BY entity_id
  `, { cutoff }).collect();
  let created = 0;
  for (const g of groups) {
    const eps = (g.episodes ?? []).filter(Boolean);
    if (eps.length < 2) continue;
    await createThread(db, {
      title: null,
      episode_ids: eps,
      entity_ids: [g.entity_id],
    });
    created++;
  }
  return { created };
}
```

- [ ] **Step 6: Write `src/dream/pipeline.js`**

```js
import { surql } from 'surrealdb';
import { dreamStepCorrections } from './step-corrections.js';
import { dreamStepKnowledge } from './step-knowledge.js';
import { dreamStepPatterns } from './step-patterns.js';
import { dreamStepProfile } from './step-profile.js';
import { dreamStepThreads } from './step-threads.js';

export async function dreamProcess(db, host, embedder, opts = {}) {
  const summary = {};
  try { summary.knowledge = await dreamStepKnowledge(db, host, embedder, opts.knowledge); }
  catch (e) { summary.knowledge = { error: e.message }; }
  try { summary.patterns = await dreamStepPatterns(db, host); }
  catch (e) { summary.patterns = { error: e.message }; }
  try { summary.corrections = await dreamStepCorrections(db, host, opts.corrections); }
  catch (e) { summary.corrections = { error: e.message }; }
  try { summary.profile = await dreamStepProfile(db, host, opts.profile); }
  catch (e) { summary.profile = { error: e.message }; }
  try { summary.threads = await dreamStepThreads(db, opts.threads); }
  catch (e) { summary.threads = { error: e.message }; }

  // Mark events as dreamed (batched)
  await db.query(surql`UPDATE events SET dreamed_at = time::now() WHERE dreamed_at IS NONE`).collect();

  // Update runtime
  await db.query(surql`UPSERT type::record('runtime', 'dream') SET value.last_run_at = time::now(), value.last_run_at_success = time::now()`).collect();

  return summary;
}
```

- [ ] **Step 7: Write minimal tests for each step**

`tests/unit/dream-step-knowledge.test.js`:

```js
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { recordEvent } from '../../src/capture/record-event.js';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { dreamStepKnowledge } from '../../src/dream/step-knowledge.js';
import { createStubEmbedder } from '../../src/embed/embedder.js';

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  return db;
}

function fakeHost(content) {
  return { invokeLLM: async () => ({ content, usage: {} }) };
}

test('dreamStepKnowledge returns 0 promoted when no eligible entities', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 384 });
  const host = fakeHost('{}');
  const r = await dreamStepKnowledge(db, host, e, { minSignals: 3 });
  assert.equal(r.promoted, 0);
  await close(db);
});

test('dreamStepKnowledge promotes when LLM says promote', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 384 });
  // Seed entity + 3 events mentioning it
  const v = Array.from(await e.embed('person: Alice'));
  const [created] = await db.query(surql`CREATE entities CONTENT ${{ name: 'Alice', type: 'person', embedding: v }}`).collect();
  const aliceId = (Array.isArray(created) ? created[0] : created).id;
  for (let i = 0; i < 3; i++) {
    const evt = await recordEvent(db, e, { source: 'cli', content: `event mentioning Alice ${i}` });
    await db.query(surql`RELATE ${evt.id}->mentions->${aliceId}`).collect();
  }
  const host = fakeHost(JSON.stringify({ promote: true, knowledge_text: 'Alice is a colleague', confidence: 0.9 }));
  const r = await dreamStepKnowledge(db, host, e, { minSignals: 3 });
  assert.equal(r.promoted, 1);
  await close(db);
});
```

`tests/unit/dream-step-corrections.test.js`:

```js
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { recordEvent } from '../../src/capture/record-event.js';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { dreamStepCorrections } from '../../src/dream/step-corrections.js';
import { createStubEmbedder } from '../../src/embed/embedder.js';

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  return db;
}

function fakeHost(content) {
  return { invokeLLM: async () => ({ content, usage: {} }) };
}

test('dreamStepCorrections proposes a rule when 3+ similar corrections cluster', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 384 });
  // Seed 3 corrections with identical content (max similarity)
  for (let i = 0; i < 3; i++) {
    await recordEvent(db, e, { source: 'manual', content: 'be more concise', meta: { kind: 'correction' } });
  }
  const host = fakeHost(JSON.stringify({ propose: true, rule_text: 'Prefer concise responses', confidence: 0.9 }));
  const r = await dreamStepCorrections(db, host, { minCluster: 3, similarityThreshold: 0.85 });
  assert.ok(r.proposed >= 1);
  await close(db);
});
```

(Also write `dream-step-patterns.test.js`, `dream-step-profile.test.js`, `dream-step-threads.test.js` as minimal smoke tests — see step 8 commit.)

`tests/unit/dream-step-patterns.test.js`:

```js
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { dreamStepPatterns } from '../../src/dream/step-patterns.js';

test('dreamStepPatterns returns 0 upserted on empty DB', async () => {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  const r = await dreamStepPatterns(db, null);
  assert.equal(r.upserted, 0);
  await close(db);
});
```

`tests/unit/dream-step-profile.test.js`:

```js
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { dreamStepProfile } from '../../src/dream/step-profile.js';

test('dreamStepProfile returns 0 proposed on empty DB', async () => {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  const host = { invokeLLM: async () => ({ content: '{"candidates":[]}', usage: {} }) };
  const r = await dreamStepProfile(db, host);
  assert.equal(r.proposed, 0);
  await close(db);
});
```

`tests/unit/dream-step-threads.test.js`:

```js
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { dreamStepThreads } from '../../src/dream/step-threads.js';

test('dreamStepThreads returns 0 created on empty DB', async () => {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  const r = await dreamStepThreads(db);
  assert.equal(r.created, 0);
  await close(db);
});
```

- [ ] **Step 8: Write integration test**

`tests/integration/dream-full-cycle.test.js`:

```js
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { recordEvent } from '../../src/capture/record-event.js';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { dreamProcess } from '../../src/dream/pipeline.js';
import { createStubEmbedder } from '../../src/embed/embedder.js';

test('dreamProcess runs all steps and marks events dreamed', async () => {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  const e = createStubEmbedder({ dimension: 384 });
  for (let i = 0; i < 3; i++) {
    await recordEvent(db, e, { source: 'manual', content: 'be more concise', meta: { kind: 'correction' } });
  }
  const host = {
    invokeLLM: async () => ({
      content: JSON.stringify({
        propose: true, rule_text: 'Prefer concise', confidence: 0.9,
        candidates: [], promote: false,
      }),
      usage: {},
    }),
  };
  const summary = await dreamProcess(db, host, e);
  assert.ok(summary);
  // All events should be dreamed now
  const [rows] = await db.query(surql`SELECT count() AS n FROM events WHERE dreamed_at IS NONE GROUP ALL`).collect();
  assert.equal(rows[0]?.n ?? 0, 0);
});
```

- [ ] **Step 9: Run all dream tests + lint + commit**

```bash
npm test -- tests/unit/dream-step-knowledge.test.js tests/unit/dream-step-corrections.test.js tests/unit/dream-step-patterns.test.js tests/unit/dream-step-profile.test.js tests/unit/dream-step-threads.test.js tests/integration/dream-full-cycle.test.js
npm run lint
git add src/dream/ tests/unit/dream-step-* tests/integration/dream-full-cycle.test.js
git commit -m "feat(dream): pipeline + 5 step modules + integration test"
```

---

## Task 7: Daemon scheduler (heartbeat-based)

**Files:**
- Create: `src/daemon/scheduler.js`
- Create: `tests/unit/scheduler-heartbeat.test.js`

- [ ] **Step 1: Write failing test**

`tests/unit/scheduler-heartbeat.test.js`:

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createScheduler } from '../../src/daemon/scheduler.js';

test('scheduler heartbeat fires runDream when next_run_at is past-due', async () => {
  let runDreamCalls = 0;
  let nextRunAt = new Date(Date.now() - 1000); // past
  const scheduler = createScheduler({
    runDream: async () => { runDreamCalls++; },
    isOverflow: async () => false,
    getCronHour: () => 4,
    readNextRunAt: async () => nextRunAt,
    writeNextRunAt: async (d) => { nextRunAt = d; },
    heartbeatMs: 50,
  });
  scheduler.start();
  await new Promise((r) => setTimeout(r, 100));
  scheduler.stop();
  assert.ok(runDreamCalls >= 1);
});

test('scheduler heartbeat fires runDream on overflow', async () => {
  let runDreamCalls = 0;
  let overflow = true;
  const scheduler = createScheduler({
    runDream: async () => { runDreamCalls++; overflow = false; },
    isOverflow: async () => overflow,
    getCronHour: () => 4,
    readNextRunAt: async () => new Date(Date.now() + 86400_000),
    writeNextRunAt: async () => {},
    heartbeatMs: 50,
  });
  scheduler.start();
  await new Promise((r) => setTimeout(r, 150));
  scheduler.stop();
  assert.ok(runDreamCalls >= 1);
});

test('scheduler does not run when in flight', async () => {
  let runDreamCalls = 0;
  const scheduler = createScheduler({
    runDream: async () => {
      runDreamCalls++;
      await new Promise((r) => setTimeout(r, 200));
    },
    isOverflow: async () => false,
    getCronHour: () => 4,
    readNextRunAt: async () => new Date(Date.now() - 1000),
    writeNextRunAt: async () => {},
    heartbeatMs: 30,
  });
  scheduler.start();
  await new Promise((r) => setTimeout(r, 100));
  scheduler.stop();
  // First tick triggers runDream; subsequent ticks should not start a second one
  assert.equal(runDreamCalls, 1);
});
```

- [ ] **Step 2: Write implementation**

`src/daemon/scheduler.js`:

```js
export function createScheduler({
  runDream, isOverflow, getCronHour, readNextRunAt, writeNextRunAt,
  heartbeatMs = 60_000,
}) {
  let timer = null;
  let inFlight = false;

  function computeNextNightly(cronHour) {
    const now = new Date();
    const next = new Date(now);
    next.setHours(cronHour, 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    return next;
  }

  async function tick() {
    if (inFlight) return;
    const next = await readNextRunAt();
    if (next && new Date() >= new Date(next)) {
      inFlight = true;
      try {
        await runDream({ trigger: 'cron' });
        await writeNextRunAt(computeNextNightly(getCronHour()));
      } finally {
        inFlight = false;
      }
      return;
    }
    if (!inFlight && (await isOverflow())) {
      inFlight = true;
      try { await runDream({ trigger: 'overflow' }); } finally { inFlight = false; }
    }
  }

  function start() {
    if (timer) clearInterval(timer);
    timer = setInterval(() => { tick().catch(() => {}); }, heartbeatMs);
    timer.unref();
    tick().catch(() => {});
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { start, stop };
}
```

- [ ] **Step 3: Run + lint + commit**

```bash
npm test -- tests/unit/scheduler-heartbeat.test.js
npm run lint
git add src/daemon/scheduler.js tests/unit/scheduler-heartbeat.test.js
git commit -m "feat(daemon): heartbeat-based scheduler with cron + overflow triggers"
```

---

## Task 8: 9 new MCP tools

This bundles all 9 tool handlers. Each is small. Single commit per tool family for clean history.

**Files:**
- Create: `src/mcp/tools/get-knowledge.js`
- Create: `src/mcp/tools/list-patterns.js`
- Create: `src/mcp/tools/get-profile.js`
- Create: `src/mcp/tools/list-threads.js`
- Create: `src/mcp/tools/list-journal.js`
- Create: `src/mcp/tools/get-hot.js`
- Create: `src/mcp/tools/list-rules.js`
- Create: `src/mcp/tools/update-rule.js`
- Create: `src/mcp/tools/run-dream.js`
- Plus minimal smoke tests for each

- [ ] **Step 1: Write all 9 tools**

(Each is a small wrapper around the memory/rules/dream modules from Tasks 2-7.)

`src/mcp/tools/get-knowledge.js`:

```js
import { listKnowledge, searchKnowledge } from '../../memory/knowledge.js';

export function createGetKnowledgeTool({ db, embedder }) {
  return {
    name: 'get_knowledge',
    description: 'Search or list knowledge — semantic search via query, or filter by subject_id.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        subject_id: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
      },
    },
    handler: async (args) => {
      if (args.query) {
        const hits = await searchKnowledge(db, embedder, args.query, { limit: args.limit ?? 10 });
        return { knowledge: hits.map((h) => ({ ...h, id: String(h.id), subject_id: h.subject_id ? String(h.subject_id) : null })) };
      }
      const list = await listKnowledge(db, { subject_id: args.subject_id, limit: args.limit ?? 10 });
      return { knowledge: list.map((k) => ({ ...k, id: String(k.id), subject_id: k.subject_id ? String(k.subject_id) : null })) };
    },
  };
}
```

`src/mcp/tools/list-patterns.js`:

```js
import { listPatterns } from '../../memory/patterns.js';

export function createListPatternsTool({ db }) {
  return {
    name: 'list_patterns',
    description: 'List recurring observation patterns dream has identified.',
    inputSchema: {
      type: 'object',
      properties: {
        active_only: { type: 'boolean', default: false },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
      },
    },
    handler: async (args) => {
      const list = await listPatterns(db, { activeOnly: args.active_only, limit: args.limit ?? 50 });
      return { patterns: list.map((p) => ({ ...p, id: String(p.id) })) };
    },
  };
}
```

`src/mcp/tools/get-profile.js`:

```js
import { getProfile } from '../../memory/profile.js';

export function createGetProfileTool({ db }) {
  return {
    name: 'get_profile',
    description: 'Read the user profile (name, pronouns, timezone, interests). Profile updates flow through rule_candidates approval.',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      const p = await getProfile(db);
      return { profile: p };
    },
  };
}
```

`src/mcp/tools/list-threads.js`:

```js
import { listThreads } from '../../memory/threads.js';

export function createListThreadsTool({ db }) {
  return {
    name: 'list_threads',
    description: 'List conversation threads (groupings of related episodes).',
    inputSchema: {
      type: 'object',
      properties: {
        since: { type: 'string', format: 'date-time' },
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
      },
    },
    handler: async (args) => {
      const list = await listThreads(db, { since: args.since, limit: args.limit ?? 20 });
      return { threads: list.map((t) => ({ ...t, id: String(t.id) })) };
    },
  };
}
```

`src/mcp/tools/list-journal.js`:

```js
import { listJournalEntries } from '../../memory/journal.js';

export function createListJournalTool({ db }) {
  return {
    name: 'list_journal',
    description: 'Chronological view of significant events.',
    inputSchema: {
      type: 'object',
      properties: {
        since: { type: 'string', format: 'date-time' },
        until: { type: 'string', format: 'date-time' },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
      },
    },
    handler: async (args) => {
      const entries = await listJournalEntries(db, args);
      return { entries: entries.map((e) => ({ ...e, id: String(e.id), episode_id: e.episode_id ? String(e.episode_id) : null })) };
    },
  };
}
```

`src/mcp/tools/get-hot.js`:

```js
import { getHotContext } from '../../memory/hot.js';

export function createGetHotTool({ db }) {
  return {
    name: 'get_hot',
    description: 'Hot context: active episodes + recent events.',
    inputSchema: {
      type: 'object',
      properties: { source: { type: 'string' } },
    },
    handler: async (args) => {
      const r = await getHotContext(db, { source: args.source });
      return {
        episodes: (r.episodes ?? []).map((e) => ({ ...e, id: String(e.id) })),
        recent_events: (r.recent_events ?? []).map((e) => ({ ...e, id: String(e.id), episode_id: e.episode_id ? String(e.episode_id) : null })),
      };
    },
  };
}
```

`src/mcp/tools/list-rules.js`:

```js
import { listCandidates } from '../../rules/candidates.js';
import { listRules } from '../../rules/rules.js';

export function createListRulesTool({ db }) {
  return {
    name: 'list_rules',
    description: 'List rules. status="active" returns approved active rules; "pending" returns rule_candidates awaiting review; "all" returns both.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['pending', 'active', 'all'], default: 'active' },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
      },
    },
    handler: async (args) => {
      const status = args.status ?? 'active';
      const limit = args.limit ?? 50;
      const out = {};
      if (status === 'active' || status === 'all') {
        const rules = await listRules(db, { activeOnly: true, limit });
        out.active = rules.map((r) => ({ ...r, id: String(r.id) }));
      }
      if (status === 'pending' || status === 'all') {
        const cands = await listCandidates(db, { status: 'pending', limit });
        out.pending = cands.map((c) => ({ ...c, id: String(c.id), signal_events: (c.signal_events ?? []).map(String) }));
      }
      return out;
    },
  };
}
```

`src/mcp/tools/update-rule.js`:

```js
import { rejectCandidate } from '../../rules/candidates.js';
import { approveCandidate, deactivateRule, setRulePriority } from '../../rules/rules.js';

export function createUpdateRuleTool({ db }) {
  return {
    name: 'update_rule',
    description: 'Update a rule or rule_candidate. action=approve/reject operates on candidates; deactivate/set_priority on rules.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        action: { type: 'string', enum: ['approve', 'reject', 'deactivate', 'set_priority'] },
        options: {
          type: 'object',
          properties: {
            reason: { type: 'string' },
            priority: { type: 'integer', minimum: 1, maximum: 100 },
          },
        },
      },
      required: ['id', 'action'],
    },
    handler: async (args) => {
      const { id, action, options = {} } = args;
      switch (action) {
        case 'approve': {
          const r = await approveCandidate(db, id);
          return { ok: true, rule_id: String(r.id) };
        }
        case 'reject':
          await rejectCandidate(db, id, options.reason);
          return { ok: true };
        case 'deactivate':
          await deactivateRule(db, id);
          return { ok: true };
        case 'set_priority':
          if (!Number.isInteger(options.priority)) {
            throw new Error('options.priority required for set_priority action');
          }
          await setRulePriority(db, id, options.priority);
          return { ok: true };
        default:
          throw new Error(`unknown action: ${action}`);
      }
    },
  };
}
```

`src/mcp/tools/run-dream.js`:

```js
export function createRunDreamTool({ db, host, embedder, dreamProcess }) {
  return {
    name: 'run_dream',
    description: 'Manually trigger the dream pipeline (knowledge synthesis, pattern detection, correction clustering, profile inference, thread updates).',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      const summary = await dreamProcess(db, host, embedder);
      return { summary };
    },
  };
}
```

- [ ] **Step 2: Write a single combined smoke test for all 9 tools**

`tests/unit/tools-2c-smoke.test.js`:

```js
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createStubEmbedder } from '../../src/embed/embedder.js';
import { createGetHotTool } from '../../src/mcp/tools/get-hot.js';
import { createGetKnowledgeTool } from '../../src/mcp/tools/get-knowledge.js';
import { createGetProfileTool } from '../../src/mcp/tools/get-profile.js';
import { createListJournalTool } from '../../src/mcp/tools/list-journal.js';
import { createListPatternsTool } from '../../src/mcp/tools/list-patterns.js';
import { createListRulesTool } from '../../src/mcp/tools/list-rules.js';
import { createListThreadsTool } from '../../src/mcp/tools/list-threads.js';
import { createUpdateRuleTool } from '../../src/mcp/tools/update-rule.js';

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  return db;
}

test('all 8 read/update tools have correct names + schemas + handlers run on empty DB', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 384 });
  const tools = [
    createGetKnowledgeTool({ db, embedder: e }),
    createListPatternsTool({ db }),
    createGetProfileTool({ db }),
    createListThreadsTool({ db }),
    createListJournalTool({ db }),
    createGetHotTool({ db }),
    createListRulesTool({ db }),
    createUpdateRuleTool({ db }),
  ];
  for (const t of tools) {
    assert.ok(t.name);
    assert.ok(t.description);
    assert.ok(t.inputSchema);
    assert.ok(typeof t.handler === 'function');
  }
  // Each read tool should run on empty DB without error
  await tools[0].handler({});  // get_knowledge with no args
  await tools[1].handler({});  // list_patterns
  await tools[2].handler({});  // get_profile
  await tools[3].handler({});  // list_threads
  await tools[4].handler({});  // list_journal
  await tools[5].handler({});  // get_hot
  await tools[6].handler({});  // list_rules
  // update_rule on missing id should throw
  await assert.rejects(tools[7].handler({ id: 'nope', action: 'approve' }));
  await close(db);
});
```

- [ ] **Step 3: Run + lint + commit**

```bash
npm test -- tests/unit/tools-2c-smoke.test.js
npm run lint
git add src/mcp/tools/get-knowledge.js src/mcp/tools/list-patterns.js src/mcp/tools/get-profile.js src/mcp/tools/list-threads.js src/mcp/tools/list-journal.js src/mcp/tools/get-hot.js src/mcp/tools/list-rules.js src/mcp/tools/update-rule.js src/mcp/tools/run-dream.js tests/unit/tools-2c-smoke.test.js
git commit -m "feat(mcp): 9 new tools — get_knowledge/list_patterns/get_profile/list_threads/list_journal/get_hot/list_rules/update_rule/run_dream"
```

---

## Task 9: Wire daemon — register new tools, scheduler, dream

**Files:**
- Modify: `src/daemon/server.js`

- [ ] **Step 1: Update daemon entry point**

Read `src/daemon/server.js` first. Add:
- Import all 9 new tool factories.
- Import `dreamProcess` from `src/dream/pipeline.js`.
- Import `createScheduler` from `src/daemon/scheduler.js`.
- Append all 9 new tools to the `tools` array.
- Wire scheduler into daemon startup: read `runtime:scheduler.next_dream_run_at`, start scheduler with `runDream` calling `dreamProcess`, `isOverflow` checking pending events count > threshold.
- Stop scheduler on SIGTERM/SIGINT.

Concrete diff to add (insert after existing tools array, before the `httpServer = createServer` block):

```js
import { dreamProcess } from '../dream/pipeline.js';
import { createScheduler } from './scheduler.js';
import { createGetHotTool } from '../mcp/tools/get-hot.js';
import { createGetKnowledgeTool } from '../mcp/tools/get-knowledge.js';
import { createGetProfileTool } from '../mcp/tools/get-profile.js';
import { createListJournalTool } from '../mcp/tools/list-journal.js';
import { createListPatternsTool } from '../mcp/tools/list-patterns.js';
import { createListRulesTool } from '../mcp/tools/list-rules.js';
import { createListThreadsTool } from '../mcp/tools/list-threads.js';
import { createRunDreamTool } from '../mcp/tools/run-dream.js';
import { createUpdateRuleTool } from '../mcp/tools/update-rule.js';

// ... in tools array, append:
tools.push(
  createGetKnowledgeTool({ db: dbHandle, embedder: embedderWrap }),
  createListPatternsTool({ db: dbHandle }),
  createGetProfileTool({ db: dbHandle }),
  createListThreadsTool({ db: dbHandle }),
  createListJournalTool({ db: dbHandle }),
  createGetHotTool({ db: dbHandle }),
  createListRulesTool({ db: dbHandle }),
  createUpdateRuleTool({ db: dbHandle }),
  createRunDreamTool({
    db: dbHandle,
    host: await getHost(),
    embedder: embedderWrap,
    dreamProcess,
  }),
);

// Scheduler wiring
const scheduler = createScheduler({
  runDream: async () => {
    const e = await idleEmbedder.get();
    const h = await getHost();
    return dreamProcess(dbHandle, h, e);
  },
  isOverflow: async () => {
    const [rows] = await dbHandle
      .query('SELECT count() AS n FROM events WHERE biographed_at IS NONE GROUP ALL')
      .collect();
    return (rows[0]?.n ?? 0) >= 500;
  },
  getCronHour: () => 4,
  readNextRunAt: async () => {
    const [rows] = await dbHandle
      .query("SELECT * FROM type::record('runtime', 'scheduler') LIMIT 1")
      .collect();
    return rows[0]?.value?.next_dream_run_at ?? null;
  },
  writeNextRunAt: async (d) => {
    await dbHandle
      .query("UPSERT type::record('runtime', 'scheduler') SET value.next_dream_run_at = $d", { d })
      .collect();
  },
});
scheduler.start();
```

(Adjust the existing shutdown handler to call `scheduler.stop()` before closing the DB.)

- [ ] **Step 2: Smoke-test daemon boot**

```bash
ROBIN_HOME=/tmp/robin-task9 ROBIN_HOST=claude_code node bin/robin migrate
ROBIN_HOME=/tmp/robin-task9 ROBIN_HOST=claude_code node src/daemon/server.js &
DAEMON_PID=$!
sleep 4
cat /tmp/robin-task9/.daemon.state
kill $DAEMON_PID 2>/dev/null
sleep 1
```

Expected: daemon starts cleanly, state file written, daemon shuts down on SIGTERM.

- [ ] **Step 3: Run full test suite + lint**

```bash
npm test
npm run lint
```

Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/daemon/server.js
git commit -m "feat(daemon): register 9 new tools + scheduler + dream wiring"
```

---

## Task 10: 8 new CLI commands

**Files:**
- Create: 8 files in `src/cli/commands/` (dream-run, rules-pending, rules-approve, rules-reject, rules-list, rules-deactivate, journal, hot)
- Modify: `src/cli/index.js` — wire new commands

- [ ] **Step 1: Write CLI commands**

`src/cli/commands/dream-run.js`:

```js
import { acquire } from '../../db/lock.js';
import { close, connect } from '../../db/client.js';
import { createTransformersEmbedder } from '../../embed/embedder.js';
import { detectHost } from '../../hosts/detect.js';
import { dreamProcess } from '../../dream/pipeline.js';
import { ensureHome, paths } from '../../runtime/home.js';

export async function dreamRun() {
  await ensureHome();
  const p = paths();
  const release = await acquire(p.lock);
  try {
    const db = await connect({ engine: `rocksdb://${p.db}` });
    try {
      const embedder = await createTransformersEmbedder();
      const host = await detectHost();
      const summary = await dreamProcess(db, host, embedder);
      console.log(JSON.stringify(summary, null, 2));
    } finally { await close(db); }
  } finally { await release(); }
}
```

`src/cli/commands/rules-pending.js`:

```js
import { close, connect } from '../../db/client.js';
import { listCandidates } from '../../rules/candidates.js';
import { ensureHome, paths } from '../../runtime/home.js';

export async function rulesPending() {
  await ensureHome();
  const p = paths();
  const db = await connect({ engine: `rocksdb://${p.db}` });
  try {
    const list = await listCandidates(db, { status: 'pending' });
    if (list.length === 0) { console.log('no pending candidates'); return; }
    for (const c of list) {
      console.log(`${String(c.id)}  [${c.kind}]  ${c.content}  (confidence ${c.confidence})`);
    }
  } finally { await close(db); }
}
```

`src/cli/commands/rules-approve.js`:

```js
import { close, connect } from '../../db/client.js';
import { ensureHome, paths } from '../../runtime/home.js';
import { approveCandidate } from '../../rules/rules.js';

export async function rulesApprove(argv) {
  if (!argv[0]) { console.error('usage: robin rules approve <id>'); process.exit(1); }
  await ensureHome();
  const p = paths();
  const db = await connect({ engine: `rocksdb://${p.db}` });
  try {
    const r = await approveCandidate(db, argv[0]);
    console.log(`approved; rule id: ${String(r.id)}`);
  } finally { await close(db); }
}
```

`src/cli/commands/rules-reject.js`:

```js
import { close, connect } from '../../db/client.js';
import { ensureHome, paths } from '../../runtime/home.js';
import { rejectCandidate } from '../../rules/rules.js';

export async function rulesReject(argv) {
  if (!argv[0]) { console.error('usage: robin rules reject <id> [reason]'); process.exit(1); }
  const id = argv[0];
  const reason = argv.slice(1).join(' ') || undefined;
  await ensureHome();
  const p = paths();
  const db = await connect({ engine: `rocksdb://${p.db}` });
  try {
    await rejectCandidate(db, id, reason);
    console.log('rejected');
  } finally { await close(db); }
}
```

`src/cli/commands/rules-list.js`:

```js
import { close, connect } from '../../db/client.js';
import { ensureHome, paths } from '../../runtime/home.js';
import { listRules } from '../../rules/rules.js';

export async function rulesList() {
  await ensureHome();
  const p = paths();
  const db = await connect({ engine: `rocksdb://${p.db}` });
  try {
    const list = await listRules(db, { activeOnly: true });
    if (list.length === 0) { console.log('no active rules'); return; }
    for (const r of list) {
      console.log(`${String(r.id)}  [priority ${r.priority}]  ${r.content}`);
    }
  } finally { await close(db); }
}
```

`src/cli/commands/rules-deactivate.js`:

```js
import { close, connect } from '../../db/client.js';
import { ensureHome, paths } from '../../runtime/home.js';
import { deactivateRule } from '../../rules/rules.js';

export async function rulesDeactivate(argv) {
  if (!argv[0]) { console.error('usage: robin rules deactivate <id>'); process.exit(1); }
  await ensureHome();
  const p = paths();
  const db = await connect({ engine: `rocksdb://${p.db}` });
  try {
    await deactivateRule(db, argv[0]);
    console.log('deactivated');
  } finally { await close(db); }
}
```

`src/cli/commands/journal.js`:

```js
import { close, connect } from '../../db/client.js';
import { listJournalEntries } from '../../memory/journal.js';
import { ensureHome, paths } from '../../runtime/home.js';
import { parseArgs } from '../args.js';

export async function journalCmd(argv) {
  const args = parseArgs(argv);
  await ensureHome();
  const p = paths();
  const db = await connect({ engine: `rocksdb://${p.db}` });
  try {
    const entries = await listJournalEntries(db, {
      since: args.flags.since,
      until: args.flags.until,
      limit: args.flags.limit ? Number.parseInt(args.flags.limit, 10) : 50,
    });
    for (const e of entries) {
      console.log(`[${new Date(e.ts).toISOString()}] [${e.source}] ${e.content}`);
    }
    if (entries.length === 0) console.log('(empty)');
  } finally { await close(db); }
}
```

`src/cli/commands/hot.js`:

```js
import { close, connect } from '../../db/client.js';
import { getHotContext } from '../../memory/hot.js';
import { ensureHome, paths } from '../../runtime/home.js';

export async function hotCmd() {
  await ensureHome();
  const p = paths();
  const db = await connect({ engine: `rocksdb://${p.db}` });
  try {
    const r = await getHotContext(db);
    console.log(JSON.stringify(r, null, 2));
  } finally { await close(db); }
}
```

- [ ] **Step 2: Wire into `src/cli/index.js`**

Read the current file. Add new top-level branches:

```js
if (cmd === 'dream') {
  if (argv[1] === 'run') {
    const { dreamRun } = await import('./commands/dream-run.js');
    return dreamRun();
  }
  console.error('usage: robin dream run');
  process.exit(1);
}
if (cmd === 'rules') {
  const sub = argv[1];
  const subcommands = {
    pending: 'rules-pending.js',
    approve: 'rules-approve.js',
    reject: 'rules-reject.js',
    list: 'rules-list.js',
    deactivate: 'rules-deactivate.js',
  };
  if (!subcommands[sub]) {
    console.error(`unknown rules subcommand: ${sub}`);
    process.exit(1);
  }
  const mod = await import(`./commands/${subcommands[sub]}`);
  const fn = Object.values(mod)[0];
  return fn(argv.slice(2));
}
if (cmd === 'journal') {
  const { journalCmd } = await import('./commands/journal.js');
  return journalCmd(argv.slice(1));
}
if (cmd === 'hot') {
  const { hotCmd } = await import('./commands/hot.js');
  return hotCmd();
}
```

Note: these CLI commands open the DB directly; they need the daemon-running check (like migrate has) OR they should route through the daemon if running. For simplicity in 2c, they bypass the daemon and use the file lock. Phase 3 polish might route through daemon HTTP.

Add the daemon-running check to each command. Pattern (from migrate.js):

```js
const stateRow = await readDaemonState(join(p.home, '.daemon.state'));
if (stateRow && isPidAlive(stateRow.pid)) {
  console.error('daemon is running. Stop it first: robin mcp stop');
  process.exit(1);
}
```

This protects against the file-lock contention with the daemon.

- [ ] **Step 3: Smoke test**

```bash
ROBIN_HOME=/tmp/robin-task10 ROBIN_HOST=claude_code node bin/robin migrate
ROBIN_HOME=/tmp/robin-task10 ROBIN_HOST=claude_code node bin/robin rules pending
ROBIN_HOME=/tmp/robin-task10 ROBIN_HOST=claude_code node bin/robin rules list
ROBIN_HOME=/tmp/robin-task10 ROBIN_HOST=claude_code node bin/robin journal
ROBIN_HOME=/tmp/robin-task10 ROBIN_HOST=claude_code node bin/robin hot
```

Expected: each prints empty/no-data messages, exits 0.

- [ ] **Step 4: Run full suite + lint + commit**

```bash
npm test
npm run lint
git add src/cli/commands/dream-run.js src/cli/commands/rules-*.js src/cli/commands/journal.js src/cli/commands/hot.js src/cli/index.js
git commit -m "feat(cli): 8 new commands — dream run, rules subcommands, journal, hot"
```

---

## Task 11: AGENTS.md update for 2c (active-rules + pending-rules sections)

**Files:**
- Modify: `src/install/agents-md.js`
- Modify: `tests/unit/agents-md.test.js`

- [ ] **Step 1: Update `agents-md.js`**

Read the current file. After the existing "Feedback" section, before "Daemon health", insert new sections for active rules + pending rule candidates:

```js
// Insert into the template string after the "Feedback" section:

`## Active rules (read at session start)

At the start of each conversation, call \`list_rules({status: 'active'})\` once and
fold the returned rules into how you respond. These are user preferences and
corrections the user has previously approved. Apply them silently; don't recite
them back.

## Pending rule candidates

Robin's dream agent periodically surfaces "rule candidates" — patterns from
recent user corrections that might warrant a permanent rule. When you have
opportunity (natural breakpoint, after a correction, or when user asks about
their preferences), call \`list_rules({status: 'pending'})\` and surface
candidates conversationally:

  "I noticed you've corrected me three times about verbosity in the last week.
   Want me to remember 'prefer concise answers'?"

If user says yes → \`update_rule(id, 'approve')\`.
If user says no → \`update_rule(id, 'reject', { reason: '...' })\`.
Don't badger; once per session at most for any given candidate.

## Profile updates as candidates

Profile changes (name, pronouns, timezone, interests) come through the same
\`rule_candidates\` flow with kind='profile_update'. Same approve/reject pattern.
Approval applies the field changes to the user's profile.

`
```

- [ ] **Step 2: Update the test**

Read `tests/unit/agents-md.test.js`. Add test cases:

```js
test('agentsMdContent includes active-rules instruction with list_rules({status: active})', () => {
  const md = agentsMdContent();
  assert.match(md, /list_rules\(\{status: 'active'\}\)/);
  assert.match(md, /Active rules/);
});

test('agentsMdContent includes pending-rules instruction with update_rule', () => {
  const md = agentsMdContent();
  assert.match(md, /list_rules\(\{status: 'pending'\}\)/);
  assert.match(md, /update_rule\(id, 'approve'\)/);
  assert.match(md, /update_rule\(id, 'reject'/);
});
```

- [ ] **Step 3: Run + lint + commit**

```bash
npm test -- tests/unit/agents-md.test.js
npm run lint
git add src/install/agents-md.js tests/unit/agents-md.test.js
git commit -m "feat(install): AGENTS.md adds active-rules + pending-rules sections"
```

---

## Task 12: Integration tests + CHANGELOG + tag

**Files:**
- Create: `tests/integration/rule-approval-roundtrip.test.js`
- Create: `tests/integration/profile-candidate-flow.test.js`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Rule approval round-trip integration test**

`tests/integration/rule-approval-roundtrip.test.js`:

```js
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { recordEvent } from '../../src/capture/record-event.js';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { dreamProcess } from '../../src/dream/pipeline.js';
import { createStubEmbedder } from '../../src/embed/embedder.js';
import { createListRulesTool } from '../../src/mcp/tools/list-rules.js';
import { createUpdateRuleTool } from '../../src/mcp/tools/update-rule.js';

test('correction → dream → list_rules pending → approve → list_rules active', async () => {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  const e = createStubEmbedder({ dimension: 384 });
  // 3 similar corrections
  for (let i = 0; i < 3; i++) {
    await recordEvent(db, e, { source: 'manual', content: 'be more concise', meta: { kind: 'correction' } });
  }
  const host = {
    invokeLLM: async () => ({
      content: JSON.stringify({ propose: true, rule_text: 'Prefer concise responses', confidence: 0.9, candidates: [], promote: false }),
      usage: {},
    }),
  };
  await dreamProcess(db, host, e);

  const list = createListRulesTool({ db });
  const update = createUpdateRuleTool({ db });

  const pending = await list.handler({ status: 'pending' });
  assert.ok(pending.pending.length >= 1);

  await update.handler({ id: pending.pending[0].id, action: 'approve' });

  const active = await list.handler({ status: 'active' });
  assert.ok(active.active.length >= 1);
  assert.match(active.active[0].content, /concise/i);
  await close(db);
});
```

- [ ] **Step 2: Profile candidate flow integration test**

`tests/integration/profile-candidate-flow.test.js`:

```js
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { getProfile } from '../../src/memory/profile.js';
import { createCandidate } from '../../src/rules/candidates.js';
import { approveCandidate } from '../../src/rules/rules.js';

test('profile_update candidate → approve → profile:singleton updated', async () => {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  const c = await createCandidate(db, {
    content: 'set name to Kevin',
    kind: 'profile_update',
    signal_events: [],
    payload: { fields: { name: 'Kevin', pronouns: 'he/him' } },
    confidence: 0.9,
  });
  await approveCandidate(db, c.id);
  const p = await getProfile(db);
  assert.equal(p.name, 'Kevin');
  assert.equal(p.pronouns, 'he/him');
  await close(db);
});
```

- [ ] **Step 3: Run all + lint**

```bash
npm test
npm run lint
```

Expected: all tests pass.

- [ ] **Step 4: Update CHANGELOG**

Prepend to CHANGELOG.md:

```markdown
## [6.0.0-alpha.4] — 2026-05-09

Phase 2c: dream agent + memory shapes + heuristic loop.

- New schema (migration 0005): `knowledge`, `patterns`, `profile` (singleton), `threads`, `rule_candidates`, `rules`. `events.dreamed_at` field added.
- **Dream agent** — daemon-internal periodic batch, heartbeat-scheduled (nightly cron at 4 AM via `process.env.TZ` + event-count overflow trigger). Five-step pipeline: knowledge synthesis → pattern detection → correction clustering → profile inference → thread updates. All LLM calls flow through `host.invokeLLM` subprocess (no direct API).
- **9 new MCP tools** (consolidated from 14): `get_knowledge`, `list_patterns`, `get_profile`, `list_threads`, `list_journal`, `get_hot`, `list_rules(status?)`, `update_rule(id, action, options?)`, `run_dream`. Total daemon surface: 19.
- **8 new CLI commands**: `robin dream run`, `robin rules pending/approve/reject/list/deactivate`, `robin journal`, `robin hot`.
- **Heuristic correction loop**: corrections → 30-day rolling cluster (cosine ≥ 0.85, min 3) → LLM proposes rule → user approves via MCP or CLI → rule active. Profile updates same flow but `kind='profile_update'` with `payload.fields` applied on approval.
- **`rules` table preserves `kind` + `payload`** for replayability of approved profile updates.
- **Heartbeat scheduler** (60s tick) replaces fragile setTimeout — robust to laptop sleep + DST.
- **AGENTS.md** updated with active-rules + pending-rules sections instructing agents to call `list_rules({status: 'active'})` at session start.
- **Task 0**: fixed Phase 2a Claude Code adapter args from stub `['invokeLLM']` to real `claude -p` + JSON output.

Phase 2d (integrations: Gmail, Discord, etc.) is the next phase.
```

- [ ] **Step 5: Commit + tag**

```bash
git add tests/integration/rule-approval-roundtrip.test.js tests/integration/profile-candidate-flow.test.js CHANGELOG.md
git commit -m "test(2c): integration tests for rule approval + profile candidate flow"
git tag v6.0.0-alpha.4
```

---

## Spec coverage cross-check

| Spec section | Tasks |
|---|---|
| Task 0 prerequisite | Task 0 |
| Section 2 schema | Task 1 |
| Section 3 dream pipeline | Task 6 |
| Section 4 derived views (journal, hot) | Task 4 |
| Section 5 heuristic correction loop | Tasks 5, 6, 8, 11 |
| Section 6 MCP tools (9) | Task 8 |
| Section 6 CLI commands (8) | Task 10 |
| Section 7 daemon scheduler | Tasks 7, 9 |
| Section 8 testing strategy | All tests inline + Task 12 |
| Section 9 open questions | Task 1 (schema), Task 5 (rules.kind+payload), Task 6 (correction lookback + dedupe), Task 7 (heartbeat scheduler) |

No spec section is uncovered.

---

## Execution Handoff

Plan complete — 12 tasks (0–12). Per user instruction, proceeding directly to subagent-driven execution without further confirmation.
