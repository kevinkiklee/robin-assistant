import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentsMdContent } from '../../runtime/install/agents-md.js';

test('robin-comm-style block exists', () => {
  const md = agentsMdContent({});
  assert.match(md, /<!-- robin-comm-style:start/);
  assert.match(md, /<!-- robin-comm-style:end -->/);
});

test('robin-comm-style — null shape shows "no comm-style inferred yet" fallback', () => {
  const md = agentsMdContent({ commStyle: null });
  assert.match(md, /no comm-style inferred yet/i);
});

test('robin-comm-style — populated shape shows fields', () => {
  const md = agentsMdContent({
    commStyle: {
      tone: 'terse',
      formality: 'casual',
      emoji_ok: false,
      direct_feedback_ok: true,
      code_comment_density: 'minimal',
      summary_style: 'bullets',
      confidence: 0.7,
      last_synthesized_at: new Date('2026-05-10T04:00:00Z'),
    },
  });
  assert.match(md, /tone:\s*"terse"/);
  assert.match(md, /confidence:\s*0\.7/);
});

test('robin-comm-style — mentions get_comm_style for re-read', () => {
  const md = agentsMdContent({});
  assert.match(md, /get_comm_style/);
});
