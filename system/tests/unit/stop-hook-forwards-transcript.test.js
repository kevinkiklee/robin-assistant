import assert from 'node:assert/strict';
import { mkdirSync as __robinMkdirSync } from 'node:fs';
import { tmpdir as __robinTmpdir } from 'node:os';
import { join as __robinJoin } from 'node:path';
import { test } from 'node:test';
import { stopHookHandler } from '../../io/hooks/stop-hook.js';

const __robinTestHome = __robinJoin(
  __robinTmpdir(),
  `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`,
);
__robinMkdirSync(__robinTestHome, { recursive: true });
process.env.ROBIN_HOME = __robinTestHome;

test('stop hook forwards transcript_path + session_id to daemon route', async () => {
  const captured = { body: null };
  const fakeFetch = async (_url, init) => {
    captured.body = JSON.parse(init.body);
    return { ok: true };
  };
  await stopHookHandler({
    stdin: {
      transcript_path: '/tmp/foo.jsonl',
      session_id: 'sess-abc',
      since: '2026-05-10T00:00:00Z',
    },
    fetchFn: fakeFetch,
    readState: async () => ({ port: 9999, pid: process.pid }),
  });
  assert.equal(captured.body.transcript_path, '/tmp/foo.jsonl');
  assert.equal(captured.body.session_id, 'sess-abc');
  assert.equal(captured.body.since, '2026-05-10T00:00:00Z');
});

test('stop hook with no transcript_path posts body without those fields', async () => {
  const captured = { body: null };
  const fakeFetch = async (_url, init) => {
    captured.body = JSON.parse(init.body);
    return { ok: true };
  };
  await stopHookHandler({
    stdin: { since: '2026-05-10T00:00:00Z' },
    fetchFn: fakeFetch,
    readState: async () => ({ port: 9999, pid: process.pid }),
  });
  assert.equal(captured.body.transcript_path, undefined);
  assert.equal(captured.body.session_id, undefined);
});
