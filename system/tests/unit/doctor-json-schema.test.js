// Snapshot test for `robin doctor --health --json` output shape.
//
// Phase A polish (A.4) locks in the CURRENT shape as a stability surface.
// Phase B may redesign — but only with a deliberate snapshot bump in this
// test, not silently.
//
// Spawns the CLI as a subprocess (>300ms on macOS) — gated behind
// ROBIN_SKIP_SLOW so the inner-loop `test:fast` skips it.

import test from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const skip = process.env.ROBIN_SKIP_SLOW === '1';

test('doctor --health --json output has stable top-level shape', { skip }, () => {
  const robin = resolve(process.cwd(), 'system/bin/robin');
  const r = spawnSync('node', [robin, 'doctor', '--health', '--json'], {
    encoding: 'utf8',
    timeout: 30000,
  });
  // exit_code 0 (healthy) or 2 (degraded) — both produce valid JSON.
  assert.ok(
    r.status === 0 || r.status === 2,
    `doctor exited ${r.status}: ${r.stderr ?? ''}`,
  );
  const parsed = JSON.parse(r.stdout);

  // Top-level keys (locked at A.4 baseline).
  assert.ok('exit_code' in parsed, 'exit_code field present');
  assert.ok('ts' in parsed, 'ts field present');
  assert.ok('budget' in parsed, 'budget field present');
  assert.ok('faculties' in parsed, 'faculties field present');
  assert.ok('pending' in parsed, 'pending field present');

  // Types of fundamental fields.
  assert.strictEqual(typeof parsed.exit_code, 'number', 'exit_code is a number');
  assert.strictEqual(typeof parsed.ts, 'string', 'ts is a string');
  assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(parsed.ts), 'ts is ISO-8601');

  // Budget sub-shape.
  if (parsed.budget) {
    assert.strictEqual(typeof parsed.budget.consumed, 'number', 'budget.consumed numeric');
    assert.strictEqual(typeof parsed.budget.daily, 'number', 'budget.daily numeric');
    assert.strictEqual(typeof parsed.budget.status, 'string', 'budget.status string');
  }
});

test('every faculty entry has step + status', { skip }, () => {
  const robin = resolve(process.cwd(), 'system/bin/robin');
  const r = spawnSync('node', [robin, 'doctor', '--health', '--json'], {
    encoding: 'utf8',
    timeout: 30000,
  });
  const parsed = JSON.parse(r.stdout);
  assert.ok(Array.isArray(parsed.faculties), 'faculties is an array');
  for (const f of parsed.faculties) {
    assert.ok(typeof f.step === 'string', `faculty ${JSON.stringify(f)} has step string`);
    assert.ok(
      ['ok', 'warn', 'fail'].includes(f.status),
      `faculty ${f.step} status valid: ${f.status}`,
    );
  }
});
