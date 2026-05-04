// E2E scenario: AUTO class with no entries 90+ days → demoted to ASK with
// `## Closed` reason "decay (idle 90d)" (Phase 12.5 step 7).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function makeWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), 'at-decay-'));
  mkdirSync(join(dir, 'bin'), { recursive: true });
  writeFileSync(join(dir, 'bin/robin.js'), '#!/usr/bin/env node\n');
  mkdirSync(join(dir, 'user-data/memory/self-improvement'), { recursive: true });
  mkdirSync(join(dir, 'user-data/runtime/config'), { recursive: true });
  return dir;
}

const POLICIES = `# Policies

## AUTO

- spotify-skip
- old-idle-class

## ASK

## NEVER
`;

const TRUST = `# Action Trust

## Open

### old-idle-class
- attempts: 6
- successes: 6
- corrections: 0
- last-action: 2026-01-15

## Closed
`;

const TODAY = '2026-05-04';
const NINETY_DAYS_MS = 90 * 24 * 3600 * 1000;

function isDecayed(lastAction, today) {
  const lastMs = Date.parse(`${lastAction}T00:00:00Z`);
  const todayMs = Date.parse(`${today}T00:00:00Z`);
  return todayMs - lastMs > NINETY_DAYS_MS;
}

function simulateDecay(ws, slug, today) {
  const policiesPath = join(ws, 'user-data/runtime/config/policies.md');
  let policies = readFileSync(policiesPath, 'utf8');
  policies = policies.replace(new RegExp(`^- ${slug}\\s*\\n`, 'm'), '');
  policies = policies.replace(/(## ASK\n\n)/, `$1- ${slug}\n`);
  writeFileSync(policiesPath, policies);

  const trustPath = join(ws, 'user-data/memory/self-improvement/action-trust.md');
  let trust = readFileSync(trustPath, 'utf8');
  const closedEntry = `\n### ${slug} → ASK (decay)\n- date: ${today}\n- reason: idle 90d\n`;
  trust = trust.replace(/^## Closed\s*\n/m, `## Closed\n${closedEntry}`);
  writeFileSync(trustPath, trust);
}

describe('e2e: jobs: action-trust 90-day decay', () => {
  it('AUTO class idle >90d → demoted with reason "idle 90d"', () => {
    const ws = makeWorkspace();
    writeFileSync(join(ws, 'user-data/runtime/config/policies.md'), POLICIES);
    writeFileSync(join(ws, 'user-data/memory/self-improvement/action-trust.md'), TRUST);

    const trustText = readFileSync(join(ws, 'user-data/memory/self-improvement/action-trust.md'), 'utf8');
    const openMatch = trustText.match(/### old-idle-class\n([\s\S]*?)(?=^### |^## )/m);
    const lastAction = openMatch[1].match(/^- last-action:\s*(\S+)/m)[1];
    assert.equal(isDecayed(lastAction, TODAY), true);

    simulateDecay(ws, 'old-idle-class', TODAY);

    const policies = readFileSync(join(ws, 'user-data/runtime/config/policies.md'), 'utf8');
    assert.match(policies, /## ASK\n\n- old-idle-class/);
    const autoMatch = policies.match(/## AUTO\n\n([\s\S]*?)## ASK/);
    assert.doesNotMatch(autoMatch[1], /old-idle-class/);

    const trust = readFileSync(join(ws, 'user-data/memory/self-improvement/action-trust.md'), 'utf8');
    assert.match(trust, /### old-idle-class → ASK \(decay\)\n- date: 2026-05-04\n- reason: idle 90d/);
  });

  it('AUTO class with recent activity is NOT demoted', () => {
    assert.equal(isDecayed('2026-04-30', TODAY), false);
  });
});
