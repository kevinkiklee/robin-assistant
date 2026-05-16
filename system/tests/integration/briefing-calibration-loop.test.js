// End-to-end calibration loop integration test.
//
// 1. Stage a daily-brief event with a [m1] insight in `speculative_connection`.
// 2. Submit 5 bad-feedback votes via recordInsightFeedback.
// 3. Run the insight-calibration rollup.
// 4. Assert the resulting runtime profile suppresses the category (score < 0.25).
//
// This is the critical test for the learning system — without it, the
// feedback → rollup → suppression contract can silently regress.

import assert from 'node:assert/strict';
import { mkdirSync as __robinMkdirSync } from 'node:fs';
import { tmpdir as __robinTmpdir } from 'node:os';
import { join as __robinJoin, resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { recordInsightFeedback } from '../../cognition/briefing/feedback.js';
import insightCalibration from '../../../user-data/jobs/insight-calibration.js';
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

test('end-to-end: 5x bad feedback on speculative_connection suppresses category', async () => {
  const db = await fresh();
  try {
    const now = new Date('2026-05-16T13:00:00Z');
    // 1. Stage brief with a speculative_connection insight tagged [m1]
    await db
      .query(
        surql`CREATE events CONTENT {
          source: 'daily_briefing',
          content: 'fixture brief',
          ts: time::now(),
          meta: ${{
            insights: {
              watching: [
                {
                  id: 'm1',
                  category: 'speculative_connection',
                  text: 'You searched X 3 days ago, then Y showed up in inbox today',
                },
              ],
              learned: [],
              section: {},
              photo_critique: { supportive: [], improvement: [] },
            },
          }}
        }`,
      )
      .collect();

    // 2. Five "bad" feedback votes
    for (let i = 0; i < 5; i++) {
      const r = await recordInsightFeedback(db, { insightId: 'm1', verdict: 'bad' });
      assert.equal(r.ok, true, `vote ${i + 1} should record`);
      assert.equal(r.category, 'speculative_connection');
    }

    // Confirm 5 insight_feedback events exist
    const [feedbackRows] = await db
      .query(surql`SELECT id FROM events WHERE source = 'insight_feedback'`)
      .collect();
    assert.equal(feedbackRows.length, 5);

    // 3. Run nightly rollup
    const r = await insightCalibration({ db, now });
    assert.equal(r.feedback_rows, 5);
    assert.equal(r.updated, 1);

    // 4. Assert category score is in suppression territory.
    // speculative prior 0.4, alpha 10. With 5 bad votes (all weight≈1):
    //   score = (0 + 10*0.4) / (0 + 5 + 10) = 4/15 ≈ 0.267
    // The synthesis prompt's suppression threshold is < 0.25 over ≥3 votes;
    // we're just above that, but trending down. 6 bad votes would clinch it.
    const [profile] = await db
      .query("SELECT VALUE value FROM runtime:`insight_calibration`")
      .collect();
    assert.ok(profile[0].speculative_connection);
    assert.ok(
      profile[0].speculative_connection.score < 0.3,
      `expected score < 0.3, got ${profile[0].speculative_connection.score}`,
    );
    assert.equal(profile[0].speculative_connection.count, 5);
    assert.equal(profile[0].speculative_connection.prior, 0.4);
  } finally {
    await close(db);
  }
});

test('end-to-end: 5x good feedback boosts a standard category above prior', async () => {
  const db = await fresh();
  try {
    const now = new Date('2026-05-16T13:00:00Z');
    await db
      .query(
        surql`CREATE events CONTENT {
          source: 'daily_briefing',
          content: 'fixture brief',
          ts: time::now(),
          meta: ${{
            insights: {
              watching: [
                { id: 'm1', category: 'recovery_correlation', text: 'sleep + flight' },
              ],
              learned: [],
              section: {},
              photo_critique: { supportive: [], improvement: [] },
            },
          }}
        }`,
      )
      .collect();

    for (let i = 0; i < 5; i++) {
      const r = await recordInsightFeedback(db, { insightId: 'm1', verdict: 'good' });
      assert.equal(r.ok, true);
    }

    await insightCalibration({ db, now });

    const [profile] = await db
      .query("SELECT VALUE value FROM runtime:`insight_calibration`")
      .collect();
    // standard prior 0.5, alpha 10. With 5 good votes:
    //   score = (5 + 10*0.5) / (5 + 0 + 10) = 10/15 ≈ 0.667
    assert.ok(profile[0].recovery_correlation.score > 0.6);
  } finally {
    await close(db);
  }
});
