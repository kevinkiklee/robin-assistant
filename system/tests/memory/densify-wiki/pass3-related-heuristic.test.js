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

import { generatePairs } from '../../../scripts/memory/lib/related-heuristic.js';

test('generatePairs excludes same parent dir (sub-tree dampening)', () => {
  const matrix = new Map([
    ['profile/people/jake-lee.md', new Set(['mom', 'dad', 'home'])],
    ['profile/people/mom.md', new Set(['jake-lee', 'dad', 'home'])],
    ['knowledge/finance/snapshot.md', new Set(['jake-lee', 'mom', 'dad'])],
  ]);
  const pairs = generatePairs(matrix, { excludedSubtrees: [] });
  const pairKeys = pairs.map(p => [p.a, p.b].sort().join('::'));
  assert.ok(pairKeys.includes(
    ['profile/people/jake-lee.md', 'knowledge/finance/snapshot.md'].sort().join('::')
  ));
  assert.ok(!pairKeys.includes(
    ['profile/people/jake-lee.md', 'profile/people/mom.md'].sort().join('::')
  ));
});

test('generatePairs excludes archive, quarantine, conversations, calendar/events, transactions paths', () => {
  const matrix = new Map([
    ['archive/2024/old.md', new Set(['mom', 'dad'])],
    ['quarantine/captures.md', new Set(['mom', 'dad'])],
    ['knowledge/conversations/x.md', new Set(['mom', 'dad'])],
    ['knowledge/calendar/events/2026-01-01.md', new Set(['mom', 'dad'])],
    ['knowledge/finance/lunch-money/transactions/2026-03.md', new Set(['mom', 'dad'])],
    ['knowledge/finance/snapshot.md', new Set(['mom', 'dad'])],
    ['profile/people/jake-lee.md', new Set(['mom', 'dad'])],
  ]);
  const pairs = generatePairs(matrix, {});
  assert.equal(pairs.length, 1);
  const sorted = [pairs[0].a, pairs[0].b].sort();
  assert.deepEqual(sorted, ['knowledge/finance/snapshot.md', 'profile/people/jake-lee.md']);
});

test('generatePairs computes shared entity counts', () => {
  const matrix = new Map([
    ['profile/people/jake-lee.md', new Set(['mom', 'dad', 'home', 'morgan-stanley'])],
    ['knowledge/finance/snapshot.md', new Set(['jake-lee', 'mom', 'dad', 'morgan-stanley'])],
  ]);
  const pairs = generatePairs(matrix, {});
  assert.equal(pairs.length, 1);
  assert.deepEqual([...pairs[0].sharedEntities].sort(), ['dad', 'mom', 'morgan-stanley'].sort());
});
