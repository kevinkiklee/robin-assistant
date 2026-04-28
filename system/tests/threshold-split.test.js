import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planSplit } from '../scripts/lib/memory-index.js';

const SAMPLE = `---
description: Provider list
---
# Medical

## Providers

- Dr. A
- Dr. B
- Dr. C

## Medications

- Med A
- Med B
- Med C

## Screenings

- Screen A
`;

test('planSplit returns null when below threshold', () => {
  assert.equal(planSplit(SAMPLE, { threshold: 100 }), null);
});

test('planSplit splits at level-2 headings when over threshold', () => {
  const plan = planSplit(SAMPLE, { threshold: 5 });
  assert.equal(plan.level, 2);
  assert.equal(plan.children.length, 3);
  assert.equal(plan.children[0].slug, 'providers');
  assert.equal(plan.children[1].slug, 'medications');
  assert.equal(plan.children[2].slug, 'screenings');
  assert.ok(plan.children[0].body.startsWith('## Providers'));
});

test('planSplit promotes deeper headings when level-2 yields one child', () => {
  const deep = `---
description: Urban photos
---
# Urban

## Urban (Astoria/Queens/NYC streets)

### Batch U1

- a
- b
- c

### Batch U2

- d
- e
- f

### Batch U3

- g
- h
- i
`;
  const plan = planSplit(deep, { threshold: 5 });
  assert.equal(plan.level, 3);
  assert.equal(plan.children.length, 3);
  assert.equal(plan.children[0].slug, 'batch-u1');
  assert.equal(plan.children[1].slug, 'batch-u2');
  assert.equal(plan.children[2].slug, 'batch-u3');
});

test('planSplit returns null when content has no level-2+ headings', () => {
  const plain = '# Plain\n\nlots\nof\nlines\n'.repeat(50);
  // Frontmatter parser requires the leading --- block, so this content has none and
  // is treated entirely as body. parseHeadings finds no level-2+ — returns null.
  assert.equal(planSplit(plain, { threshold: 5 }), null);
});

test('planSplit disambiguates duplicate child slugs', () => {
  const dup = `# Top

## Same

a
b
c
d

## Same

e
f
g
h
`;
  const plan = planSplit(dup, { threshold: 3 });
  assert.equal(plan.children[0].slug, 'same');
  assert.equal(plan.children[1].slug, 'same-2');
});
