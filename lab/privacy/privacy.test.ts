import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import {
  getDefaultPrompt,
  getPrompt,
  PROMPT_KEYS,
  resetPrompts,
  setPrompts,
} from '../../system/brain/cognition/prompts.ts';
import { buildFixture } from '../render/fixture.ts';
import { paramsWith } from '../script/params.ts';
import { localForbidden, scanText } from './forbidden.ts';
import { simPrompts } from './sim-prompts.ts';

afterEach(() => resetPrompts());

test('privacy: the scan catches the generic shapes (sanity)', () => {
  assert.ok(scanText('reach me at someone@example.com').length > 0);
  assert.ok(scanText('a rule he follows').length > 0);
});

test('privacy: the code prompt defaults are clean (personal context lives in user-data)', () => {
  for (const k of PROMPT_KEYS) assert.deepEqual(scanText(getDefaultPrompt(k)), [], k);
});

test('privacy: every effective sim prompt is clean', () => {
  setPrompts(simPrompts());
  for (const k of PROMPT_KEYS) assert.deepEqual(scanText(getPrompt(k)), [], k);
});

test('privacy: sim prompts keep the production instructions (same JSON contracts)', () => {
  const sim = simPrompts();
  assert.ok(sim['biographer.claims'].includes('{"claims":[{"topic"'));
  assert.ok(sim['biographer.entities'].includes('{{USER_CONTEXT}}'));
  assert.ok(sim['reconcile.judge'].includes("'contradicts'"));
});

test('privacy: a rendered fixture contains no forbidden strings', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lab-privacy-'));
  buildFixture(dir, paramsWith({ horizonDays: 60 }), 31);
  for (const f of ['script.json', 'stream.jsonl', 'meta.json']) {
    assert.deepEqual(scanText(readFileSync(join(dir, f), 'utf8')), [], f);
  }
});

test('privacy: local operator terms are matched case-insensitively', () => {
  for (const re of localForbidden()) assert.ok(re.flags.includes('i'), re.source);
  assert.deepEqual(scanText('job-role and sleep-recovery'), []);
});
