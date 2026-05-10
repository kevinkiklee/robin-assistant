// tests/unit/jobs-cli.test.js  (this file grows in tasks 9 and 10)
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { writeConfig as __wc } from '../../src/runtime/config.js';

const __h = join(tmpdir(), `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
mkdirSync(__h, { recursive: true });
process.env.ROBIN_HOME = __h;
await __wc({ embedder_profile: 'mxbai-1024' });

const { jobsList } = await import('../../src/cli/commands/jobs-list.js');
const { jobsStatus } = await import('../../src/cli/commands/jobs-status.js');

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
