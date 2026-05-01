import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findTicViolations } from '../scripts/lint-memory.js';

function workspace(handoffContent) {
  const dir = mkdtempSync(join(tmpdir(), 'lint-tics-'));
  mkdirSync(join(dir, 'self-improvement'), { recursive: true });
  writeFileSync(join(dir, 'self-improvement/session-handoff.md'), handoffContent);
  return dir;
}

test('flags trail-offer pattern', () => {
  const dir = workspace(`---
description: handoff
type: topic
---

## Session — claude-code-20260430
Did the thing. Let me know if you'd like me to also schedule a follow-up.
`);
  const issues = findTicViolations(dir);
  assert.equal(issues.length, 1);
  assert.match(issues[0].message, /trail-offer/i);
  assert.equal(issues[0].severity, 'warn');
});

test('flags pre-action narration', () => {
  const dir = workspace(`---
description: handoff
type: topic
---

## Session — x
I'll go ahead and do the thing now.
`);
  const issues = findTicViolations(dir);
  assert.ok(issues.some((i) => /pre-action/i.test(i.message)));
});

test('flags sycophant phrases', () => {
  const dir = workspace(`---
description: handoff
type: topic
---

## Session — y
Great choice on the framework — smart approach.
`);
  const issues = findTicViolations(dir);
  assert.ok(issues.length >= 1);
  assert.ok(issues.every((i) => i.severity === 'warn'));
});

test('flags hedge-confirm', () => {
  const dir = workspace(`---
description: handoff
type: topic
---

## Session — z
Just to confirm, you want me to merge the branch?
`);
  const issues = findTicViolations(dir);
  assert.ok(issues.some((i) => /hedge-confirm/i.test(i.message)));
});

test('flags trivial should-I', () => {
  const dir = workspace(`---
description: handoff
type: topic
---

## Session — a
Should I read the file?
`);
  const issues = findTicViolations(dir);
  assert.ok(issues.some((i) => /should-i/i.test(i.message)));
});

test('clean handoff produces zero issues', () => {
  const dir = workspace(`---
description: handoff
type: topic
---

## Session — clean
Implemented the feature. Tests pass. Committed.
`);
  const issues = findTicViolations(dir);
  assert.equal(issues.length, 0);
});

test('handles missing session-handoff.md gracefully', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lint-tics-empty-'));
  const issues = findTicViolations(dir);
  assert.deepEqual(issues, []);
});
