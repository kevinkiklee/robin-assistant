import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentsMdContent } from '../../runtime/install/agents-md.js';

test('agentsMdContent — robin-jobs block present when jobs array provided', () => {
  const md = agentsMdContent({
    jobs: [
      {
        name: 'daily-briefing',
        enabled: false,
        schedule: '0 7 * * *',
        next_run_at: null,
        manually_runnable: true,
      },
      {
        name: 'foo',
        enabled: true,
        schedule: '@hourly',
        next_run_at: new Date('2026-05-10T14:00:00Z'),
        manually_runnable: true,
      },
    ],
  });
  assert.match(md, /<!-- robin-jobs:start/);
  assert.match(md, /<!-- robin-jobs:end -->/);
  assert.match(md, /daily-briefing\s+disabled/);
  assert.match(md, /foo\s+enabled/);
});

test('agentsMdContent — fallback message when jobs array missing', () => {
  const md = agentsMdContent({});
  assert.match(md, /<!-- robin-jobs:start/);
  assert.match(md, /jobs surface unavailable/);
});

test('agentsMdContent — run_job usage caveat present', () => {
  const md = agentsMdContent({ jobs: [] });
  assert.match(md, /run_job/);
  assert.match(md, /user request/i);
});
