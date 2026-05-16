import assert from 'node:assert/strict';
import { mkdirSync as __robinMkdirSync } from 'node:fs';
import { tmpdir as __robinTmpdir } from 'node:os';
import { join as __robinJoin, resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import {
  extractMNTokens,
  findInsight,
  recordInsightFeedback,
} from '../../cognition/briefing/feedback.js';
import { writeConfig as __robinWriteConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';

const __robinTestHome = __robinJoin(
  __robinTmpdir(),
  `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`,
);
__robinMkdirSync(__robinTestHome, { recursive: true });
process.env.ROBIN_HOME = __robinTestHome;
await __robinWriteConfig({ embedder_profile: 'mxbai-1024' });

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
  return db;
}

async function seedBrief(db, insights) {
  await db
    .query(
      surql`CREATE events CONTENT {
        source: 'daily_briefing',
        content: 'fixture brief',
        ts: time::now(),
        meta: ${{ insights }}
      }`,
    )
    .collect();
}

test('extractMNTokens finds [mN] tokens with word boundaries', () => {
  assert.deepEqual(extractMNTokens('the m3 insight wasn\'t useful'), ['m3']);
  assert.deepEqual(extractMNTokens('M1 was great but m7 missed'), ['m1', 'm7']);
  assert.deepEqual(extractMNTokens('imagined as M9 — m12 too').sort(), ['m12', 'm9']);
  // No false matches inside other words
  assert.deepEqual(extractMNTokens('mistakes happen, item miscellaneous'), []);
  // Long tokens stay capped at 3 digits per regex
  assert.deepEqual(extractMNTokens('m1234 should not match'), []);
});

test('findInsight returns category and text from latest brief', async () => {
  const db = await fresh();
  try {
    await seedBrief(db, {
      watching: [{ id: 'm1', category: 'recovery_correlation', text: 'sleep 9%' }],
      learned: [],
      section: {},
      photo_critique: { supportive: [], improvement: [] },
    });
    const found = await findInsight(db, 'm1');
    assert.ok(found);
    assert.equal(found.category, 'recovery_correlation');
    assert.equal(found.text, 'sleep 9%');
  } finally {
    await close(db);
  }
});

test('findInsight returns null for unknown id', async () => {
  const db = await fresh();
  try {
    await seedBrief(db, {
      watching: [{ id: 'm1', category: 'x', text: 'y' }],
      learned: [],
      section: {},
      photo_critique: { supportive: [], improvement: [] },
    });
    const found = await findInsight(db, 'm99');
    assert.equal(found, null);
  } finally {
    await close(db);
  }
});

test('recordInsightFeedback writes events:insight_feedback with category', async () => {
  const db = await fresh();
  try {
    await seedBrief(db, {
      watching: [{ id: 'm1', category: 'recovery_correlation', text: 'sleep 9%' }],
      learned: [],
      section: {},
      photo_critique: { supportive: [], improvement: [] },
    });
    const r = await recordInsightFeedback(db, { insightId: 'm1', verdict: 'bad' });
    assert.equal(r.ok, true);
    assert.equal(r.category, 'recovery_correlation');
    const [rows] = await db
      .query(surql`SELECT meta FROM events WHERE source = 'insight_feedback'`)
      .collect();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].meta.category, 'recovery_correlation');
    assert.equal(rows[0].meta.verdict, 'bad');
  } finally {
    await close(db);
  }
});

test('recordInsightFeedback rejects invalid verdict', async () => {
  const db = await fresh();
  try {
    const r = await recordInsightFeedback(db, { insightId: 'm1', verdict: 'maybe' });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'invalid_verdict');
  } finally {
    await close(db);
  }
});

test('recordInsightFeedback rejects when insight not in any recent brief', async () => {
  const db = await fresh();
  try {
    const r = await recordInsightFeedback(db, { insightId: 'm99', verdict: 'good' });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'insight_not_found');
  } finally {
    await close(db);
  }
});

test('recordInsightFeedback finds insights across all blocks', async () => {
  const db = await fresh();
  try {
    await seedBrief(db, {
      watching: [{ id: 'm1', category: 'recovery_correlation', text: '...' }],
      learned: [{ id: 'm2', category: 'learned_preference', ref: 'rules:abc', text: '...' }],
      section: { calendar: { id: 'm3', category: 'travel_logistics', text: '...' } },
      photo_critique: {
        supportive: [{ id: 'm4', text: '...', photo_ref: 'photo1' }],
        improvement: [{ id: 'm5', text: '...', photo_ref: 'photo2' }],
      },
    });
    const r4 = await recordInsightFeedback(db, { insightId: 'm4', verdict: 'good' });
    assert.equal(r4.category, 'photography_critique_supportive');
    const r5 = await recordInsightFeedback(db, { insightId: 'm5', verdict: 'bad' });
    assert.equal(r5.category, 'photography_critique_improvement');
    const r3 = await recordInsightFeedback(db, { insightId: 'm3', verdict: 'neutral' });
    assert.equal(r3.category, 'travel_logistics');
  } finally {
    await close(db);
  }
});
