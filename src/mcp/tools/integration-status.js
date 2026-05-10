import { surql } from 'surrealdb';

export function createIntegrationStatusTool({ db }) {
  return {
    name: 'integration_status',
    description:
      'Read integration health: cadence, last_sync_at, last_sync_ok, consecutive_failures, cursor.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' } },
    },
    handler: async (args) => {
      const [rows] = await db
        .query(surql`SELECT * FROM type::record('runtime', 'scheduler')`)
        .collect();
      const integrations = rows[0]?.value?.integrations ?? {};
      if (args.name) {
        return { integration: integrations[args.name] ?? null };
      }
      return { integrations };
    },
  };
}
