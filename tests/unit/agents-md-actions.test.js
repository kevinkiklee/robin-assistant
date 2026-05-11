// tests/unit/agents-md-actions.test.js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentsMdContent } from '../../src/install/agents-md.js';

test('robin-actions block exists', () => {
  const md = agentsMdContent({});
  assert.match(md, /<!-- robin-actions:start/);
  assert.match(md, /<!-- robin-actions:end -->/);
});

test('robin-actions describes AUTO/ASK/NEVER', () => {
  const md = agentsMdContent({});
  assert.match(md, /AUTO/);
  assert.match(md, /ASK/);
  assert.match(md, /NEVER/);
});

test('robin-actions mentions force:true and update_action_policy', () => {
  const md = agentsMdContent({});
  assert.match(md, /force:\s*true|force: true/);
  assert.match(md, /update_action_policy/);
});
