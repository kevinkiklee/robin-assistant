import { surql } from 'surrealdb';

const MIN_INTERVAL_MS = 30_000;

export function createIntegrationRunTool({ db, registry, runIntegrationSync }) {
  return {
    name: 'integration_run',
    description:
      'Trigger an integration sync inline. Refuses on gateway integrations, in-flight syncs, or recent (<30s) successful runs.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
    handler: async (args) => {
      const integration = registry.get(args.name);
      if (!integration) return { ok: false, reason: 'unknown_integration', name: args.name };
      if (integration.cadence_ms === null && !integration.sync) {
        if ((integration.tools?.length ?? 0) > 0 && !integration.start) {
          return { ok: false, reason: 'tool_only_no_sync' };
        }
        return { ok: false, reason: 'gateway_no_sync' };
      }
      const [rows] = await db
        .query(surql`SELECT * FROM type::record('runtime', 'scheduler')`)
        .collect();
      const row = rows[0]?.value?.integrations?.[args.name];
      if (row?.last_sync_at) {
        const elapsed = Date.now() - new Date(row.last_sync_at).getTime();
        if (elapsed < MIN_INTERVAL_MS) {
          return {
            ok: false,
            reason: 'too_recent',
            wait_seconds: Math.ceil((MIN_INTERVAL_MS - elapsed) / 1000),
          };
        }
      }
      return await runIntegrationSync(db, registry, args.name, { manual: true });
    },
  };
}
