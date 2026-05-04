// e2e: state file mtime >24h old → PreToolUse treats as no-state (allow).
//
// The standard runScenario harness can't backdate mtime, so this test
// builds a workspace directly, writes a "would-block" state file, then
// backdates its mtime past the 24h threshold and verifies that PreToolUse
// allows the Read instead of blocking.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { STATE_STALE_MS } from '../../../scripts/hooks/lib/protocol-override-state.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');
const HOOK = join(REPO_ROOT, 'system/scripts/hooks/claude-code.js');

describe('e2e: hooks: protocol-override stale state', () => {
  it('allows Read when state file mtime is older than 24h', () => {
    const ws = mkdtempSync(join(tmpdir(), 'pohook-stale-'));
    try {
      // Override file exists.
      mkdirSync(join(ws, 'user-data/runtime/jobs'), { recursive: true });
      writeFileSync(
        join(ws, 'user-data/runtime/jobs/daily-briefing.md'),
        '---\nname: daily-briefing\n---\n# override\n',
      );
      // State file exists — would block IF fresh.
      const stateDir = join(ws, 'user-data/runtime/state/protocol-overrides');
      mkdirSync(stateDir, { recursive: true });
      const statePath = join(stateDir, 'ss-1.json');
      writeFileSync(
        statePath,
        JSON.stringify({
          session_id: 'ss-1',
          turn_started_at: '2026-05-01T00:00:00.000Z',
          triggers_fired: ['daily-briefing'],
          overrides_read: [],
        }),
      );
      // Backdate mtime well past 24h.
      const past = (Date.now() - STATE_STALE_MS - 60_000) / 1000;
      utimesSync(statePath, past, past);

      const ptu = {
        session_id: 'ss-1',
        tool_name: 'Read',
        tool_input: { file_path: join(ws, 'system/jobs/daily-briefing.md') },
      };
      // execFileSync throws on non-zero exit. If the hook (incorrectly) blocks,
      // exit 2 → throw.
      const out = execFileSync(
        'node',
        [HOOK, '--on-pre-tool-use', '--workspace', ws],
        { input: JSON.stringify(ptu), encoding: 'utf8' },
      );
      assert.equal(typeof out, 'string'); // exit 0 → no throw
    } finally {
      try { rmSync(ws, { recursive: true, force: true }); } catch {}
    }
  });
});
