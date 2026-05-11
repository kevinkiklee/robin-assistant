// tests/integration/jobs-roundtrip.test.js
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { getJob, setEnabled, upsertFromDiscovered } from '../../cognition/jobs/db.js';
import { discoverJobs } from '../../cognition/jobs/loader.js';
import { runOneJob } from '../../cognition/jobs/runner.js';
import { writeConfig as __wc } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { createStubEmbedder } from '../../data/embed/embedder.js';
import { createCapture } from '../../io/integrations/_framework/capture.js';

const __h = join(tmpdir(), `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
mkdirSync(__h, { recursive: true });
process.env.ROBIN_HOME = __h;
await __wc({ embedder_profile: 'mxbai-1024' });

const BUILTIN_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'src',
  'jobs',
  'builtin',
);

test('jobs roundtrip — discover daily-briefing → enable → run → capture event', async () => {
  const userDir = join(__h, 'jobs');
  mkdirSync(userDir, { recursive: true });

  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));

  const jobs = discoverJobs({ builtinDir: BUILTIN_DIR, userDir });
  await upsertFromDiscovered(db, jobs);

  // Ships disabled
  let row = await getJob(db, 'daily-briefing');
  assert.equal(row.enabled, false);

  // Enable
  await setEnabled(db, 'daily-briefing', true);
  row = await getJob(db, 'daily-briefing');
  assert.equal(row.enabled, true);

  // Manual run with a stub LLM
  // Override notify to 'capture' so the test doesn't need a Discord env
  const testJobs = jobs.map((j) => (j.name === 'daily-briefing' ? { ...j, notify: 'capture' } : j));
  const host = { invokeLLM: async () => ({ content: 'stubbed morning brief' }) };
  const capture = createCapture({
    db,
    embedder: createStubEmbedder({ dimension: 1024 }),
    source: 'job_output',
    embed: false,
    mode: 'insert-or-skip',
  });
  await runOneJob({ db, capture, host, jobs: testJobs, tools: [], name: 'daily-briefing' });

  // Event captured
  const [events] = await db.query("SELECT * FROM events WHERE source = 'job_output'").collect();
  assert.equal(events.length, 1);
  assert.match(events[0].content, /stubbed morning brief/);

  // Run state updated
  row = await getJob(db, 'daily-briefing');
  assert.equal(row.last_run_ok, true);
  assert.equal(row.in_flight, false);

  await close(db);
});

test('jobs roundtrip — user override wins over built-in', async () => {
  const userDir = join(__h, 'jobs2');
  mkdirSync(userDir, { recursive: true });
  writeFileSync(
    join(userDir, 'daily-briefing.md'),
    `---
name: daily-briefing
schedule: "@hourly"
runtime: agent
enabled: true
catch_up: false
notify: capture
notify_on_failure: true
timeout_minutes: 5
manually_runnable: true
---
user override body
`,
  );

  const jobs = discoverJobs({ builtinDir: BUILTIN_DIR, userDir });
  const briefing = jobs.find((j) => j.name === 'daily-briefing');
  assert.equal(briefing.schedule, '@hourly');
  assert.equal(briefing.enabled, true);
  assert.match(briefing.body, /user override body/);
  assert.equal(briefing.source, 'user');
});
