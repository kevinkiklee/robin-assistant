// e2e: when the state file directory is unwritable, the hook logs
// hook_error telemetry, attempts to delete any prior state file, and
// PreToolUse falls into the no-state allow path. We simulate write
// failure by making the protocol-overrides directory read-only.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runScenario } from '../../lib/scenario.js';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  chmodSync,
  existsSync,
  rmSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');
const HOOK = join(REPO_ROOT, 'system/scripts/hooks/claude-code.js');

// Builds a minimal workspace, then makes the protocol-overrides dir
// read-only so the atomic-rename write inside the hook fails.
function makeReadOnlyStateDirWorkspace() {
  const ws = mkdtempSync(join(tmpdir(), 'pohook-rofail-'));
  mkdirSync(join(ws, 'user-data/runtime/state/protocol-overrides'), { recursive: true });
  // Pre-existing daily-briefing override so injection branch is exercised.
  mkdirSync(join(ws, 'user-data/runtime/jobs'), { recursive: true });
  writeFileSync(
    join(ws, 'user-data/runtime/jobs/daily-briefing.md'),
    '---\nname: daily-briefing\n---\n# override\n',
  );
  // Strip write permission on the state dir.
  chmodSync(join(ws, 'user-data/runtime/state/protocol-overrides'), 0o555);
  return ws;
}

describe('e2e: hooks: protocol-override state write failure', () => {
  it('logs hook_error and PreToolUse stays on no-state allow path', () => {
    const ws = makeReadOnlyStateDirWorkspace();
    try {
      // UserPromptSubmit (write should fail; hook logs hook_error and continues).
      const event = {
        session_id: 'sw-1',
        prompt: 'good morning',
        transcript_path: '',
      };
      const r = execFileSync(
        'node',
        [HOOK, '--on-user-prompt-submit', '--workspace', ws],
        { input: JSON.stringify(event), encoding: 'utf8' },
      );
      // Hook is fail-open → exit 0. stdout MAY contain injection block
      // (injection runs even when state write fails).
      assert.match(r, /system-reminder/);

      // Verify telemetry recorded the hook_error.
      const log = readFileSync(
        join(ws, 'user-data/runtime/state/telemetry/protocol-override-enforcement.log'),
        'utf8',
      );
      assert.match(log, /"event":"hook_error"/);
      assert.match(log, /state_write_failed|state_delete_failed|override_flow_failed/);

      // Now PreToolUse on system Read — must NOT block (no state file → no-state path).
      const ptu = {
        session_id: 'sw-1',
        tool_name: 'Read',
        tool_input: {
          file_path: join(ws, 'system/jobs/daily-briefing.md'),
        },
      };
      const ptuOut = execFileSync(
        'node',
        [HOOK, '--on-pre-tool-use', '--workspace', ws],
        { input: JSON.stringify(ptu), encoding: 'utf8' },
      );
      // exit 0 → command did not throw.
      assert.equal(typeof ptuOut, 'string');
    } finally {
      // Restore perms so cleanup works.
      try { chmodSync(join(ws, 'user-data/runtime/state/protocol-overrides'), 0o755); } catch {}
      try { rmSync(ws, { recursive: true, force: true }); } catch {}
    }
  });
});
