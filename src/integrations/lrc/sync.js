import { homedir } from 'node:os';
import { join } from 'node:path';
import { readSqliteSnapshot } from '../_local/sqlite.js';
import { lrcCatalogPath, readCatalogSummary } from './client.js';

function cacheDir() {
  const home = process.env.ROBIN_HOME ?? join(homedir(), '.robin');
  return join(home, 'cache', 'sqlite-snapshots');
}

export async function sync(ctx) {
  const path = lrcCatalogPath();
  if (!path) throw new Error('LRC_CATALOG_PATH not set');

  const summary = readSqliteSnapshot({
    srcPath: path,
    cacheDir: cacheDir(),
    snapshotName: 'lrc-catalog',
    queryFn: readCatalogSummary,
  });

  const today = new Date().toISOString().slice(0, 10);
  const event = {
    source: 'lrc',
    content: `lightroom catalog: ${summary.total_photos} photos${
      summary.last_import_date ? `, last imported ${summary.last_import_date}` : ''
    }`,
    ts: new Date(),
    external_id: `lrc:${today}`,
    meta: {
      catalog_path: path,
      ...summary,
    },
  };
  await ctx.capture([event]);
  return { count: 1, cursor: { last_run_at: new Date().toISOString() } };
}
