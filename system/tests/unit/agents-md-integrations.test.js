import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentsMdContent } from '../../runtime/install/agents-md.js';

test('agentsMdContent includes integrations fence even when empty', () => {
  const md = agentsMdContent({ integrations: [] });
  assert.match(md, /<!-- robin-integrations:start/);
  assert.match(md, /<!-- robin-integrations:end -->/);
});

test('agentsMdContent lists provided integrations', () => {
  const md = agentsMdContent({
    integrations: [
      {
        name: 'gmail',
        cadence_ms: 900_000,
        kind: 'sync',
        tool_names: ['gmail_search', 'gmail_get_thread'],
      },
      { name: 'discord', cadence_ms: null, kind: 'gateway', tool_names: [] },
    ],
  });
  assert.match(md, /gmail \(15m\): gmail_search, gmail_get_thread/);
  assert.match(md, /discord \(gateway\)/);
});

test('agentsMdContent freshness section instructs poll-every-2s', () => {
  const md = agentsMdContent({ integrations: [] });
  assert.match(md, /every 2s/);
  assert.match(md, /integration_run\(\{name\}\)/);
});

test('agentsMdContent renders 1-day cadence as 1d', () => {
  const md = agentsMdContent({
    integrations: [
      {
        name: 'lunch_money',
        cadence_ms: 86_400_000,
        kind: 'sync',
        tool_names: ['lunch_money_query'],
      },
    ],
  });
  assert.match(md, /lunch_money \(1d\): lunch_money_query/);
});

test('agentsMdContent backward-compatible: no args still works and includes empty integrations block', () => {
  const md = agentsMdContent();
  assert.match(md, /<!-- robin-integrations:start/);
  assert.match(md, /<!-- robin-integrations:end -->/);
  assert.match(md, /\(none registered\)/);
});

test('agentsMdContent renders hour cadence', () => {
  const md = agentsMdContent({
    integrations: [{ name: 'foo', cadence_ms: 3_600_000, kind: 'sync', tool_names: ['foo_tool'] }],
  });
  assert.match(md, /foo \(1h\): foo_tool/);
});

test('agentsMdContent renders integration with empty tool_names as no-tools line', () => {
  const md = agentsMdContent({
    integrations: [{ name: 'silentsync', cadence_ms: 900_000, kind: 'sync', tool_names: [] }],
  });
  assert.match(md, /silentsync \(15m\): no agent-callable tools/);
});
