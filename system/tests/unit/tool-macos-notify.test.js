import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMacosNotifyTool } from '../../io/mcp/tools/macos-notify.js';

test('macos_notify.name is "macos_notify"', () => {
  const tool = createMacosNotifyTool();
  assert.equal(tool.name, 'macos_notify');
});

test('macos_notify is a no-op on non-darwin hosts', async () => {
  const tool = createMacosNotifyTool({ platform: 'linux' });
  const r = await tool.handler({ title: 'hi' });
  assert.deepEqual(r, { delivered: false, backend: 'noop', reason: 'non-macos' });
});

test('macos_notify prefers terminal-notifier when available', async () => {
  const calls = [];
  const runCommand = async (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === 'command' && args[1] === 'terminal-notifier')
      return { stdout: '/opt/homebrew/bin/terminal-notifier\n', stderr: '' };
    if (cmd === 'terminal-notifier') return { stdout: '', stderr: '' };
    throw new Error(`unexpected cmd: ${cmd}`);
  };
  const tool = createMacosNotifyTool({ platform: 'darwin', runCommand });
  const r = await tool.handler({
    title: 'hi',
    body: 'body',
    sound: 'Tink',
    click_url: 'https://example.com',
  });
  assert.equal(r.delivered, true);
  assert.equal(r.backend, 'terminal-notifier');
  const tnCall = calls.find((c) => c.cmd === 'terminal-notifier');
  assert.ok(tnCall, 'terminal-notifier was invoked');
  assert.deepEqual(tnCall.args, [
    '-title',
    'hi',
    '-message',
    'body',
    '-sound',
    'Tink',
    '-open',
    'https://example.com',
  ]);
});

test('macos_notify falls back to osascript when terminal-notifier missing', async () => {
  const calls = [];
  const runCommand = async (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === 'command' && args[1] === 'terminal-notifier') throw new Error('not found');
    if (cmd === 'osascript') return { stdout: '', stderr: '' };
    throw new Error(`unexpected cmd: ${cmd}`);
  };
  const tool = createMacosNotifyTool({ platform: 'darwin', runCommand });
  const r = await tool.handler({ title: 'hi', body: 'body', subtitle: 'sub' });
  assert.equal(r.delivered, true);
  assert.equal(r.backend, 'osascript');
  const osaCall = calls.find((c) => c.cmd === 'osascript');
  assert.ok(osaCall);
  assert.match(osaCall.args[1], /display notification "body" with title "hi" subtitle "sub"/);
});

test('macos_notify falls back to osascript when terminal-notifier exists but errors', async () => {
  const runCommand = async (cmd, args) => {
    if (cmd === 'command' && args[1] === 'terminal-notifier')
      return { stdout: '/usr/local/bin/terminal-notifier\n', stderr: '' };
    if (cmd === 'terminal-notifier') throw new Error('terminal-notifier crashed');
    if (cmd === 'osascript') return { stdout: '', stderr: '' };
    throw new Error(`unexpected cmd: ${cmd}`);
  };
  const tool = createMacosNotifyTool({ platform: 'darwin', runCommand });
  const r = await tool.handler({ title: 'hi' });
  assert.equal(r.delivered, true);
  assert.equal(r.backend, 'osascript');
});

test('macos_notify reports failure when both backends fail', async () => {
  const runCommand = async () => {
    throw new Error('all broken');
  };
  const tool = createMacosNotifyTool({ platform: 'darwin', runCommand });
  const r = await tool.handler({ title: 'hi' });
  assert.equal(r.delivered, false);
  assert.equal(r.backend, null);
  assert.match(String(r.error), /all broken/);
});

test('macos_notify escapes double-quotes and backslashes in osascript', async () => {
  let captured = null;
  const runCommand = async (cmd, args) => {
    if (cmd === 'command') throw new Error('skip');
    if (cmd === 'osascript') {
      captured = args[1];
      return { stdout: '', stderr: '' };
    }
    throw new Error(`unexpected: ${cmd}`);
  };
  const tool = createMacosNotifyTool({ platform: 'darwin', runCommand });
  await tool.handler({ title: 'has "quotes"', body: 'path\\to\\thing' });
  assert.ok(captured.includes('\\"quotes\\"'));
  assert.ok(captured.includes('path\\\\to\\\\thing'));
});
