import { describe, it } from 'node:test';
import { runScenario } from '../../lib/scenario.js';

describe('e2e: hooks: on-pre-tool-use blocks auto-memory write', () => {
  it('exits 2 when tool targets ~/.claude/projects/<ws>/memory/', async () => {
    await runScenario({
      fixture: 'hooks/on-pre-tool-use-blocks-auto-memory-write',
      clock: '2026-05-02T12:00:00Z',
      steps: [
        {
          hook: 'on-pre-tool-use',
          stdin: {
            tool_name: 'Write',
            tool_input: {
              file_path: '/Users/alice/.claude/projects/-tmp-robin-test/memory/foo.md',
              content: 'should not land',
            },
          },
          expectExit: 2,
        },
      ],
      expect: { tree: true },
    });
  });
});
