import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeSessionBlock } from '../../scripts/capture/lib/handoff.js';

function setup(initialContent) {
  const dir = mkdtempSync(join(tmpdir(), 'handoff-'));
  const file = join(dir, 'session-handoff.md');
  writeFileSync(file, initialContent);
  return { dir, file };
}

test('writeSessionBlock: creates new block when file has no matching session', () => {
  const { file } = setup(`---
description: Session Handoff
---

# Session Handoff

<!-- APPEND-ONLY below -->
`);
  const result = writeSessionBlock(file, 'claude-code-20260430-2025', 'ended: 2026-04-30T20:55:00Z (auto)\ninbox additions: 8');
  const out = readFileSync(file, 'utf8');
  assert.equal(result.action, 'created');
  assert.match(out, /## Session — claude-code-20260430-2025\n/);
  assert.match(out, /ended: 2026-04-30T20:55:00Z \(auto\)/);
  assert.match(out, /inbox additions: 8/);
});

test('writeSessionBlock: replaces existing block with same session-id', () => {
  const { file } = setup(`---
description: Session Handoff
---

# Session Handoff

## Session — claude-code-20260430-2025
ended: 2026-04-30T20:00:00Z (auto)
inbox additions: 3
`);
  const result = writeSessionBlock(file, 'claude-code-20260430-2025', 'ended: 2026-04-30T21:00:00Z (auto)\ninbox additions: 9');
  const out = readFileSync(file, 'utf8');
  assert.equal(result.action, 'replaced');
  assert.match(out, /inbox additions: 9/);
  assert.doesNotMatch(out, /inbox additions: 3/);
  // Header appears exactly once
  const matches = out.match(/## Session — claude-code-20260430-2025/g);
  assert.equal(matches.length, 1);
});

test('writeSessionBlock: trims to maxBlocks keeping freshest at top', () => {
  const { file } = setup(`---
description: Hot Cache
---

# Hot

## Session — old1
old block 1

## Session — old2
old block 2

## Session — old3
old block 3
`);
  const result = writeSessionBlock(file, 'new-session', 'fresh data', { maxBlocks: 3, position: 'top' });
  const out = readFileSync(file, 'utf8');
  assert.equal(result.action, 'created');
  assert.match(out, /## Session — new-session/);
  assert.match(out, /## Session — old1/);
  assert.match(out, /## Session — old2/);
  assert.doesNotMatch(out, /## Session — old3/);
});

test('writeSessionBlock: returns noop when rebuilt content matches original', () => {
  const { file } = setup(`---
description: Session Handoff
---

# Session Handoff

## Session — sid
body line
`);
  const r = writeSessionBlock(file, 'sid', 'body line');
  // Call a SECOND time and assert noop
  const r2 = writeSessionBlock(file, 'sid', 'body line');
  assert.equal(r2.changed, false);
  assert.equal(r2.action, 'noop');
});

test("writeSessionBlock: position='bottom' appends and trims oldest from front", () => {
  const { file } = setup(`---
description: Bottom Append
---

# Bottom

## Session — old1
old block 1

## Session — old2
old block 2

## Session — old3
old block 3
`);
  const result = writeSessionBlock(file, 'newest', 'fresh data', { maxBlocks: 3, position: 'bottom' });
  const out = readFileSync(file, 'utf8');
  assert.equal(result.action, 'created');
  // newest goes at the end; oldest (old1) is dropped
  assert.match(out, /## Session — newest/);
  assert.match(out, /## Session — old2/);
  assert.match(out, /## Session — old3/);
  assert.doesNotMatch(out, /## Session — old1/);
  // newest is at the bottom — appears AFTER old3 in the file
  assert.ok(out.indexOf('## Session — newest') > out.indexOf('## Session — old3'));
});

test('writeSessionBlock: throws when sessionId contains a newline', () => {
  const { file } = setup(`# F\n`);
  assert.throws(
    () => writeSessionBlock(file, 'bad\nid', 'body'),
    /sessionId must be a non-empty string with no newlines/,
  );
});

test('writeSessionBlock: throws when blockBody contains a session header line', () => {
  const { file } = setup(`# F\n`);
  assert.throws(
    () => writeSessionBlock(file, 'sid', 'ok line\n## Session — sneaky\nmore'),
    /blockBody must not contain/,
  );
});
