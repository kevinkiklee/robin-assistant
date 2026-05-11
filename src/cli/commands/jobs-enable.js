// src/cli/commands/jobs-enable.js
import { close, connect, defaultDbUrl } from '../../db/client.js';
import { setEnabled } from '../../jobs/db.js';
import { ensureHome } from '../../runtime/data-store.js';

export async function jobsEnable(argv = [], deps = {}) {
  const out = deps.out ?? ((s) => console.log(s));
  const name = argv[0];
  if (!name) {
    console.error('usage: robin jobs enable <name>');
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
  await set(name, true);
  out(`enabled ${name}`);
}
