// tests/unit/actions-cli.test.js  (this file grows in tasks 7 + 8)
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

const { actionsList } = await import('../../src/cli/commands/actions-list.js');
const { actionsShow } = await import('../../src/cli/commands/actions-show.js');
const { actionsSet } = await import('../../src/cli/commands/actions-set.js');
const { actionsReset } = await import('../../src/cli/commands/actions-reset.js');

function capture() {
  const lines = [];
  return { lines, fn: (s) => lines.push(s) };
}

test('actions list — empty', async () => {
  const out = capture();
  await actionsList([], { out: out.fn, listActionTrust: async () => [] });
  assert.match(out.lines.join('\n'), /\(no action classes/);
});

test('actions list — formats rows', async () => {
  const out = capture();
  await actionsList([], {
    out: out.fn,
    listActionTrust: async () => [
      {
        class: 'discord_send:send_dm',
        state: 'AUTO',
        set_by: 'user',
        success_count: 5,
        correction_count: 0,
        last_used_at: new Date('2026-05-10T12:00:00Z'),
        last_state_change_at: new Date('2026-05-09T12:00:00Z'),
      },
      {
        class: 'github_write:comment',
        state: 'ASK',
        set_by: 'default',
        success_count: 0,
        correction_count: 0,
        last_used_at: null,
        last_state_change_at: new Date('2026-05-08T12:00:00Z'),
      },
    ],
  });
  const all = out.lines.join('\n');
  assert.match(all, /discord_send:send_dm\s+AUTO/);
  assert.match(all, /github_write:comment\s+ASK/);
});

test('actions show — prints all fields', async () => {
  const out = capture();
  await actionsShow(['discord_send:send_dm'], {
    out: out.fn,
    getActionTrust: async () => ({
      class: 'discord_send:send_dm',
      state: 'AUTO',
      set_by: 'user',
      success_count: 3,
      correction_count: 1,
      last_used_at: new Date('2026-05-10T12:00:00Z'),
      last_state_change_at: new Date('2026-05-09T12:00:00Z'),
    }),
  });
  const all = out.lines.join('\n');
  assert.match(all, /class: discord_send:send_dm/);
  assert.match(all, /state: AUTO/);
  assert.match(all, /set_by: user/);
  assert.match(all, /correction_count: 1/);
});

test('actions show — unknown class', async () => {
  const out = capture();
  const err = capture();
  await actionsShow(['nope:nope'], { out: out.fn, err: err.fn, getActionTrust: async () => null });
  assert.match(err.lines.join('\n'), /no such action class/);
  process.exitCode = 0; // reset — actionsShow sets exitCode=1 for unknown class
});

test('actions set — POSTs class + state to daemon', async () => {
  let posted;
  await actionsSet(['discord_send:send_dm', 'AUTO'], {
    out: () => {},
    daemonRequest: async (path, body) => {
      posted = { path, body };
      return { ok: true, class: 'discord_send:send_dm', state: 'AUTO' };
    },
  });
  assert.equal(posted.path, '/internal/actions/set');
  assert.deepEqual(posted.body, { class: 'discord_send:send_dm', state: 'AUTO' });
});

test('actions set — refuses lowercase state input', async () => {
  let posted;
  await actionsSet(['discord_send:send_dm', 'auto'], {
    out: () => {},
    daemonRequest: async (path, body) => {
      posted = { path, body };
      return { ok: true };
    },
  });
  // Should normalize to uppercase
  assert.equal(posted.body.state, 'AUTO');
});

test('actions reset — POSTs class to daemon', async () => {
  let posted;
  await actionsReset(['github_write:comment'], {
    out: () => {},
    daemonRequest: async (path, body) => {
      posted = { path, body };
      return { ok: true };
    },
  });
  assert.equal(posted.path, '/internal/actions/reset');
  assert.deepEqual(posted.body, { class: 'github_write:comment' });
});
