import { describe, it } from 'node:test';
import { runScenario } from '../../lib/scenario.js';

describe('e2e: memory: index regen after content change', () => {
  it('regenerate-memory-index rewrites INDEX.md to reflect updated file content', async () => {
    await runScenario({
      fixture: 'memory/index-regen-after-content-change',
      clock: '2026-05-02T12:00:00Z',
      steps: [
        {
          writeFile: 'user-data/memory/knowledge/work.md',
          content: '---\ndescription: Work notes and projects\n---\n# Work\nLine 1.\nLine 2.\nLine 3.\n',
        },
        { run: ['regenerate-memory-index'] },
      ],
      expect: { tree: true, io: true },
    });
  });
});
