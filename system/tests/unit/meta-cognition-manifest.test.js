import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';

const MANIFEST_PATH = resolve(
  import.meta.dirname,
  '../../cognition/jobs/builtin/meta-recall-narrative.md',
);

test('meta-recall-narrative manifest exists and has expected frontmatter', async () => {
  const text = await readFile(MANIFEST_PATH, 'utf8');
  assert.ok(text.startsWith('---\n'), 'starts with frontmatter delimiter');
  assert.ok(text.match(/name:\s*meta-recall-narrative/));
  assert.ok(text.match(/schedule:\s*"0 5 \* \* 0"/));
  assert.ok(text.match(/runtime:\s*internal/));
  assert.ok(text.match(/enabled:\s*false/));
  assert.ok(text.match(/catch_up:\s*false/));
  assert.ok(text.match(/timeout_minutes:\s*5/));
  assert.ok(text.match(/manually_runnable:\s*true/));
});

test('internal-job orchestrator exports default function', async () => {
  const mod = await import('../../cognition/jobs/internal/meta-recall-narrative.js');
  assert.equal(typeof mod.default, 'function');
});
