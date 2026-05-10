import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentsMdContent, buildSecurityBlock } from '../../src/install/agents-md.js';

test('AGENTS.md includes Security posture block', () => {
  const md = agentsMdContent();
  assert.match(md, /Security posture/);
  assert.match(md, /no encryption at rest/i);
  assert.match(md, /robin-security:start/);
  assert.match(md, /robin-security:end/);
});

test('buildSecurityBlock contains all required fields', () => {
  const block = buildSecurityBlock();
  assert.match(block, /robin-security:start/);
  assert.match(block, /robin-security:end/);
  assert.match(block, /no encryption at rest/i);
  assert.match(block, /FileVault/);
  assert.match(block, /LUKS/);
  assert.match(block, /secrets\//);
  assert.match(block, /outbound\/policy\.js/);
  assert.match(block, /trust='untrusted'/);
});

test('agentsMdContent security block appears after integrations block', () => {
  const md = agentsMdContent({ integrations: [] });
  const integrationsEnd = md.indexOf('<!-- robin-integrations:end -->');
  const securityStart = md.indexOf('<!-- robin-security:start');
  assert.ok(integrationsEnd !== -1, 'integrations end marker must exist');
  assert.ok(securityStart !== -1, 'security start marker must exist');
  assert.ok(securityStart > integrationsEnd, 'security block must come after integrations block');
});
