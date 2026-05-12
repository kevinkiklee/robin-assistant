import { surql } from 'surrealdb';
import { readDaemonState } from '../../../config/daemon-state.js';
import { ensureHome, paths } from '../../../config/data-store.js';
import { close, connect, defaultDbUrl } from '../../../data/db/client.js';
import { acquire } from '../../../data/db/lock.js';
import { createEmbedder } from '../../../data/embed/factory.js';
import { createCapture } from '../../../io/integrations/_framework/capture.js';
import { loadManifests } from '../../../io/integrations/_framework/manifest-loader.js';
import { runIntegrationSync } from '../../../io/integrations/_framework/run-sync.js';
import { isPidAlive } from '../../daemon/lock.js';

export async function integrationsRun(argv) {
  if (!argv[0]) {
    console.error('usage: robin integrations run <name>');
    process.exit(1);
  }
  const name = argv[0];
  await ensureHome();
  const state = await readDaemonState(paths.data.daemonState());
  if (state && isPidAlive(state.pid)) {
    console.error(
      'daemon is running. Use the integration_run MCP tool, or stop the daemon first: robin mcp stop',
    );
    process.exit(1);
  }
  const release = await acquire(paths.data.daemonLock());
  try {
    const db = await connect({ engine: await defaultDbUrl() });
    try {
      const integrationsDir = new URL('../../../io/integrations/', import.meta.url).pathname;
      const { loaded: manifests, unavailable } = await loadManifests(integrationsDir);
      const target = manifests.find((m) => m.name === name);
      if (!target) {
        const why = unavailable.find((u) => u.name === name);
        if (why) {
          console.error(`integration ${name} unavailable: ${why.error}`);
        } else {
          console.error(`integration ${name} not loaded`);
        }
        process.exit(1);
      }
      const embedder = await createEmbedder();
      const registry = new Map([
        [
          name,
          {
            cadence_ms: target.cadence_ms,
            sync: target.sync,
            secrets: target.secrets,
            quiet_window: target.quiet_window ?? null,
            capture: createCapture({
              db,
              embedder,
              source: name,
              embed: target.embed,
              mode: target.capture_mode,
            }),
          },
        ],
      ]);
      // Seed the runtime row if not present so runIntegrationSync can find it.
      const [schedRows] = await db
        .query(surql`SELECT * FROM type::record('runtime', 'scheduler')`)
        .collect();
      const value = schedRows[0]?.value ?? {};
      if (!value.integrations?.[name]) {
        const integrations = {
          ...(value.integrations ?? {}),
          [name]: { cadence_ms: target.cadence_ms, consecutive_failures: 0 },
        };
        await db
          .query(
            surql`UPSERT type::record('runtime', 'scheduler') SET value = ${{ ...value, integrations }}`,
          )
          .collect();
      }
      const r = await runIntegrationSync(db, registry, name, { manual: true });
      console.log(JSON.stringify(r, null, 2));
    } finally {
      await close(db);
    }
  } finally {
    await release();
  }
}
