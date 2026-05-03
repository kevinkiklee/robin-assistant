import { describe, it } from 'node:test';
import { runScenario } from '../../lib/scenario.js';

describe('e2e: hooks: on-stop comprehensive (drain + handoff)', () => {
  it('drains auto-memory into inbox AND writes session-handoff block', async () => {
    await runScenario({
      fixture: 'hooks/on-stop-comprehensive',
      clock: '2026-05-02T12:00:00Z',
      steps: [
        {
          hook: 'on-stop',
          stdin: { session_id: 'claude-code-test1' },
          env: {
            ROBIN_AUTO_MEMORY_DIR: '__TEMPDIR__/auto-memory',
            ROBIN_DRAIN_SYNC: '1',
          },
        },
      ],
      expect: {
        tree: {
          // The migration log contains real-clock timestamps from the drain subprocess
          // (auto-memory.js does not inherit the frozen-clock preload). Exclude it
          // from the snapshot; the drain is verified by inbox.md content instead.
          ignore: ['user-data/runtime/state/migrated-auto-memory-log.json'],
        },
      },
      normalize: [
        // Migration IDs embed a real-clock timestamp (auto-memory.js subprocess
        // does not inherit the frozen-clock preload). Replace with a stable token.
        { from: /<!-- id:[a-z0-9-]+ -->/g, to: '<!-- id:<ID> -->' },
      ],
    });
  });
});
