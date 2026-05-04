// E2E scenario: Phase 12.5 capture-pipeline check.
//
// Fixture: inbox.md has zero `[action]` captures in the last 7 days.
// Phase 12.5 sub-step 1 calls scanActionCaptures and, on warning7d:true,
// appends a banner to needs-your-input.md under "Action-trust capture
// pipeline".

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanActionCaptures } from '../../../scripts/diagnostics/check-action-captures.js';
import { appendSection, readSections } from '../../../scripts/lib/needs-input.js';

function makeWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), 'at-warn-'));
  mkdirSync(join(dir, 'bin'), { recursive: true });
  writeFileSync(join(dir, 'bin/robin.js'), '#!/usr/bin/env node\n');
  mkdirSync(join(dir, 'user-data/memory/streams'), { recursive: true });
  mkdirSync(join(dir, 'user-data/runtime/state'), { recursive: true });
  return dir;
}

const INBOX_NO_RECENT_ACTIONS = `# Inbox

[fact|origin=user] Some fact <!-- id:20260501-1000-aa01 -->
[preference|origin=user] Some pref <!-- id:20260502-1000-aa02 -->
`;

const INBOX_RECENT_ACTIONS = `# Inbox

[action|origin=user] gmail-archive • silent • thread:1 <!-- id:20260503-1000-aa01 -->
`;

const BANNER = '⚠ No `[action]` captures recorded in 7 days. Either no AUTO/ASK actions occurred (unlikely) or the capture-emission rule isn\'t being honored. Review `system/rules/capture.md` `### [action] tag`.';

describe('e2e: jobs: action-trust capture-pipeline warning', () => {
  it('zero captures in 7d → banner appended to needs-your-input.md', () => {
    const ws = makeWorkspace();
    writeFileSync(join(ws, 'user-data/memory/streams/inbox.md'), INBOX_NO_RECENT_ACTIONS);

    const report = scanActionCaptures(ws, { today: '2026-05-04' });
    assert.equal(report.warning7d, true);

    if (report.warning7d) {
      appendSection(ws, 'Action-trust capture pipeline', BANNER + '\n');
    }

    const sections = readSections(ws);
    assert.ok(sections['Action-trust capture pipeline']);
    assert.match(sections['Action-trust capture pipeline'], /No .\[action\]. captures recorded/);
  });

  it('recent captures present → no banner appended', () => {
    const ws = makeWorkspace();
    writeFileSync(join(ws, 'user-data/memory/streams/inbox.md'), INBOX_RECENT_ACTIONS);

    const report = scanActionCaptures(ws, { today: '2026-05-04' });
    assert.equal(report.warning7d, false);

    if (report.warning7d) {
      appendSection(ws, 'Action-trust capture pipeline', BANNER + '\n');
    }

    const sections = readSections(ws);
    assert.ok(!sections['Action-trust capture pipeline']);
  });
});
