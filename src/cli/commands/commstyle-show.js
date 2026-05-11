// src/cli/commands/commstyle-show.js
import { close, connect } from '../../db/client.js';
import { getCommStyle as defaultGet } from '../../jobs/comm-style.js';
import { ensureHome, paths } from '../../runtime/home.js';

export async function commstyleShow(_argv = [], deps = {}) {
  const out = deps.out ?? ((s) => console.log(s));
  const fetch =
    deps.getCommStyle ??
    (async () => {
      await ensureHome();
      const p = paths();
      const db = await connect({ engine: `rocksdb://${p.db}` });
      try {
        return await defaultGet(db);
      } finally {
        await close(db);
      }
    });
  const row = await fetch();
  if (!row) {
    out('(not synthesized — too few corrections, or daemon never ran Dream)');
    return;
  }
  for (const k of [
    'tone',
    'formality',
    'emoji_ok',
    'direct_feedback_ok',
    'code_comment_density',
    'summary_style',
    'confidence',
    'last_synthesized_at',
  ]) {
    const v = row[k];
    out(`${k}: ${v instanceof Date ? v.toISOString() : v}`);
  }
  out(`evidence: ${row.evidence?.length ?? 0} event(s)`);
}
