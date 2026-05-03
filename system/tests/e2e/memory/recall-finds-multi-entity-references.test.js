import { describe, it } from 'node:test';
import { runScenario } from '../../lib/scenario.js';

describe('e2e: memory: recall finds multi-entity references', () => {
  it('robin recall --json Alice returns hits across all 3 files', async () => {
    await runScenario({
      fixture: 'memory/recall-finds-multi-entity-references',
      clock: '2026-05-02T12:00:00Z',
      steps: [{ run: ['recall', '--json', 'Alice'] }],
      expect: { tree: true, io: true },
    });
  });
});
