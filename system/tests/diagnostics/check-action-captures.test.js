// Unit tests for system/scripts/diagnostics/check-action-captures.js.
//
// The diagnostic scans inbox.md for `[action] <class> • <outcome> • <ref>`
// lines, reports a count and a per-class breakdown, and indicates whether
// action-trust.md ## Open has corresponding entries. Always exits 0 — it's
// informational. The "no captures in 7d" warning is consumed by Dream
// Phase 12.5; this diagnostic just surfaces the raw signal.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanActionCaptures, formatReport } from '../../scripts/diagnostics/check-action-captures.js';

function makeWorkspace(opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cac-'));
  mkdirSync(join(dir, 'bin'), { recursive: true });
  writeFileSync(join(dir, 'bin/robin.js'), '#!/usr/bin/env node\n');
  mkdirSync(join(dir, 'user-data/memory/streams'), { recursive: true });
  mkdirSync(join(dir, 'user-data/memory/self-improvement'), { recursive: true });
  if (opts.inbox !== undefined) {
    writeFileSync(join(dir, 'user-data/memory/streams/inbox.md'), opts.inbox);
  }
  if (opts.trust !== undefined) {
    writeFileSync(join(dir, 'user-data/memory/self-improvement/action-trust.md'), opts.trust);
  }
  return dir;
}

const TODAY = '2026-05-03';

const INBOX_WITH_ACTIONS = `# Inbox

[fact|origin=user] Test fact <!-- id:20260501-1000-aa01 -->
[action|origin=user] gmail-archive • silent • thread:abc <!-- id:20260501-1001-aa02 -->
[action|origin=user] gmail-archive • silent • thread:def <!-- id:20260502-1100-aa03 -->
[action|origin=user] gmail-reply-to-known-sender • approved • thread:xyz <!-- id:20260502-1200-aa04 -->
[preference|origin=user] Test preference <!-- id:20260502-1300-aa05 -->
[action|origin=user] spotify-skip • silent • track:99 <!-- id:20260503-0900-aa06 -->
`;

const INBOX_NO_ACTIONS = `# Inbox

[fact|origin=user] Test fact <!-- id:20260501-1000-aa01 -->
[preference|origin=user] Test preference <!-- id:20260502-1300-aa02 -->
`;

const TRUST_WITH_ENTRIES = `## Open

### gmail-reply-to-known-sender
- attempts: 1
- successes: 1
- corrections: 0

## Closed
`;

describe('check-action-captures', () => {
  describe('scanActionCaptures', () => {
    it('counts [action] lines in inbox.md and groups by class', () => {
      const ws = makeWorkspace({ inbox: INBOX_WITH_ACTIONS, trust: TRUST_WITH_ENTRIES });
      const report = scanActionCaptures(ws, { today: TODAY });
      assert.equal(report.total, 4);
      assert.equal(report.byClass['gmail-archive'], 2);
      assert.equal(report.byClass['gmail-reply-to-known-sender'], 1);
      assert.equal(report.byClass['spotify-skip'], 1);
    });

    it('records which classes have a matching ## Open trust entry', () => {
      const ws = makeWorkspace({ inbox: INBOX_WITH_ACTIONS, trust: TRUST_WITH_ENTRIES });
      const report = scanActionCaptures(ws, { today: TODAY });
      assert.ok(report.classesWithTrustEntry.includes('gmail-reply-to-known-sender'));
      assert.ok(!report.classesWithTrustEntry.includes('gmail-archive'));
    });

    it('returns zero counts and warning when inbox is missing', () => {
      const ws = makeWorkspace();
      const report = scanActionCaptures(ws, { today: TODAY });
      assert.equal(report.total, 0);
      assert.deepEqual(report.byClass, {});
      assert.equal(report.warning7d, true);
    });

    it('returns zero counts and warning when inbox has no [action] lines', () => {
      const ws = makeWorkspace({ inbox: INBOX_NO_ACTIONS });
      const report = scanActionCaptures(ws, { today: TODAY });
      assert.equal(report.total, 0);
      assert.equal(report.warning7d, true);
    });

    it('respects the windowDays option (default 30)', () => {
      // Action captures don't carry timestamps in their tag; we date them by
      // the `id:` comment. Anything matching `id:YYYYMMDD-...` is windowed.
      const oldInbox = `# Inbox

[action|origin=user] gmail-archive • silent • thread:1 <!-- id:20251201-1000-aa01 -->
[action|origin=user] gmail-archive • silent • thread:2 <!-- id:20260502-1000-aa02 -->
`;
      const ws = makeWorkspace({ inbox: oldInbox });
      const report30 = scanActionCaptures(ws, { today: TODAY, windowDays: 30 });
      assert.equal(report30.total, 1);
      const reportAll = scanActionCaptures(ws, { today: TODAY, windowDays: 365 });
      assert.equal(reportAll.total, 2);
    });

    it('sets warning7d=false when at least one capture is within 7 days', () => {
      const ws = makeWorkspace({ inbox: INBOX_WITH_ACTIONS });
      const report = scanActionCaptures(ws, { today: TODAY });
      assert.equal(report.warning7d, false);
    });
  });

  describe('formatReport', () => {
    it('produces a human-readable summary', () => {
      const ws = makeWorkspace({ inbox: INBOX_WITH_ACTIONS, trust: TRUST_WITH_ENTRIES });
      const report = scanActionCaptures(ws, { today: TODAY });
      const text = formatReport(report);
      assert.match(text, /Total/);
      assert.match(text, /gmail-archive/);
      assert.match(text, /4/);
    });

    it('shows the warning banner when warning7d is true', () => {
      const ws = makeWorkspace({ inbox: INBOX_NO_ACTIONS });
      const report = scanActionCaptures(ws, { today: TODAY });
      const text = formatReport(report);
      assert.match(text, /No \[action\] captures/i);
    });
  });
});
