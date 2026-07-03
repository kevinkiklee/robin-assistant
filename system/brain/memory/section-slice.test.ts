import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hasSliceableSections, sliceToRelevantSection } from './section-slice.ts';

/** Build a doc big enough to clear the default 1500-char min-body gate. */
function bigDoc(): string {
  return [
    '# Photography Gear',
    '',
    'Intro about the overall kit and philosophy.',
    'a'.repeat(400),
    '',
    '## Bodies',
    'The Nikon Zf is the primary body for low-light street and subway work.',
    'b'.repeat(400),
    '',
    '## Lenses',
    'The Viltrox 85mm f/2 is the canonical portrait lens. Also a Z 100-400 telephoto.',
    'c'.repeat(400),
    '',
    '## Accessories',
    'Tripods, filters, and a UGREEN NAS for the Lightroom archive.',
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
  const out = sliceToRelevantSection(bigDoc(), 'what lenses do I own');
  assert.match(out, /Photography Gear › Lenses:/);
  assert.match(out, /Viltrox 85mm/);
  assert.doesNotMatch(out, /Zf is the primary/); // the Bodies section is excluded
});

test('heading match outweighs body mentions', () => {
  // "bodies" appears once in the Bodies heading; pick that section over others.
  const out = sliceToRelevantSection(bigDoc(), 'camera bodies');
  assert.match(out, /› Bodies:/);
  assert.match(out, /Nikon Zf/);
});

test('zero lexical overlap falls back to the unchanged body', () => {
  const body = bigDoc();
  const out = sliceToRelevantSection(body, 'quantum chromodynamics tensor');
  assert.equal(out, body);
});

test('the preamble can be selected and its H1 is not echoed in the text', () => {
  const out = sliceToRelevantSection(bigDoc(), 'philosophy of the overall kit');
  // preamble has no heading → breadcrumb is just the doc title
  assert.match(out, /^Photography Gear:/);
  assert.match(out, /philosophy/);
  // the H1 line itself must not be duplicated into the body text
  assert.doesNotMatch(out, /Photography Gear:.*# Photography Gear/s);
});

test('maxSections:2 returns the top two matching sections in document order', () => {
  // Lenses and Accessories both score on their headings; Bodies scores nothing.
  const out = sliceToRelevantSection(bigDoc(), 'lenses and accessories', { maxSections: 2 });
  assert.match(out, /› Lenses:/);
  assert.match(out, /Viltrox 85mm/);
  assert.match(out, /› Accessories:/);
  assert.match(out, /UGREEN NAS/);
  // Bodies scored zero → excluded.
  assert.doesNotMatch(out, /Zf is the primary/);
  // Presented in document order (Lenses precedes Accessories), not relevance order.
  assert.ok(out.indexOf('Lenses') < out.indexOf('Accessories'), 'expected document order');
});

test('maxSections defaults to 1 — only the single best section', () => {
  const out = sliceToRelevantSection(bigDoc(), 'lenses and accessories');
  assert.match(out, /Viltrox 85mm/);
  assert.doesNotMatch(out, /UGREEN NAS/); // second-best section not included
});

test('maxChars packs whole sections greedily, always keeping the top one', () => {
  // The top section alone exceeds the tiny budget; it is kept anyway, the next is dropped.
  const out = sliceToRelevantSection(bigDoc(), 'lenses and accessories', {
    maxSections: 2,
    maxChars: 200,
  });
  assert.match(out, /Viltrox 85mm/); // top section always present
  assert.doesNotMatch(out, /UGREEN NAS/); // adding it would blow the budget
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

test('keyword-rich heading slices to the histogram section', () => {
  const doc = [
    '# Nikon Z8 — Operational Reference',
    'Last verified: 2026-07-03 · FW 2.10',
    '',
    '## Autofocus — AF-area modes, subject detection, AF-ON / back-button',
    'Back-button AF: assign AF-ON, disable shutter-button AF in custom settings.',
    'y'.repeat(1000),
    '',
    '## Histograms & displays — luminance, RGB / per-channel, highlights & blinkies',
    'Playback RGB / per-channel histogram: MENU -> Playback display options -> enable',
    'RGB histogram; cycle with DISP in playback. Red channel clips first under tungsten.',
    'x'.repeat(1000),
  ].join('\n');
  const out = sliceToRelevantSection(doc, 'how do I see the per-channel histogram');
  assert.match(out, /Histograms & displays/);
  assert.match(out, /RGB histogram/);
  // Histograms is the SECOND section — this also rejects a "return the first section" slicer.
  assert.doesNotMatch(out, /Back-button AF/);
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
    '# Nikon Z8 — Operational Reference',
    'Last verified: 2026-07-03 · FW 2.10',
    '',
    '## Autofocus — AF-area modes, subject detection, AF-ON / back-button',
    'The per-channel histogram is hidden while subject tracking is active.',
    'y'.repeat(1000),
    '',
    '## Histograms & displays — luminance, RGB / per-channel, highlights & blinkies',
    'Enable it under Playback display options; press DISP to cycle the readout.',
    'x'.repeat(1000),
  ].join('\n');
  // Query tokens (per, channel, histogram) appear in the Autofocus BODY (3 body pts) but in the
  // Histograms HEADING only — the Histograms body has none (0 body pts). Histograms wins solely
  // via the 2x heading weight (2*3 = 6 > 3); a heading-blind or heading-1x slicer would return
  // Autofocus. This isolates heading-weight as the deciding factor.
  const out = sliceToRelevantSection(doc, 'per-channel histogram');
  assert.match(out, /Histograms & displays/);
  assert.doesNotMatch(out, /subject tracking/);
});
