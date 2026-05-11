// tests/unit/comm-style-helpers.test.js
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import {
  DEFAULTS,
  getCommStyle,
  setCommStyle,
  validateCommStyleShape,
} from '../../cognition/jobs/comm-style.js';

import { writeConfig as __wc } from '../../config/paths.js';

const __h = join(tmpdir(), `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
mkdirSync(__h, { recursive: true });
process.env.ROBIN_HOME = __h;
await __wc({ embedder_profile: 'mxbai-1024' });

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  return db;
}

test('DEFAULTS shape', () => {
  assert.equal(DEFAULTS.tone, 'balanced');
  assert.equal(DEFAULTS.formality, 'balanced');
  assert.equal(DEFAULTS.emoji_ok, false);
  assert.equal(DEFAULTS.direct_feedback_ok, true);
  assert.equal(DEFAULTS.code_comment_density, 'minimal');
  assert.equal(DEFAULTS.summary_style, 'mixed');
});

test('getCommStyle returns null when unset', async () => {
  const db = await fresh();
  const r = await getCommStyle(db);
  assert.equal(r, null);
  await close(db);
});

test('setCommStyle persists + getCommStyle reads back', async () => {
  const db = await fresh();
  await setCommStyle(db, {
    tone: 'terse',
    formality: 'casual',
    emoji_ok: false,
    direct_feedback_ok: true,
    code_comment_density: 'minimal',
    summary_style: 'bullets',
    evidence: ['events:abc'],
    confidence: 0.7,
  });
  const r = await getCommStyle(db);
  assert.equal(r.tone, 'terse');
  assert.equal(r.summary_style, 'bullets');
  assert.equal(r.confidence, 0.7);
  assert.ok(r.last_synthesized_at instanceof Date);
  await close(db);
});

test('validateCommStyleShape accepts valid', () => {
  const r = validateCommStyleShape({
    tone: 'terse',
    formality: 'casual',
    emoji_ok: false,
    direct_feedback_ok: true,
    code_comment_density: 'minimal',
    summary_style: 'bullets',
    confidence: 0.5,
  });
  assert.equal(r.ok, true);
});

test('validateCommStyleShape rejects bad enum', () => {
  const r = validateCommStyleShape({
    tone: 'shouty', // invalid
    formality: 'casual',
    emoji_ok: false,
    direct_feedback_ok: true,
    code_comment_density: 'minimal',
    summary_style: 'bullets',
    confidence: 0.5,
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /tone/);
});

test('validateCommStyleShape clamps confidence out of range', () => {
  const r = validateCommStyleShape({
    tone: 'terse',
    formality: 'casual',
    emoji_ok: false,
    direct_feedback_ok: true,
    code_comment_density: 'minimal',
    summary_style: 'bullets',
    confidence: 1.7, // out of range
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /confidence/);
});

test('validateCommStyleShape rejects non-boolean booleans', () => {
  const r = validateCommStyleShape({
    tone: 'terse',
    formality: 'casual',
    emoji_ok: 'yes', // string not bool
    direct_feedback_ok: true,
    code_comment_density: 'minimal',
    summary_style: 'bullets',
    confidence: 0.5,
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /emoji_ok/);
});
