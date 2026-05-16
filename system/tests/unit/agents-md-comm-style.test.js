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

test('robin-comm-style — embeds long-form rules / character / personality when present', () => {
  const md = agentsMdContent({
    commStyle: {
      tone: 'terse',
      formality: 'casual',
      emoji_ok: false,
      direct_feedback_ok: true,
      code_comment_density: 'minimal',
      summary_style: 'bullets',
      confidence: 0.9,
      last_synthesized_at: new Date('2026-05-16T00:00:00Z'),
      'communication-style':
        '# Communication Style\n\n- **No summaries.** Skip the trailing summary block.\n',
      character: '# Character\n\n## Worldview\n\nSelf as instrumented system.\n',
      personality: '# Personality (Robin)\n\nDirect, practical, low-fluff.\n',
    },
  });
  assert.match(md, /### Active rules \(long form\)/);
  assert.match(md, /No summaries/);
  assert.match(md, /### Character — integrative read/);
  assert.match(md, /Self as instrumented system/);
  assert.match(md, /### Robin's personality/);
  assert.match(md, /Direct, practical, low-fluff/);
  // H1s inside embedded bodies should be stripped, and remaining H2s demoted
  // so they don't break the outline tree.
  assert.doesNotMatch(md, /^# Communication Style$/m);
  assert.doesNotMatch(md, /^## Worldview$/m);
  assert.match(md, /^### Worldview$/m);
});

test('robin-comm-style — omits long-form sections when bodies are empty', () => {
  const md = agentsMdContent({
    commStyle: {
      tone: 'terse',
      formality: 'casual',
      emoji_ok: false,
      direct_feedback_ok: true,
      code_comment_density: 'minimal',
      summary_style: 'bullets',
      confidence: 0.9,
      last_synthesized_at: new Date('2026-05-16T00:00:00Z'),
    },
  });
  assert.doesNotMatch(md, /### Active rules/);
  assert.doesNotMatch(md, /### Character/);
  assert.doesNotMatch(md, /### Robin's personality/);
});
