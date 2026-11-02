import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
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
  writeFileSync(join(userData, 'content/knowledge/knitting.md'), 'Acme X1 and Acme Trail Saddle');
  writeFileSync(
    join(userData, 'config/recall-topics.yaml'),
    'topics:\n  - id: knitting\n    match: [yarn, skein, purl]\n    docs: [content/knowledge/knitting.md]\n',
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

/** Raw request so a test can forge Host/Origin (fetch forbids setting Host). */
function rawRequest(
  port: number,
  path: string,
  headers: Record<string, string>,
  method = 'GET',
): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, path, method, headers, setHost: false },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on('error', reject);
    req.end(method === 'POST' ? '{}' : undefined);
  });
}

test('http: DNS-rebinding and browser requests are refused (Host/Origin gate)', async () => {
  const db = freshDb();
  const hooks: string[] = [];
  const h = await startHttpServer({
    db,
    port: 0,
    isHealthy: () => true,
    onHook: (kind) => {
      hooks.push(kind);
    },
  });
  try {
    const local = `127.0.0.1:${h.port}`;
    assert.equal(await rawRequest(h.port, '/health', { host: local }), 200);
    assert.equal(await rawRequest(h.port, '/health', { host: `localhost:${h.port}` }), 200);
    // Rebinding: the page's own hostname now resolves to 127.0.0.1.
    assert.equal(await rawRequest(h.port, '/health', { host: `evil.example:${h.port}` }), 403);
    // Node itself 400s an HTTP/1.1 request without Host, before our gate.
    assert.equal(await rawRequest(h.port, '/health', {}), 400, 'missing Host');
    // A browser page POSTing to the real loopback address carries an Origin.
    assert.equal(
      await rawRequest(
        h.port,
        '/hooks/session_end',
        { host: local, origin: 'https://evil.example', 'content-type': 'text/plain' },
        'POST',
      ),
      403,
    );
    assert.equal(
      await rawRequest(
        h.port,
        '/hooks/user_prompt_submit',
        { host: local, origin: 'null' },
        'POST',
      ),
      403,
    );
    // A page's no-cors GET carries no Origin but does carry Sec-Fetch-Site.
    assert.equal(
      await rawRequest(h.port, '/health', { host: local, 'sec-fetch-site': 'cross-site' }),
      403,
    );
    assert.deepEqual(hooks, [], 'refused requests never reach a hook');
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

interface UpsResponse {
  decision?: string;
  reason?: string;
  hookSpecificOutput: { hookEventName: string; additionalContext?: string; sessionTitle?: string };
}

async function postHook(port: number, path: string, body: unknown): Promise<UpsResponse> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: controller.signal,
  });
  clearTimeout(timeoutId);
  return res.json() as Promise<UpsResponse>;
}

function postUps(port: number, body: unknown): Promise<UpsResponse> {
  return postHook(port, '/hooks/user_prompt_submit', body);
}

test('http: user_prompt_submit injects additionalContext for a matching prompt', async () => {
  __resetAutoRecallCache();
  const { userData, db } = freshUserData();
  const h = await startHttpServer({ db, llm: null, userData, port: 0, isHealthy: () => true });
  try {
    const out = await postUps(h.port, {
      prompt: 'which yarn should I use tonight',
      session_id: 'a',
    });
    assert.equal(out.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    assert.match(out.hookSpecificOutput.additionalContext ?? '', /Acme Trail Saddle/);
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
    assert.equal(out.hookSpecificOutput.additionalContext ?? '', '');
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
      prompt: 'which yarn should I use tonight',
      session_id: 'c',
    });
    assert.equal(out.hookSpecificOutput.additionalContext ?? '', '');
  } finally {
    await h.close();
    closeDb(db);
  }
});

test('http: user_prompt_submit blocks and captures lines for the bound note session only', async () => {
  __resetAutoRecallCache();
  const { userData, db } = freshUserData();
  const h = await startHttpServer({ db, llm: null, userData, port: 0, isHealthy: () => true });
  try {
    const started = await postUps(h.port, {
      prompt: '>>note lakeport-2026 Smoke',
      session_id: 'n1',
    });
    assert.equal(started.decision, 'block');
    assert.match(started.reason ?? '', /"lakeport-2026" started/);
    assert.equal(started.hookSpecificOutput.sessionTitle, '📝 notes: lakeport-2026');

    // Bound window: captured, blocked, and auto-recall never ran (the prompt matches the fixture's topic).
    const captured = await postUps(h.port, {
      prompt: 'which yarn should I use tonight',
      session_id: 'n1',
    });
    assert.equal(captured.decision, 'block');
    assert.equal(captured.reason, '📝 #1');
    assert.equal(captured.hookSpecificOutput.additionalContext, undefined);

    // Another window: untouched — normal auto-recall.
    const other = await postUps(h.port, {
      prompt: 'which yarn should I use tonight',
      session_id: 'n2',
    });
    assert.equal(other.decision, undefined);
    assert.match(other.hookSpecificOutput.additionalContext ?? '', /Acme Trail Saddle/);

    const rawFile = join(userData, 'content', 'sources', 'notes', 'lakeport-2026.md');
    assert.equal(existsSync(rawFile), true);
    assert.match(readFileSync(rawFile, 'utf8'), /- \d\d:\d\d which yarn should I use tonight\n$/);

    const ended = await postUps(h.port, { prompt: '>>end', session_id: 'n2' });
    assert.match(ended.reason ?? '', /ended — 1 entries, 0 sections/);
  } finally {
    await h.close();
    closeDb(db);
  }
});

test('http: session_start parses its body, still returns the primer, and re-binds after /clear', async () => {
  __resetAutoRecallCache();
  const { userData, db } = freshUserData();
  const h = await startHttpServer({ db, llm: null, userData, port: 0, isHealthy: () => true });
  try {
    await postUps(h.port, { prompt: '>>note lakeport-2026', session_id: 'n1', cwd: '/w' });
    await postHook(h.port, '/hooks/session_end', { session_id: 'n1', reason: 'clear', cwd: '/w' });
    const start = await postHook(h.port, '/hooks/session_start', {
      session_id: 'n9',
      source: 'clear',
      cwd: '/w',
    });
    assert.equal(start.hookSpecificOutput.hookEventName, 'SessionStart');
    const captured = await postUps(h.port, { prompt: 'after clear', session_id: 'n9' });
    assert.equal(captured.reason, '📝 #1');
  } finally {
    await h.close();
    closeDb(db);
  }
});

test('http: a note-session failure passes the prompt through instead of erroring', async () => {
  __resetAutoRecallCache();
  const db = freshDb();
  // userData is a regular FILE, so every mkdirSync/readFileSync under it throws (ENOTDIR).
  const bogus = join(mkdtempSync(join(tmpdir(), 'robin-http-bad-')), 'not-a-dir');
  writeFileSync(bogus, 'x');
  const h = await startHttpServer({
    db,
    llm: null,
    userData: bogus,
    port: 0,
    isHealthy: () => true,
  });
  try {
    const out = await postUps(h.port, { prompt: '>>note lakeport-2026', session_id: 'e1' });
    assert.equal(out.decision, undefined);
    assert.equal(out.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    assert.equal(out.hookSpecificOutput.additionalContext, '');
  } finally {
    await h.close();
    closeDb(db);
  }
});
