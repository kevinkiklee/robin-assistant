// system/tests/e2e/hooks/on-pre-bash-blocks-sensitive-command.test.js
import { describe, it } from 'node:test';
import { runScenario } from '../../lib/scenario.js';

describe('e2e: hooks: on-pre-bash blocks sensitive command', () => {
  it('exits 2 and leaves user-data unchanged (refusal logged to ignored telemetry path)', async () => {
    await runScenario({
      fixture: 'hooks/on-pre-bash-blocks-sensitive-command',
      clock: '2026-05-02T12:00:00Z',
      steps: [
        {
          hook: 'on-pre-bash',
          stdin: { tool_input: { command: 'printenv' } },
          expectExit: 2,
        },
      ],
      expect: { tree: true },
    });
  });
});
