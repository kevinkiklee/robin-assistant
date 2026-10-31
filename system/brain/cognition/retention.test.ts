import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runRetention } from './retention.ts';

const NOW = new Date('2026-10-03T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

function setup(): { root: string; runs: string; runtime: string } {
  const root = mkdtempSync(join(tmpdir(), 'robin-retention-'));
  const runs = join(root, 'agent-runs');
  const runtime = join(root, 'state', 'runtime');
  mkdirSync(runs, { recursive: true });
  mkdirSync(runtime, { recursive: true });
  return { root, runs, runtime };
}

function touch(path: string, ageDays: number, body = 'x'): void {
  writeFileSync(path, body);
  const t = new Date(NOW.getTime() - ageDays * DAY);
  utimesSync(path, t, t);
}

test('retention: deletes agent-runs files older than 60 days by mtime, keeps newer', () => {
  const { root, runs } = setup();
  touch(join(runs, 'old-agentic-autonomous.jsonl'), 61, 'abcd');
  touch(join(runs, 'old-H.md'), 90);
  touch(join(runs, 'recent-agentic-autonomous.jsonl'), 59);
  mkdirSync(join(runs, 'subdir'));

  const res = runRetention(root, { now: NOW });
  assert.equal(res.agentRunsDeleted, 2);
  assert.equal(res.agentRunsBytes, 5);
  assert.equal(existsSync(join(runs, 'old-agentic-autonomous.jsonl')), false);
  assert.equal(existsSync(join(runs, 'old-H.md')), false);
  assert.equal(existsSync(join(runs, 'recent-agentic-autonomous.jsonl')), true);
  assert.equal(existsSync(join(runs, 'subdir')), true, 'directories are never touched');
});

test('retention: deletes only dated state/runtime files past the window, by NAME date', () => {
  const { root, runtime } = setup();
  const old = [
    'brief-delivered-2026-07-01.json',
    'dream-synthesis-2026-07-01.json',
    'dream-synthesis-staging-2026-07-01.json',
    'reliability-audit-2026-08-03.json',
    'nightly-critique-2026-06-30.json',
  ];
  const keep = [
    'brief-delivered-2026-08-04.json', // inside 60 days
    'reliability-audit-2026-10-03.json',
    'boots.json',
    'daemon.pid',
    'agent-runner.lock',
    'agent-dream.lock',
    'agent-runner-cursor',
    'agent-runner-adaptive.json',
    'surprise-ledger.json',
    'note-session.json',
    'cognition-dream.run.lock',
    'brief-delivered-2026-07-01.json.tmp', // not the exact dated shape
    'cursor-2026-01-01.json', // dated shape but deny-listed
  ];
  // mtime is fresh for every file: age comes from the name, not mtime.
  for (const n of [...old, ...keep]) touch(join(runtime, n), 0);

  const res = runRetention(root, { now: NOW });
  assert.equal(res.runtimeDeleted, old.length);
  for (const n of old) assert.equal(existsSync(join(runtime, n)), false, `${n} should be swept`);
  for (const n of keep) assert.equal(existsSync(join(runtime, n)), true, `${n} must survive`);
});

test('retention: missing directories are a no-op', () => {
  const root = mkdtempSync(join(tmpdir(), 'robin-retention-empty-'));
  assert.deepEqual(runRetention(root, { now: NOW }), {
    agentRunsDeleted: 0,
    agentRunsBytes: 0,
    runtimeDeleted: 0,
    errors: 0,
  });
});
