import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { closeDb, openDb } from '../../brain/memory/db.ts';
import { allMigrations, applyMigrations } from '../../brain/memory/migrations/index.ts';
import { dbFilePath, pidFilePath } from '../../lib/paths.ts';
import { enqueueJob } from '../scheduler/claim.ts';
import { Daemon } from './daemon.ts';

function freshUserData(): string {
  const dir = mkdtempSync(join(tmpdir(), 'robin-daemon-'));
  mkdirSync(join(dir, 'state', 'db'), { recursive: true });
  mkdirSync(join(dir, 'state', 'runtime'), { recursive: true });
  mkdirSync(join(dir, 'observability', 'logs'), { recursive: true });
  mkdirSync(join(dir, 'config'), { recursive: true });
  return dir;
}

test('daemon: start writes pidfile, stop removes it', async () => {
  const userData = freshUserData();
  process.env.ROBIN_USER_DATA_DIR = userData;

  const daemon = new Daemon();
  daemon.registerHandler('test.noop', async () => {});
  const startPromise = daemon.start({ foreground: true });

  // Let it tick once
  await sleep(100);

  assert.ok(existsSync(pidFilePath(userData)), 'pidfile should exist while daemon runs');
  await daemon.stop('test');
  await startPromise.catch(() => {});
  assert.ok(!existsSync(pidFilePath(userData)), 'pidfile should be removed after stop');
});

test('daemon: session_end hook reads transcript and writes session.captured event', async () => {
  const userData = freshUserData();
  process.env.ROBIN_USER_DATA_DIR = userData;

  // Build a synthetic Claude Code transcript .jsonl: one user turn, one assistant turn
  const transcriptPath = join(userData, 'fake-transcript.jsonl');
  writeFileSync(
    transcriptPath,
    JSON.stringify({
      type: 'user',
      message: { role: 'user', content: 'what is the daemon hook test verifying' },
    }) +
      '\n' +
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: 'It POSTs a synthetic session_end and asserts a session.captured event lands.',
        },
      }) +
      '\n',
  );

  const daemon = new Daemon();
  // Port 0 = OS-assigned. Without this the test collides with any running daemon on 41273.
  const startPromise = daemon.start({ foreground: true, httpPort: 0 });
  // Wait for HTTP server to be listening + port assigned
  let port: number | undefined;
  for (let i = 0; i < 30; i++) {
    port = daemon.getHttpPort();
    if (port) break;
    await sleep(100);
  }
  assert.ok(port, 'daemon http server should be bound');

  const res = await fetch(`http://127.0.0.1:${port}/hooks/session_end`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session_id: 'hook-test-session', transcript_path: transcriptPath }),
  });
  const responseBody = await res.text();
  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${responseBody}`);

  // Give the hook handler a moment to read+capture the file
  await sleep(500);

  const db = openDb(dbFilePath(userData));
  const allEvents = db.prepare(`SELECT kind FROM events`).all() as Array<{ kind: string }>;
  const ev = db
    .prepare(`SELECT id, payload FROM events WHERE kind = 'session.captured' LIMIT 1`)
    .get() as { id: number; payload: string } | undefined;
  closeDb(db);

  await daemon.stop('test');
  await startPromise.catch(() => {});

  assert.ok(
    ev,
    `expected a session.captured event from the hook; all event kinds: ${JSON.stringify(allEvents.map((e) => e.kind))}`,
  );
  const payload = JSON.parse(ev.payload);
  assert.equal(payload.sessionId, 'hook-test-session');
});

test('daemon: claims and runs a queued no-op job', async () => {
  const userData = freshUserData();
  process.env.ROBIN_USER_DATA_DIR = userData;

  // Pre-seed a manual job
  const db = openDb(dbFilePath(userData));
  applyMigrations(db, allMigrations);
  enqueueJob(db, {
    name: 'test.noop',
    trigger_kind: 'manual',
    scheduled_at: new Date().toISOString(),
  });
  closeDb(db);

  let calls = 0;
  const daemon = new Daemon();
  daemon.registerHandler('test.noop', async () => {
    calls++;
  });

  const startPromise = daemon.start({ foreground: true });
  await sleep(1500); // tick interval is 1s
  await daemon.stop('test');
  await startPromise.catch(() => {});

  assert.ok(calls >= 1, `expected handler to be called at least once, got ${calls}`);
});

test('daemon: hook receipts are not persisted as invariant.check events', async () => {
  const userData = freshUserData();
  process.env.ROBIN_USER_DATA_DIR = userData;

  const daemon = new Daemon();
  const startPromise = daemon.start({ foreground: true, httpPort: 0 });
  let port: number | undefined;
  for (let i = 0; i < 30; i++) {
    port = daemon.getHttpPort();
    if (port) break;
    await sleep(100);
  }
  assert.ok(port, 'daemon http server should be bound');

  // session_end is the only hook that reaches the generic onHook receipt path
  // (session_start / user_prompt_submit have dedicated early-return routes). We omit
  // transcript_path so the capture pipeline is skipped — isolating the receipt write.
  // Before the fix each POST appended an 'invariant.check' event — 27k of these (all
  // 'hook.session_end') accumulated in the live DB.
  for (let i = 0; i < 3; i++) {
    const res = await fetch(`http://127.0.0.1:${port}/hooks/session_end`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: `s${i}` }),
    });
    assert.equal(res.status, 200);
  }
  await sleep(200);

  const db = openDb(dbFilePath(userData));
  const n = db.prepare(`SELECT count(*) AS n FROM events WHERE kind = 'invariant.check'`).get() as {
    n: number;
  };
  closeDb(db);

  await daemon.stop('test');
  await startPromise.catch(() => {});

  assert.equal(n.n, 0, 'hook receipts must not be written as invariant.check events');
});
