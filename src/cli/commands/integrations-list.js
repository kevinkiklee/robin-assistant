import { surql } from 'surrealdb';
import { close, connect } from '../../db/client.js';
import { loadManifests } from '../../integrations/_framework/manifest-loader.js';
import { ensureHome, paths } from '../../runtime/home.js';

function formatCadence(m) {
  if (m.kind === 'gateway') return 'gateway';
  if (m.kind === 'tool-only') return 'tool-only';
  if (m.cadence_ms === null) return '—';
  if (m.cadence_ms >= 86_400_000 && m.cadence_ms % 86_400_000 === 0)
    return `${m.cadence_ms / 86_400_000}d`;
  if (m.cadence_ms >= 3_600_000 && m.cadence_ms % 3_600_000 === 0)
    return `${m.cadence_ms / 3_600_000}h`;
  return `${m.cadence_ms / 60_000}m`;
}

export async function integrationsList() {
  await ensureHome();
  const p = paths();
  const integrationsDir = new URL('../../integrations/', import.meta.url).pathname;
  const manifests = await loadManifests(integrationsDir);

  const db = await connect({ engine: `rocksdb://${p.db}` });
  let rtIntegrations = {};
  try {
    const [rows] = await db
      .query(surql`SELECT * FROM type::record('runtime', 'scheduler')`)
      .collect();
    rtIntegrations = rows[0]?.value?.integrations ?? {};
  } finally {
    await close(db);
  }

  if (manifests.length === 0) {
    console.log('(no integrations registered)');
    return;
  }
  for (const m of manifests) {
    const cadence = formatCadence(m);
    const rt = rtIntegrations[m.name];
    const last = rt?.last_sync_at
      ? new Date(rt.last_sync_at).toISOString()
      : m.kind === 'sync'
        ? 'never'
        : '—';
    const ok = rt?.last_sync_ok === true ? 'OK' : rt?.last_sync_ok === false ? 'FAIL' : '—';
    console.log(`${m.name.padEnd(15)}  ${cadence.padEnd(10)}  last=${last.padEnd(25)}  ${ok}`);
  }
}
