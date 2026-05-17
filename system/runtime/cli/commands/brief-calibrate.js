// brief-calibrate.js — CLI: manually set a brief insight category's usefulness.
//
// Usage:
//   robin brief calibrate <category> <score 0.0..1.0>   set manual override
//   robin brief calibrate --list                         show current profile
//   robin brief calibrate --clear <category>             remove manual override
//
// Manual overrides set here are preserved across the nightly insight-calibration
// rollup. Use this to hard-suppress (score 0.1) or hard-boost (0.9) a category.

import { surql } from 'surrealdb';
import { ensureHome } from '../../../config/data-store.js';
import { close, connect, defaultDbUrl } from '../../../data/db/client.js';

async function readProfile(db) {
  const [rows] = await db.query('SELECT VALUE value FROM runtime:`insight_calibration`').collect();
  return rows[0] ?? {};
}

async function writeProfile(db, profile) {
  await db
    .query(surql`UPSERT type::record('runtime', 'insight_calibration') SET value = ${profile}`)
    .collect();
}

export async function briefCalibrate(argv = [], deps = {}) {
  const out = deps.out ?? ((s) => console.log(s));
  const err = deps.err ?? ((s) => console.error(s));
  let args = argv.slice();
  if (args[0] === 'calibrate') args = args.slice(1);

  await ensureHome();
  const db = await connect({ engine: await defaultDbUrl() });
  try {
    if (args[0] === '--list' || args.length === 0) {
      const profile = await readProfile(db);
      const cats = Object.keys(profile).sort();
      if (cats.length === 0) {
        out('(no calibration data yet — feedback drives this)');
        return;
      }
      out('category                                  score   votes  manual');
      for (const c of cats) {
        const e = profile[c];
        const score = e.score?.toFixed?.(3) ?? '?';
        const votes = e.count ?? 0;
        const manual = e.manual_override ? 'yes' : '';
        out(`${c.padEnd(40)} ${String(score).padEnd(7)} ${String(votes).padEnd(6)} ${manual}`);
      }
      return;
    }

    if (args[0] === '--clear') {
      const category = args[1];
      if (!category) {
        err('usage: robin brief calibrate --clear <category>');
        if (deps.exit) deps.exit(2);
        return;
      }
      const profile = await readProfile(db);
      if (profile[category]) {
        delete profile[category];
        await writeProfile(db, profile);
        out(`cleared ${category}`);
      } else {
        out(`(no entry for ${category})`);
      }
      return;
    }

    const [category, scoreStr] = args;
    if (!category || !scoreStr) {
      err('usage: robin brief calibrate <category> <0.0-1.0> | --list | --clear <category>');
      if (deps.exit) deps.exit(2);
      return;
    }
    const score = Number.parseFloat(scoreStr);
    if (!Number.isFinite(score) || score < 0 || score > 1) {
      err(`invalid score: ${scoreStr} (expected 0.0-1.0)`);
      if (deps.exit) deps.exit(2);
      return;
    }

    const profile = await readProfile(db);
    profile[category] = {
      score,
      manual_override: true,
      prior: profile[category]?.prior ?? 0.5,
      count: profile[category]?.count ?? 0,
      useful_w: profile[category]?.useful_w ?? 0,
      not_useful_w: profile[category]?.not_useful_w ?? 0,
      updated_at: new Date().toISOString(),
    };
    await writeProfile(db, profile);
    out(`set ${category} = ${score} (manual override)`);
  } finally {
    await close(db);
  }
}
