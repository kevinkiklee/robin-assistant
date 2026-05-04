// system/tests/e2e/hooks/post-tool-use-link-failure-modes.test.js
//
// The hook is fail-soft: any error inside the link path must be swallowed
// and the hook must still exit 0 so it never blocks Claude's tool result.
// expect.tree is disabled here — the property under test is the exit code.
import { describe, it } from 'node:test';
import { runScenario } from '../../lib/scenario.js';

describe('e2e: hooks: on-post-tool-use is fail-soft', () => {
  it('exits 0 when the target file does not exist', async () => {
    await runScenario({
      fixture: 'hooks/post-tool-use-link-failure-missing',
      clock: '2026-05-04T12:00:00Z',
      steps: [
        {
          hook: 'on-post-tool-use',
          stdin: {
            tool_name: 'Write',
            tool_input: {
              file_path: '__TEMPDIR__/user-data/memory/knowledge/people/missing.md',
            },
          },
          expectExit: 0,
        },
      ],
      expect: { tree: false },
    });
  });

  it('exits 0 when the file has corrupt frontmatter', async () => {
    await runScenario({
      fixture: 'hooks/post-tool-use-link-failure-corrupt',
      clock: '2026-05-04T12:00:00Z',
      steps: [
        {
          hook: 'on-post-tool-use',
          stdin: {
            tool_name: 'Write',
            tool_input: {
              file_path: '__TEMPDIR__/user-data/memory/knowledge/people/corrupt.md',
            },
          },
          expectExit: 0,
        },
      ],
      expect: { tree: false },
    });
  });
});
