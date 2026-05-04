// e2e: when trigger fires for a protocol with no user-data override, Read
// of the system file is allowed (no override means nothing to enforce).

import { describe, it } from 'node:test';
import { runScenario } from '../../lib/scenario.js';

describe('e2e: hooks: protocol-override no override no block', () => {
  it('allows Read of system file when trigger fires but no override exists', async () => {
    await runScenario({
      fixture: 'hooks/protocol-override-no-override-no-block-read',
      clock: '2026-05-03T12:00:00Z',
      steps: [
        {
          hook: 'on-user-prompt-submit',
          stdin: {
            session_id: 'noov-2',
            // "good morning" triggers daily-briefing, but no override exists.
            prompt: 'good morning',
            transcript_path: '',
          },
          expectExit: 0,
        },
        {
          hook: 'on-pre-tool-use',
          stdin: {
            session_id: 'noov-2',
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
