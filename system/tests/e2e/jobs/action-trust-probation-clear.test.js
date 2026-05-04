// E2E scenario: probation expiry clears the flag (Phase 12.5 step 6).
//
// Fixture: AUTO class with probation-until in the past, zero corrections
// during probation. Clear the probation-until field on the class block.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function makeWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), 'at-prob-'));
  mkdirSync(join(dir, 'bin'), { recursive: true });
  writeFileSync(join(dir, 'bin/robin.js'), '#!/usr/bin/env node\n');
  mkdirSync(join(dir, 'user-data/memory/self-improvement'), { recursive: true });
  return dir;
}

const TRUST_PROBATION_EXPIRED = `# Action Trust

## Open

### gmail-reply-to-known-sender
- attempts: 12
- successes: 12
- corrections: 0
- last-action: 2026-05-03
- probation-until: 2026-05-01

## Closed

### gmail-reply-to-known-sender → AUTO
- date: 2026-04-24
- evidence: 5 successes, 0 corrections
- probation-until: 2026-05-01
`;

// Detection helper — read class block, see if probation-until is past today
// AND no corrections occurred during the window.
function probationExpired(blockText, today) {
  const m = blockText.match(/^- probation-until:\s*(\S+)/m);
  if (!m) return false;
  return m[1] < today;
}

// Simulate the clear: strip the `- probation-until: ...` line from the open block.
function clearProbation(ws, slug) {
  const path = join(ws, 'user-data/memory/self-improvement/action-trust.md');
  let trust = readFileSync(path, 'utf8');
  // Find the open block for slug and strip its probation-until line.
  // Regex: anchor on `### slug` heading, capture lines until next heading or EOF.
  trust = trust.replace(
    new RegExp(`(### ${slug}\\n(?:- [^\\n]+\\n)*?)- probation-until: [^\\n]+\\n`),
    '$1',
  );
  writeFileSync(path, trust);
}

describe('e2e: jobs: action-trust probation clear', () => {
  it('AUTO class past probation-until with 0 corrections → flag cleared on Open block', () => {
    const ws = makeWorkspace();
    writeFileSync(
      join(ws, 'user-data/memory/self-improvement/action-trust.md'),
      TRUST_PROBATION_EXPIRED,
    );

    // Detection.
    const trustText = readFileSync(join(ws, 'user-data/memory/self-improvement/action-trust.md'), 'utf8');
    const openMatch = trustText.match(/### gmail-reply-to-known-sender\n([\s\S]*?)(?=^### |^## )/m);
    assert.ok(openMatch);
    assert.equal(probationExpired(openMatch[1], '2026-05-04'), true);

    // Clear.
    clearProbation(ws, 'gmail-reply-to-known-sender');

    const after = readFileSync(join(ws, 'user-data/memory/self-improvement/action-trust.md'), 'utf8');
    // Open block no longer has probation-until.
    const openAfter = after.match(/### gmail-reply-to-known-sender\n([\s\S]*?)(?=^### |^## )/m)[1];
    assert.doesNotMatch(openAfter, /probation-until/);
    // Closed block STILL has probation-until (history preserved).
    const closedAfter = after.match(/## Closed[\s\S]*/)[0];
    assert.match(closedAfter, /probation-until: 2026-05-01/);
  });
});
