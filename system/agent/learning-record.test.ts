import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { writeLearningRecord } from './learning-record.ts';

test('writes a per-handler record with outcome fields in frontmatter', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lr-'));
  const path = writeLearningRecord(dir, {
    handler: 'D',
    goal: 'curate',
    status: 'success',
    outcome: 'did-work',
    impact: 'low',
    verified: 'verified',
    turns: 7,
    costUsd: 1.23,
    ts: '2026-06-11T12:00:00.000Z',
  });
  assert.ok(path.endsWith('-D.md'));
  const body = readFileSync(path, 'utf8');
  assert.match(body, /handler: D/);
  assert.match(body, /outcome: did-work/);
  assert.match(body, /verified: verified/);
});

test('branch and outcome fields are optional (handler-A back-compat)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lr-'));
  const path = writeLearningRecord(dir, {
    handler: 'A',
    goal: 'g',
    status: 'success',
    turns: 1,
    costUsd: 0,
    ts: '2026-06-11T12:00:00.000Z',
  });
  assert.match(readFileSync(path, 'utf8'), /handler: A/);
});
