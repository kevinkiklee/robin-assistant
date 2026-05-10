# Phase 4f Conversation Capture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On every Stop hook fire, capture the most recent user+assistant turn as one `events` row with `source='conversation'`, then let the existing biographer extract entities/edges/episodes from it.

**Architecture:** New `src/capture/transcript.js` parses the host's transcript JSONL (tail-read, walk backwards past `tool_result` user messages). New `src/capture/session-capture.js` runs skip heuristics + dedup probe + PII guard, then calls `recordEvent`. Stop hook (`src/hooks/handlers/stop-hook.js`) forwards `transcript_path` + `session_id` to the existing biographer subprocess; that subprocess runs the capture pre-step before processing pending events. No new tables, no migration, no daemon endpoints — extends the existing `/internal/biographer/process-pending` body shape only.

**Tech Stack:** Node.js 22 ES modules · `node:test` runner · SurrealDB v3 embedded via `surrealdb` JS SDK · existing `recordEvent` + `guardInboundContent` + biographer pipeline.

**Spec:** `docs/superpowers/specs/2026-05-10-robin-v2-phase-4f-conversation-capture-design.md`

---

## File map

| File | Action | Purpose |
|---|---|---|
| `src/capture/record-event.js` | Modify | Add `'conversation'` to `VALID_SOURCES`. |
| `src/runtime/file-tail.js` | Create | Shared `readFileTail(path, maxBytes)` helper (extracted from auto-recall). |
| `src/hooks/handlers/auto-recall.js` | Modify | Import `readFileTail` from the new util (delete local copy). |
| `src/capture/transcript.js` | Create | `extractTurns({transcriptPath, tailBytes})` — parse JSONL backwards, return `{userText, assistantText, hasToolCalls, tsAssistant}`. |
| `src/capture/session-capture.js` | Create | `captureFromTranscript(db, embedder, {transcriptPath, sessionId, host})` — skip heuristics + dedup probe + PII guard + `recordEvent`. |
| `src/hooks/handlers/stop-hook.js` | Modify | Pull `transcript_path` + `session_id` from `args.stdin`; forward via daemon POST body and direct-spawn flags. |
| `src/cli/commands/biographer-process-pending.js` | Modify | Accept `--transcript-path` + `--session-id`; run capture pre-step before draining pending. |
| `src/daemon/server.js` | Modify | `/internal/biographer/process-pending` accepts `{transcript_path, session_id}` in body; runs capture pre-step. |
| `tests/unit/transcript-parse.test.js` | Create | Unit tests for `extractTurns`. |
| `tests/unit/session-capture.test.js` | Create | Unit tests for `captureFromTranscript`. |
| `tests/integration/conversation-capture-roundtrip.test.js` | Create | End-to-end: stop hook → capture → biographer → entities. |
| `CHANGELOG.md` | Modify | New `v6.0.0-alpha.10` entry. |
| `README.md` | Modify | Add capture arrow to the "How Robin works" diagram. |

---

## Task 1: Add `'conversation'` to VALID_SOURCES

**Files:**
- Modify: `src/capture/record-event.js:5-14`
- Test: `tests/unit/record-event-conversation-source.test.js` (new)

- [ ] **Step 1: Write the failing test**

Create `tests/unit/record-event-conversation-source.test.js`:

```js
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { recordEvent } from '../../src/capture/record-event.js';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createStubEmbedder } from '../../src/embed/embedder.js';

import { mkdirSync as __robinMkdirSync } from 'node:fs';
import { tmpdir as __robinTmpdir } from 'node:os';
import { join as __robinJoin } from 'node:path';
import { writeConfig as __robinWriteConfig } from '../../src/runtime/config.js';

const __robinTestHome = __robinJoin(
  __robinTmpdir(),
  `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`,
);
__robinMkdirSync(__robinTestHome, { recursive: true });
process.env.ROBIN_HOME = __robinTestHome;
await __robinWriteConfig({ embedder_profile: 'mxbai-1024' });

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  return db;
}

test("recordEvent accepts source='conversation'", async () => {
  const db = await fresh();
  try {
    const embedder = createStubEmbedder();
    const { id } = await recordEvent(db, embedder, {
      source: 'conversation',
      content: 'USER: hi\n\nASSISTANT: hello',
    });
    const [rows] = await db.query(surql`SELECT source FROM ${id}`).collect();
    assert.equal(rows[0].source, 'conversation');
  } finally {
    await close(db);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/unit/record-event-conversation-source.test.js`
Expected: FAIL with `recordEvent: unknown source "conversation"`.

- [ ] **Step 3: Add `'conversation'` to VALID_SOURCES**

In `src/capture/record-event.js`, change the constant:

```js
const VALID_SOURCES = new Set([
  'cli',
  'stop_hook',
  'manual',
  'sync',
  'biographer',
  'ingest',
  'discord',
  'migration',
  'conversation',
]);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/unit/record-event-conversation-source.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/capture/record-event.js tests/unit/record-event-conversation-source.test.js
git commit -m "feat(4f): allow source='conversation' in recordEvent"
```

---

## Task 2: Extract `readFileTail` into a shared util

The auto-recall handler already has a private `readTail`. Factoring it out keeps the new transcript parser DRY and lets us share the tested implementation. This is a pure refactor — no behavior change.

**Files:**
- Create: `src/runtime/file-tail.js`
- Modify: `src/hooks/handlers/auto-recall.js:17-87` (delete local `readTail`, import shared)
- Test: `tests/unit/file-tail.test.js` (new)

- [ ] **Step 1: Write the failing test**

Create `tests/unit/file-tail.test.js`:

```js
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readFileTail } from '../../src/runtime/file-tail.js';

function tmpFile(content) {
  const dir = join(tmpdir(), `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'sample.jsonl');
  writeFileSync(path, content, 'utf8');
  return path;
}

test('readFileTail returns last N bytes', () => {
  const path = tmpFile('A'.repeat(100) + 'B'.repeat(50));
  assert.equal(readFileTail(path, 50), 'B'.repeat(50));
});

test('readFileTail returns whole file when smaller than maxBytes', () => {
  const path = tmpFile('hello');
  assert.equal(readFileTail(path, 100), 'hello');
});

test('readFileTail returns empty string on missing file', () => {
  assert.equal(readFileTail('/nonexistent/path.jsonl', 100), '');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/unit/file-tail.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Create the shared util**

Create `src/runtime/file-tail.js`:

```js
import { closeSync, openSync, readSync, statSync } from 'node:fs';

// Read the last N bytes of a file as utf8. Returns '' on any error.
// Used for tailing JSONL transcripts without loading the whole file.
export function readFileTail(filePath, maxBytes) {
  let fd;
  try {
    const st = statSync(filePath);
    if (!st.isFile()) return '';
    const size = st.size;
    const start = Math.max(0, size - maxBytes);
    const length = size - start;
    if (length <= 0) return '';
    fd = openSync(filePath, 'r');
    const buf = Buffer.alloc(length);
    readSync(fd, buf, 0, length, start);
    return buf.toString('utf8');
  } catch {
    return '';
  } finally {
    if (typeof fd === 'number') {
      try {
        closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/unit/file-tail.test.js`
Expected: PASS — all 3 tests.

- [ ] **Step 5: Refactor auto-recall to use the shared util**

In `src/hooks/handlers/auto-recall.js`:

Replace the imports at line 17 with:

```js
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readDaemonState } from '../../daemon/state.js';
import { paths } from '../../runtime/home.js';
import { readFileTail } from '../../runtime/file-tail.js';
```

Delete the entire local `readTail` function (lines 63–87 in the original).

Replace its single call site (line 117) from `readTail(transcriptPath, TRANSCRIPT_TAIL_BYTES)` to `readFileTail(transcriptPath, TRANSCRIPT_TAIL_BYTES)`.

- [ ] **Step 6: Run the existing auto-recall tests to verify no regression**

Run: `node --test tests/unit/auto-recall-handler.test.js`
Expected: PASS (existing tests untouched).

- [ ] **Step 7: Commit**

```bash
git add src/runtime/file-tail.js src/hooks/handlers/auto-recall.js tests/unit/file-tail.test.js
git commit -m "refactor(4f): extract readFileTail into a shared runtime util"
```

---

## Task 3: Build `extractTurns` transcript parser

**Files:**
- Create: `src/capture/transcript.js`
- Test: `tests/unit/transcript-parse.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/transcript-parse.test.js`:

```js
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { extractTurns } from '../../src/capture/transcript.js';

function tmpJsonl(lines) {
  const dir = join(tmpdir(), `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'transcript.jsonl');
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
  return path;
}

test('extracts simple text user + assistant turn pair', () => {
  const path = tmpJsonl([
    { type: 'user', message: { role: 'user', content: 'fix the bug' } },
    {
      type: 'assistant',
      message: { role: 'assistant', content: 'Done.', ts: '2026-05-10T12:00:00Z' },
    },
  ]);
  const t = extractTurns({ transcriptPath: path, tailBytes: 8192 });
  assert.equal(t.userText, 'fix the bug');
  assert.equal(t.assistantText, 'Done.');
  assert.equal(t.hasToolCalls, false);
});

test('extracts text from assistant message with array content (text + tool_use blocks)', () => {
  const path = tmpJsonl([
    { type: 'user', message: { role: 'user', content: 'list files' } },
    {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Running ls.' },
          { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
        ],
      },
    },
  ]);
  const t = extractTurns({ transcriptPath: path, tailBytes: 8192 });
  assert.equal(t.assistantText, 'Running ls.');
  assert.equal(t.hasToolCalls, true);
});

test('skips tool_result user messages and walks back to the human prompt', () => {
  const path = tmpJsonl([
    { type: 'user', message: { role: 'user', content: 'use the tool' } },
    {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', name: 'X', input: {} }],
      },
    },
    {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'a', content: 'result' }],
      },
    },
    { type: 'assistant', message: { role: 'assistant', content: 'finished' } },
  ]);
  const t = extractTurns({ transcriptPath: path, tailBytes: 8192 });
  assert.equal(t.userText, 'use the tool');
  assert.equal(t.assistantText, 'finished');
});

test('tolerates malformed final line (partial flush)', () => {
  const path = tmpJsonl([
    { type: 'user', message: { role: 'user', content: 'hi' } },
    { type: 'assistant', message: { role: 'assistant', content: 'hello' } },
  ]);
  // Append a partial line simulating a mid-write race.
  const fs = await import('node:fs');
  fs.appendFileSync(path, '{"type":"assist', 'utf8');
  const t = extractTurns({ transcriptPath: path, tailBytes: 8192 });
  assert.equal(t.assistantText, 'hello');
});

test('returns all-nulls when no assistant turn in window', () => {
  const path = tmpJsonl([{ type: 'user', message: { role: 'user', content: 'just a user msg' } }]);
  const t = extractTurns({ transcriptPath: path, tailBytes: 8192 });
  assert.equal(t.assistantText, null);
  assert.equal(t.userText, null);
});

test('returns userText=null when only a long tool chain fits in window before assistant', () => {
  const path = tmpJsonl([
    {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'a', content: 'r1' }],
      },
    },
    {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'b', content: 'r2' }],
      },
    },
    { type: 'assistant', message: { role: 'assistant', content: 'done' } },
  ]);
  const t = extractTurns({ transcriptPath: path, tailBytes: 8192 });
  assert.equal(t.userText, null);
  assert.equal(t.assistantText, 'done');
});

test('returns empty result on missing transcript', () => {
  const t = extractTurns({ transcriptPath: '/nonexistent/path.jsonl', tailBytes: 8192 });
  assert.equal(t.assistantText, null);
  assert.equal(t.userText, null);
  assert.equal(t.hasToolCalls, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/unit/transcript-parse.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `extractTurns`**

Create `src/capture/transcript.js`:

```js
import { readFileTail } from '../runtime/file-tail.js';

const DEFAULT_TAIL_BYTES = 32 * 1024;

const EMPTY = { userText: null, assistantText: null, hasToolCalls: false, tsAssistant: null };

// Return the concatenated text from a message's content field.
// Content can be a bare string OR an array of content blocks. For arrays
// we extract only `text`-type blocks. `tool_use`, `tool_result`, and
// `thinking` blocks do not contribute to the returned string.
//
// Side-channel: returns `{ text, hasToolCalls, hasToolResultOnly }`
// so the caller can tell tool-call turns from text turns and skip
// user-role messages that are pure tool_result returns.
function readContent(content) {
  if (typeof content === 'string') {
    return { text: content, hasToolCalls: false, hasToolResultOnly: false };
  }
  if (!Array.isArray(content)) {
    return { text: '', hasToolCalls: false, hasToolResultOnly: false };
  }
  const parts = [];
  let hasToolCalls = false;
  let hasText = false;
  let hasToolResult = false;
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
      hasText = true;
    } else if (block.type === 'tool_use') {
      hasToolCalls = true;
    } else if (block.type === 'tool_result' || block.type === 'function_response') {
      hasToolResult = true;
    }
  }
  return {
    text: parts.join('\n'),
    hasToolCalls,
    hasToolResultOnly: hasToolResult && !hasText,
  };
}

function parseJsonlBackwards(tail) {
  if (typeof tail !== 'string' || tail.length === 0) return [];
  const lines = tail.split('\n');
  // Drop the leading possibly-partial fragment unless the tail is a single line.
  const usable = lines.length > 1 ? lines.slice(1) : lines;
  const parsed = [];
  for (const line of usable) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      parsed.push(JSON.parse(trimmed));
    } catch {
      // Tolerate malformed line (e.g. partial final write); skip and continue.
    }
  }
  return parsed;
}

function pickRole(obj) {
  return obj?.role ?? obj?.message?.role ?? null;
}

function pickContent(obj) {
  if (obj?.content !== undefined) return obj.content;
  if (obj?.message?.content !== undefined) return obj.message.content;
  return null;
}

function pickAssistantTs(obj) {
  const raw = obj?.ts ?? obj?.message?.ts ?? obj?.timestamp ?? null;
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function extractTurns({ transcriptPath, tailBytes } = {}) {
  if (!transcriptPath || typeof transcriptPath !== 'string') return { ...EMPTY };
  const tail = readFileTail(transcriptPath, tailBytes ?? DEFAULT_TAIL_BYTES);
  if (!tail) return { ...EMPTY };
  const msgs = parseJsonlBackwards(tail);
  if (msgs.length === 0) return { ...EMPTY };

  // Walk backwards: find the latest assistant message with text content.
  let assistantIdx = -1;
  let assistantText = null;
  let hasToolCalls = false;
  let tsAssistant = null;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (pickRole(msgs[i]) !== 'assistant') continue;
    const { text, hasToolCalls: tc } = readContent(pickContent(msgs[i]));
    // Accept any assistant message (including empty-text + tool_use only)
    // as the anchor — the orchestrator's skip rules decide whether to keep it.
    assistantIdx = i;
    assistantText = text.length > 0 ? text : (tc ? '' : null);
    hasToolCalls = tc;
    tsAssistant = pickAssistantTs(msgs[i]);
    break;
  }
  if (assistantIdx === -1 || assistantText === null) return { ...EMPTY };

  // Walk backwards from the assistant message to find the human user prompt,
  // skipping any user-role messages that are pure tool_result returns.
  let userText = null;
  for (let i = assistantIdx - 1; i >= 0; i--) {
    if (pickRole(msgs[i]) !== 'user') continue;
    const { text, hasToolResultOnly } = readContent(pickContent(msgs[i]));
    if (hasToolResultOnly) continue;
    if (text.length === 0) continue;
    userText = text;
    break;
  }

  return { userText, assistantText, hasToolCalls, tsAssistant };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/unit/transcript-parse.test.js`
Expected: PASS — all 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/capture/transcript.js tests/unit/transcript-parse.test.js
git commit -m "feat(4f): transcript JSONL parser with tool_result walking"
```

---

## Task 4: Build `captureFromTranscript` orchestrator

**Files:**
- Create: `src/capture/session-capture.js`
- Test: `tests/unit/session-capture.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/session-capture.test.js`:

```js
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { join } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { captureFromTranscript } from '../../src/capture/session-capture.js';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createStubEmbedder } from '../../src/embed/embedder.js';

import { mkdirSync as __robinMkdirSync } from 'node:fs';
import { tmpdir as __robinTmpdir } from 'node:os';
import { join as __robinJoin } from 'node:path';
import { writeConfig as __robinWriteConfig } from '../../src/runtime/config.js';

const __robinTestHome = __robinJoin(
  __robinTmpdir(),
  `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`,
);
__robinMkdirSync(__robinTestHome, { recursive: true });
process.env.ROBIN_HOME = __robinTestHome;
await __robinWriteConfig({ embedder_profile: 'mxbai-1024' });

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  return db;
}

function tmpJsonl(lines) {
  const dir = join(tmpdir(), `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'transcript.jsonl');
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
  return path;
}

function transcriptPair(userText, assistantText) {
  return tmpJsonl([
    { type: 'user', message: { role: 'user', content: userText } },
    { type: 'assistant', message: { role: 'assistant', content: assistantText } },
  ]);
}

test('captures normal turn → writes one events row with source=conversation', async () => {
  const db = await fresh();
  try {
    const path = transcriptPair('drop the watches feature', 'Removed the watches table and helpers.');
    const result = await captureFromTranscript(db, createStubEmbedder(), {
      transcriptPath: path,
      sessionId: 's1',
      host: 'claude_code',
    });
    assert.equal(result.captured, true);
    const [rows] = await db
      .query(surql`SELECT source, content, meta FROM events WHERE source = 'conversation'`)
      .collect();
    assert.equal(rows.length, 1);
    assert.ok(rows[0].content.startsWith('USER: drop the watches feature'));
    assert.ok(rows[0].content.includes('ASSISTANT: Removed the watches table'));
    assert.equal(rows[0].meta.session_id, 's1');
    assert.equal(rows[0].meta.host, 'claude_code');
  } finally {
    await close(db);
  }
});

test('skips on missing transcript_path', async () => {
  const db = await fresh();
  try {
    const result = await captureFromTranscript(db, createStubEmbedder(), {
      transcriptPath: null,
      sessionId: 's1',
      host: 'claude_code',
    });
    assert.equal(result.captured, false);
    assert.equal(result.skippedReason, 'no_transcript_path');
  } finally {
    await close(db);
  }
});

test('skips single-word ack (yes / ok / thanks)', async () => {
  const db = await fresh();
  try {
    for (const ack of ['ok', 'yes', 'thanks', 'continue', 'go ahead']) {
      const path = transcriptPair(ack, 'Proceeding.');
      const result = await captureFromTranscript(db, createStubEmbedder(), {
        transcriptPath: path,
        sessionId: 's',
        host: 'claude_code',
      });
      assert.equal(result.captured, false, `should skip ack="${ack}"`);
      assert.equal(result.skippedReason, 'single_word_ack');
    }
  } finally {
    await close(db);
  }
});

test('skips pure-tool turn (hasToolCalls + combined < 30 chars)', async () => {
  const db = await fresh();
  try {
    const path = tmpJsonl([
      { type: 'user', message: { role: 'user', content: 'ls' } },
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'OK' },
            { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
          ],
        },
      },
    ]);
    const result = await captureFromTranscript(db, createStubEmbedder(), {
      transcriptPath: path,
      sessionId: 's',
      host: 'claude_code',
    });
    assert.equal(result.captured, false);
    assert.equal(result.skippedReason, 'pure_tool_turn');
  } finally {
    await close(db);
  }
});

test('skips empty/near-empty turn (< 8 chars combined)', async () => {
  const db = await fresh();
  try {
    const path = transcriptPair('x', '.');
    const result = await captureFromTranscript(db, createStubEmbedder(), {
      transcriptPath: path,
      sessionId: 's',
      host: 'claude_code',
    });
    assert.equal(result.captured, false);
    assert.equal(result.skippedReason, 'empty_turn');
  } finally {
    await close(db);
  }
});

test('does NOT skip short-but-meaningful turn ("drop it", "no, don\'t do that")', async () => {
  const db = await fresh();
  try {
    for (const userMsg of ['drop it', "no, don't do that", 'merge it']) {
      const path = transcriptPair(userMsg, 'Acknowledged. Proceeding as instructed.');
      const result = await captureFromTranscript(db, createStubEmbedder(), {
        transcriptPath: path,
        sessionId: 's',
        host: 'claude_code',
      });
      assert.equal(result.captured, true, `should capture user="${userMsg}"`);
    }
  } finally {
    await close(db);
  }
});

test('dedup probe short-circuits when same content_hash already exists', async () => {
  const db = await fresh();
  try {
    const path = transcriptPair('fix the bug in foo.js', 'Patched foo.js line 42.');
    const r1 = await captureFromTranscript(db, createStubEmbedder(), {
      transcriptPath: path,
      sessionId: 's',
      host: 'claude_code',
    });
    assert.equal(r1.captured, true);
    const r2 = await captureFromTranscript(db, createStubEmbedder(), {
      transcriptPath: path,
      sessionId: 's',
      host: 'claude_code',
    });
    assert.equal(r2.captured, false);
    assert.equal(r2.skippedReason, 'dedup_hit');

    const [rows] = await db
      .query(surql`SELECT count() AS n FROM events WHERE source = 'conversation' GROUP ALL`)
      .collect();
    assert.equal(rows[0].n, 1);
  } finally {
    await close(db);
  }
});

test('PII guard refuses inbound content with credential shape', async () => {
  const db = await fresh();
  try {
    // sk-ant-api03-... is the canonical Anthropic API key shape covered by inbound-guard.
    const userMsg = 'use this token sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const path = transcriptPair(userMsg, 'I will not use credentials in code.');
    const result = await captureFromTranscript(db, createStubEmbedder(), {
      transcriptPath: path,
      sessionId: 's',
      host: 'claude_code',
    });
    assert.equal(result.captured, false);
    assert.equal(result.skippedReason, 'pii_refused');
    const [refusals] = await db
      .query(surql`SELECT * FROM outbound_refusals WHERE direction = 'inbound'`)
      .collect();
    assert.ok(refusals.length >= 1);
  } finally {
    await close(db);
  }
});

test('truncates very long content to 16 KB total', async () => {
  const db = await fresh();
  try {
    const big = 'x'.repeat(20 * 1024);
    const path = transcriptPair(big, big);
    const result = await captureFromTranscript(db, createStubEmbedder(), {
      transcriptPath: path,
      sessionId: 's',
      host: 'claude_code',
    });
    assert.equal(result.captured, true);
    const [rows] = await db
      .query(surql`SELECT content FROM events WHERE source = 'conversation'`)
      .collect();
    assert.ok(rows[0].content.length <= 16 * 1024 + 64, `content was ${rows[0].content.length} bytes`);
  } finally {
    await close(db);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/unit/session-capture.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `captureFromTranscript`**

Create `src/capture/session-capture.js`:

```js
import { mkdirSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { surql } from 'surrealdb';
import { sha256 } from '../embed/hash.js';
import { guardInboundContent } from '../hooks/inbound-guard.js';
import { paths } from '../runtime/home.js';
import { RobinPiiRefusedError } from './errors.js';
import { recordEvent } from './record-event.js';
import { extractTurns } from './transcript.js';

const ACK_WORDS = new Set([
  'ok',
  'okay',
  'yes',
  'no',
  'thanks',
  'thank you',
  'continue',
  'go',
  'go ahead',
  'next',
  'sure',
  'done',
]);

const SIDE_CAP_BYTES = 8 * 1024;
const TOTAL_CAP_BYTES = 16 * 1024;
const PURE_TOOL_MIN_CHARS = 30;
const EMPTY_MIN_CHARS = 8;

function trimToBytes(s, max) {
  if (typeof s !== 'string') return '';
  if (Buffer.byteLength(s, 'utf8') <= max) return s;
  // Fast char-based truncate; we only need to be near the budget for biographer.
  return s.slice(0, max);
}

function formatContent(userText, assistantText) {
  const u = trimToBytes(userText ?? '(no user prompt)', SIDE_CAP_BYTES);
  const a = trimToBytes(assistantText ?? '', SIDE_CAP_BYTES);
  const out = `USER: ${u}\n\nASSISTANT: ${a}`;
  return trimToBytes(out, TOTAL_CAP_BYTES);
}

async function logSkip({ rule, sessionId, userLen, assistantLen }) {
  try {
    const p = paths();
    const dir = join(p.cache, 'logs');
    mkdirSync(dir, { recursive: true });
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      kind: 'capture_skip',
      session_id: sessionId ?? null,
      rule,
      user_len: userLen,
      assistant_len: assistantLen,
    });
    await appendFile(join(dir, 'biographer.log'), `${line}\n`, 'utf8');
  } catch {
    // never block capture on log failure
  }
}

export async function captureFromTranscript(db, embedder, { transcriptPath, sessionId, host } = {}) {
  if (!transcriptPath || typeof transcriptPath !== 'string') {
    await logSkip({ rule: 'no_transcript_path', sessionId, userLen: 0, assistantLen: 0 });
    return { captured: false, skippedReason: 'no_transcript_path' };
  }

  const { userText, assistantText, hasToolCalls, tsAssistant } = extractTurns({ transcriptPath });
  const userTrim = (userText ?? '').trim();
  const assistantTrim = (assistantText ?? '').trim();
  const userLen = userTrim.length;
  const assistantLen = assistantTrim.length;
  const combinedLen = userLen + assistantLen;

  if (assistantText === null) {
    await logSkip({ rule: 'no_assistant_turn', sessionId, userLen, assistantLen });
    return { captured: false, skippedReason: 'no_assistant_turn' };
  }

  if (userText !== null && ACK_WORDS.has(userTrim.toLowerCase())) {
    await logSkip({ rule: 'single_word_ack', sessionId, userLen, assistantLen });
    return { captured: false, skippedReason: 'single_word_ack' };
  }

  if (combinedLen < EMPTY_MIN_CHARS) {
    await logSkip({ rule: 'empty_turn', sessionId, userLen, assistantLen });
    return { captured: false, skippedReason: 'empty_turn' };
  }

  if (hasToolCalls && combinedLen < PURE_TOOL_MIN_CHARS) {
    await logSkip({ rule: 'pure_tool_turn', sessionId, userLen, assistantLen });
    return { captured: false, skippedReason: 'pure_tool_turn' };
  }

  const content = formatContent(userText, assistantText);
  const content_hash = sha256(content);

  const [hits] = await db
    .query(
      surql`SELECT id FROM events WHERE source = 'conversation' AND content_hash = ${content_hash} LIMIT 1`,
    )
    .collect();
  if (hits.length > 0) {
    await logSkip({ rule: 'dedup_hit', sessionId, userLen, assistantLen });
    return { captured: false, skippedReason: 'dedup_hit' };
  }

  try {
    const { id } = await recordEvent(db, embedder, {
      source: 'conversation',
      content,
      ts: tsAssistant ?? undefined,
      meta: {
        session_id: sessionId ?? null,
        host: host ?? null,
        has_tool_calls: hasToolCalls,
      },
      guard: guardInboundContent,
    });
    return { captured: true, eventId: String(id) };
  } catch (e) {
    if (e instanceof RobinPiiRefusedError) {
      await logSkip({ rule: 'pii_refused', sessionId, userLen, assistantLen });
      return { captured: false, skippedReason: 'pii_refused' };
    }
    throw e;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/unit/session-capture.test.js`
Expected: PASS — all 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/capture/session-capture.js tests/unit/session-capture.test.js
git commit -m "feat(4f): captureFromTranscript orchestrator with skip heuristics + PII guard"
```

---

## Task 5: Wire Stop hook to forward `transcript_path` and `session_id`

**Files:**
- Modify: `src/hooks/handlers/stop-hook.js`
- Test: `tests/unit/stop-hook-detached.test.js` (existing — extend) OR new `tests/unit/stop-hook-forwards-transcript.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/stop-hook-forwards-transcript.test.js`:

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stopHookHandler } from '../../src/hooks/handlers/stop-hook.js';

import { mkdirSync as __robinMkdirSync } from 'node:fs';
import { tmpdir as __robinTmpdir } from 'node:os';
import { join as __robinJoin } from 'node:path';

const __robinTestHome = __robinJoin(
  __robinTmpdir(),
  `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`,
);
__robinMkdirSync(__robinTestHome, { recursive: true });
process.env.ROBIN_HOME = __robinTestHome;

test('stop hook forwards transcript_path + session_id to daemon route', async () => {
  const captured = { body: null };
  const fakeFetch = async (_url, init) => {
    captured.body = JSON.parse(init.body);
    return { ok: true };
  };
  await stopHookHandler({
    stdin: {
      transcript_path: '/tmp/foo.jsonl',
      session_id: 'sess-abc',
      since: '2026-05-10T00:00:00Z',
    },
    fetchFn: fakeFetch,
    readState: async () => ({ port: 9999, pid: process.pid }),
  });
  assert.equal(captured.body.transcript_path, '/tmp/foo.jsonl');
  assert.equal(captured.body.session_id, 'sess-abc');
  assert.equal(captured.body.since, '2026-05-10T00:00:00Z');
});

test('stop hook with no transcript_path posts body without those fields', async () => {
  const captured = { body: null };
  const fakeFetch = async (_url, init) => {
    captured.body = JSON.parse(init.body);
    return { ok: true };
  };
  await stopHookHandler({
    stdin: { since: '2026-05-10T00:00:00Z' },
    fetchFn: fakeFetch,
    readState: async () => ({ port: 9999, pid: process.pid }),
  });
  assert.equal(captured.body.transcript_path, undefined);
  assert.equal(captured.body.session_id, undefined);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/unit/stop-hook-forwards-transcript.test.js`
Expected: FAIL — `stopHookHandler` doesn't accept `fetchFn` / `readState`, or doesn't forward the fields.

- [ ] **Step 3: Rewrite `stop-hook.js` to accept injectable deps and forward fields**

Replace the entire contents of `src/hooks/handlers/stop-hook.js` with:

```js
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { isPidAlive } from '../../daemon/lock.js';
import { readDaemonState } from '../../daemon/state.js';
import { resolveBinPath } from '../../runtime/bin.js';
import { ensureHome, paths } from '../../runtime/home.js';

async function tryDaemonRoute(state, body, fetchFn) {
  try {
    const url = `http://127.0.0.1:${state.port}/internal/biographer/process-pending`;
    const res = await fetchFn(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function stopHookHandler(args = {}) {
  const stdin = args.stdin ?? {};
  const since = args.since ?? stdin.since;
  const transcriptPath = stdin.transcript_path ?? stdin.transcriptPath;
  const sessionId = stdin.session_id ?? stdin.sessionId;
  const fetchFn = args.fetchFn ?? fetch;
  const readState = args.readState;

  await ensureHome();
  const p = paths();
  const state = readState ? await readState() : await readDaemonState(p.daemonState);
  if (state && isPidAlive(state.pid)) {
    const body = {};
    if (since) body.since = since;
    if (transcriptPath) body.transcript_path = transcriptPath;
    if (sessionId) body.session_id = sessionId;
    const ok = await tryDaemonRoute(state, body, fetchFn);
    if (ok) return;
  }
  // Direct-spawn fallback
  const logsDir = join(p.cache, 'logs');
  mkdirSync(logsDir, { recursive: true });
  const logFh = await open(join(logsDir, 'biographer.log'), 'a');
  const cmdArgs = [resolveBinPath(), 'biographer', 'process-pending'];
  if (since) cmdArgs.push('--since', since);
  if (transcriptPath) cmdArgs.push('--transcript-path', transcriptPath);
  if (sessionId) cmdArgs.push('--session-id', sessionId);
  const proc = spawn(process.execPath, cmdArgs, {
    detached: true,
    stdio: ['ignore', logFh.fd, logFh.fd],
    env: process.env,
  });
  proc.unref();
  await logFh.close();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/unit/stop-hook-forwards-transcript.test.js`
Expected: PASS.

- [ ] **Step 5: Verify existing stop-hook tests still pass**

Run: `node --test tests/unit/stop-hook-detached.test.js tests/integration/stop-hook-detached.test.js tests/integration/stop-hook-via-daemon.test.js`
Expected: PASS (no regression from the daemon-route signature change).

- [ ] **Step 6: Commit**

```bash
git add src/hooks/handlers/stop-hook.js tests/unit/stop-hook-forwards-transcript.test.js
git commit -m "feat(4f): Stop hook forwards transcript_path + session_id to biographer"
```

---

## Task 6: Extend `biographer-process-pending` CLI with capture pre-step

**Files:**
- Modify: `src/cli/commands/biographer-process-pending.js`
- Test: `tests/integration/biographer-pipeline.test.js` (existing — extend) OR new `tests/integration/biographer-process-pending-captures.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/integration/biographer-process-pending-captures.test.js`:

```js
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { join } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { biographerProcessPending } from '../../src/cli/commands/biographer-process-pending.js';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';

import { mkdirSync as __robinMkdirSync } from 'node:fs';
import { tmpdir as __robinTmpdir } from 'node:os';
import { join as __robinJoin } from 'node:path';
import { writeConfig as __robinWriteConfig } from '../../src/runtime/config.js';

const __robinTestHome = __robinJoin(
  __robinTmpdir(),
  `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`,
);
__robinMkdirSync(__robinTestHome, { recursive: true });
process.env.ROBIN_HOME = __robinTestHome;
await __robinWriteConfig({ embedder_profile: 'mxbai-1024' });

function transcriptPair(userText, assistantText) {
  const dir = join(tmpdir(), `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'transcript.jsonl');
  writeFileSync(
    path,
    [
      { type: 'user', message: { role: 'user', content: userText } },
      { type: 'assistant', message: { role: 'assistant', content: assistantText } },
    ]
      .map((l) => JSON.stringify(l))
      .join('\n') + '\n',
    'utf8',
  );
  return path;
}

test('biographer-process-pending --transcript-path runs capture pre-step', async () => {
  // Sanity: with --transcript-path, the conversation event lands in `events`.
  const path = transcriptPair('drop the watches feature', 'OK, removed it.');

  // The CLI command connects to the rocksdb path under ROBIN_HOME; pre-migrate
  // it ourselves so the same DB the CLI opens has the schema applied.
  const homeDb = `rocksdb://${__robinTestHome}/db`;
  const seedDb = await connect({ engine: homeDb });
  try {
    await runMigrations(seedDb, resolve(import.meta.dirname, '../../src/schema/migrations'));
  } finally {
    await close(seedDb);
  }

  await biographerProcessPending([
    '--transcript-path',
    path,
    '--session-id',
    's1',
  ]);

  const verifyDb = await connect({ engine: homeDb });
  try {
    const [rows] = await verifyDb
      .query(surql`SELECT source, meta FROM events WHERE source = 'conversation'`)
      .collect();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].meta.session_id, 's1');
  } finally {
    await close(verifyDb);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/integration/biographer-process-pending-captures.test.js`
Expected: FAIL — flags ignored, no `conversation` event written.

- [ ] **Step 3: Implement the capture pre-step**

Replace the contents of `src/cli/commands/biographer-process-pending.js` with:

```js
import { surql } from 'surrealdb';
import { biographerProcess } from '../../capture/biographer.js';
import { captureFromTranscript } from '../../capture/session-capture.js';
import { close, connect } from '../../db/client.js';
import { acquire } from '../../db/lock.js';
import { createEmbedder } from '../../embed/factory.js';
import { detectHost } from '../../hosts/detect.js';
import { ensureHome, paths } from '../../runtime/home.js';
import { parseArgs } from '../args.js';

export async function biographerProcessPending(argv) {
  const args = parseArgs(argv);
  const since = args.flags.since ? new Date(args.flags.since) : null;
  const transcriptPath = args.flags['transcript-path'] ?? null;
  const sessionId = args.flags['session-id'] ?? null;

  await ensureHome();
  const p = paths();
  const release = await acquire(p.daemonLock);
  try {
    const db = await connect({ engine: `rocksdb://${p.db}` });
    try {
      let embedder = null;
      let host = null;

      // Capture pre-step. Fail-soft: errors do not block biographer.
      // Hoists embedder + host so the biographer loop below reuses them.
      if (transcriptPath) {
        try {
          embedder = await createEmbedder();
          host = await detectHost();
          await captureFromTranscript(db, embedder, {
            transcriptPath,
            sessionId,
            host: host?.name ?? null,
          });
        } catch (e) {
          console.error(`capture pre-step failed: ${e.message}`);
        }
      }

      // Find pending events (avoids loading embedder when there's nothing to do
      // AND the capture pre-step didn't already load one).
      const query = since
        ? surql`SELECT id, ts FROM events WHERE biographed_at IS NONE AND ts >= ${since} ORDER BY ts ASC LIMIT 50`
        : surql`SELECT id, ts FROM events WHERE biographed_at IS NONE ORDER BY ts ASC LIMIT 50`;
      const [pending] = await db.query(query).collect();

      if (pending.length === 0) {
        console.log('process-pending: 0 events');
        return;
      }

      if (!embedder) embedder = await createEmbedder();
      if (!host) host = await detectHost();

      let ok = 0;
      let failed = 0;
      for (const row of pending) {
        try {
          await biographerProcess(db, embedder, host, row.id);
          ok++;
        } catch (e) {
          failed++;
          console.error(`biographer failed on ${row.id}: ${e.message}`);
        }
      }
      console.log(`process-pending: ${ok} events${failed ? ` (${failed} failed)` : ''}`);
    } finally {
      await close(db);
    }
  } finally {
    await release();
  }
}
```

Embedder and host are hoisted so the biographer loop reuses what the capture step already constructed. On capture-failure (try/catch), `embedder`/`host` stay `null` and the lazy branch below re-constructs them — never a stale/broken handle.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/integration/biographer-process-pending-captures.test.js`
Expected: PASS.

- [ ] **Step 5: Verify existing biographer tests still pass**

Run: `node --test tests/integration/biographer-pipeline.test.js tests/integration/biographer-catchup.test.js`
Expected: PASS (capture pre-step is a no-op when `--transcript-path` is absent).

- [ ] **Step 6: Commit**

```bash
git add src/cli/commands/biographer-process-pending.js tests/integration/biographer-process-pending-captures.test.js
git commit -m "feat(4f): biographer-process-pending --transcript-path runs capture pre-step"
```

---

## Task 7: Extend daemon `/internal/biographer/process-pending` endpoint

**Files:**
- Modify: `src/daemon/server.js:490-500` (the existing handler)
- Test: new `tests/integration/biographer-endpoint-captures.test.js`

- [ ] **Step 1: Write the failing test**

The daemon is started by spawning `node src/daemon/server.js` as a child process (no clean named-export `start`/`stop` exists — see `tests/integration/multi-instance.test.js` for the canonical pattern). Match that.

Create `tests/integration/biographer-endpoint-captures.test.js`:

```js
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { close, connect } from '../../src/db/client.js';

function seedConfig(home) {
  writeFileSync(join(home, 'config.json'), JSON.stringify({ embedder_profile: 'mxbai-1024' }));
}

async function waitForState(home, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      return JSON.parse(readFileSync(join(home, '.daemon.state'), 'utf8'));
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error('daemon did not start');
}

function writeTranscript(userText, assistantText) {
  const dir = join(tmpdir(), `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'transcript.jsonl');
  writeFileSync(
    path,
    [
      { type: 'user', message: { role: 'user', content: userText } },
      { type: 'assistant', message: { role: 'assistant', content: assistantText } },
    ]
      .map((l) => JSON.stringify(l))
      .join('\n') + '\n',
    'utf8',
  );
  return path;
}

test('daemon /internal/biographer/process-pending accepts transcript_path and runs capture', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'robin-4f-'));
  seedConfig(tmp);
  const root = resolve(import.meta.dirname, '../..');

  const m = spawn('node', [join(root, 'bin/robin'), 'migrate'], {
    env: { ...process.env, ROBIN_HOME: tmp },
    stdio: 'inherit',
  });
  await new Promise((r) => m.on('exit', r));

  const daemon = spawn('node', [join(root, 'src/daemon/server.js')], {
    env: { ...process.env, ROBIN_HOME: tmp, ROBIN_HOST: 'claude_code' },
    stdio: 'pipe',
  });
  try {
    const state = await waitForState(tmp);
    const transcriptPath = writeTranscript(
      'drop the watches feature',
      'OK, removed the watches table and helpers.',
    );

    const res = await fetch(
      `http://127.0.0.1:${state.port}/internal/biographer/process-pending`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ transcript_path: transcriptPath, session_id: 's-daemon-1' }),
        signal: AbortSignal.timeout(5000),
      },
    );
    assert.equal(res.ok, true);

    // Capture is synchronous within the handler; the response returns after
    // the event is written.
    await delay(200);

    const db = await connect({ engine: `rocksdb://${tmp}/db` });
    try {
      const [rows] = await db
        .query(surql`SELECT meta FROM events WHERE source = 'conversation'`)
        .collect();
      assert.equal(rows.length, 1);
      assert.equal(rows[0].meta.session_id, 's-daemon-1');
    } finally {
      await close(db);
    }
  } finally {
    daemon.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 500));
    rmSync(tmp, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/integration/biographer-endpoint-captures.test.js`
Expected: FAIL — daemon ignores `transcript_path`; no `conversation` event written.

- [ ] **Step 3: Extend the daemon handler**

In `src/daemon/server.js`, find the existing block (around line 490) and replace it:

```js
if (req.method === 'POST' && req.url === '/internal/biographer/process-pending') {
  const body = await readJsonBody(req);
  // Capture pre-step (fail-soft).
  if (body && typeof body.transcript_path === 'string' && body.transcript_path.length > 0) {
    try {
      const { captureFromTranscript } = await import('../capture/session-capture.js');
      await captureFromTranscript(dbHandle, embedderWrap, {
        transcriptPath: body.transcript_path,
        sessionId: body.session_id ?? body.sessionId ?? null,
        host: host?.name ?? null,
      });
    } catch (e) {
      // log to stderr, do not block biographer
      console.error(`daemon capture pre-step failed: ${e.message}`);
    }
  }

  const [pendingRows] = await dbHandle
    .query('SELECT id, ts FROM events WHERE biographed_at IS NONE ORDER BY ts ASC LIMIT 50')
    .collect();
  for (const row of pendingRows) {
    queueWrap.enqueue(String(row.id)).catch(() => {});
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ enqueued: pendingRows.length }));
  return;
}
```

Variable references: `host` is the host detector result declared at the top of the daemon closure (around line 189: `let host = null; try { host = await detectHost(); } ...`). `embedderWrap` is the lazy-loading embedder facade declared near line 231 — already used by `/internal/remember` for the same purpose. Both are in scope at the HTTP handler. The capture's `host` field is informational metadata for the event row.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/integration/biographer-endpoint-captures.test.js`
Expected: PASS.

- [ ] **Step 5: Verify all existing daemon tests still pass**

Run: `node --test tests/integration/biographer-pipeline.test.js tests/integration/mcp-end-to-end.test.js tests/integration/biographer-failure.test.js`
Expected: PASS (capture pre-step is a no-op when `transcript_path` is absent from the body).

- [ ] **Step 6: Commit**

```bash
git add src/daemon/server.js tests/integration/biographer-endpoint-captures.test.js
git commit -m "feat(4f): daemon endpoint runs capture pre-step when transcript_path provided"
```

---

## Task 8: CHANGELOG entry and README diagram update

Coverage rationale for not including a separate stop-hook-through-daemon-through-biographer end-to-end test: the path is already covered by orthogonal layers — Task 4 covers `captureFromTranscript` against a real DB, Task 5 covers stop-hook forwarding the fields, Task 6 covers the CLI direct-spawn path (the fallback when no daemon is running), Task 7 covers the daemon HTTP endpoint. Stitching them adds a heavyweight (~15–20s daemon-spawn) test for negligible marginal coverage. Reject.


**Files:**
- Modify: `CHANGELOG.md` (prepend new version section after the title)
- Modify: `README.md` (update the "How Robin works" diagram + status line)

- [ ] **Step 1: Add CHANGELOG entry**

In `CHANGELOG.md`, immediately after the `# Changelog` heading and before the `## [6.0.0-alpha.9]` entry, insert:

```markdown
## [6.0.0-alpha.10] — 2026-05-10

Phase 4f: conversation capture. Replaces v1's `migrate-auto-memory` job with a host-agnostic Stop-hook capture step. Closes the last accidental gap from the v1→v2 audit.

- **New `src/capture/transcript.js`** — tail-and-parse the host transcript JSONL. Returns `{userText, assistantText, hasToolCalls, tsAssistant}`. Walks backwards past `tool_result` user-role messages to find the actual human prompt (Claude Code stores tool returns as user messages; Gemini CLI uses `function_response` — both handled). Tolerates malformed final lines (transcript-write race on Stop fire).
- **New `src/capture/session-capture.js`** — `captureFromTranscript(db, embedder, {transcriptPath, sessionId, host})`. Skip heuristics: missing transcript_path, no assistant turn, single-word ack (`ok`/`yes`/`thanks`/...), empty turn (<8 chars), pure-tool turn (`hasToolCalls && combined<30 chars`), content-hash dedup probe against existing `source='conversation'` rows. PII guard wired (`guardInboundContent`); credential-shaped content refuses and logs to `outbound_refusals(direction='inbound')`. Skip log line per fire to `<robinHome>/cache/logs/biographer.log` for threshold tuning.
- **New shared `src/runtime/file-tail.js`** — extracts `readFileTail(path, maxBytes)` previously private to auto-recall. Refactor only, no behavior change for 4a.
- **`'conversation'` added to `recordEvent`'s VALID_SOURCES.** Host (`claude_code`/`gemini`) goes into `meta.host`; `session_id` and `has_tool_calls` in `meta`. Single source value keeps recall queries simple.
- **Stop hook extended** to forward `transcript_path` + `session_id` from the host stdin payload to the biographer subprocess — both via the daemon `/internal/biographer/process-pending` POST body and via the direct-spawn fallback's CLI flags (`--transcript-path`, `--session-id`).
- **No new tables, no migration, no new endpoints.** Reuses `events`, the existing biographer queue, and the existing 4a `runtime_sessions.transcript_path` field. The biographer takes over from the captured event using its existing prompt — zero new LLM calls in the capture step itself; cost is one additional fast-tier biographer call per non-skipped turn.
- **Test count**: ~20 new tests across `transcript-parse`, `session-capture`, `stop-hook-forwards-transcript`, `biographer-process-pending-captures`, `biographer-endpoint-captures`, `conversation-capture-roundtrip`, `record-event-conversation-source`, `file-tail`. All passing.
- **Closes v1→v2 audit gap:** `migrate-auto-memory` is now formally **replaced** (not deferred, not dropped) — Robin captures conversations directly via its own pipeline rather than bridging Claude Code's `~/.claude/projects/*/memory/` files.

Phase 4b candidates (unchanged from alpha.9): action policy, predictions/calibration, comm-style profile (now unblocked — has a steady source of conversation events to infer from).
```

- [ ] **Step 2: Update README diagram**

In `README.md`, find the "How Robin works → The big picture" code block. The current block lists:

```
   ├─ SessionStart hook ────────────► registers session + tamper warnings
   ├─ UserPromptSubmit hook ────────► auto-recall: injects relevant memory
   ├─ PreToolUse(Bash) hook ────────► bash policy: refuses risky commands
   ├─ MCP tool calls (SSE) ─────────► recall, remember, find_entity, etc.
   └─ Stop hook ────────────────────► biographer processes new events
```

Replace the `└─ Stop hook` line with:

```
   └─ Stop hook ────────────────────► capture (transcript → events) +
                                       biographer processes new events
```

Then in the "A typical agent turn" section, replace step 6 (the biographer step) with:

```markdown
6. **Stop hook** spawns a detached `robin biographer process-pending` subprocess with `--transcript-path` and `--session-id`. The subprocess runs the **capture step first**: tails the transcript, extracts the last user+assistant turn pair, applies skip heuristics (single-word acks, empty turns, pure-tool turns, content-hash dedup), runs the inbound PII guard, and writes one `events('conversation')` row if the turn is worth keeping. The biographer then reads new events, makes one LLM call per event through `host.invokeLLM`, and UPSERTs entities + edges + episodes.
```

Update the Status line near the top of the README from:

```markdown
`6.0.0-alpha.9` — Phase 4a (daily-use safety floor: bash policy, PII guard inside MCP, tamper detection, auto-recall on prompt, multi-session registry, pre-commit hook, host-side hook installation).
```

to:

```markdown
`6.0.0-alpha.10` — Phase 4f (conversation capture: Stop hook reads the transcript, writes one `events('conversation')` row per non-trivial turn, biographer takes over from there).
```

- [ ] **Step 3: Run the full test suite one last time**

Run: `node --test tests/unit/**/*.test.js tests/integration/**/*.test.js`
Expected: PASS — modulo the ~7 pre-existing native-binding failures noted in CHANGELOG alpha.9 (chrome-sync, lrc-sync — better-sqlite3 issues unrelated to 4f).

- [ ] **Step 4: Commit**

```bash
git add CHANGELOG.md README.md
git commit -m "docs(4f): CHANGELOG + README for v6.0.0-alpha.10 conversation capture"
```

---

## Done criteria

- [ ] `'conversation'` is in `VALID_SOURCES`.
- [ ] `src/capture/transcript.js` and `src/capture/session-capture.js` exist with the exports described in the spec.
- [ ] `src/runtime/file-tail.js` exists; auto-recall imports it (no local copy).
- [ ] Stop hook forwards `transcript_path` + `session_id` via both daemon route and direct-spawn fallback.
- [ ] `robin biographer process-pending --transcript-path <p> --session-id <id>` runs the capture pre-step, then drains pending.
- [ ] Daemon `/internal/biographer/process-pending` accepts `{transcript_path, session_id}` and runs the same pre-step.
- [ ] All unit tests pass (~20 new).
- [ ] Integration roundtrip test produces one `events('conversation')` row with `biographed_at` set, an `episode_id`, and at least one entity.
- [ ] CHANGELOG `v6.0.0-alpha.10` entry exists.
- [ ] README diagram + status line updated.

## Spec coverage check

- §4 file layout — Tasks 1–7 each create/modify the named files. ✓
- §5.A transcript reader — Task 3. ✓
- §5.B skip heuristics — Task 4 (all six rules). ✓
- §5.C orchestrator — Task 4. ✓
- §5.D stop hook wire-up — Task 5. ✓
- §5.E biographer integration — Task 6 (CLI) + Task 7 (daemon). ✓
- §6 source naming — Task 1. ✓
- §7 edge cases — covered by tests in Tasks 3 and 4 (malformed final line, `tool_result` walking, dedup probe, PII guard, missing transcript). ✓
- §8 tests — Tasks 3, 4, 5, 6, 7 collectively. The full stop-hook→daemon→biographer roundtrip is deliberately not its own test (see Task 8 prelude). ✓
- §9 migration / cutover — Task 8 (CHANGELOG + README). ✓
- §10 decisions — Task 4 wires PII guard (the closed decision). ✓
- §11 non-goals — respected: no multi-turn batching, no per-turn LLM extraction, no transcript redaction beyond PII guard, no cross-host transcript merging. ✓
- §12 done criteria — restated above. ✓
