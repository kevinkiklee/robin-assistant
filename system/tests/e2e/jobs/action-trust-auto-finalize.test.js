// E2E scenario: 24h+ proposal with no objection finalizes.
//
// Fixture: needs-your-input.md has a proposal whose surfaced-at is >24h
// ago; corrections.md contains nothing referencing the proposal-id.
// Simulate Phase 12.5 step 5 finalize:
//   1. Move slug from ASK list to AUTO list in policies.md.
//   2. Append ## Closed entry to action-trust.md.
//   3. Set probation-until on the class block.
//   4. clearSection the proposal from needs-your-input.md.

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
  const dir = mkdtempSync(join(tmpdir(), 'at-fin-'));
  mkdirSync(join(dir, 'bin'), { recursive: true });
  writeFileSync(join(dir, 'bin/robin.js'), '#!/usr/bin/env node\n');
  mkdirSync(join(dir, 'user-data/memory/self-improvement'), { recursive: true });
  mkdirSync(join(dir, 'user-data/runtime/config'), { recursive: true });
  mkdirSync(join(dir, 'user-data/runtime/state'), { recursive: true });
  return dir;
}

const POLICIES_PRE = `# Policies

## AUTO

- spotify-skip

## ASK

- gmail-reply-to-known-sender
- calendar-create-event

## NEVER
`;

const TRUST_PRE = `# Action Trust

## Open

### gmail-reply-to-known-sender
- attempts: 5
- successes: 5
- corrections: 0
- last-action: 2026-05-02
- surfaced-at: 2026-05-03T05:00:00Z

## Closed
`;

const CORRECTIONS_EMPTY = `# Corrections\n\n_(no corrections this cycle)_\n`;

// Simulate the deterministic part of finalize.
function simulateFinalize(ws, slug, proposalId, today, probationUntil) {
  // 1. Move slug ASK → AUTO in policies.md.
  const policiesPath = join(ws, 'user-data/runtime/config/policies.md');
  let policies = readFileSync(policiesPath, 'utf8');
  // Strip from ASK section.
  policies = policies.replace(new RegExp(`^- ${slug}.*\\n`, 'm'), '');
  // Add to AUTO section (insert after `## AUTO\n\n`).
  policies = policies.replace(/(## AUTO\n\n)/, `$1- ${slug}\n`);
  writeFileSync(policiesPath, policies);

  // 2. Append ## Closed entry in action-trust.md.
  const trustPath = join(ws, 'user-data/memory/self-improvement/action-trust.md');
  let trust = readFileSync(trustPath, 'utf8');
  const closedEntry = `\n### ${slug} → AUTO\n- date: ${today}\n- evidence: 5 successes, 0 corrections\n- probation-until: ${probationUntil}\n`;
  trust = trust.replace(/^## Closed\s*\n/m, `## Closed\n${closedEntry}`);
  // Also add probation-until to the open class block.
  trust = trust.replace(
    new RegExp(`(### ${slug}\\n(?:- [^\\n]+\\n)+)`),
    `$1- probation-until: ${probationUntil}\n`,
  );
  writeFileSync(trustPath, trust);

  // 3. Clear the proposal.
  clearSection(ws, 'Action-trust promotion proposals');
}

describe('e2e: jobs: action-trust auto-finalize (no objection)', () => {
  it('moves class ASK → AUTO, appends ## Closed, sets probation, clears proposal', () => {
    const ws = makeWorkspace();
    writeFileSync(join(ws, 'user-data/runtime/config/policies.md'), POLICIES_PRE);
    writeFileSync(join(ws, 'user-data/memory/self-improvement/action-trust.md'), TRUST_PRE);
    writeFileSync(join(ws, 'user-data/memory/self-improvement/corrections.md'), CORRECTIONS_EMPTY);

    // Pre-existing proposal in needs-your-input.md.
    appendSection(
      ws,
      'Action-trust promotion proposals',
      `<!-- proposal-id:20260503-01 -->\n**\`gmail-reply-to-known-sender\` → AUTO**\n`,
    );

    simulateFinalize(ws, 'gmail-reply-to-known-sender', '20260503-01', '2026-05-04', '2026-05-11');

    const policies = readFileSync(join(ws, 'user-data/runtime/config/policies.md'), 'utf8');
    // Slug now in AUTO section.
    assert.match(policies, /## AUTO\n\n- gmail-reply-to-known-sender\n/);
    // No longer in ASK.
    const askMatch = policies.match(/## ASK\n\n([\s\S]*?)## NEVER/);
    assert.ok(askMatch);
    assert.doesNotMatch(askMatch[1], /gmail-reply-to-known-sender/);

    const trust = readFileSync(join(ws, 'user-data/memory/self-improvement/action-trust.md'), 'utf8');
    // ## Closed has the new entry with probation.
    assert.match(trust, /## Closed[\s\S]*### gmail-reply-to-known-sender → AUTO[\s\S]*probation-until: 2026-05-11/);

    // Proposal cleared from needs-your-input.md.
    const sections = readSections(ws);
    assert.ok(!sections['Action-trust promotion proposals']);
  });
});
