import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { discoverJobs, parseJobFile, validateJob } from '../../cognition/jobs/loader.js';

let tmp;
test.beforeEach(() => {
  tmp = join(tmpdir(), `robin-jobs-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(tmp, 'builtin'), { recursive: true });
  mkdirSync(join(tmp, 'user'), { recursive: true });
});
test.afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function writeJob(dir, name, frontmatter, body = 'job body') {
  const fm = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? JSON.stringify(v) : v}`)
    .join('\n');
  writeFileSync(join(dir, `${name}.md`), `---\n${fm}\n---\n${body}\n`);
}

test('parseJobFile — extracts frontmatter + body', () => {
  writeJob(
    join(tmp, 'builtin'),
    'foo',
    {
      name: 'foo',
      schedule: '@daily',
      runtime: 'agent',
      enabled: true,
    },
    'hello world',
  );
  const job = parseJobFile(join(tmp, 'builtin', 'foo.md'));
  assert.equal(job.name, 'foo');
  assert.equal(job.schedule, '@daily');
  assert.equal(job.runtime, 'agent');
  assert.equal(job.enabled, true);
  assert.match(job.body, /hello world/);
  assert.equal(job.source, 'builtin');
});

test('validateJob — rejects missing name/schedule/runtime', () => {
  assert.throws(() => validateJob({ schedule: '@daily', runtime: 'agent' }), /name/);
  assert.throws(() => validateJob({ name: 'x', runtime: 'agent' }), /schedule/);
  assert.throws(() => validateJob({ name: 'x', schedule: '@daily' }), /runtime/);
});

test('validateJob — rejects invalid runtime + notify values', () => {
  assert.throws(() => validateJob({ name: 'x', schedule: '@daily', runtime: 'bogus' }), /runtime/);
  assert.throws(
    () => validateJob({ name: 'x', schedule: '@daily', runtime: 'agent', notify: 'sms' }),
    /notify/,
  );
});

test('validateJob — name/filename mismatch rejected', () => {
  writeJob(join(tmp, 'builtin'), 'foo', { name: 'bar', schedule: '@daily', runtime: 'agent' });
  assert.throws(() => parseJobFile(join(tmp, 'builtin', 'foo.md')), /filename/);
});

test('discoverJobs — merges builtin + user; user wins by name', () => {
  writeJob(
    join(tmp, 'builtin'),
    'foo',
    {
      name: 'foo',
      schedule: '@daily',
      runtime: 'agent',
      enabled: false,
    },
    'builtin body',
  );
  writeJob(
    join(tmp, 'user'),
    'foo',
    {
      name: 'foo',
      schedule: '@hourly',
      runtime: 'agent',
      enabled: true,
    },
    'user body',
  );
  writeJob(join(tmp, 'builtin'), 'other', {
    name: 'other',
    schedule: '@hourly',
    runtime: 'internal',
    enabled: false,
  });
  const jobs = discoverJobs({ builtinDir: join(tmp, 'builtin'), userDir: join(tmp, 'user') });
  const byName = Object.fromEntries(jobs.map((j) => [j.name, j]));
  assert.equal(byName.foo.schedule, '@hourly', 'user copy wins');
  assert.equal(byName.foo.source, 'user');
  assert.match(byName.foo.body, /user body/);
  assert.equal(byName.other.source, 'builtin');
});

test('discoverJobs — missing user dir is fine', () => {
  writeJob(join(tmp, 'builtin'), 'foo', {
    name: 'foo',
    schedule: '@daily',
    runtime: 'agent',
    enabled: false,
  });
  const jobs = discoverJobs({
    builtinDir: join(tmp, 'builtin'),
    userDir: join(tmp, 'nonexistent'),
  });
  assert.equal(jobs.length, 1);
});

test('discoverJobs — defaults filled in', () => {
  writeJob(join(tmp, 'builtin'), 'foo', {
    name: 'foo',
    schedule: '@daily',
    runtime: 'agent',
  });
  const [job] = discoverJobs({ builtinDir: join(tmp, 'builtin'), userDir: join(tmp, 'user') });
  assert.equal(job.enabled, false);
  assert.equal(job.catch_up, false);
  assert.equal(job.timeout_minutes, 10);
  assert.equal(job.notify, 'none');
  assert.equal(job.notify_on_failure, true);
  assert.equal(job.manually_runnable, true);
});

test('discoverJobs — user override merges with builtin', () => {
  writeJob(
    join(tmp, 'builtin'),
    'foo',
    {
      name: 'foo',
      schedule: '@daily',
      runtime: 'agent',
      enabled: true,
      timeout_minutes: 5,
    },
    'builtin body',
  );
  writeJob(
    join(tmp, 'user'),
    'foo',
    { override: 'foo', schedule: '0 6 * * *' },
    'user override body',
  );
  const jobs = discoverJobs({ builtinDir: join(tmp, 'builtin'), userDir: join(tmp, 'user') });
  assert.equal(jobs.length, 1);
  const job = jobs[0];
  assert.equal(job.name, 'foo');
  assert.equal(job.source, 'user');
  assert.equal(job.schedule, '0 6 * * *'); // overridden
  assert.equal(job.runtime, 'agent'); // inherited
  assert.equal(job.timeout_minutes, 5); // inherited
  assert.match(job.body, /user override body/);
});

test('discoverJobs — override with no matching builtin is rejected', () => {
  writeJob(join(tmp, 'user'), 'orphan', { override: 'orphan' });
  const jobs = discoverJobs({ builtinDir: join(tmp, 'builtin'), userDir: join(tmp, 'user') });
  assert.equal(jobs.length, 0);
});

test('discoverJobs — override target must match filename', () => {
  writeJob(join(tmp, 'builtin'), 'foo', {
    name: 'foo',
    schedule: '@daily',
    runtime: 'agent',
  });
  // file named bar.md but override: foo — should be rejected
  writeJob(join(tmp, 'user'), 'bar', { override: 'foo' });
  const jobs = discoverJobs({ builtinDir: join(tmp, 'builtin'), userDir: join(tmp, 'user') });
  // builtin foo still there, user bar rejected — exactly one job
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].source, 'builtin');
});

test('discoverJobs — daily-briefing is no longer a builtin (moved to user-data)', async () => {
  const { discoverJobs } = await import('../../cognition/jobs/loader.js');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const builtinDir = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    'cognition',
    'jobs',
    'builtin',
  );
  const jobs = discoverJobs({ builtinDir, userDir: '/nonexistent' });
  // Task 17: daily-briefing is Kevin-specific composition; the md + JS both
  // live in `user-data/jobs/` now. With no user dir on disk it must not appear.
  assert.equal(
    jobs.find((j) => j.name === 'daily-briefing'),
    undefined,
    'daily-briefing should not be discoverable from system/builtin alone',
  );
});
