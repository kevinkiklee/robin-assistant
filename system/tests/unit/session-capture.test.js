import assert from 'node:assert/strict';
import { mkdirSync as __robinMkdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir as __robinTmpdir, tmpdir } from 'node:os';
import { join as __robinJoin, join, resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { writeConfig as __robinWriteConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { createStubEmbedder } from '../../data/embed/embedder.js';
import { captureFromTranscript } from '../../io/capture/session-capture.js';

const __robinTestHome = __robinJoin(
  __robinTmpdir(),
  `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`,
);
__robinMkdirSync(__robinTestHome, { recursive: true });
process.env.ROBIN_HOME = __robinTestHome;
await __robinWriteConfig({ embedder_profile: 'mxbai-1024' });

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
  return db;
}

function tmpJsonl(lines) {
  const dir = join(tmpdir(), `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'transcript.jsonl');
  writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`, 'utf8');
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
    const path = transcriptPair(
      'drop the watches feature',
      'Removed the watches table and helpers.',
    );
    const result = await captureFromTranscript(db, createStubEmbedder(), {
      transcriptPath: path,
      sessionId: 's1',
      host: 'claude-code',
    });
    assert.equal(result.captured, true);
    const [rows] = await db
      .query(surql`SELECT source, content, meta FROM events WHERE source = 'conversation'`)
      .collect();
    assert.equal(rows.length, 1);
    assert.ok(rows[0].content.startsWith('USER: drop the watches feature'));
    assert.ok(rows[0].content.includes('ASSISTANT: Removed the watches table'));
    assert.equal(rows[0].meta.session_id, 's1');
    assert.equal(rows[0].meta.host, 'claude-code');
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
      host: 'claude-code',
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
        host: 'claude-code',
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
      host: 'claude-code',
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
      host: 'claude-code',
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
        host: 'claude-code',
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
      host: 'claude-code',
    });
    assert.equal(r1.captured, true);
    const r2 = await captureFromTranscript(db, createStubEmbedder(), {
      transcriptPath: path,
      sessionId: 's',
      host: 'claude-code',
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
    const userMsg =
      'use this token sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const path = transcriptPair(userMsg, 'I will not use credentials in code.');
    const result = await captureFromTranscript(db, createStubEmbedder(), {
      transcriptPath: path,
      sessionId: 's',
      host: 'claude-code',
    });
    assert.equal(result.captured, false);
    assert.equal(result.skippedReason, 'pii_refused');
    const [refusals] = await db
      .query(surql`SELECT * FROM refusals WHERE direction = 'inbound'`)
      .collect();
    assert.ok(refusals.length >= 1);
  } finally {
    await close(db);
  }
});

test('routes agent-internal system-prompt turns to source=agent_internal', async () => {
  const db = await fresh();
  try {
    const path = transcriptPair(
      'You disambiguate entity mentions. Given a mention and candidates, pick one.',
      '```json\n{ "pick": null }\n```',
    );
    const result = await captureFromTranscript(db, createStubEmbedder(), {
      transcriptPath: path,
      sessionId: 's-agent',
      host: 'claude-code',
    });
    assert.equal(result.captured, true);
    const [conv] = await db
      .query(surql`SELECT count() AS n FROM events WHERE source = 'conversation' GROUP ALL`)
      .collect();
    const [internal] = await db
      .query(surql`SELECT count() AS n FROM events WHERE source = 'agent_internal' GROUP ALL`)
      .collect();
    assert.equal(conv?.[0]?.n ?? 0, 0);
    assert.equal(internal?.[0]?.n ?? 0, 1);
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
      host: 'claude-code',
    });
    assert.equal(result.captured, true);
    const [rows] = await db
      .query(surql`SELECT content FROM events WHERE source = 'conversation'`)
      .collect();
    assert.ok(
      rows[0].content.length <= 16 * 1024 + 64,
      `content was ${rows[0].content.length} bytes`,
    );
  } finally {
    await close(db);
  }
});
