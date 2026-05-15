import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { recordDivergence } from '../../../runtime/invariants/divergence-log.js';
import { withTempStateFile } from '../../helpers/invariant-fixtures.js';

test('recordDivergence appends JSON lines', () =>
  withTempStateFile(async ({ dir }) => {
    const path = join(dir, 'divergence_log.json');
    recordDivergence(path, { invariant: 'a', legacy: 'ok', framework: 'fail' });
    recordDivergence(path, { invariant: 'b', legacy: 'fail', framework: 'ok' });
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);
    const first = JSON.parse(lines[0]);
    assert.equal(first.invariant, 'a');
    assert.ok(first.ts);
  }));

test('recordDivergence creates parent directory', () =>
  withTempStateFile(async ({ dir }) => {
    const path = join(dir, 'nested', 'sub', 'divergence_log.json');
    recordDivergence(path, { invariant: 'x' });
    assert.ok(existsSync(path));
  }));

test('recordDivergence rotates when file exceeds 1MB', () =>
  withTempStateFile(async ({ dir }) => {
    const path = join(dir, 'divergence_log.json');
    // Seed a large file
    const big = 'x'.repeat(1024 * 1024 + 100);
    writeFileSync(path, big);
    recordDivergence(path, { invariant: 'rot' });
    const remaining = readFileSync(path, 'utf8').trim().split('\n');
    // After rotation the file should be just the one new line
    assert.equal(remaining.length, 1);
    assert.ok(JSON.parse(remaining[0]).invariant === 'rot');
  }));
