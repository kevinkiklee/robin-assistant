// Unit tests for `robin trust [...]` CLI subcommand.
//
// All commands are pure-read; no fixture writes side-effects beyond setup.
// Each test seeds a fresh tmp workspace with policies.md / action-trust.md /
// needs-your-input.md and asserts on stdout shape.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTrust } from '../../scripts/cli/trust.js';

function captureStdout(fn) {
  const chunks = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (s) => {
    chunks.push(typeof s === 'string' ? s : s.toString());
    return true;
  };
  try {
    return Promise.resolve(fn()).then((r) => ({ result: r, output: chunks.join('') }));
  } finally {
    process.stdout.write = original;
  }
}

function makeWorkspace(opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'trust-'));
  mkdirSync(join(dir, 'bin'), { recursive: true });
  writeFileSync(join(dir, 'bin/robin.js'), '#!/usr/bin/env node\n');
  mkdirSync(join(dir, 'user-data/runtime/config'), { recursive: true });
  mkdirSync(join(dir, 'user-data/memory/self-improvement'), { recursive: true });
  mkdirSync(join(dir, 'user-data/runtime/state'), { recursive: true });
  if (opts.policies !== undefined) {
    writeFileSync(join(dir, 'user-data/runtime/config/policies.md'), opts.policies);
  }
  if (opts.trust !== undefined) {
    writeFileSync(join(dir, 'user-data/memory/self-improvement/action-trust.md'), opts.trust);
  }
  if (opts.needsInput !== undefined) {
    writeFileSync(join(dir, 'user-data/runtime/state/needs-your-input.md'), opts.needsInput);
  }
  return dir;
}

const POLICIES = `---
type: reference
---

<!-- BEGIN compact-summary -->
AUTO: spotify-queue, spotify-skip, gmail-archive
NEVER: gmail-send-new-thread, shell-rm-recursive
<!-- END compact-summary -->
# Policies

## AUTO

- spotify-queue          # queue songs
- spotify-skip
- gmail-archive

## ASK

- gmail-reply-to-known-sender
- calendar-create-event

## NEVER

- gmail-send-new-thread
- shell-rm-recursive
`;

const TRUST = `---
type: topic
---

# Action Trust

## Open

### gmail-reply-to-known-sender
- attempts: 6
- successes: 5
- corrections: 0
- last-action: 2026-04-30
- next-review: 2026-05-04

### calendar-create-event
- attempts: 2
- successes: 2
- corrections: 0
- last-action: 2026-05-01

## Closed

### spotify-skip → AUTO
- date: 2026-05-01
- evidence: 7 successes, 0 corrections, 30d

### github-mark-read → ASK (demoted)
- date: 2026-04-29
- evidence: corrected once after promotion
`;

const NEEDS_INPUT = `---
generated_at: 2026-05-04T05:00:00Z
generated_by: dream
---

# Needs your input

## Action-trust promotion proposals

<!-- proposal-id:20260504-01 -->
**\`gmail-reply-to-known-sender\` → AUTO** (auto-finalize at 2026-05-05T05:00Z)

## Recall telemetry

- bytes rising 2.4×
`;

describe('cli/trust.js', () => {
  describe('default summary', () => {
    it('prints counts of AUTO/ASK/NEVER and pending review', async () => {
      const ws = makeWorkspace({ policies: POLICIES, trust: TRUST, needsInput: NEEDS_INPUT });
      const { output, result } = await captureStdout(() => runTrust([], ws));
      assert.equal(result.exitCode, 0);
      assert.match(output, /AUTO:\s*3/);
      assert.match(output, /ASK:\s*2/);
      assert.match(output, /NEVER:\s*2/);
      assert.match(output, /Open trust entries:\s*2/);
      assert.match(output, /Pending promotions:\s*1/);
    });

    it('prints zeros gracefully when files are missing', async () => {
      const ws = makeWorkspace();
      const { output, result } = await captureStdout(() => runTrust([], ws));
      assert.equal(result.exitCode, 0);
      assert.match(output, /AUTO:\s*0/);
      assert.match(output, /ASK:\s*0/);
      assert.match(output, /NEVER:\s*0/);
    });
  });

  describe('status', () => {
    it('prints the AUTO/ASK/NEVER lists from policies and Open trust entries', async () => {
      const ws = makeWorkspace({ policies: POLICIES, trust: TRUST });
      const { output, result } = await captureStdout(() => runTrust(['status'], ws));
      assert.equal(result.exitCode, 0);
      assert.match(output, /AUTO/);
      assert.match(output, /spotify-queue/);
      assert.match(output, /gmail-archive/);
      assert.match(output, /ASK/);
      assert.match(output, /gmail-reply-to-known-sender/);
      assert.match(output, /NEVER/);
      assert.match(output, /shell-rm-recursive/);
      assert.match(output, /Open trust entries/);
    });
  });

  describe('pending', () => {
    it('prints just the action-trust section of needs-your-input.md', async () => {
      const ws = makeWorkspace({ needsInput: NEEDS_INPUT });
      const { output, result } = await captureStdout(() => runTrust(['pending'], ws));
      assert.equal(result.exitCode, 0);
      assert.match(output, /promotion proposals/);
      assert.match(output, /gmail-reply-to-known-sender/);
      // Should not include the unrelated Recall telemetry section.
      assert.doesNotMatch(output, /Recall telemetry/);
    });

    it('prints "no pending items" when no proposals section is present', async () => {
      const ws = makeWorkspace();
      const { output, result } = await captureStdout(() => runTrust(['pending'], ws));
      assert.equal(result.exitCode, 0);
      assert.match(output, /no pending/i);
    });
  });

  describe('history', () => {
    it('prints ## Closed entries from action-trust.md', async () => {
      const ws = makeWorkspace({ trust: TRUST });
      const { output, result } = await captureStdout(() => runTrust(['history'], ws));
      assert.equal(result.exitCode, 0);
      assert.match(output, /spotify-skip/);
      assert.match(output, /github-mark-read/);
    });

    it('prints "no history" when ## Closed is empty', async () => {
      const ws = makeWorkspace({ trust: '## Open\n## Closed\n' });
      const { output, result } = await captureStdout(() => runTrust(['history'], ws));
      assert.equal(result.exitCode, 0);
      assert.match(output, /no history|no entries/i);
    });
  });

  describe('class', () => {
    it('prints state + counters + history for one class', async () => {
      const ws = makeWorkspace({ policies: POLICIES, trust: TRUST });
      const { output, result } = await captureStdout(() =>
        runTrust(['class', 'gmail-reply-to-known-sender'], ws),
      );
      assert.equal(result.exitCode, 0);
      assert.match(output, /gmail-reply-to-known-sender/);
      assert.match(output, /ASK/);
      assert.match(output, /successes/);
    });

    it('handles unknown class slug gracefully (exit 0)', async () => {
      const ws = makeWorkspace({ policies: POLICIES, trust: TRUST });
      const { output, result } = await captureStdout(() =>
        runTrust(['class', 'class-that-does-not-exist'], ws),
      );
      assert.equal(result.exitCode, 0);
      assert.match(output, /not found|no entry|unknown/i);
    });

    it('errors when no slug is supplied', async () => {
      const ws = makeWorkspace({ policies: POLICIES, trust: TRUST });
      const result = await runTrust(['class'], ws).catch((e) => ({ exitCode: 1, err: e }));
      assert.notEqual(result.exitCode, 0);
    });
  });

  describe('unknown subcommand', () => {
    it('returns non-zero exit code', async () => {
      const ws = makeWorkspace({ policies: POLICIES });
      const result = await runTrust(['nonsense'], ws);
      assert.notEqual(result.exitCode, 0);
    });
  });
});
