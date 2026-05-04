// E2E scenario: a `corrected` outcome on an AUTO class triggers immediate
// demotion to ASK (Phase 12.5 step 3).
//
// Hard rule from CLAUDE.md operational rules: any `corrected` outcome
// demotes same-cycle. We simulate the deterministic part:
//   1. Scan inbox for `[action] <class> • corrected • <ref>`.
//   2. Move slug from AUTO → ASK in policies.md.
//   3. Append ## Closed entry "demoted (correction)".

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanActionCaptures } from '../../../scripts/diagnostics/check-action-captures.js';

function makeWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), 'at-dem-'));
  mkdirSync(join(dir, 'bin'), { recursive: true });
  writeFileSync(join(dir, 'bin/robin.js'), '#!/usr/bin/env node\n');
  mkdirSync(join(dir, 'user-data/memory/self-improvement'), { recursive: true });
  mkdirSync(join(dir, 'user-data/memory/streams'), { recursive: true });
  mkdirSync(join(dir, 'user-data/runtime/config'), { recursive: true });
  return dir;
}

const POLICIES_PRE = `# Policies

## AUTO

- spotify-skip
- gmail-archive

## ASK

- calendar-create-event

## NEVER
`;

const TRUST_PRE = `# Action Trust

## Open

### gmail-archive
- attempts: 6
- successes: 5
- corrections: 0
- last-action: 2026-05-01

## Closed
`;

const INBOX_WITH_CORRECTION = `# Inbox

[action|origin=user] gmail-archive • silent • thread:abc <!-- id:20260502-1000-aa01 -->
[action|origin=user] gmail-archive • corrected • thread:def <!-- id:20260504-0900-aa02 -->
`;

// Simulate Phase 12.5 step 3 (demote on correction).
function simulateDemotion(ws, slug, today, ref) {
  const policiesPath = join(ws, 'user-data/runtime/config/policies.md');
  let policies = readFileSync(policiesPath, 'utf8');
  // Strip from AUTO.
  policies = policies.replace(new RegExp(`^- ${slug}.*\\n`, 'm'), '');
  // Add to ASK section.
  policies = policies.replace(/(## ASK\n\n)/, `$1- ${slug}\n`);
  writeFileSync(policiesPath, policies);

  const trustPath = join(ws, 'user-data/memory/self-improvement/action-trust.md');
  let trust = readFileSync(trustPath, 'utf8');
  const closedEntry = `\n### ${slug} → ASK (demoted)\n- date: ${today}\n- evidence: corrected outcome ${ref}\n`;
  trust = trust.replace(/^## Closed\s*\n/m, `## Closed\n${closedEntry}`);
  writeFileSync(trustPath, trust);
}

describe('e2e: jobs: action-trust demotion on correction', () => {
  it('AUTO class with `corrected` outcome → demoted to ASK same cycle', () => {
    const ws = makeWorkspace();
    writeFileSync(join(ws, 'user-data/runtime/config/policies.md'), POLICIES_PRE);
    writeFileSync(join(ws, 'user-data/memory/self-improvement/action-trust.md'), TRUST_PRE);
    writeFileSync(join(ws, 'user-data/memory/streams/inbox.md'), INBOX_WITH_CORRECTION);

    // Detect: scanActionCaptures groups by class + outcome.
    const report = scanActionCaptures(ws, { today: '2026-05-04' });
    assert.equal(report.byClass['gmail-archive'], 2);
    assert.equal(report.byOutcome['corrected'], 1);

    // Apply demotion.
    simulateDemotion(ws, 'gmail-archive', '2026-05-04', 'thread:def');

    const policies = readFileSync(join(ws, 'user-data/runtime/config/policies.md'), 'utf8');
    // Slug now in ASK.
    assert.match(policies, /## ASK\n\n- gmail-archive/);
    // Removed from AUTO.
    const autoMatch = policies.match(/## AUTO\n\n([\s\S]*?)## ASK/);
    assert.doesNotMatch(autoMatch[1], /gmail-archive/);

    // Trust ledger has demotion entry.
    const trust = readFileSync(join(ws, 'user-data/memory/self-improvement/action-trust.md'), 'utf8');
    assert.match(trust, /### gmail-archive → ASK \(demoted\)\n- date: 2026-05-04\n- evidence: corrected outcome thread:def/);
  });
});
