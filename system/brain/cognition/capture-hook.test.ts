import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkHookTranscript } from './capture.ts';

function fakeHome() {
  const home = mkdtempSync(join(tmpdir(), 'robin-hook-home-'));
  const proj = join(home, '.claude', 'projects', 'p');
  mkdirSync(proj, { recursive: true });
  return { home, proj };
}

test('checkHookTranscript: accepts a transcript inside ~/.claude/projects', () => {
  const { home, proj } = fakeHome();
  writeFileSync(join(proj, 's.jsonl'), '{}\n');
  assert.deepEqual(checkHookTranscript(join(proj, 's.jsonl'), home), { ok: true });
});

test('checkHookTranscript: refuses paths outside projects, symlinks out, and non-jsonl', () => {
  const { home, proj } = fakeHome();
  const outside = mkdtempSync(join(tmpdir(), 'robin-hook-out-'));
  writeFileSync(join(outside, 'secret.jsonl'), '{}\n');
  symlinkSync(join(outside, 'secret.jsonl'), join(proj, 'link.jsonl'));
  writeFileSync(join(proj, 'notes.txt'), 'x');
  for (const p of [
    join(outside, 'secret.jsonl'),
    join(proj, 'link.jsonl'),
    join(proj, 'notes.txt'),
  ]) {
    const r = checkHookTranscript(p, home);
    assert.equal(r.ok, false, p);
  }
  assert.deepEqual(checkHookTranscript(join(proj, 'missing.jsonl'), home), {
    ok: false,
    reason: 'transcript_unreadable',
  });
});
