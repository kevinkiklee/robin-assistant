// E2E scenario: Phase 12.5 emits a promotion proposal to needs-your-input.md.
//
// Fixture: action-trust.md `## Open` has `gmail-reply-to-known-sender` with
// 5 successes / 0 corrections / 30d. Simulate the deterministic part of
// Phase 12.5: detect eligibility, append proposal section. Telemetry not
// asserted here (tested separately in scanActionCaptures); we focus on the
// surface contract — the proposal must land in needs-your-input.md with
// the auto-finalize deadline and a parseable `<!-- proposal-id:... -->`
// marker.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendSection,
  readSections,
  needsInputPath,
} from '../../../scripts/lib/needs-input.js';

function makeWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), 'at-prom-'));
  mkdirSync(join(dir, 'bin'), { recursive: true });
  writeFileSync(join(dir, 'bin/robin.js'), '#!/usr/bin/env node\n');
  mkdirSync(join(dir, 'user-data/memory/self-improvement'), { recursive: true });
  mkdirSync(join(dir, 'user-data/runtime/config'), { recursive: true });
  mkdirSync(join(dir, 'user-data/runtime/state'), { recursive: true });
  return dir;
}

const TRUST_ELIGIBLE = `# Action Trust

## Open

### gmail-reply-to-known-sender
- attempts: 5
- successes: 5
- corrections: 0
- last-action: 2026-05-02

## Closed
`;

const POLICIES = `# Policies

## AUTO

- spotify-skip

## ASK

- gmail-reply-to-known-sender

## NEVER

- gmail-send-new-thread
`;

// Simulate Phase 12.5 step 4 (propose promotions) for one eligible class.
// Returns the proposal-id used.
function simulateProposal(ws, slug, evidence, today, deadlineIso) {
  const proposalId = `${today.replace(/-/g, '')}-01`;
  const body = [
    `<!-- proposal-id:${proposalId} -->`,
    `**\`${slug}\` → AUTO** (auto-finalize at ${deadlineIso})`,
    `- evidence: ${evidence.successes} successes, ${evidence.corrections} corrections, last 30 days`,
    `- last action: ${evidence.last}`,
    `- to object: append \`[correction|origin=user] reject promotion ${proposalId}: <reason>\` to inbox`,
    '',
  ].join('\n');
  appendSection(ws, 'Action-trust promotion proposals', body);
  return proposalId;
}

describe('e2e: jobs: action-trust promotion proposal', () => {
  it('eligible class → proposal section appears in needs-your-input.md', () => {
    const ws = makeWorkspace();
    writeFileSync(
      join(ws, 'user-data/memory/self-improvement/action-trust.md'),
      TRUST_ELIGIBLE,
    );
    writeFileSync(join(ws, 'user-data/runtime/config/policies.md'), POLICIES);

    const id = simulateProposal(
      ws,
      'gmail-reply-to-known-sender',
      { successes: 5, corrections: 0, last: '2026-05-02' },
      '2026-05-04',
      '2026-05-05T05:00:00Z',
    );
    assert.equal(id, '20260504-01');

    // Section should exist with proposal marker + auto-finalize deadline.
    const text = readFileSync(needsInputPath(ws), 'utf8');
    assert.match(text, /## Action-trust promotion proposals/);
    assert.match(text, new RegExp(`<!-- proposal-id:${id} -->`));
    assert.match(text, /gmail-reply-to-known-sender.*AUTO/);
    assert.match(text, /auto-finalize at 2026-05-05T05:00:00Z/);
    assert.match(text, /5 successes, 0 corrections/);
  });

  it('multiple proposals coexist in the same section', () => {
    const ws = makeWorkspace();
    writeFileSync(
      join(ws, 'user-data/memory/self-improvement/action-trust.md'),
      TRUST_ELIGIBLE,
    );
    writeFileSync(join(ws, 'user-data/runtime/config/policies.md'), POLICIES);

    // First proposal.
    const body1 = `<!-- proposal-id:20260504-01 -->\n**\`gmail-reply-to-known-sender\` → AUTO**\n`;
    appendSection(ws, 'Action-trust promotion proposals', body1);

    // Second proposal — must replace the section atomically with both.
    const body2 = body1 + `\n<!-- proposal-id:20260504-02 -->\n**\`calendar-create-event\` → AUTO**\n`;
    appendSection(ws, 'Action-trust promotion proposals', body2);

    const sections = readSections(ws);
    assert.match(sections['Action-trust promotion proposals'], /20260504-01/);
    assert.match(sections['Action-trust promotion proposals'], /20260504-02/);
  });
});
