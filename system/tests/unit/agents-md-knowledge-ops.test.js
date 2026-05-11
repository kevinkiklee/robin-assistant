import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentsMdContent } from '../../src/install/agents-md.js';

test('agentsMdContent — knowledge-ops block present', () => {
  const md = agentsMdContent({});
  assert.match(md, /<!-- robin-knowledge-ops:start/);
  assert.match(md, /<!-- robin-knowledge-ops:end -->/);
});

test('agentsMdContent — knowledge-ops mentions all three tools by name', () => {
  const md = agentsMdContent({});
  assert.match(md, /\bingest\b/);
  assert.match(md, /\blint\b/);
  assert.match(md, /\baudit\b/);
});

test('agentsMdContent — knowledge-ops emphasizes user-triggered', () => {
  const md = agentsMdContent({});
  assert.match(md, /user-triggered/i);
  assert.match(md, /never.*autonomous/i);
});
