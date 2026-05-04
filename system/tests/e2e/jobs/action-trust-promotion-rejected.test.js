// E2E scenario: user objects to a pending promotion → cancel.
//
// Fixture: needs-your-input.md has a proposal; corrections.md (or
// inbox.md) carries `[correction|origin=user] reject promotion <id>`.
// Simulate the cancel branch of Phase 12.5 step 5:
//   1. Class STAYS in ASK (no policies.md mutation).
//   2. Append ## Closed entry "promotion rejected" to action-trust.md.
//   3. Remove proposal from needs-your-input.md.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendSection,
  clearSection,
  readSections,
} from '../../../scripts/lib/needs-input.js';

function makeWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), 'at-rej-'));
  mkdirSync(join(dir, 'bin'), { recursive: true });
  writeFileSync(join(dir, 'bin/robin.js'), '#!/usr/bin/env node\n');
  mkdirSync(join(dir, 'user-data/memory/self-improvement'), { recursive: true });
  mkdirSync(join(dir, 'user-data/memory/streams'), { recursive: true });
  mkdirSync(join(dir, 'user-data/runtime/config'), { recursive: true });
  mkdirSync(join(dir, 'user-data/runtime/state'), { recursive: true });
  return dir;
}

const POLICIES = `# Policies

## AUTO

- spotify-skip

## ASK

- gmail-reply-to-known-sender

## NEVER
`;

const TRUST = `# Action Trust

## Open

### gmail-reply-to-known-sender
- attempts: 5
- successes: 5
- corrections: 0
- last-action: 2026-05-02
- surfaced-at: 2026-05-03T05:00:00Z

## Closed
`;

const PROPOSAL_ID = '20260503-01';

// Detect rejection by scanning corrections + inbox text.
function findRejection(text, proposalId) {
  const re = new RegExp(`\\[correction\\|origin=user\\][^\\n]*reject promotion ${proposalId}(?:\\s*:\\s*([^\\n]+))?`);
  const m = text.match(re);
  return m ? { found: true, reason: m[1] || '' } : { found: false };
}

// Simulate the cancel branch.
function simulateCancel(ws, slug, proposalId, today, reason) {
  const trustPath = join(ws, 'user-data/memory/self-improvement/action-trust.md');
  let trust = readFileSync(trustPath, 'utf8');
  const closedEntry = `\n### ${slug} → promotion rejected\n- date: ${today}\n- reason: ${reason}\n`;
  trust = trust.replace(/^## Closed\s*\n/m, `## Closed\n${closedEntry}`);
  writeFileSync(trustPath, trust);
  clearSection(ws, 'Action-trust promotion proposals');
}

describe('e2e: jobs: action-trust promotion rejected', () => {
  it('user [correction] reject → class stays ASK, ## Closed says rejected, proposal cleared', () => {
    const ws = makeWorkspace();
    writeFileSync(join(ws, 'user-data/runtime/config/policies.md'), POLICIES);
    writeFileSync(join(ws, 'user-data/memory/self-improvement/action-trust.md'), TRUST);
    writeFileSync(
      join(ws, 'user-data/memory/streams/inbox.md'),
      `# Inbox

[correction|origin=user] reject promotion ${PROPOSAL_ID}: too risky for unfamiliar senders <!-- id:20260504-0700-aa01 -->
`,
    );
    appendSection(
      ws,
      'Action-trust promotion proposals',
      `<!-- proposal-id:${PROPOSAL_ID} -->\n**\`gmail-reply-to-known-sender\` → AUTO**\n`,
    );

    // Detect.
    const inbox = readFileSync(join(ws, 'user-data/memory/streams/inbox.md'), 'utf8');
    const rej = findRejection(inbox, PROPOSAL_ID);
    assert.equal(rej.found, true);
    assert.match(rej.reason, /too risky/);

    // Cancel.
    simulateCancel(ws, 'gmail-reply-to-known-sender', PROPOSAL_ID, '2026-05-04', rej.reason);

    // Class still ASK in policies.
    const policies = readFileSync(join(ws, 'user-data/runtime/config/policies.md'), 'utf8');
    assert.match(policies, /## ASK\n\n- gmail-reply-to-known-sender/);
    assert.doesNotMatch(policies.match(/## AUTO[\s\S]*?## ASK/)[0], /gmail-reply-to-known-sender/);

    // Trust ledger has rejection record.
    const trust = readFileSync(join(ws, 'user-data/memory/self-improvement/action-trust.md'), 'utf8');
    assert.match(trust, /### gmail-reply-to-known-sender → promotion rejected/);
    assert.match(trust, /reason: too risky for unfamiliar senders/);

    // Proposal cleared.
    const sections = readSections(ws);
    assert.ok(!sections['Action-trust promotion proposals']);
  });
});
