import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseArgv,
  readPassMarkers,
  writePassMarker,
  clearPassMarkers,
  detectFirstRun,
  computeSentinelCap,
  validateAgainstCap,
  runDensifyWiki,
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
    mkdirSync(join(ws, 'user-data/runtime/state/densify-wiki'), { recursive: true });
    writeFileSync(join(ws, 'user-data/runtime/state/densify-wiki/2026-04-15.md'), '# old run');
    assert.equal(detectFirstRun(ws), false);
  } finally {
    rmSync(ws, { recursive: true });
  }
});

test('detectFirstRun ignores non-report files in the directory', () => {
  const ws = mkdtempSync(join(tmpdir(), 'orch-test-'));
  try {
    mkdirSync(join(ws, 'user-data/runtime/state/densify-wiki'), { recursive: true });
    writeFileSync(join(ws, 'user-data/runtime/state/densify-wiki/.pass-1-done'), '');
    writeFileSync(join(ws, 'user-data/runtime/state/densify-wiki/notes.txt'), '');
    assert.equal(detectFirstRun(ws), true, 'first-run should still be true (no YYYY-MM-DD.md report)');
  } finally {
    rmSync(ws, { recursive: true });
  }
});

test('computeSentinelCap returns 250 on first run, 50 ongoing', () => {
  const ws = mkdtempSync(join(tmpdir(), 'cap-test-'));
  try {
    assert.equal(computeSentinelCap(ws), 250);
    mkdirSync(join(ws, 'user-data/runtime/state/densify-wiki'), { recursive: true });
    writeFileSync(join(ws, 'user-data/runtime/state/densify-wiki/2026-04-15.md'), '# old');
    assert.equal(computeSentinelCap(ws), 50);
  } finally {
    rmSync(ws, { recursive: true });
  }
});

test('validateAgainstCap throws when estimate exceeds cap', () => {
  assert.throws(
    () => validateAgainstCap(300, 250),
    /too many changes/i,
  );
  assert.doesNotThrow(() => validateAgainstCap(100, 250));
});

test('validateAgainstCap accepts equal-to-cap', () => {
  assert.doesNotThrow(() => validateAgainstCap(250, 250));
});

test('runDensifyWiki end-to-end on minimal workspace produces report (dry-run)', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'e2e-test-'));
  try {
    // Build a minimal workspace structure.
    mkdirSync(join(ws, 'user-data/memory/profile/people'), { recursive: true });
    mkdirSync(join(ws, 'user-data/memory/knowledge/finance'), { recursive: true });
    mkdirSync(join(ws, 'backup'), { recursive: true });
    writeFileSync(join(ws, 'user-data/memory/INDEX.md'), '# INDEX\n');
    writeFileSync(join(ws, 'user-data/memory/profile/people/jake-lee.md'),
      `---\ntype: topic\naliases: ["Jake"]\n---\n# Jake Lee\nMet Mom and Dad at home.`);
    writeFileSync(join(ws, 'user-data/memory/profile/people/mom.md'),
      `---\ntype: entity\naliases: ["Mom"]\n---\n# Mom\n`);
    writeFileSync(join(ws, 'user-data/memory/profile/people/dad.md'),
      `---\ntype: entity\naliases: ["Dad"]\n---\n# Dad\n`);
    writeFileSync(join(ws, 'user-data/memory/knowledge/finance/snapshot.md'),
      `---\ntype: snapshot\n---\n# Snapshot\nBeneficiary: Jake. Mom and Dad share.`);

    // Use mode: 'dry-run' so the test doesn't try to run npm run backup.
    const result = await runDensifyWiki({ workspaceDir: ws, mode: 'dry-run', skipBackup: true });
    assert.equal(result.exitCode, 0);
    assert.ok(result.summaryPath, 'should return summary.json path');
    assert.ok(result.reportPath, 'should return markdown report path');

    const summary = JSON.parse(readFileSync(result.summaryPath, 'utf-8'));
    assert.equal(summary.mode, 'dry-run');
    assert.equal(summary.exit_code, 0);
  } finally {
    rmSync(ws, { recursive: true });
  }
});

test('runDensifyWiki captures errors from a failing pass and still writes a report', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'e2e-err-'));
  try {
    // Empty memory dir — passes should run but find nothing. Should NOT crash.
    mkdirSync(join(ws, 'user-data/memory'), { recursive: true });
    mkdirSync(join(ws, 'backup'), { recursive: true });
    const result = await runDensifyWiki({ workspaceDir: ws, mode: 'dry-run', skipBackup: true });
    // Even with an empty memory dir, should still produce a report (no crash).
    assert.ok(result.summaryPath);
    assert.equal(result.exitCode, 0);
  } finally {
    rmSync(ws, { recursive: true });
  }
});
