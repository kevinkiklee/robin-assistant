import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  appendStalenessNotice,
  stalenessNotice,
  wrapRegistrarWithStalenessNotice,
} from './staleness-notice.ts';

/** Minimal stand-in for McpServer — collects what got registered. */
function fakeRegistrar() {
  const tools = new Map<string, (...a: unknown[]) => Promise<CallToolResult>>();
  const configs = new Map<string, unknown>();
  return {
    tools,
    configs,
    registerTool(
      name: string,
      config: unknown,
      cb: (...a: unknown[]) => Promise<CallToolResult>,
    ): string {
      tools.set(name, cb);
      configs.set(name, config);
      return name;
    },
  };
}

test('stalenessNotice: no notice when sha and deep hash both match', () => {
  assert.equal(
    stalenessNotice({ sha: 'a1b2c3d', deepHash: 'aaa' }, { sha: 'a1b2c3d', deepHash: 'aaa' }),
    null,
  );
});

test('stalenessNotice: no notice when this process has no loaded stamp', () => {
  // tsx dev / no `pnpm build` in this checkout — nothing to compare against,
  // which is "unknown", not "stale". Same philosophy as assertDeepHashCoherent.
  assert.equal(
    stalenessNotice({ sha: null, deepHash: null }, { sha: 'a1b2c3d', deepHash: 'aaa' }),
    null,
  );
});

test('stalenessNotice: no notice when there is no stamp on disk', () => {
  assert.equal(
    stalenessNotice({ sha: 'a1b2c3d', deepHash: 'aaa' }, { sha: null, deepHash: null }),
    null,
  );
});

test('stalenessNotice: names both shas when the commit moved under a live process', () => {
  const notice = stalenessNotice(
    { sha: 'd4e5f6a', deepHash: 'aaa' },
    { sha: 'a1b2c3d', deepHash: 'bbb' },
  );
  assert.ok(notice, 'expected a notice when the shas differ');
  assert.match(notice, /d4e5f6a/, 'names the sha this process is actually running');
  assert.match(notice, /a1b2c3d/, 'names the sha now on disk');
  assert.match(notice, /\/mcp/, 'tells the caller how to fix it');
});

test('stalenessNotice: fires when only the deep hash moved (rebuild from a dirty tree)', () => {
  // THE case this repo actually hits: `pnpm build` stamps
  // `git rev-parse --short HEAD`, which does not move for uncommitted work.
  // A sha-only comparison would call this fresh and stay silent — which is
  // precisely the silent-stale-code failure the notice exists to end.
  const notice = stalenessNotice(
    { sha: 'a1b2c3d', deepHash: 'aaa' },
    { sha: 'a1b2c3d', deepHash: 'bbb' },
  );
  assert.ok(notice, 'a content change with an unchanged HEAD is still stale');
  assert.match(notice, /uncommitted|rebuilt/i, 'should explain why the sha looks unchanged');
  assert.match(notice, /\/mcp/);
});

test('stalenessNotice: falls back to the sha when either deep hash is absent', () => {
  // Legacy 2-line stamp, or a build with nothing hashable.
  assert.equal(
    stalenessNotice({ sha: 'a1b2c3d', deepHash: null }, { sha: 'a1b2c3d', deepHash: 'bbb' }),
    null,
    'same sha, no deep hash to compare → nothing to assert',
  );
  assert.ok(
    stalenessNotice({ sha: 'd4e5f6a', deepHash: null }, { sha: 'a1b2c3d', deepHash: null }),
    'differing sha still detected without any deep hash',
  );
});

test('appendStalenessNotice: returns the result untouched when fresh', () => {
  const result: CallToolResult = { content: [{ type: 'text', text: '{"ok":true}' }] };
  assert.deepEqual(appendStalenessNotice(result, null), result);
});

test('appendStalenessNotice: appends the notice without disturbing the payload', () => {
  const result: CallToolResult = { content: [{ type: 'text', text: '{"ok":true}' }] };
  const out = appendStalenessNotice(result, 'STALE');

  assert.equal(out.content.length, 2);
  // The real payload must stay FIRST and byte-identical — callers parse
  // content[0] as JSON, so a prepended banner would break every one of them.
  assert.deepEqual(out.content[0], { type: 'text', text: '{"ok":true}' });
  assert.deepEqual(out.content[1], { type: 'text', text: 'STALE' });
});

test('appendStalenessNotice: preserves isError on a failing result', () => {
  const result: CallToolResult = {
    isError: true,
    content: [{ type: 'text', text: 'boom' }],
  };
  const out = appendStalenessNotice(result, 'STALE');

  assert.equal(out.isError, true);
  assert.equal(out.content.length, 2);
});

test('appendStalenessNotice: does not mutate the caller-supplied result', () => {
  const result: CallToolResult = { content: [{ type: 'text', text: '{"ok":true}' }] };
  appendStalenessNotice(result, 'STALE');
  assert.equal(result.content.length, 1, 'input result must not gain a block');
});

test('wrapRegistrarWithStalenessNotice: passes name and config through untouched', () => {
  const reg = fakeRegistrar();
  wrapRegistrarWithStalenessNotice(reg, () => null);

  const config = { description: 'd', inputSchema: {} };
  reg.registerTool('run', config, async () => ({ content: [{ type: 'text', text: 'ok' }] }));

  assert.equal(reg.configs.get('run'), config, 'config must reach the real registrar by identity');
  assert.ok(reg.tools.has('run'));
});

test('wrapRegistrarWithStalenessNotice: leaves results alone while fresh', async () => {
  const reg = fakeRegistrar();
  wrapRegistrarWithStalenessNotice(reg, () => null);
  reg.registerTool('run', {}, async () => ({ content: [{ type: 'text', text: '{"ok":true}' }] }));

  const out = await reg.tools.get('run')?.({});
  assert.equal(out?.content.length, 1);
});

test('wrapRegistrarWithStalenessNotice: appends the notice when stale', async () => {
  const reg = fakeRegistrar();
  wrapRegistrarWithStalenessNotice(reg, () => 'STALE');
  reg.registerTool('run', {}, async () => ({ content: [{ type: 'text', text: '{"ok":true}' }] }));

  const out = await reg.tools.get('run')?.({});
  assert.equal(out?.content.length, 2);
  assert.deepEqual(out?.content[0], { type: 'text', text: '{"ok":true}' });
  assert.deepEqual(out?.content[1], { type: 'text', text: 'STALE' });
});

test('wrapRegistrarWithStalenessNotice: evaluates staleness per CALL, not at registration', async () => {
  // The whole point: a process registers its tools while fresh and goes stale
  // hours later, mid-session. Reading the stamp once at registration would
  // mean the warning could never fire for the sessions that need it most.
  const reg = fakeRegistrar();
  let notice: string | null = null;
  wrapRegistrarWithStalenessNotice(reg, () => notice);
  reg.registerTool('run', {}, async () => ({ content: [{ type: 'text', text: 'ok' }] }));

  const before = await reg.tools.get('run')?.({});
  assert.equal(before?.content.length, 1, 'fresh at first call');

  notice = 'STALE'; // a build lands mid-session

  const after = await reg.tools.get('run')?.({});
  assert.equal(after?.content.length, 2, 'must notice the build that landed after registration');
});

test('wrapRegistrarWithStalenessNotice: forwards call arguments to the wrapped callback', async () => {
  const reg = fakeRegistrar();
  wrapRegistrarWithStalenessNotice(reg, () => null);
  let seen: unknown[] = [];
  reg.registerTool('run', {}, async (...args: unknown[]) => {
    seen = args;
    return { content: [{ type: 'text', text: 'ok' }] };
  });

  await reg.tools.get('run')?.({ type: 'integration', name: 'whoop' }, { signal: 'x' });
  assert.deepEqual(seen[0], { type: 'integration', name: 'whoop' });
  assert.equal(seen.length, 2, 'every argument must reach the tool, not just the first');
});

test('wrapRegistrarWithStalenessNotice: a thrown tool error is not masked by the wrapper', async () => {
  const reg = fakeRegistrar();
  wrapRegistrarWithStalenessNotice(reg, () => 'STALE');
  reg.registerTool('run', {}, async () => {
    throw new Error('boom');
  });

  await assert.rejects(() => reg.tools.get('run')?.({}) as Promise<CallToolResult>, /boom/);
});
