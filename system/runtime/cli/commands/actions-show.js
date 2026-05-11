// src/cli/commands/actions-show.js

import { getActionTrust as defaultGet } from '../../../cognition/jobs/action-trust.js';
import { ensureHome } from '../../../config/data-store.js';
import { close, connect, defaultDbUrl } from '../../../data/db/client.js';

export async function actionsShow(argv = [], deps = {}) {
  const out = deps.out ?? ((s) => console.log(s));
  const err = deps.err ?? ((s) => console.error(s));
  const cls = argv[0];
  if (!cls) {
    err('usage: robin actions show <class>');
    process.exitCode = 1;
    return;
  }
  const fetch =
    deps.getActionTrust ??
    (async (c) => {
      await ensureHome();
      const db = await connect({ engine: await defaultDbUrl() });
      try {
        return await defaultGet(db, c);
      } finally {
        await close(db);
      }
    });
  const row = await fetch(cls);
  if (!row) {
    err(`no such action class: ${cls}`);
    process.exitCode = 1;
    return;
  }
  const fields = [
    'class',
    'state',
    'set_by',
    'success_count',
    'correction_count',
    'last_used_at',
    'last_state_change_at',
  ];
  for (const f of fields) {
    const v = row[f];
    out(`${f}: ${v instanceof Date ? v.toISOString() : v}`);
  }
}
