import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// Regression test: runHook must fail-soft on every path, including the
// kill-switch lookup. isHookDisabled hits readConfig which throws when
// Robin isn't installed. Without the outer try/catch, a stale hook entry
// on an uninstalled Robin would crash the host's hook line with exit !=0.
//
// We invoke dispatcher.js as a subprocess against a fresh ROBIN_HOME that
// has NO config (the "uninstalled" shape) and assert exit 0.

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const dispatcher = resolve(__dirname, '../../io/hooks/dispatcher.js');

function runDispatcher(phase, { debug = false } = {}) {
  // To reproduce the "Robin is not installed" path, we run from a directory
  // that has no `.robin-home` pointer file AND we strip ROBIN_HOME from the
  // child's environment so robinHome()/readConfig() throws.
  const cwd = mkdtempSync(join(tmpdir(), `robin-test-dispatch-${process.pid}-`));
  try {
    const env = { ...process.env };
    delete env.ROBIN_HOME;
    if (debug) env.ROBIN_DEBUG = '1';
    return spawnSync(process.execPath, [dispatcher, phase], {
      cwd,
      env,
      input: '{}',
      encoding: 'utf8',
      timeout: 10000,
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

test('runHook exits 0 even when ROBIN_HOME has no config (uninstalled Robin)', () => {
  // No config.json exists under home, so readConfig throws "Robin is not
  // installed". The dispatcher must swallow this; the host hook line must
  // see exit 0 and no stderr noise.
  const r = runDispatcher('intuition');
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}: stderr=${r.stderr}`);
  assert.equal(r.stderr.trim(), '', 'no stderr without ROBIN_DEBUG');
});

test('runHook surfaces the error to stderr when ROBIN_DEBUG=1', () => {
  const r = runDispatcher('intuition', { debug: true });
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}: stderr=${r.stderr}`);
  assert.match(r.stderr, /\[hook:intuition\]/);
  assert.match(r.stderr, /not installed/);
});

test('runHook exits 0 for an unknown phase (no DISPATCH entry)', () => {
  const r = runDispatcher('totally-unknown-phase');
  assert.equal(r.status, 0);
});
