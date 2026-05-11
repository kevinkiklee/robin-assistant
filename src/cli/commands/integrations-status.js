import { surql } from 'surrealdb';
import { close, connect } from '../../db/client.js';
import { ensureHome, paths } from '../../runtime/data-store.js';

export async function integrationsStatus(argv) {
  if (!argv[0]) {
    console.error('usage: robin integrations status <name> [--json]');
    process.exit(1);
  }
  const name = argv[0];
  const json = argv.includes('--json');
  await ensureHome();
  const db = await connect({ engine: `rocksdb://${paths.data.db()}` });
  try {
    const [rows] = await db
      .query(surql`SELECT * FROM type::record('runtime', 'scheduler')`)
      .collect();
    const row = rows[0]?.value?.integrations?.[name];
    if (!row) {
      console.log(`integration ${name} not registered`);
      return;
    }
    if (json) {
      console.log(JSON.stringify(row, null, 2));
      return;
    }
    console.log(`name:                 ${name}`);
    console.log(`cadence_ms:           ${row.cadence_ms ?? 'gateway'}`);
    console.log(`next_run_at:          ${row.next_run_at ?? '—'}`);
    console.log(`in_flight:            ${row.in_flight ?? false}`);
    console.log(`last_sync_at:         ${row.last_sync_at ?? '—'}`);
    console.log(`last_sync_ok:         ${row.last_sync_ok ?? '—'}`);
    console.log(`last_sync_count:      ${row.last_sync_count ?? '—'}`);
    console.log(`last_sync_error:      ${row.last_sync_error ?? '—'}`);
    console.log(`consecutive_failures: ${row.consecutive_failures ?? 0}`);
    console.log(`cursor:               ${JSON.stringify(row.cursor ?? null)}`);
  } finally {
    await close(db);
  }
}
