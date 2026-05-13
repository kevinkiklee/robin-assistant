import { getJob } from '../../../cognition/jobs/db.js';
import { runOneJob } from '../../../cognition/jobs/runner.js';

export function createRunJobTool({ db, capture, host, embedder, tools, getJobs }) {
  return {
    name: 'run_job',
    description: 'Trigger a job manually. Refuses jobs declared manually_runnable: false.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 100 },
        dry_run: { type: 'boolean' },
      },
      required: ['name'],
    },
    handler: async ({ name, dry_run }) => {
      const row = await getJob(db, name);
      if (!row) return { ok: false, reason: 'job_not_found' };
      if (row.manually_runnable === false) return { ok: false, reason: 'not_manually_runnable' };
      if (row.in_flight) return { ok: false, reason: 'in_flight' };
      if (dry_run) return { ok: true, dry_run: true };
      await runOneJob({
        db,
        capture,
        host,
        embedder,
        jobs: getJobs(),
        tools: typeof tools === 'function' ? tools() : tools,
        name,
      });
      const after = await getJob(db, name);
      return {
        ok: after.last_run_ok === true,
        last_error: after.last_error ?? null,
      };
    },
  };
}
