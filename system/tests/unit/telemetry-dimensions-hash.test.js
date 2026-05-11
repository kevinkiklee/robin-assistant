// Unit tests for dimensionsHash — determinism and collision behavior.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dimensionsHash } from '../../cognition/telemetry/dimensions-hash.js';

const HOUR = new Date('2026-05-11T14:00:00Z');

test('dimensionsHash is deterministic across key insertion order', () => {
  const a = dimensionsHash('intuition', 'recall', HOUR, {
    source: 'intuition',
    mmr_path: 'cosine',
  });
  const b = dimensionsHash('intuition', 'recall', HOUR, {
    mmr_path: 'cosine',
    source: 'intuition',
  });
  assert.equal(a, b);
});

test('dimensionsHash distinguishes different faculties', () => {
  const a = dimensionsHash('intuition', 'recall', HOUR, { source: 'intuition' });
  const b = dimensionsHash('reinforcement', 'recall', HOUR, { source: 'intuition' });
  assert.notEqual(a, b);
});

test('dimensionsHash distinguishes different event_kinds', () => {
  const a = dimensionsHash('intuition', 'recall', HOUR, { source: 'intuition' });
  const b = dimensionsHash('intuition', 'recall_attribution', HOUR, { source: 'intuition' });
  assert.notEqual(a, b);
});

test('dimensionsHash distinguishes different hours', () => {
  const a = dimensionsHash('intuition', 'recall', HOUR, {});
  const b = dimensionsHash('intuition', 'recall', new Date(HOUR.getTime() + 3_600_000), {});
  assert.notEqual(a, b);
});

test('dimensionsHash is 24 hex chars', () => {
  const h = dimensionsHash('intuition', 'recall', HOUR, { source: 'intuition' });
  assert.match(h, /^[0-9a-f]{24}$/);
});

test('dimensionsHash treats empty and missing dimensions identically', () => {
  const a = dimensionsHash('intuition', 'recall', HOUR, {});
  const b = dimensionsHash('intuition', 'recall', HOUR, undefined);
  const c = dimensionsHash('intuition', 'recall', HOUR, null);
  assert.equal(a, b);
  assert.equal(a, c);
});

test('dimensionsHash differs when a dimension value differs', () => {
  const a = dimensionsHash('intuition', 'recall', HOUR, { source: 'intuition' });
  const b = dimensionsHash('intuition', 'recall', HOUR, { source: 'mcp_recall' });
  assert.notEqual(a, b);
});

test('dimensionsHash differs when a dimension key differs', () => {
  const a = dimensionsHash('intuition', 'recall', HOUR, { source: 'intuition' });
  const b = dimensionsHash('intuition', 'recall', HOUR, { src: 'intuition' });
  assert.notEqual(a, b);
});
