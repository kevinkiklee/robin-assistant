import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { upsertFromDiscovered } from '../../cognition/jobs/db.js';
import { writeConfig as __wc } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { createStubEmbedder } from '../../data/embed/embedder.js';
import { createCapture } from '../../io/integrations/_framework/capture.js';
import { createListJobsTool } from '../../io/mcp/tools/list-jobs.js';
import { createRunJobTool } from '../../io/mcp/tools/run-job.js';

const __h = join(tmpdir(), `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
mkdirSync(__h, { recursive: true });
process.env.ROBIN_HOME = __h;
await __wc({ embedder_profile: 'mxbai-1024' });

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  return db;
}

const SAMPLE = (over = {}) => ({
  name: 'foo',
  schedule: '@daily',
  runtime: 'agent',
  enabled: true,
  catch_up: false,
  notify: 'capture',
  notify_on_failure: true,
  timeout_minutes: 1,
  manually_runnable: true,
  body: 'hi',
  ...over,
});

test('list_jobs — returns shape with subset of fields', async () => {
  const db = await fresh();
  await upsertFromDiscovered(db, [SAMPLE()]);
  const tool = createListJobsTool({ db });
  const r = await tool.handler({});
  assert.ok(Array.isArray(r.jobs));
  assert.equal(r.jobs.length, 1);
  assert.equal(r.jobs[0].name, 'foo');
  assert.equal(r.jobs[0].manually_runnable, true);
  await close(db);
});

test('list_jobs — filter enabled=false hides enabled jobs', async () => {
  const db = await fresh();
  await upsertFromDiscovered(db, [SAMPLE(), SAMPLE({ name: 'bar', enabled: false })]);
  const tool = createListJobsTool({ db });
  const r = await tool.handler({ filter: { enabled: false } });
  assert.equal(r.jobs.length, 1);
  assert.equal(r.jobs[0].name, 'bar');
  await close(db);
});

test('run_job — refuses not_manually_runnable', async () => {
  const db = await fresh();
  const job = SAMPLE({ manually_runnable: false });
  await upsertFromDiscovered(db, [job]);
  const tool = createRunJobTool({
    db,
    host: { invokeLLM: async () => ({ content: 'x' }) },
    capture: createCapture({
      db,
      embedder: createStubEmbedder({ dimension: 1024 }),
      source: 'job_output',
      embed: false,
      mode: 'insert-or-skip',
    }),
    tools: () => [],
    getJobs: () => [job],
  });
  const r = await tool.handler({ name: 'foo' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'not_manually_runnable');
  await close(db);
});

test('run_job — dry_run validates without dispatching', async () => {
  const db = await fresh();
  const job = SAMPLE();
  await upsertFromDiscovered(db, [job]);
  let llmCalled = false;
  const tool = createRunJobTool({
    db,
    host: {
      invokeLLM: async () => {
        llmCalled = true;
        return { content: 'x' };
      },
    },
    capture: createCapture({
      db,
      embedder: createStubEmbedder({ dimension: 1024 }),
      source: 'job_output',
      embed: false,
      mode: 'insert-or-skip',
    }),
    tools: () => [],
    getJobs: () => [job],
  });
  const r = await tool.handler({ name: 'foo', dry_run: true });
  assert.equal(r.ok, true);
  assert.equal(r.dry_run, true);
  assert.equal(llmCalled, false);
  await close(db);
});

test('run_job — happy path', async () => {
  const db = await fresh();
  const job = SAMPLE();
  await upsertFromDiscovered(db, [job]);
  const tool = createRunJobTool({
    db,
    host: { invokeLLM: async () => ({ content: 'morning' }) },
    capture: createCapture({
      db,
      embedder: createStubEmbedder({ dimension: 1024 }),
      source: 'job_output',
      embed: false,
      mode: 'insert-or-skip',
    }),
    tools: () => [],
    getJobs: () => [job],
  });
  const r = await tool.handler({ name: 'foo' });
  assert.equal(r.ok, true);
  await close(db);
});
