import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { createStubEmbedder } from '../../data/embed/embedder.js';
import { createCapture } from '../../io/integrations/_framework/capture.js';
import { upsertFromDiscovered } from '../../cognition/jobs/db.js';
import { runOneJob } from '../../cognition/jobs/runner.js';

import { writeConfig as __wc } from '../../config/paths.js';

const __h = join(tmpdir(), `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
mkdirSync(__h, { recursive: true });
process.env.ROBIN_HOME = __h;
await __wc({ embedder_profile: 'mxbai-1024' });

async function setup() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  const capture = createCapture({
    db,
    embedder: createStubEmbedder({ dimension: 1024 }),
    source: 'job_output',
    embed: false,
    mode: 'insert-or-skip',
  });
  return { db, capture };
}

const SAMPLE_AGENT = {
  name: 'agent-job',
  schedule: '@daily',
  runtime: 'agent',
  enabled: true,
  catch_up: false,
  notify: 'capture',
  notify_on_failure: true,
  timeout_minutes: 1,
  manually_runnable: true,
  body: 'do the thing',
};

test('agent runtime — happy path captures job_output event', async () => {
  const { db, capture } = await setup();
  await upsertFromDiscovered(db, [SAMPLE_AGENT]);
  const host = { invokeLLM: async () => ({ content: 'hi from the LLM' }) };
  await runOneJob({ db, capture, host, jobs: [SAMPLE_AGENT], tools: [], name: 'agent-job' });
  const [rows] = await db.query("SELECT * FROM events WHERE source = 'job_output'").collect();
  assert.equal(rows.length, 1);
  await close(db);
});

test('agent runtime — timeout fails the job', async () => {
  const { db, capture } = await setup();
  await upsertFromDiscovered(db, [SAMPLE_AGENT]);
  const host = {
    invokeLLM: () => new Promise((resolve) => setTimeout(resolve, 5_000)),
  };
  // Override timeout to 50ms via job copy (0.001 min ≈ 60ms; floor min is 100ms)
  const fast = { ...SAMPLE_AGENT, timeout_minutes: 0.001 };
  await runOneJob({ db, capture, host, jobs: [fast], tools: [], name: 'agent-job' });
  const [rows] = await db.query("SELECT * FROM runtime_jobs WHERE name = 'agent-job'").collect();
  assert.equal(rows[0].last_run_ok, false);
  assert.match(rows[0].last_error, /timeout/);
  await close(db);
});

test('agent runtime — host throw fails the job and bumps consecutive_failures', async () => {
  const { db, capture } = await setup();
  await upsertFromDiscovered(db, [SAMPLE_AGENT]);
  const host = {
    invokeLLM: async () => {
      throw new Error('host went away');
    },
  };
  await runOneJob({ db, capture, host, jobs: [SAMPLE_AGENT], tools: [], name: 'agent-job' });
  const [rows] = await db.query("SELECT * FROM runtime_jobs WHERE name = 'agent-job'").collect();
  assert.equal(rows[0].last_run_ok, false);
  assert.match(rows[0].last_error, /host went away/);
  assert.equal(rows[0].consecutive_failures, 1);
  await close(db);
});

test('internal runtime — dispatches to src/jobs/internal/<name>.js', async () => {
  const { db, capture } = await setup();
  const job = {
    name: 'test-internal-fixture',
    schedule: '@daily',
    runtime: 'internal',
    enabled: true,
    catch_up: false,
    notify: 'capture',
    notify_on_failure: true,
    timeout_minutes: 1,
    manually_runnable: true,
    body: '',
  };
  await upsertFromDiscovered(db, [job]);
  await runOneJob({
    db,
    capture,
    host: null,
    jobs: [job],
    tools: [],
    name: 'test-internal-fixture',
  });
  const [rows] = await db.query("SELECT * FROM events WHERE source = 'job_output'").collect();
  assert.equal(rows.length, 1);
  assert.match(rows[0].content, /from internal fixture/);
  await close(db);
});

test('notify_on_failure — failure with notify=capture writes job_notification event', async () => {
  const { db, capture } = await setup();
  await upsertFromDiscovered(db, [SAMPLE_AGENT]);
  const host = {
    invokeLLM: async () => {
      throw new Error('boom');
    },
  };
  await runOneJob({ db, capture, host, jobs: [SAMPLE_AGENT], tools: [], name: 'agent-job' });
  const [rows] = await db.query("SELECT * FROM events WHERE source = 'job_notification'").collect();
  assert.equal(rows.length, 1);
  assert.match(rows[0].content, /failed: boom/);
  await close(db);
});
