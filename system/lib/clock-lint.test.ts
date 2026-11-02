import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { ageDaysFrom } from '../brain/memory/provenance.ts';
import { setClock } from './clock.ts';

const ROOT = join(import.meta.dirname, '..');
// Files on the lab's read/score paths: every "now" must come from lib/clock.ts.
const CLOCKED = [
  'brain/memory/provenance.ts',
  'brain/memory/recall.ts',
  'brain/cognition/recall-audit.ts',
  'brain/memory/correction-recall.ts',
  'brain/memory/compact-sessions.ts',
  'brain/memory/recall-replay.ts',
];

afterEach(() => setClock(null));

test('clock lint: lab read paths never read the wall clock directly', () => {
  for (const rel of CLOCKED) {
    const src = readFileSync(join(ROOT, rel), 'utf8');
    assert.doesNotMatch(src, /new Date\(\)|Date\.now\(\)/, `${rel} reads the wall clock`);
  }
});

test('ageDaysFrom defaults to the lab clock', () => {
  setClock(() => Date.parse('2027-03-11T00:00:00Z'));
  assert.equal(ageDaysFrom('2027-03-01T00:00:00Z'), 10);
});
