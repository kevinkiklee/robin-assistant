import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentsMdContent } from '../../runtime/install/agents-md.js';

test('AGENTS.md includes Agent disciplines block with sentinel markers', () => {
  const md = agentsMdContent();
  assert.match(md, /robin-disciplines:start/);
  assert.match(md, /robin-disciplines:end/);
  assert.match(md, /Agent disciplines/);
});

test('disciplines block codifies recall-before-advising', () => {
  const md = agentsMdContent();
  assert.match(md, /Recall before advising/i);
  assert.match(md, /how to use it well/i);
  assert.match(md, /buy-vs-skip/i);
});

test('disciplines block codifies verify-before-asserting and no permission-asks', () => {
  const md = agentsMdContent();
  assert.match(md, /Verify before asserting/i);
  assert.match(md, /WebFetch/);
  assert.match(md, /Never ask "want me to verify\?"/);
});

test('disciplines block codifies no fabricated mechanical specs', () => {
  const md = agentsMdContent();
  assert.match(md, /fabricate mechanical specs/i);
  assert.match(md, /zoom mechanism|blade count|filter thread/i);
});

test('disciplines block appears before integrations block (high prominence)', () => {
  const md = agentsMdContent({ integrations: [] });
  const disciplinesStart = md.indexOf('<!-- robin-disciplines:start');
  const integrationsStart = md.indexOf('<!-- robin-integrations:start');
  assert.ok(disciplinesStart !== -1);
  assert.ok(integrationsStart !== -1);
  assert.ok(
    disciplinesStart < integrationsStart,
    'disciplines must appear before integrations for prominence',
  );
});
