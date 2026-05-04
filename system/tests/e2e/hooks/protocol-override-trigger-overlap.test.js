// e2e: two protocols share an overlapping trigger phrase → both trigger,
// both injected (when both have overrides).

import { describe, it } from 'node:test';
import { runScenario } from '../../lib/scenario.js';

describe('e2e: hooks: protocol-override trigger overlap', () => {
  it('emits one injection per matched protocol when phrases overlap', async () => {
    await runScenario({
      fixture: 'hooks/protocol-override-trigger-overlap',
      clock: '2026-05-03T12:00:00Z',
      steps: [
        {
          hook: 'on-user-prompt-submit',
          stdin: {
            session_id: 'to-1',
            // "daily briefing" matches both daily-briefing and a custom
            // "briefing" protocol defined in user-data.
            prompt: 'give me a daily briefing now',
            transcript_path: '',
          },
          expectExit: 0,
        },
      ],
      expect: { tree: true, io: true },
    });
  });
});
