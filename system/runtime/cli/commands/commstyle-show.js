// src/cli/commands/commstyle-show.js

import { getEffectiveContextCommStyle } from '../../../cognition/dream/step-comm-style.js';
import { resolveSessionContext } from '../../../cognition/dream/comm-style-context-router.js';
import { getCommStyle as defaultGet } from '../../../cognition/jobs/comm-style.js';
import { ensureHome } from '../../../config/data-store.js';
import { close, connect, defaultDbUrl } from '../../../data/db/client.js';

export async function commstyleShow(_argv = [], deps = {}) {
  const out = deps.out ?? ((s) => console.log(s));

  // Context: injected for tests, otherwise auto-detect from env (defaults to
  // 'terminal' when ROBIN_SESSION_PLATFORM is unset — the CLI surface).
  const ctx = deps.context ?? resolveSessionContext();

  const fetch =
    deps.getCommStyle ??
    (async () => {
      await ensureHome();
      const db = await connect({ engine: await defaultDbUrl() });
      try {
        // Try per-context row; fall back to flat default.
        const perCtx = await getEffectiveContextCommStyle(db, ctx);
        return perCtx ?? (await defaultGet(db));
      } finally {
        await close(db);
      }
    });

  const row = await fetch();
  if (!row) {
    out('(not synthesized — too few corrections, or daemon never ran Dream)');
    return;
  }
  out(`context: ${ctx}`);
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
