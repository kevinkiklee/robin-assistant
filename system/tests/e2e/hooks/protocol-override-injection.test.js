// e2e: UserPromptSubmit injects a <system-reminder> when a known trigger
// fires AND a user-data override exists for that protocol.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runScenario } from '../../lib/scenario.js';

describe('e2e: hooks: protocol-override injection', () => {
  it('injects <system-reminder> when trigger fires and override exists', async () => {
    await runScenario({
      fixture: 'hooks/protocol-override-injection',
      clock: '2026-05-03T12:00:00Z',
      steps: [
        {
          hook: 'on-user-prompt-submit',
          stdin: {
            session_id: 'inj-1',
            prompt: 'good morning',
            transcript_path: '',
          },
          expectExit: 0,
        },
      ],
      expect: { tree: true, io: true },
    });
  });

  it('does NOT inject when trigger fires but no override exists', async () => {
    await runScenario({
      fixture: 'hooks/protocol-override-no-override-no-block',
      clock: '2026-05-03T12:00:00Z',
      steps: [
        {
          hook: 'on-user-prompt-submit',
          stdin: {
            session_id: 'no-ov-1',
            prompt: 'good morning',
            transcript_path: '',
          },
          expectExit: 0,
        },
      ],
      expect: { tree: true, io: true },
    });
  });
});
