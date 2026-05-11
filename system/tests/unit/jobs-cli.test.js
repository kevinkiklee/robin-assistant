// tests/unit/jobs-cli.test.js  (this file grows in tasks 9 and 10)
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { writeConfig as __wc } from '../../config/paths.js';

const __h = join(tmpdir(), `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
mkdirSync(__h, { recursive: true });
process.env.ROBIN_HOME = __h;
await __wc({ embedder_profile: 'mxbai-1024' });

const { jobsList } = await import('../../runtime/cli/commands/jobs-list.js');
const { jobsStatus } = await import('../../runtime/cli/commands/jobs-status.js');

function capture() {
  const lines = [];
  return { lines, fn: (s) => lines.push(s) };
}

test('jobs list — prints (no jobs) when DB empty', async () => {
  const out = capture();
  await jobsList([], { out: out.fn, listJobs: async () => [] });
  assert.match(out.lines.join('\n'), /\(no jobs\)/);
});

test('jobs list — formats columns', async () => {
  const out = capture();
  await jobsList([], {
    out: out.fn,
    listJobs: async () => [
      {
        name: 'foo',
        enabled: true,
        schedule: '@daily',
        last_run_at: null,
        last_run_ok: null,
        next_run_at: new Date('2026-05-10T14:00:00Z'),
      },
      {
        name: 'bar',
        enabled: false,
        schedule: '@hourly',
        last_run_at: new Date('2026-05-10T12:00:00Z'),
        last_run_ok: true,
        next_run_at: null,
      },
    ],
  });
  const all = out.lines.join('\n');
  assert.match(all, /foo\s+enabled\s+@daily/);
  assert.match(all, /bar\s+disabled\s+@hourly/);
});

test('jobs status — prints all DB fields', async () => {
  const out = capture();
  await jobsStatus(['foo'], {
    out: out.fn,
    getJob: async () => ({
      name: 'foo',
      enabled: true,
      schedule: '@daily',
      runtime: 'agent',
      last_run_at: new Date('2026-05-10T14:00:00Z'),
      last_run_ok: true,
      last_error: null,
      last_duration_ms: 1234,
      next_run_at: new Date('2026-05-11T14:00:00Z'),
      consecutive_failures: 0,
      in_flight: false,
      manually_runnable: true,
    }),
  });
  const all = out.lines.join('\n');
  assert.match(all, /name: foo/);
  assert.match(all, /enabled: true/);
  assert.match(all, /runtime: agent/);
  assert.match(all, /consecutive_failures: 0/);
});

test('jobs status — unknown job', async () => {
  const out = capture();
  const err = capture();
  await jobsStatus(['nope'], { out: out.fn, err: err.fn, getJob: async () => null });
  assert.match(err.lines.join('\n'), /no such job: nope/);
  process.exitCode = 0; // reset — jobsStatus sets exitCode=1 for unknown jobs
});

import { jobsDisable } from '../../runtime/cli/commands/jobs-disable.js';
import { jobsEnable } from '../../runtime/cli/commands/jobs-enable.js';
import { jobsReload } from '../../runtime/cli/commands/jobs-reload.js';
import { jobsRun } from '../../runtime/cli/commands/jobs-run.js';

test('jobs run — POSTs to /internal/jobs/run', async () => {
  const out = capture();
  let posted;
  await jobsRun(['foo'], {
    out: out.fn,
    daemonRequest: async (path, body) => {
      posted = { path, body };
      return { ok: true, last_error: null };
    },
  });
  assert.equal(posted.path, '/internal/jobs/run');
  assert.deepEqual(posted.body, { name: 'foo', force: false });
  assert.match(out.lines.join('\n'), /ok/);
});

test('jobs run --force passes force=true', async () => {
  let posted;
  await jobsRun(['foo', '--force'], {
    out: () => {},
    daemonRequest: async (_path, body) => {
      posted = body;
      return { ok: true };
    },
  });
  assert.equal(posted.force, true);
});

test('jobs run reports not_manually_runnable as ok=false', async () => {
  const out = capture();
  const err = capture();
  await jobsRun(['heavy'], {
    out: out.fn,
    err: err.fn,
    daemonRequest: async () => ({ ok: false, reason: 'not_manually_runnable' }),
  });
  assert.match(err.lines.join('\n'), /not_manually_runnable/);
  process.exitCode = 0; // reset — jobsRun sets exitCode=1 on failure
});

test('jobs enable/disable call setEnabled', async () => {
  const calls = [];
  await jobsEnable(['foo'], { setEnabled: async (n, v) => calls.push([n, v]), out: () => {} });
  await jobsDisable(['foo'], { setEnabled: async (n, v) => calls.push([n, v]), out: () => {} });
  assert.deepEqual(calls, [
    ['foo', true],
    ['foo', false],
  ]);
});

test('jobs reload triggers /internal/jobs/reload', async () => {
  let hit;
  await jobsReload([], {
    daemonRequest: async (path) => {
      hit = path;
      return { ok: true, count: 3 };
    },
    out: () => {},
  });
  assert.equal(hit, '/internal/jobs/reload');
});
