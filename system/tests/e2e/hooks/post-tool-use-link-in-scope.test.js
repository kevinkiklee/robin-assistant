// system/tests/e2e/hooks/post-tool-use-link-in-scope.test.js
import { describe, it } from 'node:test';
import { runScenario } from '../../lib/scenario.js';

describe('e2e: hooks: on-post-tool-use links in-scope memory writes', () => {
  it('inserts wiki-links into a knowledge/people file after Write', async () => {
    // Asserted via expected/tree snapshot — jane.md must contain
    // `[Kevin](../../profile/identity.md)` after the hook fires.
    await runScenario({
      fixture: 'hooks/post-tool-use-link-in-scope',
      clock: '2026-05-04T12:00:00Z',
      steps: [
        {
          hook: 'on-post-tool-use',
          stdin: {
            tool_name: 'Write',
            tool_input: {
              file_path: '__TEMPDIR__/user-data/memory/knowledge/people/jane.md',
            },
          },
          expectExit: 0,
        },
      ],
      expect: {
        tree: {
          // Hook writes a perf-log entry on success; ignore for snapshot stability.
          ignore: ['user-data/runtime/state/hook-perf.log'],
        },
      },
    });
  });
});
