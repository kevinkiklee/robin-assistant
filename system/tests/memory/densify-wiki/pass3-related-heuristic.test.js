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

import { computeSuperHubs, applySuperHubFilter } from '../../../scripts/memory/lib/related-heuristic.js';

test('computeSuperHubs returns top-N% most-mentioned slugs', () => {
  const matrix = new Map([
    ['a.md', new Set(['kevin', 'mom'])],
    ['b.md', new Set(['kevin', 'dad'])],
    ['c.md', new Set(['kevin', 'home'])],
    ['d.md', new Set(['kevin'])],
    ['e.md', new Set(['mom'])],
    ['f.md', new Set(['dad'])],
    ['g.md', new Set(['home'])],
    ['h.md', new Set(['rare'])],
  ]);
  // 5 distinct slugs (kevin, mom, dad, home, rare); top 5% = ceil(0.25) = 1; "kevin" is most mentioned (4).
  const hubs = computeSuperHubs(matrix, { pct: 0.05 });
  assert.deepEqual([...hubs], ['kevin']);
});

test('applySuperHubFilter removes super-hubs from each pair shared set', () => {
  const pairs = [{
    a: 'x.md', b: 'y.md',
    sharedEntities: new Set(['kevin', 'mom', 'dad']),
  }];
  const filtered = applySuperHubFilter(pairs, new Set(['kevin']));
  assert.deepEqual([...filtered[0].sharedEntities].sort(), ['dad', 'mom']);
});

import { selectEdges } from '../../../scripts/memory/lib/related-heuristic.js';

test('selectEdges enforces top-K outbound + threshold + symmetric', () => {
  const pairs = [
    { a: 'x.md', b: 'y.md', sharedEntities: new Set(['m', 'n', 'o']) },
    { a: 'x.md', b: 'z.md', sharedEntities: new Set(['m', 'n', 'o', 'p', 'q']) },
    { a: 'x.md', b: 'w.md', sharedEntities: new Set(['m', 'n']) },           // overlap=2 fails threshold=3
    { a: 'x.md', b: 'v.md', sharedEntities: new Set(['m', 'n', 'o', 'p']) },
    { a: 'x.md', b: 'u.md', sharedEntities: new Set(['m', 'n', 'o']) },
    { a: 'x.md', b: 't.md', sharedEntities: new Set(['m', 'n', 'o']) },
    { a: 'x.md', b: 's.md', sharedEntities: new Set(['m', 'n', 'o']) },
  ];
  const existing = new Map();
  const edges = selectEdges(pairs, { threshold: 3, topK: 5, totalCap: 10, existing });
  assert.equal(edges.get('x.md').size, 5);
  for (const target of edges.get('x.md')) {
    assert.ok(edges.get(target).has('x.md'), `${target} missing back-edge`);
  }
  assert.ok(!edges.has('w.md'), 'w should not appear at all (under threshold)');
});

test('selectEdges preserves hand-curated existing edges (set union)', () => {
  const pairs = [
    { a: 'x.md', b: 'y.md', sharedEntities: new Set(['m', 'n', 'o']) },
  ];
  const existing = new Map([['x.md', new Set(['hand-curated.md'])]]);
  const edges = selectEdges(pairs, { threshold: 3, topK: 5, totalCap: 10, existing });
  assert.ok(edges.get('x.md').has('hand-curated.md'));
  assert.ok(edges.get('x.md').has('y.md'));
});

test('selectEdges respects totalCap when inbound additions arrive', () => {
  const pairs = Array.from({ length: 12 }, (_, i) => ({
    a: `f${i}.md`, b: 'z.md', sharedEntities: new Set(['m', 'n', 'o']),
  }));
  const edges = selectEdges(pairs, { threshold: 3, topK: 5, totalCap: 10, existing: new Map() });
  assert.ok(edges.get('z.md').size <= 10, `z.md has ${edges.get('z.md').size} edges, expected ≤ 10`);
});
