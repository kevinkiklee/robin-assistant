// src/cli/commands/predictions-list.js
import { close, connect, defaultDbUrl } from '../../../data/db/client.js';
import { listAllPredictions as defaultList } from '../../../cognition/jobs/predictions.js';
import { ensureHome } from '../../../config/data-store.js';

function _fmt(d) {
  return d ? new Date(d).toISOString() : '—';
}

export async function predictionsList(argv = [], deps = {}) {
  const out = deps.out ?? ((s) => console.log(s));
  let kind;
  let resolved;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--kind') kind = argv[++i];
    if (argv[i] === '--open') resolved = false;
    if (argv[i] === '--resolved') resolved = true;
  }
  const list =
    deps.listAllPredictions ??
    (async () => {
      await ensureHome();
      const db = await connect({ engine: await defaultDbUrl() });
      try {
        return await defaultList(db, { kind, resolved });
      } finally {
        await close(db);
      }
    });
  const rows = await list({ kind, resolved });
  if (!rows || rows.length === 0) {
    out('(no predictions)');
    return;
  }
  out('id                                  kind             status       confidence  statement');
  for (const r of rows) {
    const status = r.resolved_at ? (r.correct ? 'CORRECT' : 'WRONG') : 'OPEN';
    const id = String(r.id).slice(0, 36);
    const k = String(r.kind ?? '').padEnd(16);
    out(
      `${id.padEnd(36)} ${k} ${status.padEnd(12)} ${String(r.confidence ?? '?').padEnd(11)} ${r.statement?.slice(0, 80) ?? ''}`,
    );
  }
}
