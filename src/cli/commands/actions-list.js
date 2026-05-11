// src/cli/commands/actions-list.js
import { close, connect } from '../../db/client.js';
import { listActionTrust as defaultList } from '../../jobs/action-trust.js';
import { ensureHome, paths } from '../../runtime/data-store.js';

function fmt(d) {
  return d ? new Date(d).toISOString() : '—';
}

export async function actionsList(_argv = [], deps = {}) {
  const out = deps.out ?? ((s) => console.log(s));
  const list =
    deps.listActionTrust ??
    (async () => {
      await ensureHome();
      const db = await connect({ engine: `rocksdb://${paths.data.db()}` });
      try {
        return await defaultList(db);
      } finally {
        await close(db);
      }
    });
  const rows = await list();
  if (rows.length === 0) {
    out('(no action classes — none invoked yet)');
    return;
  }
  out(
    'class                          state    set_by       successes  corrections  last_used                  last_change',
  );
  for (const r of rows) {
    out(
      `${r.class.padEnd(30)} ${r.state.padEnd(8)} ${r.set_by.padEnd(12)} ${String(r.success_count).padStart(9)}  ${String(r.correction_count).padStart(11)}  ${fmt(r.last_used_at).padEnd(25)} ${fmt(r.last_state_change_at)}`,
    );
  }
}
