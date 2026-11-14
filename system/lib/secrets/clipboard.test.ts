import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type ClipboardIO,
  hashText,
  macClipboardWith,
  takeFreshCopy,
  waitForFreshCopy,
} from './clipboard.js';

const SHAPE = /^\S{16,}$/;
const KEY = 'spk_test_abcdefghijklmnop';

function fake(reads: string[]): ClipboardIO & { notes: Array<[string, string]>; cleared: number } {
  let i = 0;
  const f = {
    notes: [] as Array<[string, string]>,
    cleared: 0,
    read: () => reads[Math.min(i++, reads.length - 1)] ?? '',
    clear: () => {
      f.cleared++;
    },
    notify: (t: string, b: string) => {
      f.notes.push([t, b]);
    },
  };
  return f;
}

test('takeFreshCopy: unchanged since arm → refuse', () => {
  const io = fake([KEY]);
  const r = takeFreshCopy(io, hashText(KEY), SHAPE);
  assert.deepEqual(r, { ok: false, reason: 'unchanged' });
});

test('takeFreshCopy: empty clipboard → reason empty', () => {
  const r = takeFreshCopy(fake(['']), hashText('x'), SHAPE);
  assert.deepEqual(r, { ok: false, reason: 'empty' });
});

test('takeFreshCopy: fails shape → reason shape', () => {
  const r = takeFreshCopy(fake(['has a space in it here']), hashText('old'), SHAPE);
  assert.deepEqual(r, { ok: false, reason: 'shape' });
});

test('takeFreshCopy: drops surrounding whitespace from a manual selection', () => {
  assert.deepEqual(takeFreshCopy(fake([`${KEY}\n`]), hashText('old'), SHAPE), {
    ok: true,
    value: KEY,
  });
  assert.deepEqual(takeFreshCopy(fake([`  ${KEY}\n\n`]), hashText('old'), SHAPE), {
    ok: true,
    value: KEY,
  });
});

test('takeFreshCopy: a selected line with one key-shaped word yields that word', () => {
  assert.deepEqual(takeFreshCopy(fake([`Your API key: ${KEY}`]), hashText('old'), SHAPE), {
    ok: true,
    value: KEY,
  });
});

test('takeFreshCopy: two key-shaped words are ambiguous — refused as shape', () => {
  const r = takeFreshCopy(fake([`${KEY} ${KEY}x`]), hashText('old'), SHAPE);
  assert.deepEqual(r, { ok: false, reason: 'shape' });
});

test('waitForFreshCopy: reports shape when a wrong copy arrived and no key ever did', async () => {
  const io = fake(['old', 'not a key at all']);
  const r = await waitForFreshCopy(io, hashText('old'), SHAPE, {
    timeoutMs: 30,
    pollMs: 10,
    sleep: async () => {},
    message: 'm',
  });
  assert.deepEqual(r, { ok: false, reason: 'shape' });
});

test('waitForFreshCopy: resolves when the clipboard changes on the 3rd poll', async () => {
  const io = fake(['old', 'old', KEY]);
  let sleeps = 0;
  const r = await waitForFreshCopy(io, hashText('old'), SHAPE, {
    timeoutMs: 10_000,
    pollMs: 100,
    message: 'copy the key',
    sleep: async () => {
      sleeps++;
    },
  });
  assert.deepEqual(r, { ok: true, value: KEY });
  assert.equal(sleeps, 2);
  assert.deepEqual(io.notes, [['Robin secret', 'copy the key']]);
});

test('waitForFreshCopy: times out', async () => {
  const io = fake(['old']);
  const r = await waitForFreshCopy(io, hashText('old'), SHAPE, {
    timeoutMs: 500,
    pollMs: 100,
    message: 'copy',
    sleep: async () => {},
  });
  assert.deepEqual(r, { ok: false, reason: 'timeout' });
  assert.equal(io.notes.length, 1);
});

test('macClipboard: pbpaste/pbcopy/osascript by absolute path with a fixed env', () => {
  const calls: { file: string; env: unknown }[] = [];
  const io = macClipboardWith((file, _args, opts) => {
    calls.push({ file, env: opts.env });
    return 'x';
  });
  io.read();
  io.clear();
  io.notify('t', 'b');
  assert.deepEqual(
    calls.map((c) => c.file),
    ['/usr/bin/pbpaste', '/usr/bin/pbcopy', '/usr/bin/osascript'],
  );
  for (const c of calls) assert.deepEqual(c.env, { PATH: '/usr/bin:/bin' });
});
