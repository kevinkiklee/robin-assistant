import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type ClipboardIO, hashText, takeFreshCopy, waitForFreshCopy } from './clipboard.js';

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

test('takeFreshCopy: strips one trailing newline only', () => {
  const r = takeFreshCopy(fake([`${KEY}\n`]), hashText('old'), SHAPE);
  assert.deepEqual(r, { ok: true, value: KEY });
  const two = takeFreshCopy(fake([`${KEY}\n\n`]), hashText('old'), SHAPE);
  assert.equal(two.ok, false);
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
