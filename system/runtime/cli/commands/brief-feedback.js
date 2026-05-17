// brief-feedback.js — CLI: record feedback on a daily-brief insight.
//
// Usage: robin brief feedback <mN> <good|bad|neutral> [free text]
//
// Writes an `events:insight_feedback` row tagged with the insight's category.
// The nightly `insight-calibration` job rolls these up into the usefulness
// profile that drives next-brief synthesis suppression.

import { recordInsightFeedback } from '../../../cognition/briefing/feedback.js';
import { ensureHome } from '../../../config/data-store.js';
import { close, connect, defaultDbUrl } from '../../../data/db/client.js';

const VERDICT_ALIASES = {
  '+1': 'good',
  yes: 'good',
  good: 'good',
  useful: 'good',
  '-1': 'bad',
  no: 'bad',
  bad: 'bad',
  not: 'bad',
  neutral: 'neutral',
  meh: 'neutral',
  0: 'neutral',
};

export async function briefFeedback(argv = [], deps = {}) {
  const out = deps.out ?? ((s) => console.log(s));
  const err = deps.err ?? ((s) => console.error(s));

  // argv shape: ['feedback', '<mN>', '<verdict>', ...optional free text]
  // When invoked via `robin brief feedback ...` the dispatcher strips the
  // `brief` prefix; depending on the wiring, `feedback` may or may not still
  // be the first arg. Be tolerant.
  let args = argv.slice();
  if (args[0] === 'feedback') args = args.slice(1);

  const [rawId, rawVerdict, ...rest] = args;
  if (!rawId || !rawVerdict) {
    err('usage: robin brief feedback <mN> <good|bad|neutral> [free text]');
    if (deps.exit) deps.exit(2);
    return;
  }
  const insightId = rawId.toLowerCase();
  if (!/^m\d{1,3}$/.test(insightId)) {
    err(`invalid insight id: ${rawId} (expected mN like 'm3')`);
    if (deps.exit) deps.exit(2);
    return;
  }
  const verdict = VERDICT_ALIASES[rawVerdict.toLowerCase()];
  if (!verdict) {
    err(`invalid verdict: ${rawVerdict} (expected good|bad|neutral)`);
    if (deps.exit) deps.exit(2);
    return;
  }
  const freeText = rest.length ? rest.join(' ') : null;

  await ensureHome();
  const db = await connect({ engine: await defaultDbUrl() });
  try {
    const result = await recordInsightFeedback(db, {
      insightId,
      verdict,
      source: 'cli',
      freeText,
    });
    if (!result.ok) {
      err(`feedback rejected: ${result.reason}`);
      if (deps.exit) deps.exit(1);
      return;
    }
    out(`recorded ${insightId}=${verdict} (category=${result.category})`);
  } finally {
    await close(db);
  }
}
