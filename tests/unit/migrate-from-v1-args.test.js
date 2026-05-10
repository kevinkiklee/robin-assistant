import assert from 'node:assert';
import { test } from 'node:test';
import { parseArgs } from '../../src/cli/commands/migrate-from-v1.js';

test('parseArgs --source + --dry-run', () => {
  const a = parseArgs(['--source', '/path/to/v1', '--dry-run']);
  assert.equal(a.source, '/path/to/v1');
  assert.equal(a.dryRun, true);
  assert.equal(a.mode, 'migrate');
});

test('parseArgs --source=path inline form', () => {
  const a = parseArgs(['--source=/inline/path']);
  assert.equal(a.source, '/inline/path');
});

test('parseArgs --status routes to mode=status', () => {
  const a = parseArgs(['--status']);
  assert.equal(a.mode, 'status');
});

test('parseArgs --show-failures --phase entity', () => {
  const a = parseArgs(['--show-failures', '--phase', 'entity']);
  assert.equal(a.mode, 'show-failures');
  assert.equal(a.phase, 'entity');
});

test('parseArgs --reset --phase entity --dry-run', () => {
  const a = parseArgs(['--reset', '--phase', 'entity', '--dry-run']);
  assert.equal(a.mode, 'reset');
  assert.equal(a.phase, 'entity');
  assert.equal(a.dryRun, true);
});

test('parseArgs --export-mappings <path>', () => {
  const a = parseArgs(['--export-mappings', '/tmp/mappings.json']);
  assert.equal(a.mode, 'export-mappings');
  assert.equal(a.exportPath, '/tmp/mappings.json');
});

test('parseArgs --phase as a single-phase migrate flag', () => {
  const a = parseArgs(['--source', '/p', '--phase', 'entity']);
  assert.equal(a.mode, 'migrate');
  assert.equal(a.phase, 'entity');
});
