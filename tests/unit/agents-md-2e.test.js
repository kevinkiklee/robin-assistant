import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentsMdContent } from '../../src/install/agents-md.js';

test('agentsMdContent renders three sub-blocks inside one fence', () => {
  const md = agentsMdContent({
    integrations: [
      { name: 'gmail', cadence_ms: 900_000, kind: 'sync', tool_names: ['gmail_search'] },
      { name: 'discord', cadence_ms: null, kind: 'gateway', tool_names: [] },
      {
        name: 'github_write',
        cadence_ms: null,
        kind: 'tool-only',
        tool_names: ['github_write'],
      },
    ],
  });
  assert.match(md, /<!-- robin-integrations:start/);
  assert.match(md, /<!-- robin-integrations:end -->/);
  assert.match(md, /## Integration data freshness/);
  assert.match(md, /## Outbound writes \(github_write, spotify_write, discord_send\)/);
  assert.match(md, /## Available integrations/);
  assert.match(md, /gmail \(15m\): gmail_search/);
  assert.match(md, /discord \(gateway\)/);
  assert.match(md, /github_write \(tool-only\): github_write/);
});

test('outbound-writes section warns against bypass', () => {
  const md = agentsMdContent({ integrations: [] });
  assert.match(md, /DON'T retry by paraphrasing/);
  assert.match(md, /outbound_blocked/);
});

test('outbound-writes section explains label/mark-read non-capture', () => {
  const md = agentsMdContent({ integrations: [] });
  assert.match(md, /label, mark-read, queue, skip/);
});

test('outbound-writes section mentions spotify_write rate-limit and capture', () => {
  const md = agentsMdContent({ integrations: [] });
  assert.match(md, /spotify_write/);
  assert.match(md, /rate_limited/);
  assert.match(md, /playlist-add/);
});

test('outbound-writes section mentions discord_send allowlist + content cap', () => {
  const md = agentsMdContent({ integrations: [] });
  assert.match(md, /discord_send/);
  assert.match(md, /send_dm/);
  assert.match(md, /send_channel/);
  assert.match(md, /not_allowed/);
  assert.match(md, /content_too_long/);
});

test('renderIntegrationsList shows (none registered) when empty', () => {
  const md = agentsMdContent({ integrations: [] });
  assert.match(md, /\(none registered\)/);
});
