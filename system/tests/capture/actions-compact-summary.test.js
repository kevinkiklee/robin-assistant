import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parsePolicies,
  buildSummary,
  regenerateCompactSummary,
} from '../../scripts/capture/lib/actions/compact-summary.js';

function tmp() {
  return mkdtempSync(join(tmpdir(), 'compact-'));
}

test('parsePolicies extracts AUTO/ASK/NEVER bullets ignoring comments', () => {
  const body = `
## AUTO
- spotify-queue          # silent: queue songs without confirming
- spotify-skip
- gmail-archive

## ASK
- gmail-reply-to-known-sender   # earned-trust may promote

## NEVER
- gmail-send-new-thread
- shell-rm-recursive
`;
  const p = parsePolicies(body);
  assert.deepEqual(p.auto, ['spotify-queue', 'spotify-skip', 'gmail-archive']);
  assert.deepEqual(p.ask, ['gmail-reply-to-known-sender']);
  assert.deepEqual(p.never, ['gmail-send-new-thread', 'shell-rm-recursive']);
});

test('buildSummary emits AUTO and NEVER lines (ASK is implicit default, omitted)', () => {
  const out = buildSummary({
    auto: ['a', 'b'],
    ask: ['x'],
    never: ['z'],
  });
  assert.match(out, /AUTO: a, b/);
  assert.match(out, /NEVER: z/);
  assert.doesNotMatch(out, /ASK:/);
});

test('buildSummary handles empty AUTO or NEVER gracefully', () => {
  assert.match(buildSummary({ auto: [], ask: [], never: ['z'] }), /AUTO: \(none\)/);
  assert.match(buildSummary({ auto: ['a'], ask: [], never: [] }), /NEVER: \(none\)/);
});

test('regenerateCompactSummary inserts block when missing', async () => {
  const dir = tmp();
  const file = join(dir, 'policies.md');
  writeFileSync(
    file,
    `---
description: Policies
type: reference
---

# Policies

## AUTO
- spotify-queue

## NEVER
- shell-rm-recursive
`,
  );
  await regenerateCompactSummary(file);
  const out = readFileSync(file, 'utf8');
  assert.match(out, /<!-- BEGIN compact-summary[^>]*-->/);
  assert.match(out, /AUTO: spotify-queue/);
  assert.match(out, /NEVER: shell-rm-recursive/);
  assert.match(out, /<!-- END compact-summary -->/);
  // Block sits between frontmatter and first heading.
  assert.match(out, /---\n\n<!-- BEGIN compact-summary/);
});

test('regenerateCompactSummary replaces existing block in place', async () => {
  const dir = tmp();
  const file = join(dir, 'policies.md');
  writeFileSync(
    file,
    `---
description: Policies
type: reference
---

<!-- BEGIN compact-summary (Dream-maintained — DO NOT EDIT BY HAND) -->
AUTO: stale-class
NEVER: another-stale
<!-- END compact-summary -->

# Policies

## AUTO
- spotify-queue
- gmail-archive

## NEVER
- shell-rm-recursive
`,
  );
  await regenerateCompactSummary(file);
  const out = readFileSync(file, 'utf8');
  assert.doesNotMatch(out, /stale-class/);
  assert.match(out, /AUTO: spotify-queue, gmail-archive/);
  // Exactly one block present.
  const begins = out.match(/<!-- BEGIN compact-summary/g) ?? [];
  assert.equal(begins.length, 1);
});

test('regenerateCompactSummary is idempotent', async () => {
  const dir = tmp();
  const file = join(dir, 'policies.md');
  writeFileSync(
    file,
    `---
description: Policies
type: reference
---

# Policies

## AUTO
- spotify-queue

## NEVER
- shell-rm-recursive
`,
  );
  await regenerateCompactSummary(file);
  const first = readFileSync(file, 'utf8');
  await regenerateCompactSummary(file);
  const second = readFileSync(file, 'utf8');
  assert.equal(second, first);
});
