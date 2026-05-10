import { join } from 'node:path';
import { paths } from '../../runtime/home.js';
import { readSqliteSnapshot } from '../_local/sqlite.js';
import { chromeHistoryPath } from './manifest.js';

const VISIT_LIMIT = 200;

// Chrome's visit_time is microseconds since 1601-01-01 UTC. Convert to a JS
// Date (ms since 1970-01-01) by subtracting the epoch offset and dividing.
function chromeTimeToDate(visit_time) {
  return new Date((visit_time - 11_644_473_600_000_000) / 1000);
}

function cacheDir() {
  return join(paths().cache, 'sqlite-snapshots');
}

export async function sync(ctx) {
  const sinceVisitId = ctx.cursor?.since_visit_id ?? 0;
  const events = [];
  let maxVisitId = sinceVisitId;
  const domainCounts = new Map();

  readSqliteSnapshot({
    srcPath: chromeHistoryPath(),
    cacheDir: cacheDir(),
    snapshotName: 'chrome-history',
    queryFn: (db) => {
      const stmt = db.prepare(`
        SELECT v.id, v.visit_time, u.url, u.title, v.transition
        FROM visits v JOIN urls u ON v.url = u.id
        WHERE v.id > ?
        ORDER BY v.id DESC LIMIT ?
      `);
      const rows = stmt.all(sinceVisitId, VISIT_LIMIT);
      for (const row of rows) {
        const ts = chromeTimeToDate(row.visit_time);
        events.push({
          source: 'chrome',
          content: `visit: ${row.title ?? '(no title)'} · ${row.url}`,
          ts,
          external_id: `chrome:visit:${row.id}`,
          meta: {
            kind: 'visit',
            visit_id: row.id,
            url: row.url,
            title: row.title,
            visit_time: row.visit_time,
            transition: row.transition,
          },
        });
        if (row.id > maxVisitId) maxVisitId = row.id;
        try {
          const host = new URL(row.url).hostname;
          domainCounts.set(host, (domainCounts.get(host) ?? 0) + 1);
        } catch {
          // skip unparseable URLs (chrome://, file://, malformed)
        }
      }
    },
  });

  // Daily top-domains aggregation. external_id is keyed by date so
  // insert-or-skip dedupe makes it safe to re-run within the day.
  if (domainCounts.size > 0) {
    const today = new Date().toISOString().slice(0, 10);
    const domains = [...domainCounts.entries()]
      .map(([domain, count]) => ({ domain, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);
    events.push({
      source: 'chrome',
      content: `top domains today: ${domains.map((d) => `${d.domain} (${d.count})`).join(', ')}`,
      ts: new Date(),
      external_id: `chrome:top_domains:${today}`,
      meta: { kind: 'top_domains', date: today, domains },
    });
  }

  await ctx.capture(events);
  return { count: events.length, cursor: { since_visit_id: maxVisitId } };
}
