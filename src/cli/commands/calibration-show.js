// src/cli/commands/calibration-show.js
import { close, connect } from '../../db/client.js';
import { getCalibration as defaultGet } from '../../jobs/predictions.js';
import { ensureHome, paths } from '../../runtime/data-store.js';

export async function calibrationShow(_argv = [], deps = {}) {
  const out = deps.out ?? ((s) => console.log(s));
  const fetch =
    deps.getCalibration ??
    (async () => {
      await ensureHome();
      const db = await connect({ engine: `rocksdb://${paths.data.db()}` });
      try {
        return await defaultGet(db);
      } finally {
        await close(db);
      }
    });
  const c = await fetch();
  if (!c) {
    out('(no calibration data yet — make some predictions and resolve them)');
    return;
  }
  out(`Calibration as of ${c.last_computed_at ? new Date(c.last_computed_at).toISOString() : '?'}`);
  out(`total_open=${c.total_open ?? 0} total_resolved=${c.total_resolved ?? 0}`);
  out('');
  out('kind                accuracy   n');
  const kinds = Object.keys(c.by_kind ?? {}).sort();
  for (const k of kinds) {
    const v = c.by_kind[k];
    const pct = (v.accuracy * 100).toFixed(0);
    out(`${k.padEnd(20)} ${(pct + '%').padEnd(10)} ${v.resolved}`);
  }
  if (kinds.length === 0) out('(no resolved predictions yet)');
}
