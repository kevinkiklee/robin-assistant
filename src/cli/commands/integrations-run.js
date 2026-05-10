import { join } from 'node:path';
import { surql } from 'surrealdb';
import { isPidAlive } from '../../daemon/lock.js';
import { readDaemonState } from '../../daemon/state.js';
import { close, connect } from '../../db/client.js';
import { acquire } from '../../db/lock.js';
import { createTransformersEmbedder } from '../../embed/embedder.js';
import { createCapture } from '../../integrations/_framework/capture.js';
import { loadManifests } from '../../integrations/_framework/manifest-loader.js';
import { runIntegrationSync } from '../../integrations/_framework/run-sync.js';
import { ensureHome, paths } from '../../runtime/home.js';

export async function integrationsRun(argv) {
  if (!argv[0]) {
    console.error('usage: robin integrations run <name>');
    process.exit(1);
  }
  const name = argv[0];
  await ensureHome();
  const p = paths();
  const state = await readDaemonState(join(p.home, '.daemon.state'));
  if (state && isPidAlive(state.pid)) {
    console.error(
      'daemon is running. Use the integration_run MCP tool, or stop the daemon first: robin mcp stop',
    );
    process.exit(1);
  }
  const release = await acquire(p.lock);
  try {
    const db = await connect({ engine: `rocksdb://${p.db}` });
    try {
      const integrationsDir = new URL('../../integrations/', import.meta.url).pathname;
      const manifests = await loadManifests(integrationsDir);
      const target = manifests.find((m) => m.name === name);
      if (!target) {
        console.error(`integration ${name} not loaded`);
        process.exit(1);
      }
      const embedder = await createTransformersEmbedder();
      const registry = new Map([
        [
          name,
          {
            cadence_ms: target.cadence_ms,
            sync: target.sync,
            secrets: target.secrets,
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
