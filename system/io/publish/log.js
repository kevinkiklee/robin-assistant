import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export async function appendLogEntry(logPath, row) {
  await mkdir(dirname(logPath), { recursive: true });
  // O_APPEND atomic for sub-PIPE_BUF (4KB) writes; rows are far smaller.
  await appendFile(logPath, `${JSON.stringify(row)}\n`);
}

export async function readLog(logPath) {
  let raw;
  try {
    raw = await readFile(logPath, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return { entries: [], skipped: 0 };
    throw e;
  }
  const entries = [];
  let skipped = 0;
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      skipped += 1;
    }
  }
  return { entries, skipped };
}

export function groupBySlug(entries) {
  const map = new Map();
  for (const e of entries) {
    const cur = map.get(e.slug) || { slug: e.slug, count: 0 };
    cur.count += 1;
    cur.lastAction = e.action;
    cur.lastTs = e.ts;
    cur.lastSource = e.source ?? cur.lastSource ?? null;
    cur.lastUrl = e.url ?? cur.lastUrl ?? null;
    map.set(e.slug, cur);
  }
  return [...map.values()];
}
