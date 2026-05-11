#!/usr/bin/env node
// Generates 200 events across 5 topic clusters, plus 10 query/relevance pairs.
// Written deterministically so the recall-quality test is reproducible.

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '../tests/fixtures');

const CLUSTERS = [
  {
    name: 'cooking',
    sentences: [
      'I made a roast chicken with thyme and lemon.',
      'The pasta sauce simmered for two hours.',
      'Sourdough starter doubled overnight in the warm kitchen.',
      'Tried a new recipe for braised short ribs tonight.',
      'Whisked together a quick vinaigrette with mustard and shallot.',
      'The cake came out denser than expected; need less butter next time.',
      'Stocked the spice rack with cardamom and sumac.',
      'Slow-cooked beans with tomato and rosemary all afternoon.',
    ],
  },
  {
    name: 'photography',
    sentences: [
      'Shot a roll of Portra 400 at the riverbank at golden hour.',
      'The 50mm lens has the look I want for portraits.',
      'New prints arrived; the matte paper is gorgeous.',
      'Took a long-exposure of the bridge with a 10-stop ND filter.',
      'Backlight at noon flattened the contrast on the cliffs.',
      'The medium format negatives are scanning better than 35mm.',
      'Charged batteries and packed lenses for the photowalk.',
      'Tried HSS flash to balance midday sun on a model.',
    ],
  },
  {
    name: 'coding',
    sentences: [
      'Refactored the auth middleware to use async iterators.',
      'TypeScript narrowing finally caught the bug in the dispatcher.',
      'Wrote a tiny CLI parser; pushed the test suite to green.',
      'Replaced the React effect with a state machine via XState.',
      'The migration runner is idempotent now; checksums caught a stale file.',
      'Switched the embed model to bge and retook the latency numbers.',
      'CI is flaky on macOS — possibly the prebuild for the native engine.',
      'Profiling showed the hot loop spent 80% of time in JSON.stringify.',
    ],
  },
  {
    name: 'travel',
    sentences: [
      'Booked a flight to Lisbon for early October.',
      'The train from Kyoto to Osaka was on time and quiet.',
      'Walked the coastal path at sunrise; saw seals on the rocks.',
      'Hostel in Porto had the best breakfast of the trip.',
      'Lost my hat to the wind on the ferry across the strait.',
      'Bus passes saved a fortune in Buenos Aires.',
      'The Lonely Planet 2024 edition was already out of date.',
      'A two-week itinerary felt rushed; would do three next time.',
    ],
  },
  {
    name: 'reading',
    sentences: [
      'Finished Sebald late last night; the digressions are unforgettable.',
      'Picked up Le Guin again — every paragraph rewards rereading.',
      'The biography of Borges has too many footnotes.',
      'Switched to a paper book after a month of e-ink fatigue.',
      'Found a first edition Calvino at the secondhand shop.',
      'Returned three library books I never finished.',
      'The poetry anthology arranged by season is a perfect bedside book.',
      'Started Thinking, Fast and Slow again — the priming chapters age oddly.',
    ],
  },
];

const events = [];
let nextId = 0;
for (const c of CLUSTERS) {
  // 40 events per cluster — repeat the eight base sentences with light variation
  for (let i = 0; i < 40; i++) {
    const base = c.sentences[i % c.sentences.length];
    const suffix = i < 8 ? '' : ` (note ${Math.floor(i / 8)})`;
    events.push({
      id: `synthetic:${nextId++}`,
      source: 'cli',
      content: base + suffix,
      cluster: c.name,
    });
  }
}

const pairs = [
  { query: 'what should I cook for dinner', cluster: 'cooking' },
  { query: 'film photography tips', cluster: 'photography' },
  { query: 'auth middleware refactor', cluster: 'coding' },
  { query: 'planning a trip to Portugal', cluster: 'travel' },
  { query: 'recently finished books', cluster: 'reading' },
  { query: 'long exposure with ND filter', cluster: 'photography' },
  { query: 'how to use TypeScript narrowing', cluster: 'coding' },
  { query: 'sourdough bread baking', cluster: 'cooking' },
  { query: 'train travel in Japan', cluster: 'travel' },
  { query: 'Le Guin novels', cluster: 'reading' },
];

await mkdir(outDir, { recursive: true });
await writeFile(resolve(outDir, 'synthetic-events.json'), JSON.stringify(events, null, 2));
await writeFile(resolve(outDir, 'seed-recall-pairs.json'), JSON.stringify(pairs, null, 2));
console.log(`wrote ${events.length} events, ${pairs.length} pairs to ${outDir}`);
