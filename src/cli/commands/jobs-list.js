import { close, connect } from '../../db/client.js';
import { listAllJobs } from '../../jobs/db.js';
import { ensureHome, paths } from '../../runtime/data-store.js';

function fmt(d) {
  return d ? new Date(d).toISOString() : '—';
}

export async function jobsList(_argv = [], deps = {}) {
  const out = deps.out ?? ((s) => console.log(s));
  const list =
    deps.listJobs ??
    (async () => {
      await ensureHome();
      const p = paths();
      const db = await connect({ engine: `rocksdb://${p.db}` });
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
