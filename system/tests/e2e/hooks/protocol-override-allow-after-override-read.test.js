// e2e: Read override first, then Read system → both allowed (exit 0).

import { describe, it } from 'node:test';
import { runScenario } from '../../lib/scenario.js';

describe('e2e: hooks: protocol-override allow after override read', () => {
  it('allows Read of system file after override has been Read', async () => {
    await runScenario({
      fixture: 'hooks/protocol-override-allow-after-override-read',
      clock: '2026-05-03T12:00:00Z',
      steps: [
        {
          hook: 'on-user-prompt-submit',
          stdin: {
            session_id: 'aar-1',
            prompt: 'good morning',
            transcript_path: '',
          },
          expectExit: 0,
        },
        // Read user-data override first → marks overrides_read.
        {
          hook: 'on-pre-tool-use',
          stdin: {
            session_id: 'aar-1',
            tool_name: 'Read',
            tool_input: {
              file_path: '__TEMPDIR__/user-data/runtime/jobs/daily-briefing.md',
            },
          },
          expectExit: 0,
        },
        // Now Read of system file is allowed.
        {
          hook: 'on-pre-tool-use',
          stdin: {
            session_id: 'aar-1',
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
