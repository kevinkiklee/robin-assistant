import { listAllJobs } from '../../jobs/db.js';

const FIELDS = [
  'name',
  'enabled',
  'schedule',
  'runtime',
  'manually_runnable',
  'last_run_at',
  'last_run_ok',
  'next_run_at',
  'consecutive_failures',
];

export function createListJobsTool({ db }) {
  return {
    name: 'list_jobs',
    description: 'List jobs known to the runner.',
    inputSchema: {
      type: 'object',
      properties: {
        filter: {
          type: 'object',
          properties: { enabled: { type: 'boolean' } },
        },
      },
    },
    handler: async (input) => {
      const all = await listAllJobs(db);
      const filtered =
        input?.filter && typeof input.filter.enabled === 'boolean'
          ? all.filter((j) => j.enabled === input.filter.enabled)
          : all;
      const jobs = filtered.map((j) => {
        const out = {};
        for (const f of FIELDS) out[f] = j[f] ?? null;
        return out;
      });
      return { jobs };
    },
  };
}
