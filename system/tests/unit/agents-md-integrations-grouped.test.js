import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentsMdContent } from '../../runtime/install/agents-md.js';

test('integrationsSection groups by source: System and User', () => {
  const md = agentsMdContent({
    integrations: [
      {
        name: 'gmail',
        cadence_ms: 15 * 60 * 1000,
        kind: 'sync',
        tool_names: ['gmail_search'],
        source: 'system',
        enabled: true,
      },
      {
        name: 'spotify',
        cadence_ms: 4 * 60 * 60 * 1000,
        kind: 'sync',
        tool_names: ['spotify_recently_played'],
        source: 'user-data',
        enabled: true,
      },
      {
        name: 'whoop',
        cadence_ms: 30 * 60 * 1000,
        kind: 'sync',
        tool_names: [],
        source: 'user-data',
        enabled: false,
      },
    ],
  });
  assert.match(md, /### System integrations[\s\S]+gmail/);
  assert.match(md, /### User integrations[\s\S]+spotify/);
  assert.match(md, /whoop.*\(disabled\)/);
});

test('outbound section auto-renders from manifests with write_semantics', () => {
  const md = agentsMdContent({
    integrations: [
      {
        name: 'discord',
        cadence_ms: null,
        kind: 'gateway',
        source: 'user-data',
        enabled: true,
        write_semantics: {
          actions: ['send_dm', 'send_channel'],
          rate_limit_per_hour: 10,
          audit_level_per_action: { send_dm: 'events', send_channel: 'events' },
          tool_name: 'discord_send',
        },
      },
    ],
  });
  assert.match(md, /## Outbound writes/);
  assert.match(md, /discord_send/);
  assert.match(md, /send_dm/);
  assert.match(md, /send_channel/);
});

test('outbound section omitted when no integration has write_semantics', () => {
  const md = agentsMdContent({
    integrations: [
      {
        name: 'gmail',
        cadence_ms: 15 * 60 * 1000,
        kind: 'sync',
        tool_names: ['gmail_search'],
        source: 'system',
        enabled: true,
      },
    ],
  });
  assert.doesNotMatch(md, /## Outbound writes/);
});

test('outbound section lists actions and extra gates from write_semantics', () => {
  const md = agentsMdContent({
    integrations: [
      {
        name: 'github_write',
        cadence_ms: null,
        kind: 'tool-only',
        source: 'user-data',
        enabled: true,
        tool_names: ['github_write'],
        write_semantics: {
          tool_name: 'github_write',
          actions: ['create-issue', 'comment', 'label', 'mark-read'],
          rate_limit_per_hour: 10,
          audit_level_per_action: {
            'create-issue': 'events',
            comment: 'events',
            label: 'log-only',
            'mark-read': 'log-only',
          },
          extra_gates: ['outbound-policy'],
        },
      },
    ],
  });
  assert.match(md, /\*\*github_write\*\* — actions: create-issue, comment, label, mark-read/);
  assert.match(md, /events-audited.*create-issue, comment/);
  assert.match(md, /log-only.*label, mark-read/);
  assert.match(md, /extra gates: outbound-policy/);
});
