// e2e: turn 1 fires trigger, turn 2 does not → turn 2 Read of system file
// is allowed. Verifies always-overwrite state semantics.

import { describe, it } from 'node:test';
import { runScenario } from '../../lib/scenario.js';

describe('e2e: hooks: protocol-override cross-turn clears', () => {
  it('always-overwrites state so prior-turn triggers do not leak', async () => {
    await runScenario({
      fixture: 'hooks/protocol-override-cross-turn-clears',
      clock: '2026-05-03T12:00:00Z',
      steps: [
        // Turn 1 — trigger fires.
        {
          hook: 'on-user-prompt-submit',
          stdin: {
            session_id: 'ctc-1',
            prompt: 'good morning',
            transcript_path: '',
          },
          expectExit: 0,
        },
        // Turn 2 — no trigger; state must be reset.
        {
          hook: 'on-user-prompt-submit',
          stdin: {
            session_id: 'ctc-1',
            prompt: 'unrelated query',
            transcript_path: '',
          },
          expectExit: 0,
        },
        // Read of system file in turn 2 is allowed.
        {
          hook: 'on-pre-tool-use',
          stdin: {
            session_id: 'ctc-1',
            tool_name: 'Read',
            tool_input: {
              file_path: '__TEMPDIR__/system/jobs/daily-briefing.md',
            },
          },
          expectExit: 0,
        },
      ],
      expect: { tree: true, io: true },
    });
  });
});
