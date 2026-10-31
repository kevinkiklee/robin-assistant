import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hasSliceableSections, sliceToRelevantSection } from './section-slice.ts';

/** Build a doc big enough to clear the default 1500-char min-body gate. */
function bigDoc(): string {
  return [
    '# Kitchen Gear',
    '',
    'Intro about the overall kit and philosophy.',
    'a'.repeat(400),
    '',
    '## Cookware',
    'The Acme cast-iron skillet is the main pan for weeknights.',
    'b'.repeat(400),
    '',
    '## Knives',
    'The Acme 8-inch chef knife is the go-to blade. Also an Acme paring knife.',
    'c'.repeat(400),
    '',
    '## Accessories',
    'Cutting boards, timers, and a spare apron for messy days.',
    'd'.repeat(400),
  ].join('\n');
}

test('small bodies pass through untouched', () => {
  const body = '## A\nshort\n## B\nalso short';
  assert.equal(sliceToRelevantSection(body, 'A', { minBodyChars: 1500 }), body);
});

test('a doc with no H2 structure is returned unchanged', () => {
  const body = `# Title\n${'x'.repeat(2000)}`;
  assert.equal(sliceToRelevantSection(body, 'anything', { minBodyChars: 100 }), body);
});

test('slices to the section matching the query, with a breadcrumb', () => {
  const out = sliceToRelevantSection(bigDoc(), 'what knives do I own');
  assert.match(out, /Kitchen Gear › Knives:/);
  assert.match(out, /Acme 8-inch/);
  assert.doesNotMatch(out, /skillet is the main pan/); // the Cookware section is excluded
});

test('heading match outweighs body mentions', () => {
  // "cookware" appears once in the Cookware heading; pick that section over others.
  const out = sliceToRelevantSection(bigDoc(), 'stovetop cookware');
  assert.match(out, /› Cookware:/);
  assert.match(out, /Acme cast-iron/);
});

test('zero lexical overlap falls back to the unchanged body', () => {
  const body = bigDoc();
  const out = sliceToRelevantSection(body, 'quantum chromodynamics tensor');
  assert.equal(out, body);
});

test('the preamble can be selected and its H1 is not echoed in the text', () => {
  const out = sliceToRelevantSection(bigDoc(), 'philosophy of the overall kit');
  // preamble has no heading → breadcrumb is just the doc title
  assert.match(out, /^Kitchen Gear:/);
  assert.match(out, /philosophy/);
  // the H1 line itself must not be duplicated into the body text
  assert.doesNotMatch(out, /Kitchen Gear:.*# Kitchen Gear/s);
});

test('maxSections:2 returns the top two matching sections in document order', () => {
  // Knives and Accessories both score on their headings; Cookware scores nothing.
  const out = sliceToRelevantSection(bigDoc(), 'knives and accessories', { maxSections: 2 });
  assert.match(out, /› Knives:/);
  assert.match(out, /Acme 8-inch/);
  assert.match(out, /› Accessories:/);
  assert.match(out, /spare apron/);
  // Cookware scored zero → excluded.
  assert.doesNotMatch(out, /skillet is the main pan/);
  // Presented in document order (Knives precedes Accessories), not relevance order.
  assert.ok(out.indexOf('Knives') < out.indexOf('Accessories'), 'expected document order');
});

test('maxSections defaults to 1 — only the single best section', () => {
  const out = sliceToRelevantSection(bigDoc(), 'knives and accessories');
  assert.match(out, /Acme 8-inch/);
  assert.doesNotMatch(out, /spare apron/); // second-best section not included
});

test('maxChars packs whole sections greedily, always keeping the top one', () => {
  // The top section alone exceeds the tiny budget; it is kept anyway, the next is dropped.
  const out = sliceToRelevantSection(bigDoc(), 'knives and accessories', {
    maxSections: 2,
    maxChars: 200,
  });
  assert.match(out, /Acme 8-inch/); // top section always present
  assert.doesNotMatch(out, /spare apron/); // adding it would blow the budget
});

test('`##` inside a fenced code block is not a section boundary', () => {
  const body = [
    '# Config',
    '',
    'Intro line for the config doc that is reasonably long to set context.',
    'e'.repeat(400),
    '',
    '## Real Section',
    'Body about deployment and the daemon restart procedure here.',
    '```sh',
    '## not a heading, just a shell comment',
    'launchctl kickstart -k gui/$(id -u)/io.robin-assistant.daemon',
    '```',
    'f'.repeat(400),
  ].join('\n');
  const out = sliceToRelevantSection(body, 'deployment daemon restart', { minBodyChars: 100 });
  assert.match(out, /› Real Section:/);
  // The fenced "## not a heading" must remain inside this section, not split into its own.
  assert.match(out, /not a heading, just a shell comment/);
});

test('keyword-rich heading slices to the revival section', () => {
  const doc = [
    '# Sourdough care',
    '',
    '## Feeding — flour ratio, water temperature, schedule',
    'Discard half, then stir in equal weights of rye flour and lukewarm water.',
    'y'.repeat(1000),
    '',
    '## Storage & revival — fridge rest, hooch, sluggish starters',
    'Pour off the grey liquid, then feed twice at room temperature;',
    'a sluggish starter should double again within a day.',
    'x'.repeat(1000),
  ].join('\n');
  const out = sliceToRelevantSection(doc, 'how do I revive a sluggish starter');
  assert.match(out, /Storage & revival/);
  assert.match(out, /double again/);
  // Revival is the SECOND section — this also rejects a "return the first section" slicer.
  assert.doesNotMatch(out, /Discard half/);
});

test('hasSliceableSections: true for real H2s; false for none or fenced-only ##', () => {
  assert.equal(hasSliceableSections(['# T', '', '## A', 'body', '## B', 'more'].join('\n')), true);
  assert.equal(hasSliceableSections('# T\nonly a preamble, no sections'), false);
  // A `##` that lives only inside a fenced code block is NOT a real section boundary.
  const fenced = ['# T', 'intro', '```', '## not a heading', '```'].join('\n');
  assert.equal(hasSliceableSections(fenced), false);
});

test('a keyword-rich heading outweighs a section that scores higher on body tokens alone', () => {
  const doc = [
    '# Sourdough care',
    '',
    '## Feeding — flour ratio, water temperature, schedule',
    'A sluggish starter wants warmer water; revival can take three feedings.',
    'y'.repeat(1000),
    '',
    '## Storage & revival — fridge rest, hooch, sluggish starters',
    'Keep the jar loosely lidded at the back of the fridge between bakes.',
    'x'.repeat(1000),
  ].join('\n');
  // Query tokens (sluggish, starter, revival) appear in the Feeding BODY (3 body pts) but in
  // the Storage HEADING only — the Storage body has none (0 body pts). Storage wins solely
  // via the 2x heading weight (2*3 = 6 > 3); a heading-blind or heading-1x slicer would return
  // Feeding. This isolates heading-weight as the deciding factor.
  const out = sliceToRelevantSection(doc, 'sluggish starter revival');
  assert.match(out, /Storage & revival/);
  assert.doesNotMatch(out, /warmer water/);
});
