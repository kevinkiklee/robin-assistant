// E2E contract test: needs-your-input.md is wired into the session-start
// surface end-to-end.
//
// "Startup #4 reads it" is implemented by the agent (claude-code reading
// CLAUDE.md), not a deterministic hook — so we can't drive a process-level
// invocation. Instead we assert the three documentation surfaces all agree:
//
//   1. CLAUDE.md startup #4 names the path.
//   2. token-budget.json includes the path in tier1_files (so the file is
//      part of the always-on read budget).
//   3. The needs-input.js helper writes to that exact path (so the
//      producer and the reader use the same filename).
//
// If any one of these drifts, action-trust loop-closure breaks: Dream
// might write to a path the agent never reads, or vice versa.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendSection, needsInputPath } from '../../../scripts/lib/needs-input.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');

const EXPECTED_PATH = 'user-data/runtime/state/needs-your-input.md';

describe('e2e: hooks: needs-your-input.md startup-load wiring', () => {
  it('CLAUDE.md startup #4 names the path', () => {
    const claudeMd = readFileSync(join(REPO_ROOT, 'CLAUDE.md'), 'utf8');
    // Find the startup #4 numbered list item.
    const m = claudeMd.match(/^4\.\s+([\s\S]*?)^5\./m);
    assert.ok(m, 'startup #4 not found in CLAUDE.md');
    assert.match(m[1], new RegExp(EXPECTED_PATH));
  });

  it('token-budget.json lists the path in tier1_files', () => {
    const budget = JSON.parse(
      readFileSync(join(REPO_ROOT, 'system/scripts/diagnostics/lib/token-budget.json'), 'utf8'),
    );
    const paths = budget.tier1_files.map((f) => f.path);
    assert.ok(paths.includes(EXPECTED_PATH), `tier1_files missing ${EXPECTED_PATH}`);
  });

  it('needs-input helper writes to the same path documented in CLAUDE.md and budget', () => {
    const ws = mkdtempSync(join(tmpdir(), 'ni-startup-'));
    mkdirSync(join(ws, 'bin'), { recursive: true });
    writeFileSync(join(ws, 'bin/robin.js'), '#!/usr/bin/env node\n');
    appendSection(ws, 'Test', '- one\n');
    const helperPath = needsInputPath(ws);
    assert.equal(helperPath, join(ws, EXPECTED_PATH));
  });

  it('non-empty needs-your-input.md is parseable by readSections (the surface contract)', async () => {
    // Simulates what the agent sees at startup: read the file, find sections.
    const { readSections } = await import('../../../scripts/lib/needs-input.js');
    const ws = mkdtempSync(join(tmpdir(), 'ni-startup-'));
    mkdirSync(join(ws, 'bin'), { recursive: true });
    writeFileSync(join(ws, 'bin/robin.js'), '#!/usr/bin/env node\n');
    appendSection(
      ws,
      'Action-trust promotion proposals',
      '<!-- proposal-id:20260504-01 -->\n**`gmail-archive` → AUTO**\n',
    );
    const sections = readSections(ws);
    assert.ok(sections['Action-trust promotion proposals']);
    assert.match(sections['Action-trust promotion proposals'], /proposal-id:20260504-01/);
  });
});
