import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

test('robin doctor: runs against a fresh user-data and reports JSON', () => {
  const userData = mkdtempSync(join(tmpdir(), 'robin-doctor-int-'));
  const out = execFileSync('pnpm', ['robin', 'doctor', '--json'], {
    env: { ...process.env, ROBIN_USER_DATA_DIR: userData },
    encoding: 'utf8',
  });
  // pnpm wraps stdout; find the JSON braces
  const start = out.indexOf('{');
  const end = out.lastIndexOf('}');
  interface DoctorCheck {
    name: string;
    status: 'ok' | 'warn' | 'fail';
  }
  interface DoctorReport {
    robin_version: string;
    checks: DoctorCheck[];
    summary: { fail: number };
  }
  const json = JSON.parse(out.slice(start, end + 1)) as DoctorReport;
  assert.equal(typeof json.robin_version, 'string');
  assert.ok(Array.isArray(json.checks));
  assert.equal(
    json.summary.fail,
    0,
    `unexpected failures: ${JSON.stringify(json.checks.filter((c) => c.status === 'fail'))}`,
  );
});
