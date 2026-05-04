// e2e: protocol exists ONLY in user-data (no system version) → trigger
// fires, no system file to block on, injection still emitted.

import { describe, it } from 'node:test';
import { runScenario } from '../../lib/scenario.js';

describe('e2e: hooks: protocol-override user-only protocol', () => {
  it('emits injection for a user-only protocol with declared triggers', async () => {
    await runScenario({
      fixture: 'hooks/protocol-override-user-only-protocol',
      clock: '2026-05-03T12:00:00Z',
      steps: [
        {
          hook: 'on-user-prompt-submit',
          stdin: {
            session_id: 'uo-1',
            prompt: 'time for some birding',
            transcript_path: '',
          },
          expectExit: 0,
        },
      ],
      expect: { tree: true, io: true },
    });
  });
});
