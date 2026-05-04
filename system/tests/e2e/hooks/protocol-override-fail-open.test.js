// e2e: corrupt state file → PreToolUse fail-open path (allow + log).
//
// The runScenario harness's tree-comparison would object to the telemetry
// log file's volatile timestamps. We use a direct execFileSync test instead.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');
const HOOK = join(REPO_ROOT, 'system/scripts/hooks/claude-code.js');

describe('e2e: hooks: protocol-override fail-open', () => {
  it('allows Read when state file is corrupt JSON', () => {
    const ws = mkdtempSync(join(tmpdir(), 'pohook-corrupt-'));
    try {
      mkdirSync(join(ws, 'user-data/runtime/jobs'), { recursive: true });
      writeFileSync(
        join(ws, 'user-data/runtime/jobs/daily-briefing.md'),
        '---\nname: daily-briefing\n---\n# override\n',
      );
      const stateDir = join(ws, 'user-data/runtime/state/protocol-overrides');
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(join(stateDir, 'fo-1.json'), '{ this is not json');

      const ptu = {
        session_id: 'fo-1',
        tool_name: 'Read',
        tool_input: { file_path: join(ws, 'system/jobs/daily-briefing.md') },
      };
      // Should NOT throw (exit 0 = allow despite corrupt state).
      const out = execFileSync(
        'node',
        [HOOK, '--on-pre-tool-use', '--workspace', ws],
        { input: JSON.stringify(ptu), encoding: 'utf8' },
      );
      assert.equal(typeof out, 'string');
    } finally {
      try { rmSync(ws, { recursive: true, force: true }); } catch {}
    }
  });
});
