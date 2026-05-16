import { surql } from 'surrealdb';
import { ensureHome, getIntegrationDirs } from '../../../config/data-store.js';
import { close, connect, defaultDbUrl } from '../../../data/db/client.js';
import { isEnabled, readIntegrationsState } from '../../../data/runtime/integrations-state.js';
import { loadManifests } from '../../../io/integrations/_framework/manifest-loader.js';

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

export function parseFilter(args) {
  if (!args || args.length === 0) return null;
  const positional = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--filter' || a === '--name') {
      const v = args[i + 1];
      if (!v || v.startsWith('--')) {
        throw new Error('usage: robin integrations list [<name> | --filter <name>]');
      }
      return v;
    }
    if (a.startsWith('--filter=') || a.startsWith('--name=')) {
      return a.slice(a.indexOf('=') + 1);
    }
    if (!a.startsWith('-')) positional.push(a);
  }
  return positional[0] ?? null;
}

export async function integrationsList(args = []) {
  const filter = parseFilter(args);
  const needle = filter?.toLowerCase() ?? null;
  const matches = (name) => (needle ? name.toLowerCase().includes(needle) : true);

  await ensureHome();
  const { loaded: manifests, unavailable } = await loadManifests(getIntegrationDirs());

  const db = await connect({ engine: await defaultDbUrl() });
  let rtIntegrations = {};
  let intState = { states: {}, rev: 0, migrated_at: null };
  try {
    const [rows] = await db
      .query(surql`SELECT * FROM type::record('runtime', 'scheduler')`)
      .collect();
    rtIntegrations = rows[0]?.value?.integrations ?? {};
    intState = await readIntegrationsState(db);
  } finally {
    await close(db);
  }

  if (manifests.length === 0 && unavailable.length === 0) {
    console.log('(no integrations registered)');
    return;
  }

  const filteredManifests = manifests.filter((m) => matches(m.name));
  const filteredUnavailable = unavailable.filter((u) => matches(u.name));

  if (filter && filteredManifests.length === 0 && filteredUnavailable.length === 0) {
    console.log(`(no integration matches '${filter}')`);
    return;
  }

  console.log(
    `${'name'.padEnd(15)}  ${'cadence'.padEnd(10)}  ${'status'.padEnd(9)}  ${'source'.padEnd(6)}  last=<timestamp>            ok`,
  );

  for (const m of filteredManifests) {
    const cadence = formatCadence(m);
    const rt = rtIntegrations[m.name];
    const last = rt?.last_sync_at
      ? new Date(rt.last_sync_at).toISOString()
      : m.kind === 'sync'
        ? 'never'
        : '—';
    const ok = rt?.last_sync_ok === true ? 'OK' : rt?.last_sync_ok === false ? 'FAIL' : '—';
    const status = isEnabled(intState, m.name) ? 'enabled' : 'disabled';
    const source = m._source === 'user-data' ? 'user' : 'system';
    console.log(
      `${m.name.padEnd(15)}  ${cadence.padEnd(10)}  ${status.padEnd(9)}  ${source.padEnd(6)}  last=${last.padEnd(25)}  ${ok}`,
    );
  }
  for (const u of filteredUnavailable) {
    const source = u.source === 'user-data' ? 'user' : 'system';
    console.log(
      `${u.name.padEnd(15)}  ${'—'.padEnd(10)}  ${'unavailable'.padEnd(9)}  ${source.padEnd(6)}  ${u.error}`,
    );
  }
}
