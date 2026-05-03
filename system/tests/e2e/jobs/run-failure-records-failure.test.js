import { describe, it } from 'node:test';
import { runScenario } from '../../lib/scenario.js';

describe('e2e: jobs: run failure records failure', () => {
  it('a failing script job is recorded in state', async () => {
    await runScenario({
      fixture: 'jobs/run-failure-records-failure',
      clock: '2026-05-02T12:00:00Z',
      steps: [{ run: ['run', 'sample'], expectExit: 1, env: { ROBIN_NO_NOTIFY: '1' } }],
      expect: { tree: true },
      normalize: [
        { from: /\[?\+\d+ms\]?/g, to: '[+<N>ms]' },
        { from: /"last_duration_ms":\s*\d+/g, to: '"last_duration_ms": <N>' },
        { from: /duration=\d+ms/g, to: 'duration=<N>ms' },
      ],
    });
  });
});
