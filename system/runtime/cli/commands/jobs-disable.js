// src/cli/commands/jobs-disable.js
import { close, connect, defaultDbUrl } from '../../../data/db/client.js';
import { setEnabled } from '../../../cognition/jobs/db.js';
import { ensureHome } from '../../../config/data-store.js';

export async function jobsDisable(argv = [], deps = {}) {
  const out = deps.out ?? ((s) => console.log(s));
  const name = argv[0];
  if (!name) {
    console.error('usage: robin jobs disable <name>');
    process.exitCode = 1;
    return;
  }
  const set =
    deps.setEnabled ??
    (async (n, v) => {
      await ensureHome();
      const db = await connect({ engine: await defaultDbUrl() });
      try {
        await setEnabled(db, n, v);
      } finally {
        await close(db);
      }
    });
  await set(name, false);
  out(`disabled ${name}`);
}
