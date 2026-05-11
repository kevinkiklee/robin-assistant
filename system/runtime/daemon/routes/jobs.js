import { getJob } from '../../../cognition/jobs/db.js';
import { runOneJob } from '../../../cognition/jobs/runner.js';
import { planNextRunAt } from '../../../cognition/jobs/scheduler-ext.js';

export const jobsRoutes = [
  {
    method: 'POST',
    path: '/internal/jobs/run',
    async handler({ ctx, body, tools }) {
      const name = body?.name;
      const force = body?.force === true;
      if (!name) {
        return { _status: 400, _body: { ok: false, reason: 'missing name' } };
      }
      const row = await getJob(ctx.db, name);
      if (!row) {
        return { _status: 404, _body: { ok: false, reason: 'job not found' } };
      }
      if (row.in_flight && !force) {
        return { _status: 409, _body: { ok: false, reason: 'in_flight' } };
      }
      if (row.manually_runnable === false && !force) {
        return { _status: 403, _body: { ok: false, reason: 'not_manually_runnable' } };
      }
      await runOneJob({
        db: ctx.db,
        capture: ctx.capture.forJobs,
        host: ctx.host,
        jobs: ctx.jobs.cache.current,
        tools,
        name,
      });
      await planNextRunAt(ctx.db, ctx.jobs.cache.current);
      const after = await getJob(ctx.db, name);
      return {
        ok: after.last_run_ok === true,
        last_error: after.last_error ?? null,
      };
    },
  },
  {
    method: 'POST',
    path: '/internal/jobs/reload',
    async handler({ ctx }) {
      await ctx.jobs.refresh();
      return { ok: true, count: ctx.jobs.cache.current.length };
    },
  },
];
