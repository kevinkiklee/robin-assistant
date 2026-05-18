import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentsMdContent } from '../../runtime/install/agents-md.js';

test('AGENTS.md includes pinned-profile block with sentinel markers', () => {
  const md = agentsMdContent();
  assert.match(md, /robin-pinned:start/);
  assert.match(md, /robin-pinned:end/);
  assert.match(md, /Pinned profile/);
});

test('empty pinned content surfaces a soft pointer to the file path', () => {
  const md = agentsMdContent({ pinned: '' });
  assert.match(md, /robin-pinned:start/);
  assert.match(md, /profile\/pinned\.md/);
  assert.match(md, /No pinned profile file/i);
});

test('pinned body is shifted under the Pinned profile heading (no duplicate H1)', () => {
  const pinned = '# My pinned context\n\n## Bodies\n\n- Nikon Zf (24.5MP)\n';
  const md = agentsMdContent({ pinned });
  assert.match(md, /## Pinned profile/);
  assert.match(md, /### Bodies/);
  assert.match(md, /Nikon Zf \(24\.5MP\)/);
  const pinnedSection = md.slice(md.indexOf('robin-pinned:start'), md.indexOf('robin-pinned:end'));
  assert.ok(
    !/^# My pinned context/m.test(pinnedSection),
    'leading H1 must be stripped from pinned body',
  );
});

test('pinned block appears before the integrations block (high prominence)', () => {
  const md = agentsMdContent({ integrations: [], pinned: '- gear here' });
  const pinnedStart = md.indexOf('<!-- robin-pinned:start');
  const integrationsStart = md.indexOf('<!-- robin-integrations:start');
  assert.ok(pinnedStart !== -1);
  assert.ok(integrationsStart !== -1);
  assert.ok(pinnedStart < integrationsStart);
});

test('whitespace-only pinned input is treated as empty', () => {
  const md = agentsMdContent({ pinned: '   \n\n   ' });
  assert.match(md, /No pinned profile file/i);
});
