import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentsMdContent } from '../../runtime/install/agents-md.js';
import { currentStateSection, readCurrentState } from '../../runtime/install/current-state.js';

test('current-state block exists in agentsMdContent output', () => {
  const md = agentsMdContent({});
  assert.match(md, /<!-- robin-current-state:start/);
  assert.match(md, /<!-- robin-current-state:end -->/);
});

test('empty state renders graceful "no record" placeholders, not throw', () => {
  const out = currentStateSection({ sleep: null, recovery: null, weather: null });
  assert.match(out, /Sleep: \(no recent record/);
  assert.match(out, /Recovery: \(no recent record\)/);
  assert.match(out, /Weather: \(no recent record\)/);
});

test('populated state renders sleep content + perf% + end-ts', () => {
  const state = {
    sleep: {
      content: 'sleep: 1h 46m · efficiency 89%',
      ts: '2026-05-16T06:52:21Z',
      meta: {
        kind: 'sleep',
        nap: false,
        end: '2026-05-16T08:38:51Z',
        score: { sleep_performance_percentage: 12 },
      },
    },
    recovery: null,
    weather: null,
  };
  const out = currentStateSection(state);
  assert.match(out, /Sleep last cycle: sleep: 1h 46m/);
  assert.match(out, /perf 12%/);
  assert.match(out, /ended 2026-05-16T08:38:51\.000Z/);
});

test('NAP cycle gets [NAP] flag so the agent does not confuse a nap with a night sleep', () => {
  const state = {
    sleep: {
      content: 'sleep: 1h 32m · efficiency 97.8%',
      ts: '2026-05-15T22:59:50Z',
      meta: { kind: 'sleep', nap: true, end: '2026-05-16T00:32:20Z' },
    },
    recovery: null,
    weather: null,
  };
  const out = currentStateSection(state);
  assert.match(out, /\[NAP\]/);
});

test('block instructs agent NOT to ask permission for read-only Whoop/weather lookups', () => {
  const out = currentStateSection(null);
  assert.match(out, /Do NOT ask the\s+user permission/);
});

test('block tells agent to refresh stale data, not paper over it', () => {
  const out = currentStateSection(null);
  assert.match(out, /integration_run/);
  assert.match(out, /do\s*\n?\s*not paper over a gap/);
});

test('readCurrentState returns empty shape when db is null (refresh job tolerates degraded daemon)', async () => {
  const s = await readCurrentState(null);
  assert.deepEqual(s, { sleep: null, recovery: null, weather: null });
});
