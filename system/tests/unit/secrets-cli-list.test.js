import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

let tmpHome;
test.beforeEach(() => {
  tmpHome = join(tmpdir(), `robin-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpHome, { recursive: true });
  process.env.ROBIN_HOME = tmpHome;
});
test.afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

test('secrets list prints keys, never values', async () => {
  const { saveSecret } = await import(`../../config/secrets.js?cb=${Date.now()}`);
  saveSecret('SECRET_KEY', 'super-secret-value-do-not-print');
  const { secretsList } = await import(
    `../../runtime/cli/commands/secrets-list.js?cb=${Date.now()}`
  );
  const lines = [];
  const orig = console.log;
  console.log = (s) => lines.push(s);
  try {
    await secretsList();
  } finally {
    console.log = orig;
  }
  const all = lines.join('\n');
  assert.match(all, /SECRET_KEY/);
  assert.doesNotMatch(all, /super-secret-value/);
});
