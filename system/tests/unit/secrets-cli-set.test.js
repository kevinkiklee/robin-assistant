import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
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

async function loadSet() {
  const mod = await import(`../../runtime/cli/commands/secrets-set.js?cb=${Date.now()}`);
  return mod.secretsSet;
}

function captureExit() {
  const calls = { exit: 0, errors: [], warns: [], logs: [] };
  const origExit = process.exit;
  const origError = console.error;
  const origWarn = console.warn;
  const origLog = console.log;
  process.exit = (code) => {
    calls.exit = code ?? 0;
    throw new Error(`__exit__${calls.exit}`);
  };
  console.error = (s) => calls.errors.push(String(s));
  console.warn = (s) => calls.warns.push(String(s));
  console.log = (s) => calls.logs.push(String(s));
  return {
    calls,
    restore: () => {
      process.exit = origExit;
      console.error = origError;
      console.warn = origWarn;
      console.log = origLog;
    },
  };
}

function envFile() {
  return join(process.env.ROBIN_HOME, 'config', 'secrets', '.env');
}

test('secrets set <KEY>=<value> saves and warns about shell history', async () => {
  const set = await loadSet();
  const cap = captureExit();
  try {
    await set(['GEMINI_API_KEY=AIzaSyXYZ']);
  } finally {
    cap.restore();
  }
  assert.match(readFileSync(envFile(), 'utf-8'), /^GEMINI_API_KEY=AIzaSyXYZ$/m);
  assert.ok(cap.calls.warns.some((w) => /shell history/.test(w)));
  assert.ok(cap.calls.logs.some((l) => /saved GEMINI_API_KEY/.test(l)));
});

test('secrets set <KEY> <value> (two args) saves and warns — does not silently drop value', async () => {
  const set = await loadSet();
  const cap = captureExit();
  try {
    await set(['GEMINI_API_KEY', 'AIzaSyXYZ']);
  } finally {
    cap.restore();
  }
  assert.match(readFileSync(envFile(), 'utf-8'), /^GEMINI_API_KEY=AIzaSyXYZ$/m);
  assert.ok(cap.calls.warns.some((w) => /shell history/.test(w)));
  assert.ok(cap.calls.logs.some((l) => /saved GEMINI_API_KEY/.test(l)));
});

test('secrets set with no args exits with usage', async () => {
  const set = await loadSet();
  const cap = captureExit();
  let threw = null;
  try {
    await set([]);
  } catch (e) {
    threw = e;
  } finally {
    cap.restore();
  }
  assert.match(threw?.message ?? '', /__exit__1/);
  assert.ok(cap.calls.errors.some((e) => /usage: robin secrets set/.test(e)));
});

test('secrets set with >2 args exits with usage', async () => {
  const set = await loadSet();
  const cap = captureExit();
  let threw = null;
  try {
    await set(['KEY', 'value', 'extra']);
  } catch (e) {
    threw = e;
  } finally {
    cap.restore();
  }
  assert.match(threw?.message ?? '', /__exit__1/);
  assert.ok(cap.calls.errors.some((e) => /usage: robin secrets set/.test(e)));
});

test('secrets set rejects shell-invalid key before prompting (one-arg, no `=`)', async () => {
  // Simulates `robin secrets set AIzaSy-xyz` — user forgot the env var name.
  // Must throw on key shape, not silently sit waiting for hidden value input.
  const origIsTTY = process.stdin.isTTY;
  // Force isTTY so the bailout for "no TTY" doesn't preempt the key check.
  Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
  const set = await loadSet();
  let threw = null;
  try {
    await set(['AIzaSy-xyz']);
  } catch (e) {
    threw = e;
  } finally {
    Object.defineProperty(process.stdin, 'isTTY', { value: origIsTTY, configurable: true });
  }
  assert.match(threw?.message ?? '', /invalid secret key/);
});
