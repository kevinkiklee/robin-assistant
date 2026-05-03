// system/tests/e2e/hooks/on-pre-tool-use-blocks-pii-write.test.js
import { describe, it } from 'node:test';
import { runScenario } from '../../lib/scenario.js';

describe('e2e: hooks: on-pre-tool-use blocks PII write', () => {
  it('exits 2 when payload writes a full SSN-shaped string to a memory file', async () => {
    await runScenario({
      fixture: 'hooks/on-pre-tool-use-blocks-pii-write',
      clock: '2026-05-02T12:00:00Z',
      steps: [
        {
          hook: 'on-pre-tool-use',
          stdin: {
            tool_name: 'Write',
            tool_input: {
              file_path: '__TEMPDIR__/user-data/memory/notes.md',
              content: 'Alice SSN: 123-45-6789',
            },
          },
          expectExit: 2,
        },
      ],
      expect: { tree: true },
    });
  });
});
