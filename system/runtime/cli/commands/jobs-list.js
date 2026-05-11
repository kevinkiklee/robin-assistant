import { listAllJobs } from '../../../cognition/jobs/db.js';
import { ensureHome } from '../../../config/data-store.js';
import { close, connect, defaultDbUrl } from '../../../data/db/client.js';

function fmt(d) {
  return d ? new Date(d).toISOString() : '—';
}

export async function jobsList(_argv = [], deps = {}) {
  const out = deps.out ?? ((s) => console.log(s));
  const list =
    deps.listJobs ??
    (async () => {
      await ensureHome();
      const db = await connect({ engine: await defaultDbUrl() });
      try {
        return await listAllJobs(db);
      } finally {
        await close(db);
      }
    });
  const jobs = await list();
  if (jobs.length === 0) {
    out('(no jobs)');
    return;
  }
  out(
    'name             status     schedule         last-run                 next-run                 ok',
  );
  for (const j of jobs) {
    const ok = j.last_run_ok === true ? 'OK' : j.last_run_ok === false ? 'FAIL' : '—';
    out(
      `${j.name.padEnd(16)} ${(j.enabled ? 'enabled' : 'disabled').padEnd(10)} ${(j.schedule ?? '').padEnd(16)} ${fmt(j.last_run_at).padEnd(24)} ${fmt(j.next_run_at).padEnd(24)} ${ok}`,
    );
  }
}
