// e2e: when no trigger fires this turn, Read of a system protocol file is
// not blocked (state has empty triggers_fired).

import { describe, it } from 'node:test';
import { runScenario } from '../../lib/scenario.js';

describe('e2e: hooks: protocol-override no trigger no block', () => {
  it('allows Read of system file when no trigger fired', async () => {
    await runScenario({
      fixture: 'hooks/protocol-override-no-trigger-no-block',
      clock: '2026-05-03T12:00:00Z',
      steps: [
        {
          hook: 'on-user-prompt-submit',
          stdin: {
            session_id: 'ntnb-1',
            prompt: 'what is the time?',
            transcript_path: '',
          },
          expectExit: 0,
        },
        {
          hook: 'on-pre-tool-use',
          stdin: {
            session_id: 'ntnb-1',
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
