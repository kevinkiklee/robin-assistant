import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { buildMentionMatrix } from '../../../scripts/memory/lib/related-heuristic.js';

test('buildMentionMatrix maps file → set of entity slugs', () => {
  const files = new Map([
    ['profile/people/jake-lee.md', `# Jake Lee\n\nMet with Mom and Dad at home.`],
    ['knowledge/finance/snapshot.md', `Beneficiary: Jake. Account at Morgan Stanley.`],
    ['archive/old.md', `Just words.`],
  ]);
  const registry = [
    { slug: 'jake-lee', aliases: ['Jake', 'Jake Lee', 'Joony'] },
    { slug: 'mom', aliases: ['Mom', 'Umma'] },
    { slug: 'dad', aliases: ['Dad', 'Appa'] },
    { slug: 'morgan-stanley', aliases: ['Morgan Stanley'] },
    { slug: 'home', aliases: ['home', 'Astoria apartment'] },
  ];
  const matrix = buildMentionMatrix(files, registry);
  assert.deepEqual([...matrix.get('profile/people/jake-lee.md')].sort(), ['dad', 'home', 'mom'].sort());
  assert.deepEqual([...matrix.get('knowledge/finance/snapshot.md')].sort(), ['jake-lee', 'morgan-stanley'].sort());
  assert.deepEqual([...matrix.get('archive/old.md')], []);
});

test('buildMentionMatrix skips frontmatter and code fences', () => {
  const files = new Map([
    ['x.md', `---\naliases: [Jake]\n---\n\nReal text mentions Mom.\n\n\`\`\`\nMom in code\n\`\`\`\n`],
  ]);
  const registry = [{ slug: 'mom', aliases: ['Mom'] }];
  const matrix = buildMentionMatrix(files, registry);
  assert.deepEqual([...matrix.get('x.md')], ['mom']);
});

test('buildMentionMatrix matches whole words only (no substrings)', () => {
  const files = new Map([
    ['x.md', `Discussion of momentum and momentary lapses.`],
  ]);
  const registry = [{ slug: 'mom', aliases: ['Mom'] }];
  const matrix = buildMentionMatrix(files, registry);
  assert.deepEqual([...matrix.get('x.md')], []);
});
