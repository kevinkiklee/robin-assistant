import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sliceToRelevantSection } from './section-slice.ts';

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
