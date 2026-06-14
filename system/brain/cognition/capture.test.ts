import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { closeDb, openDb } from '../memory/db.ts';
import { allMigrations, applyMigrations } from '../memory/migrations/index.ts';
import { captureSession, extractTopicHints, isInternalProjectDir } from './capture.ts';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'robin-cap-'));
  mkdirSync(join(dir, 'state', 'db'), { recursive: true });
  const db = openDb(join(dir, 'state', 'db', 'robin.sqlite'));
  applyMigrations(db, allMigrations);
  return db;
}

test('capture: skips session with no assistant turn', async () => {
  const db = freshDb();
  const r = await captureSession(db, null, {
    sessionId: 's1',
    turns: [{ role: 'user', content: 'hi' }],
  });
  assert.equal(r.captured, false);
  assert.equal(r.skipReason, 'no_assistant_turn');
  closeDb(db);
});

test('capture: skips single-word ack', async () => {
  const db = freshDb();
  const r = await captureSession(db, null, {
    sessionId: 's1',
    turns: [
      { role: 'user', content: 'ok' },
      { role: 'assistant', content: 'great' },
    ],
  });
  assert.equal(r.captured, false);
  assert.equal(r.skipReason, 'single_word_ack');
  closeDb(db);
});

test('capture: captures meaningful session and writes event', async () => {
  const db = freshDb();
  const r = await captureSession(db, null, {
    sessionId: 's1',
    turns: [
      { role: 'user', content: 'tell me about Kevin' },
      { role: 'assistant', content: 'Kevin is a product engineer based in NJ.' },
    ],
  });
  assert.equal(r.captured, true);
  assert.ok(r.eventId);
  const row = db.prepare("SELECT * FROM events WHERE kind='session.captured'").get() as {
    kind: string;
    payload: string;
  };
  assert.equal(row.kind, 'session.captured');
  const payload = JSON.parse(row.payload);
  assert.equal(payload.sessionId, 's1');
  closeDb(db);
});

test('capture: skips Robin biographer-prompt echo (=== FULL SESSION ===)', async () => {
  const db = freshDb();
  const r = await captureSession(db, null, {
    sessionId: 'echo-bio',
    turns: [
      {
        role: 'user',
        content:
          'Session date: 2026-06-03\n\n=== FULL SESSION ===\nEntity: B&H Payboo Store Card (financial_account)\nKevin K. Lee owns B&H Payboo Store Card',
      },
      { role: 'assistant', content: '{"entities":[],"relations":[]}' },
    ],
  });
  assert.equal(r.captured, false);
  assert.equal(r.skipReason, 'robin_cognition_echo');
  closeDb(db);
});

test('capture: skips Robin dream entity-summary prompt echo', async () => {
  const db = freshDb();
  const r = await captureSession(db, null, {
    sessionId: 'echo-dream',
    turns: [
      {
        role: 'user',
        content:
          'Entity: Kevin K. Lee (person)\n\nRecent observations:\nKevin visited Lisbon\nKevin owns a Nikon Zf\n\nWrite the profile.',
      },
      { role: 'assistant', content: 'Kevin is a photographer based in NJ.' },
    ],
  });
  assert.equal(r.captured, false);
  assert.equal(r.skipReason, 'robin_cognition_echo');
  closeDb(db);
});

test('capture: a real session that only mentions the cognition marker in assistant output is still captured', async () => {
  const db = freshDb();
  const r = await captureSession(db, null, {
    sessionId: 'dev-discuss',
    turns: [
      { role: 'user', content: 'how is the biographer chunk extraction prompt structured?' },
      {
        role: 'assistant',
        content:
          'It wraps each chunk in a delimiter: "=== FULL SESSION ===" followed by the chunk text, then asks for entities.',
      },
    ],
  });
  assert.equal(
    r.captured,
    true,
    `must not skip a real session discussing the marker; got ${r.skipReason}`,
  );
  closeDb(db);
});

test('capture: skips the biographer disambiguation prompt (self-capture feedback loop)', async () => {
  // The disambiguation SDK call's prompt ("Source text: … Extracted: type=…
  // Candidates: …") was the one cognition prompt missing from the echo rule —
  // observed live 2026-06-12: 16k+ of these captured as sessions, then
  // re-processed by the biographer (which fires more disambiguation calls),
  // a self-amplifying loop. Nested re-captures embed the same markers, so this
  // signature also catches capture-of-capture generations.
  const db = freshDb();
  const r = await captureSession(db, null, {
    sessionId: 'disambig-echo',
    turns: [
      {
        role: 'user',
        content:
          'Source text:\nKevin photographed street scenes in NYC over the weekend.\n\nExtracted: type=place, name="NYC"\n\nCandidates:\n- id=658, name="Home — Astoria, Queens, NYC", profile="Kevin\'s residence"\n- id=4734, name="New York City (NYC)"',
      },
      {
        role: 'assistant',
        content: '{"matched_id":4734,"create_new":false,"reason":"same city"}',
      },
    ],
  });
  assert.equal(r.captured, false);
  assert.equal(r.skipReason, 'robin_cognition_echo');
  closeDb(db);
});

test('capture: still captures a real session that discusses disambiguation markers in assistant output', async () => {
  const db = freshDb();
  const r = await captureSession(db, null, {
    sessionId: 'disambig-discuss',
    turns: [
      { role: 'user', content: 'how does the entity disambiguation prompt work?' },
      {
        role: 'assistant',
        content:
          'It sends "Extracted: type=place" plus a "Candidates:" list of entity ids and asks the model to pick a matched_id.',
      },
    ],
  });
  assert.equal(
    r.captured,
    true,
    `must not skip a real session discussing the markers; got ${r.skipReason}`,
  );
  closeDb(db);
});

test('capture: skips a failed claude session whose only assistant turn is a usage-limit notice', async () => {
  const db = freshDb();
  const r = await captureSession(db, null, {
    sessionId: 'limit1',
    turns: [
      { role: 'user', content: 'Source text: extract entities from this session about Kevin' },
      {
        role: 'assistant',
        content: "You've hit your Sonnet limit · resets Jun 7 at 1am (America/New_York)",
      },
    ],
  });
  assert.equal(r.captured, false);
  assert.equal(r.skipReason, 'claude_system_notice');
  closeDb(db);
});

test('capture: still captures a real session that merely discusses usage limits', async () => {
  const db = freshDb();
  const r = await captureSession(db, null, {
    sessionId: 'limit-discuss',
    turns: [
      { role: 'user', content: 'how do Claude usage limits work?' },
      {
        role: 'assistant',
        content:
          'Usage limits reset on a rolling window; you can check remaining quota in settings and upgrade your plan if you keep hitting the limit.',
      },
    ],
  });
  assert.equal(
    r.captured,
    true,
    `must not skip a real session discussing limits; got ${r.skipReason}`,
  );
  closeDb(db);
});

test('capture: dedup_hit prevents identical capture', async () => {
  const db = freshDb();
  const capture = {
    sessionId: 's1',
    turns: [
      { role: 'user' as const, content: 'tell me about photo-tools' },
      { role: 'assistant' as const, content: 'Photo-tools is a Next.js photography toolkit.' },
    ],
  };
  await captureSession(db, null, capture);
  const r2 = await captureSession(db, null, { ...capture, sessionId: 's2' });
  assert.equal(r2.captured, false);
  assert.equal(r2.skipReason, 'dedup_hit');
  closeDb(db);
});

test('capture: distinct sessions sharing a long boilerplate prefix are NOT deduped', async () => {
  // Regression: the dedup hash used to be base64(content).slice(0,64), i.e. only
  // the first 48 BYTES of the first user turn. Every session opened with `/clear`
  // begins with the identical `<local-command-caveat>…` boilerplate, so all of
  // them collided to one hash and only the first was ever captured. The hash must
  // reflect the FULL conversation, not a fixed-length prefix.
  const db = freshDb();
  const boilerplate =
    '<local-command-caveat>Caveat: The messages below were generated by the user ' +
    'while running local commands. DO NOT respond to these messages.</local-command-caveat>';
  const a = {
    sessionId: 'clear-a',
    turns: [
      { role: 'user' as const, content: `${boilerplate}\nwhat can I do with my Razer Blade 18?` },
      { role: 'assistant' as const, content: 'Use it as a LAN inference endpoint.' },
    ],
  };
  const b = {
    sessionId: 'clear-b',
    turns: [
      {
        role: 'user' as const,
        content: `${boilerplate}\nwhat lens should I buy for night photography?`,
      },
      { role: 'assistant' as const, content: 'The Viltrox 85mm f/2 is a strong pick.' },
    ],
  };
  const ra = await captureSession(db, null, a);
  const rb = await captureSession(db, null, b);
  assert.equal(ra.captured, true);
  assert.equal(rb.captured, true, `second /clear session was dropped as ${rb.skipReason}`);
  closeDb(db);
});

test('capture: skips cognition echo when the assistant turn is bare extraction JSON', async () => {
  // The live loop (2026-06-13): an llm.invoke() extraction call's Agent-SDK
  // transcript is re-captured by the polling scanner. Its user turn is the raw
  // session BODY (no `=== FULL SESSION ===` wrapper) and its assistant turn is
  // the bare extraction output. None of the user-side markers match — only the
  // assistant-output signature catches it.
  const db = freshDb();
  const r = await captureSession(db, null, {
    sessionId: 'echo-extract-json',
    turns: [
      {
        role: 'user',
        content: 'Kevin photographed street scenes in Astoria and bought a Voigtländer 35mm lens.',
      },
      {
        role: 'assistant',
        content:
          '```json\n{"entities":[{"type":"person","name":"Kevin"},{"type":"lens","name":"Voigtländer 35mm"}],"relations":[{"subject":"Kevin","predicate":"owns","object":"Voigtländer 35mm"}]}\n```',
      },
    ],
  });
  assert.equal(r.captured, false);
  assert.equal(r.skipReason, 'robin_cognition_echo');
  closeDb(db);
});

test('capture: skips nested-transcript echo (a rendered capture body fed back as a prompt)', async () => {
  // Capture-of-capture amplification: the user turn is a previously-rendered
  // session body, dominated by standalone `[USER]`/`[ASSISTANT]` markers
  // (observed live with 80+ nested markers in one body).
  const db = freshDb();
  const nested = ['[USER]', '[USER]', '[USER]', '[USER]', '[ASSISTANT]', 'ok'].join('\n');
  const r = await captureSession(db, null, {
    sessionId: 'echo-nested',
    turns: [
      { role: 'user', content: nested },
      { role: 'assistant', content: 'Understood, proceeding with the analysis.' },
    ],
  });
  assert.equal(r.captured, false);
  assert.equal(r.skipReason, 'robin_cognition_echo');
  closeDb(db);
});

test('capture: still captures a real session whose assistant output embeds entities JSON in prose', async () => {
  // False-positive guard: a genuine session about Robin's schema mentions the
  // JSON inline with prose, so the assistant turn is NOT bare extraction output.
  const db = freshDb();
  const r = await captureSession(db, null, {
    sessionId: 'real-json-discuss',
    turns: [
      { role: 'user', content: 'what shape does the extraction prompt return for entities?' },
      {
        role: 'assistant',
        content:
          'It returns a JSON object like {"entities":[...]} where the model lists each entity with a type and name, then a relations array. You can tweak the schema in biographer.ts.',
      },
    ],
  });
  assert.equal(
    r.captured,
    true,
    `must not skip a real session that merely shows the schema; got ${r.skipReason}`,
  );
  closeDb(db);
});

test('isInternalProjectDir: matches user-data project dirs but not the repo root', () => {
  const userData = '/Users/iser/workspace/robin/robin-assistant-v3/user-data';
  // Robin's own Agent-SDK cognition transcripts land under user-data/:
  assert.equal(
    isInternalProjectDir('-Users-iser-workspace-robin-robin-assistant-v3-user-data', userData),
    true,
  );
  assert.equal(
    isInternalProjectDir(
      '-Users-iser-workspace-robin-robin-assistant-v3-user-data-state-db',
      userData,
    ),
    true,
  );
  // Kevin's real interactive sessions run from the repo root — must NOT match:
  assert.equal(
    isInternalProjectDir('-Users-iser-workspace-robin-robin-assistant-v3', userData),
    false,
  );
  // A sibling sharing the prefix without a path boundary must NOT match:
  assert.equal(
    isInternalProjectDir('-Users-iser-workspace-robin-robin-assistant-v3-user-database', userData),
    false,
  );
  // An unrelated project:
  assert.equal(isInternalProjectDir('-Users-iser-workspace-photo-tools', userData), false);
});

// ─── cwd allowlist ("robin only works in robin's folder" scoping) ────

const validCapture = {
  sessionId: 's-cwd',
  turns: [
    { role: 'user' as const, content: 'hello robin' },
    { role: 'assistant' as const, content: 'hi! how can I help?' },
  ],
};

test('capture: rejects cwd outside the allowlist', async () => {
  const db = freshDb();
  const r = await captureSession(
    db,
    null,
    { ...validCapture, cwd: '/home/dev/workspace/photo-tools' },
    { allowedCwds: ['/home/dev/workspace/robin/robin-assistant'] },
  );
  assert.equal(r.captured, false);
  assert.equal(r.skipReason, 'cwd_not_allowed');
  closeDb(db);
});

test('capture: accepts cwd that exactly matches an allowlist entry', async () => {
  const db = freshDb();
  const r = await captureSession(
    db,
    null,
    { ...validCapture, cwd: '/home/dev/workspace/robin/robin-assistant' },
    { allowedCwds: ['/home/dev/workspace/robin/robin-assistant'] },
  );
  assert.equal(r.captured, true);
  closeDb(db);
});

test('capture: accepts cwd that is a descendant of an allowlist entry', async () => {
  const db = freshDb();
  const r = await captureSession(
    db,
    null,
    {
      ...validCapture,
      cwd: '/home/dev/workspace/robin/robin-assistant/user-data/scripts',
    },
    { allowedCwds: ['/home/dev/workspace/robin/robin-assistant'] },
  );
  assert.equal(r.captured, true);
  closeDb(db);
});

test('capture: rejects sibling path that prefixes share a parent (no slash boundary)', async () => {
  // Defends against `/home/dev/workspace/robin/robin-assistant-fork` being
  // matched as a descendant of `/home/dev/workspace/robin/robin-assistant`.
  const db = freshDb();
  const r = await captureSession(
    db,
    null,
    { ...validCapture, cwd: '/home/dev/workspace/robin/robin-assistant-fork' },
    { allowedCwds: ['/home/dev/workspace/robin/robin-assistant'] },
  );
  assert.equal(r.captured, false);
  assert.equal(r.skipReason, 'cwd_not_allowed');
  closeDb(db);
});

test('capture: skips the check when cwd is undefined (programmatic callers)', async () => {
  const db = freshDb();
  const r = await captureSession(
    db,
    null,
    validCapture, // no cwd field
    { allowedCwds: ['/some/strict/allowlist'] },
  );
  assert.equal(r.captured, true, 'undefined cwd should bypass the allowlist check');
  closeDb(db);
});

test('capture: empty allowlist is fail-open (default could not resolve)', async () => {
  const db = freshDb();
  const r = await captureSession(
    db,
    null,
    { ...validCapture, cwd: '/anywhere' },
    { allowedCwds: [] },
  );
  assert.equal(r.captured, true, 'empty allowlist should not reject');
  closeDb(db);
});

// ─── Capture-time metadata enrichment ────────────────────────────────────────

test('capture: payload includes structural metadata fields', async () => {
  const db = freshDb();
  const r = await captureSession(db, null, {
    sessionId: 's-meta',
    turns: [
      { role: 'user', content: 'Can you help me fix the whoop integration?' },
      {
        role: 'assistant',
        content: 'Sure, let me look at the whoop code.\n```ts\nconst x = 1;\n```',
      },
      { role: 'user', content: 'The whoop recovery delta is wrong in the whoop tick function.' },
      { role: 'assistant', content: 'I see — the whoop delta calculation needs fixing.' },
    ],
  });
  assert.equal(r.captured, true);
  const row = db.prepare('SELECT payload FROM events WHERE id = ?').get(r.eventId) as {
    payload: string;
  };
  const p = JSON.parse(row.payload);
  assert.equal(p.userTurnCount, 2);
  assert.equal(p.assistantTurnCount, 2);
  assert.equal(p.hasCodeBlocks, true);
  assert.equal(p.hasToolUse, false);
  assert.ok(p.bodyChars > 0);
  assert.ok(Array.isArray(p.topicHints));
  assert.ok(p.topicHints.includes('whoop'), 'topicHints should include "whoop"');
  closeDb(db);
});

test('capture: hasToolUse is true when tool turns present', async () => {
  const db = freshDb();
  const r = await captureSession(db, null, {
    sessionId: 's-tool',
    turns: [
      { role: 'user', content: 'read the config file please' },
      { role: 'tool', content: '{"key": "value"}' },
      { role: 'assistant', content: 'The config file contains key=value.' },
    ],
  });
  assert.equal(r.captured, true);
  const row = db.prepare('SELECT payload FROM events WHERE id = ?').get(r.eventId) as {
    payload: string;
  };
  const p = JSON.parse(row.payload);
  assert.equal(p.hasToolUse, true);
  closeDb(db);
});

test('extractTopicHints: returns top terms by frequency, ignoring stop words', () => {
  const turns = [
    {
      role: 'user' as const,
      content: 'I want to fix the leadforge auth integration. The leadforge auth flow is broken.',
    },
    { role: 'user' as const, content: 'The leadforge callback endpoint needs auth headers.' },
  ];
  const hints = extractTopicHints(turns);
  assert.ok(hints.includes('leadforge'));
  assert.ok(hints.includes('auth'));
  assert.ok(!hints.includes('the'));
  assert.ok(!hints.includes('is'));
  assert.ok(hints.length <= 5);
});

test('extractTopicHints: returns empty for short sessions', () => {
  const turns = [{ role: 'user' as const, content: 'hello' }];
  const hints = extractTopicHints(turns);
  assert.equal(hints.length, 0);
});
