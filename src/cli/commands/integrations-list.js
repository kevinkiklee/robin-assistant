import { surql } from 'surrealdb';
import { close, connect } from '../../db/client.js';
import { ensureHome, paths } from '../../runtime/home.js';

export async function integrationsList() {
  await ensureHome();
  const p = paths();
  const db = await connect({ engine: `rocksdb://${p.db}` });
  try {
    const [rows] = await db
      .query(surql`SELECT * FROM type::record('runtime', 'scheduler')`)
      .collect();
    const integrations = rows[0]?.value?.integrations ?? {};
    if (Object.keys(integrations).length === 0) {
      console.log('(no integrations registered)');
      return;
    }
    for (const [name, row] of Object.entries(integrations)) {
      const cadence = row.cadence_ms ? `${row.cadence_ms / 60_000}m` : 'gateway';
      const last = row.last_sync_at ? new Date(row.last_sync_at).toISOString() : 'never';
      const ok = row.last_sync_ok === true ? 'OK' : row.last_sync_ok === false ? 'FAIL' : '—';
      console.log(`${name.padEnd(15)}  ${cadence.padEnd(10)}  last=${last}  ${ok}`);
    }
  } finally {
    await close(db);
  }
}
