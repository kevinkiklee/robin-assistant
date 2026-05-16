import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentsMdContent } from '../../runtime/install/agents-md.js';

// Minimal write_semantics fixtures matching what real manifests now declare.
// These exist so tests can exercise the data-driven outbound-writes rendering
// without depending on the user-data/ manifests at import time.
const GITHUB_WRITE_SEMANTICS = {
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
};
const SPOTIFY_WRITE_SEMANTICS = {
  tool_name: 'spotify_write',
  actions: ['queue', 'skip', 'playlist-add'],
  rate_limit_per_hour: 10,
  audit_level_per_action: {
    queue: 'log-only',
    skip: 'log-only',
    'playlist-add': 'events',
  },
  extra_gates: ['outbound-policy'],
};
const DISCORD_SEND_SEMANTICS = {
  tool_name: 'discord_send',
  actions: ['send_dm', 'send_channel'],
  rate_limit_per_hour: 10,
  audit_level_per_action: { send_dm: 'events', send_channel: 'events' },
  extra_gates: ['outbound-policy', 'allowlist', 'content-length-cap-2000'],
};

const ALL_WRITERS = [
  {
    name: 'github_write',
    cadence_ms: null,
    kind: 'tool-only',
    source: 'user-data',
    enabled: true,
    tool_names: ['github_write'],
    write_semantics: GITHUB_WRITE_SEMANTICS,
  },
  {
    name: 'spotify_write',
    cadence_ms: null,
    kind: 'tool-only',
    source: 'user-data',
    enabled: true,
    tool_names: ['spotify_write'],
    write_semantics: SPOTIFY_WRITE_SEMANTICS,
  },
  {
    name: 'discord',
    cadence_ms: null,
    kind: 'gateway',
    source: 'user-data',
    enabled: true,
    tool_names: ['discord_send'],
    write_semantics: DISCORD_SEND_SEMANTICS,
  },
];

test('agentsMdContent renders three sub-blocks inside one fence', () => {
  const md = agentsMdContent({
    integrations: [
      {
        name: 'gmail',
        cadence_ms: 900_000,
        kind: 'sync',
        tool_names: ['gmail_search'],
        source: 'system',
        enabled: true,
      },
      ...ALL_WRITERS,
    ],
  });
  assert.match(md, /<!-- robin-integrations:start/);
  assert.match(md, /<!-- robin-integrations:end -->/);
  assert.match(md, /## Integration data freshness/);
  assert.match(md, /## Outbound writes/);
  assert.match(md, /## Available integrations/);
  assert.match(md, /gmail \(15m\): gmail_search/);
  assert.match(md, /discord \(gateway\)/);
  assert.match(md, /github_write \(tool-only\): github_write/);
});

test('outbound-writes section warns against bypass via outbound-policy gate', () => {
  const md = agentsMdContent({ integrations: ALL_WRITERS });
  assert.match(md, /DON'T retry by paraphrasing/);
  assert.match(md, /outbound_blocked/);
});

test('outbound-writes section separates events-audited from log-only actions', () => {
  const md = agentsMdContent({ integrations: ALL_WRITERS });
  // github_write: label, mark-read → log-only
  assert.match(md, /log-only.*label, mark-read/);
  // spotify_write: queue, skip → log-only
  assert.match(md, /log-only.*queue, skip/);
});

test('outbound-writes section mentions spotify_write rate-limit and capture', () => {
  const md = agentsMdContent({ integrations: ALL_WRITERS });
  assert.match(md, /spotify_write/);
  assert.match(md, /rate_limited/);
  assert.match(md, /playlist-add/);
});

test('outbound-writes section mentions discord_send and its actions', () => {
  const md = agentsMdContent({ integrations: ALL_WRITERS });
  assert.match(md, /discord_send/);
  assert.match(md, /send_dm/);
  assert.match(md, /send_channel/);
  // extra-gates surface allowlist + content-length-cap for discord
  assert.match(md, /allowlist/);
  assert.match(md, /content-length-cap-2000/);
});

test('renderIntegrationsList shows (none registered) when empty', () => {
  const md = agentsMdContent({ integrations: [] });
  assert.match(md, /\(none registered\)/);
});
