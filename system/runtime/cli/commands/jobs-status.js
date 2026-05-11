import { close, connect, defaultDbUrl } from '../../../data/db/client.js';
import { getJob } from '../../../cognition/jobs/db.js';
import { ensureHome } from '../../../config/data-store.js';

export async function jobsStatus(argv = [], deps = {}) {
  const out = deps.out ?? ((s) => console.log(s));
  const err = deps.err ?? ((s) => console.error(s));
  const name = argv[0];
  if (!name) {
    err('usage: robin jobs status <name>');
    process.exitCode = 1;
    return;
  }
  const fetch =
    deps.getJob ??
    (async (n) => {
      await ensureHome();
      const db = await connect({ engine: await defaultDbUrl() });
      try {
        return await getJob(db, n);
      } finally {
        await close(db);
      }
    });
  const row = await fetch(name);
  if (!row) {
    err(`no such job: ${name}`);
    process.exitCode = 1;
    return;
  }
  const fields = [
    'name',
    'enabled',
    'schedule',
    'runtime',
    'manually_runnable',
    'last_run_at',
    'last_run_ok',
    'last_error',
    'last_duration_ms',
    'next_run_at',
    'consecutive_failures',
    'in_flight',
  ];
  for (const f of fields) {
    const v = row[f];
    out(`${f}: ${v instanceof Date ? v.toISOString() : v}`);
  }
}
