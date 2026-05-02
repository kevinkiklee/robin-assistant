import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseArgv,
  readPassMarkers,
  writePassMarker,
  clearPassMarkers,
  detectFirstRun,
} from '../../../scripts/memory/densify-wiki.js';

test('parseArgv default mode is dry-run', () => {
  assert.deepEqual(parseArgv([]), { mode: 'dry-run' });
  assert.deepEqual(parseArgv(['--dry-run']), { mode: 'dry-run' });
  assert.deepEqual(parseArgv(['--apply']), { mode: 'apply' });
  assert.deepEqual(parseArgv(['--restart']), { mode: 'restart' });
  assert.deepEqual(parseArgv(['--resume']), { mode: 'resume' });
});

test('writePassMarker / readPassMarkers / clearPassMarkers round-trip', () => {
  const ws = mkdtempSync(join(tmpdir(), 'orch-test-'));
  try {
    writePassMarker(ws, 1, 'done');
    writePassMarker(ws, 3, 'failed');
    const markers = readPassMarkers(ws);
    assert.deepEqual(markers, { 1: 'done', 3: 'failed' });
    clearPassMarkers(ws);
    assert.deepEqual(readPassMarkers(ws), {});
  } finally {
    rmSync(ws, { recursive: true });
  }
});

test('readPassMarkers returns empty object when no markers exist', () => {
  const ws = mkdtempSync(join(tmpdir(), 'orch-test-'));
  try {
    assert.deepEqual(readPassMarkers(ws), {});
  } finally {
    rmSync(ws, { recursive: true });
  }
});

test('detectFirstRun is true when no dated reports exist', () => {
  const ws = mkdtempSync(join(tmpdir(), 'orch-test-'));
  try {
    assert.equal(detectFirstRun(ws), true);
    mkdirSync(join(ws, 'user-data/ops/state/densify-wiki'), { recursive: true });
    writeFileSync(join(ws, 'user-data/ops/state/densify-wiki/2026-04-15.md'), '# old run');
    assert.equal(detectFirstRun(ws), false);
  } finally {
    rmSync(ws, { recursive: true });
  }
});

test('detectFirstRun ignores non-report files in the directory', () => {
  const ws = mkdtempSync(join(tmpdir(), 'orch-test-'));
  try {
    mkdirSync(join(ws, 'user-data/ops/state/densify-wiki'), { recursive: true });
    writeFileSync(join(ws, 'user-data/ops/state/densify-wiki/.pass-1-done'), '');
    writeFileSync(join(ws, 'user-data/ops/state/densify-wiki/notes.txt'), '');
    assert.equal(detectFirstRun(ws), true, 'first-run should still be true (no YYYY-MM-DD.md report)');
  } finally {
    rmSync(ws, { recursive: true });
  }
});
