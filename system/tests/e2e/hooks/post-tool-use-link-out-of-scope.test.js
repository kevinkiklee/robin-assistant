// system/tests/e2e/hooks/post-tool-use-link-out-of-scope.test.js
//
// Each fixture seeds the target file with text that WOULD be linked if the
// hook treated the path as in-scope (every fixture mentions Kevin and ships
// a profile/identity.md with `canonical: Kevin K Lee`). The expected tree
// mirrors the input verbatim — if the hook erroneously links the file, the
// snapshot diff fails.
import { describe, it } from 'node:test';
import { runScenario } from '../../lib/scenario.js';

const cases = [
  { sub: 'streams/inbox.md', fixture: 'hooks/post-tool-use-link-out-of-scope-inbox' },
  { sub: 'hot.md', fixture: 'hooks/post-tool-use-link-out-of-scope-hot' },
  { sub: 'archive/old.md', fixture: 'hooks/post-tool-use-link-out-of-scope-archive' },
  { sub: 'knowledge/conversations/2026-05-04.md', fixture: 'hooks/post-tool-use-link-out-of-scope-conv' },
];

describe('e2e: hooks: on-post-tool-use is a no-op outside scope', () => {
  for (const { sub, fixture } of cases) {
    it(`does not modify ${sub}`, async () => {
      await runScenario({
        fixture,
        clock: '2026-05-04T12:00:00Z',
        steps: [
          {
            hook: 'on-post-tool-use',
            stdin: {
              tool_name: 'Write',
              tool_input: { file_path: `__TEMPDIR__/user-data/memory/${sub}` },
            },
            expectExit: 0,
          },
        ],
        expect: {
          tree: {
            // Skip-path emits a perf-log entry with hook='link-hook-skip'.
            ignore: ['user-data/runtime/state/hook-perf.log'],
          },
        },
      });
    });
  }
});
