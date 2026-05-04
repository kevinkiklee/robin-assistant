// e2e: PreToolUse blocks Read of system/jobs/<name>.md when the trigger
// fired this turn AND the user-data override exists AND the override has
// not yet been Read.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runScenario } from '../../lib/scenario.js';

describe('e2e: hooks: protocol-override block system read', () => {
  it('exits 2 with POLICY_REFUSED when reading system file before override', async () => {
    await runScenario({
      fixture: 'hooks/protocol-override-block-system-read',
      clock: '2026-05-03T12:00:00Z',
      steps: [
        // Step 0: turn starts; trigger fires; state is written.
        {
          hook: 'on-user-prompt-submit',
          stdin: {
            session_id: 'blk-1',
            prompt: 'good morning',
            transcript_path: '',
          },
          expectExit: 0,
        },
        // Step 1: model attempts to Read system/jobs/daily-briefing.md without
        // first reading the user-data override → blocked.
        {
          hook: 'on-pre-tool-use',
          stdin: {
            session_id: 'blk-1',
            tool_name: 'Read',
            tool_input: {
              file_path: '__TEMPDIR__/system/jobs/daily-briefing.md',
            },
          },
          expectExit: 2,
        },
      ],
      expect: { tree: true, io: true },
    });
  });
});
