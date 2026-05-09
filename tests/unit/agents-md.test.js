import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentsMdContent, mergeAgentsMdContent } from '../../src/install/agents-md.js';

test('agentsMdContent mentions all 10 tools', () => {
  const md = agentsMdContent();
  for (const tool of [
    'recall',
    'remember',
    'run_biographer',
    'find_entity',
    'get_entity',
    'related_entities',
    'list_episodes',
    'health',
    'mark_recall_used',
    'record_correction',
  ]) {
    assert.match(md, new RegExp(tool), `expected AGENTS.md to mention ${tool}`);
  }
});

test('agentsMdContent has feedback section', () => {
  const md = agentsMdContent();
  assert.match(md, /Feedback/);
  assert.match(md, /correction/i);
});

test('mergeAgentsMdContent fences the Robin section', () => {
  const merged = mergeAgentsMdContent('', agentsMdContent());
  assert.match(merged, /<!-- robin-mcp:start -->/);
  assert.match(merged, /<!-- robin-mcp:end -->/);
});

test('mergeAgentsMdContent preserves existing content outside the fence', () => {
  const existing = '# My personal notes\n\nSomething about me.\n';
  const merged = mergeAgentsMdContent(existing, agentsMdContent());
  assert.ok(merged.startsWith('# My personal notes'));
  assert.match(merged, /<!-- robin-mcp:start -->/);
});

test('mergeAgentsMdContent replaces an existing fenced section, does not duplicate', () => {
  const first = mergeAgentsMdContent('# Existing\n', agentsMdContent());
  const second = mergeAgentsMdContent(first, agentsMdContent());
  const startMatches = second.match(/<!-- robin-mcp:start -->/g) ?? [];
  assert.equal(startMatches.length, 1);
});
