// `robin published` — list pages published from this Robin instance.
// Reads <robin-home>/io/publish/index.jsonl, groups by slug.

import { parseArgs } from 'node:util';
import { paths } from '../../../config/data-store.js';
import { readLog, groupBySlug } from '../../../io/publish/log.js';

function pad(s, n) {
  s = String(s);
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

function trunc(s, n) {
  s = String(s ?? '');
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

export async function published(argv) {
  const { values } = parseArgs({
    args: argv,
    options: { all: { type: 'boolean', default: false } },
    strict: true,
  });

  const logPath = paths.data.publishIndex();
  const { entries, skipped } = await readLog(logPath);

  if (entries.length === 0) {
    process.stdout.write('(no published pages)\n');
    if (skipped) process.stdout.write(`(skipped ${skipped} malformed entries)\n`);
    return;
  }

  const rows = values.all
    ? entries.map((e) => ({
        slug: e.slug,
        lastTs: e.ts,
        lastAction: e.action,
        count: 1,
        lastSource: e.source,
      }))
    : groupBySlug(entries);

  const sorted = [...rows].sort((a, b) => (b.lastTs || '').localeCompare(a.lastTs || ''));

  for (const r of sorted) {
    const ts = (r.lastTs || '').replace('T', ' ').slice(0, 16);
    const url = `/p/${trunc(r.slug, 30)}`;
    const action = r.lastAction === 'delete' ? 'DELETED' : r.lastAction;
    const count = r.lastAction === 'delete' ? '—' : `${r.count}×`;
    const source = r.lastAction === 'delete' ? '—' : trunc(r.lastSource ?? '', 40);
    process.stdout.write(
      `${pad(ts, 17)}${pad(url, 33)}${pad(action, 12)}${pad(count, 6)}${source}\n`,
    );
  }
  if (skipped) process.stdout.write(`(skipped ${skipped} malformed entries)\n`);
}
