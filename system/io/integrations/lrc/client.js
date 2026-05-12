/**
 * Lightroom Classic catalog reader. The catalog is a SQLite file ending in
 * `.lrcat`. Schema is approximate — Lightroom's tables shift between major
 * versions, so each query is wrapped in try/catch and falls back to an empty
 * value rather than aborting the whole snapshot.
 */

import { getSecret } from '../../../config/secrets.js';

// Read from process.env first (so shell-level override still works), then
// fall back to user-data/secrets/.env so `robin secrets set LRC_CATALOG_PATH`
// is the supported way to configure this without touching shell rc files.
export function lrcCatalogPath() {
  return process.env.LRC_CATALOG_PATH ?? getSecret('LRC_CATALOG_PATH') ?? undefined;
}

export function readCatalogSummary(db) {
  // Total photos
  let total = 0;
  try {
    const row = db.prepare('SELECT COUNT(*) AS n FROM Adobe_images').get();
    total = row?.n ?? 0;
  } catch {
    // Adobe_images missing or schema variant — leave total at 0.
  }

  // Last import date. captureTime is stored as 'YYYY-MM-DDThh:mm:ss'; MAX()
  // works lexicographically on that ISO-8601-like string.
  let lastImport = null;
  try {
    const row = db.prepare('SELECT MAX(captureTime) AS t FROM Adobe_images').get();
    lastImport = row?.t ?? null;
  } catch {
    // ignore
  }

  // Top folder names (proxy for top albums/keywords — keeps the integration
  // robust against schema variation).
  let topFolders = [];
  try {
    const rows = db
      .prepare(
        `SELECT f.pathFromRoot AS folder, COUNT(*) AS n
         FROM Adobe_images i JOIN AgLibraryFolder f ON i.rootFolder = f.id_local
         GROUP BY f.pathFromRoot ORDER BY n DESC LIMIT 10`,
      )
      .all();
    topFolders = rows.map((r) => ({ folder: r.folder, count: r.n }));
  } catch {
    // ignore
  }

  // Rating distribution
  const ratings = {};
  try {
    const rows = db.prepare('SELECT rating, COUNT(*) AS n FROM Adobe_images GROUP BY rating').all();
    for (const r of rows) ratings[r.rating ?? 0] = r.n;
  } catch {
    // ignore
  }

  return {
    total_photos: total,
    last_import_date: lastImport,
    top_folders: topFolders,
    ratings,
  };
}
