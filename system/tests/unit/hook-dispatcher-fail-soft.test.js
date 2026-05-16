import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

function runDispatcher(phase, { debug = false, seedBadConfig = false } = {}) {
  // To reliably trigger the dispatcher's fail-soft envelope we point
  // ROBIN_HOME at a tmpdir whose config/config.json is malformed JSON.
  // readConfig throws `malformed <path>: ...`, hits the dispatcher's
  // try/catch, and (when ROBIN_DEBUG=1) emits `[hook:<phase>] ...` to
  // stderr. Previously this test deleted ROBIN_HOME and assumed no pointer
  // would resolve — fragile, since the package's own .robin-home or the
  // OS-native install.json can exist on a developer machine and silently
  // resolve to a real Robin install. Also previously assumed readConfig
  // throws on missing-config; it does not (returns null) so the seed is
  // needed to actually exercise the error path.
  const cwd = mkdtempSync(join(tmpdir(), `robin-test-dispatch-${process.pid}-`));
  try {
    if (seedBadConfig) {
      mkdirSync(join(cwd, 'config'), { recursive: true });
      writeFileSync(join(cwd, 'config', 'config.json'), '{this is not json');
    }
    const env = { ...process.env };
    env.ROBIN_HOME = cwd;
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

test('runHook exits 0 even when config triggers a readConfig throw', () => {
  // Malformed config.json under ROBIN_HOME makes readConfig throw. The
  // dispatcher must swallow it; the host hook line must see exit 0 and no
  // stderr noise without ROBIN_DEBUG.
  const r = runDispatcher('intuition', { seedBadConfig: true });
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}: stderr=${r.stderr}`);
  assert.equal(r.stderr.trim(), '', 'no stderr without ROBIN_DEBUG');
});

test('runHook surfaces the error to stderr when ROBIN_DEBUG=1', () => {
  const r = runDispatcher('intuition', { debug: true, seedBadConfig: true });
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}: stderr=${r.stderr}`);
  assert.match(r.stderr, /\[hook:intuition\]/);
  assert.match(r.stderr, /malformed/);
});

test('runHook exits 0 for an unknown phase (no DISPATCH entry)', () => {
  const r = runDispatcher('totally-unknown-phase');
  assert.equal(r.status, 0);
});
