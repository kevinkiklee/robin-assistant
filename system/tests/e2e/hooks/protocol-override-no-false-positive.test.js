// e2e: word-boundary check — "the daily briefing system" must NOT match
// because "daily briefing" appears mid-phrase but our intent is to detect
// invocation, not narrative reference. This is the spec's primary
// false-positive guard.

import { describe, it } from 'node:test';
import { runScenario } from '../../lib/scenario.js';

describe('e2e: hooks: protocol-override no false positive', () => {
  it('does NOT inject when phrase appears as part of a longer word', async () => {
    await runScenario({
      fixture: 'hooks/protocol-override-no-false-positive',
      clock: '2026-05-03T12:00:00Z',
      steps: [
        {
          hook: 'on-user-prompt-submit',
          stdin: {
            session_id: 'np-1',
            // "weeklyreviewer" is one word — should NOT match the trigger
            // phrase "weekly review".
            prompt: 'I am a weeklyreviewer of news',
            transcript_path: '',
          },
          expectExit: 0,
        },
      ],
      expect: { tree: true, io: true },
    });
  });
});
