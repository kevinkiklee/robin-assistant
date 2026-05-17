import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import {
  escapeApplescript,
  sendDm,
  sendGroup,
} from '../../io/integrations/imessage/sender.js';

// `sender.js` enforces a 200ms inter-send rate-limit via module-level state +
// real `Date.now() + setTimeout`. Successful-send tests fake the timer so the
// rate-limit branch executes immediately while still being exercised.
function withFakeTimers(fn) {
  return async (t) => {
    // Bump base time forward each call so module state from prior tests
    // doesn't make the new fake clock look "in the past".
    const base = 1_700_000_000_000 + (withFakeTimers.counter++ * 60_000);
    mock.timers.enable({ apis: ['Date', 'setTimeout'], now: base });
    try {
      await fn(t);
    } finally {
      mock.timers.reset();
    }
  };
}
withFakeTimers.counter = 0;

test('escapeApplescript: doubles backslashes and quotes', () => {
  assert.equal(escapeApplescript('hello'), 'hello');
  assert.equal(escapeApplescript('say "hi"'), 'say \\"hi\\"');
  assert.equal(escapeApplescript('back\\slash'), 'back\\\\slash');
  assert.equal(escapeApplescript('mix\\and "match"'), 'mix\\\\and \\"match\\"');
});

test('escapeApplescript: coerces non-string input', () => {
  assert.equal(escapeApplescript(42), '42');
  assert.equal(escapeApplescript(null), 'null');
});

test('escapeApplescript: leaves newlines and other chars alone', () => {
  // AppleScript heredoc-style strings accept newlines; we only escape \ and "
  assert.equal(escapeApplescript("it's\nmulti"), "it's\nmulti");
});

test('sendDm: non-darwin platform refuses cleanly', async () => {
  const r = await sendDm({
    handle: 'a@b.com',
    message: 'hi',
    runCommand: async () => { throw new Error('should not be invoked'); },
    platform: 'linux',
  });
  assert.deepEqual(r, { ok: false, reason: 'non-macos' });
});

test('sendDm: missing handle throws', async () => {
  await assert.rejects(
    () => sendDm({ message: 'hi', platform: 'darwin', runCommand: async () => ({}) }),
    /handle required/,
  );
});

test('sendDm: missing message throws', async () => {
  await assert.rejects(
    () => sendDm({ handle: 'a', platform: 'darwin', runCommand: async () => ({}) }),
    /message required/,
  );
});

test('sendDm: runs osascript and escapes handle + message', withFakeTimers(async () => {
  let lastCmd, lastArgs;
  const runCommand = async (cmd, args) => {
    lastCmd = cmd;
    lastArgs = args;
    return { stdout: '', stderr: '' };
  };
  const r = await sendDm({
    handle: 'a"b@example.com',
    message: 'say "hi"',
    platform: 'darwin',
    runCommand,
  });
  assert.equal(r.ok, true);
  assert.equal(r.target.kind, 'dm');
  assert.equal(r.target.handle, 'a"b@example.com');
  assert.equal(lastCmd, 'osascript');
  // -e flag plus a script body
  assert.equal(lastArgs[0], '-e');
  const script = lastArgs[1];
  assert.match(script, /tell application "Messages"/);
  // Escaped values appear inside the script
  assert.ok(script.includes('a\\"b@example.com'), 'handle escaped');
  assert.ok(script.includes('say \\"hi\\"'), 'message escaped');
}));

test('sendDm: maps runCommand failure to osascript_failed result', withFakeTimers(async () => {
  const r = await sendDm({
    handle: 'a',
    message: 'x',
    platform: 'darwin',
    runCommand: async () => { throw new Error('boom'); },
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'osascript_failed');
  assert.match(r.error, /boom/);
}));

test('sendGroup: non-darwin refuses', async () => {
  const r = await sendGroup({
    chatGuid: 'iMessage;+;chat123',
    message: 'hi',
    platform: 'win32',
    runCommand: async () => ({}),
  });
  assert.deepEqual(r, { ok: false, reason: 'non-macos' });
});

test('sendGroup: missing chatGuid throws', async () => {
  await assert.rejects(
    () => sendGroup({ message: 'x', platform: 'darwin', runCommand: async () => ({}) }),
    /chatGuid required/,
  );
});

test('sendGroup: missing message throws', async () => {
  await assert.rejects(
    () => sendGroup({ chatGuid: 'g', platform: 'darwin', runCommand: async () => ({}) }),
    /message required/,
  );
});

test('sendGroup: invokes chat id form with escaped guid + message', withFakeTimers(async () => {
  let scriptCalled = null;
  const runCommand = async (cmd, args) => {
    scriptCalled = args[1];
    return { stdout: '', stderr: '' };
  };
  const r = await sendGroup({
    chatGuid: 'iMessage;+;chat"123',
    message: 'hello\\world',
    platform: 'darwin',
    runCommand,
  });
  assert.equal(r.ok, true);
  assert.equal(r.target.kind, 'group');
  assert.equal(r.target.chat_guid, 'iMessage;+;chat"123');
  assert.match(scriptCalled, /set targetChat to chat id "iMessage;\+;chat\\"123"/);
  assert.ok(scriptCalled.includes('hello\\\\world'));
}));

test('sendGroup: maps runCommand failure to osascript_failed', withFakeTimers(async () => {
  const r = await sendGroup({
    chatGuid: 'g',
    message: 'x',
    platform: 'darwin',
    runCommand: async () => { throw new Error('osascript exited 1'); },
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'osascript_failed');
  assert.match(r.error, /osascript exited 1/);
}));
