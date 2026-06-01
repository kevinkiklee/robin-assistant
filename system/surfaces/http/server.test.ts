import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { __resetAutoRecallCache } from '../../brain/memory/auto-recall.ts';
import { closeDb, openDb } from '../../brain/memory/db.ts';
import { allMigrations, applyMigrations } from '../../brain/memory/migrations/index.ts';
import { startHttpServer } from './server.ts';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'robin-http-'));
  mkdirSync(join(dir, 'state', 'db'), { recursive: true });
  const db = openDb(join(dir, 'state', 'db', 'robin.sqlite'));
  applyMigrations(db, allMigrations);
  return db;
}

/** A temp user-data dir with a populated topic map + canonical doc, plus its db. */
function freshUserData() {
  const userData = mkdtempSync(join(tmpdir(), 'robin-http-ud-'));
  mkdirSync(join(userData, 'config'), { recursive: true });
  mkdirSync(join(userData, 'content', 'knowledge'), { recursive: true });
  mkdirSync(join(userData, 'state', 'db'), { recursive: true });
  writeFileSync(join(userData, 'content/knowledge/gear.md'), 'Nikon Zf and Viltrox 85mm f/2');
  writeFileSync(
    join(userData, 'config/recall-topics.yaml'),
    'topics:\n  - id: photography\n    match: [camera, lens, photo]\n    docs: [content/knowledge/gear.md]\n',
  );
  const db = openDb(join(userData, 'state', 'db', 'robin.sqlite'));
  applyMigrations(db, allMigrations);
  return { userData, db };
}

test('http: GET /health returns 200 with ok=true when healthy', async () => {
  const db = freshDb();
  const h = await startHttpServer({ db, port: 0, isHealthy: () => true });
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`http://${h.host}:${h.port}/health`, { signal: controller.signal });
    clearTimeout(timeoutId);
    assert.equal(res.status, 200);
    const data = (await res.json()) as { ok: boolean };
    assert.equal(data.ok, true);
  } finally {
    await h.close();
    closeDb(db);
  }
});

test('http: GET /health returns 503 when unhealthy', async () => {
  const db = freshDb();
  const h = await startHttpServer({ db, port: 0, isHealthy: () => false });
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`http://${h.host}:${h.port}/health`, { signal: controller.signal });
    clearTimeout(timeoutId);
    assert.equal(res.status, 503);
  } finally {
    await h.close();
    closeDb(db);
  }
});

test('http: POST /hooks/<kind> dispatches to onHook with parsed payload', async () => {
  const db = freshDb();
  const captured: { kind: string; payload: unknown } = { kind: '', payload: {} };
  const h = await startHttpServer({
    db,
    port: 0,
    isHealthy: () => true,
    onHook: async (kind, payload) => {
      captured.kind = kind;
      captured.payload = payload;
    },
  });
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`http://${h.host}:${h.port}/hooks/session_end`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 'abc', turns: 3 }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    assert.equal(res.status, 200);
    assert.equal(captured.kind, 'session_end');
    assert.deepEqual(captured.payload, { session_id: 'abc', turns: 3 });
  } finally {
    await h.close();
    closeDb(db);
  }
});

test('http: unknown path returns 404', async () => {
  const db = freshDb();
  const h = await startHttpServer({ db, port: 0, isHealthy: () => true });
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`http://${h.host}:${h.port}/nope`, { signal: controller.signal });
    clearTimeout(timeoutId);
    assert.equal(res.status, 404);
  } finally {
    await h.close();
    closeDb(db);
  }
});

async function postUps(
  port: number,
  body: unknown,
): Promise<{ hookSpecificOutput: { hookEventName: string; additionalContext: string } }> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);
  const res = await fetch(`http://127.0.0.1:${port}/hooks/user_prompt_submit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: controller.signal,
  });
  clearTimeout(timeoutId);
  return res.json() as Promise<{
    hookSpecificOutput: { hookEventName: string; additionalContext: string };
  }>;
}

test('http: user_prompt_submit injects additionalContext for a matching prompt', async () => {
  __resetAutoRecallCache();
  const { userData, db } = freshUserData();
  const h = await startHttpServer({ db, llm: null, userData, port: 0, isHealthy: () => true });
  try {
    const out = await postUps(h.port, {
      prompt: 'what camera should I bring tonight',
      session_id: 'a',
    });
    assert.equal(out.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    assert.match(out.hookSpecificOutput.additionalContext, /Viltrox 85mm/);
  } finally {
    await h.close();
    closeDb(db);
  }
});

test('http: user_prompt_submit returns empty context for a short/irrelevant prompt', async () => {
  __resetAutoRecallCache();
  const { userData, db } = freshUserData();
  const h = await startHttpServer({ db, llm: null, userData, port: 0, isHealthy: () => true });
  try {
    const out = await postUps(h.port, { prompt: 'hi', session_id: 'b' });
    assert.equal(out.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    assert.equal(out.hookSpecificOutput.additionalContext, '');
  } finally {
    await h.close();
    closeDb(db);
  }
});

test('http: user_prompt_submit degrades to empty when userData is absent', async () => {
  __resetAutoRecallCache();
  const db = freshDb();
  const h = await startHttpServer({ db, llm: null, port: 0, isHealthy: () => true });
  try {
    const out = await postUps(h.port, {
      prompt: 'what camera should I bring tonight',
      session_id: 'c',
    });
    assert.equal(out.hookSpecificOutput.additionalContext, '');
  } finally {
    await h.close();
    closeDb(db);
  }
});
