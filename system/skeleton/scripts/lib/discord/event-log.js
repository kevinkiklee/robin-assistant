import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const METADATA_KEYS = new Set([
  'ts', 'status', 'userId', 'conversationKey', 'latencyMs',
  'claudeSessionId', 'totalCostUsd', 'error', 'event',
]);

export function createEventLog({ path }) {
  let initPromise = mkdir(dirname(path), { recursive: true });

  return {
    async append(record) {
      await initPromise;
      const filtered = {};
      for (const [k, v] of Object.entries(record)) {
        if (METADATA_KEYS.has(k)) filtered[k] = v;
      }
      filtered.ts = filtered.ts ?? new Date().toISOString();
      await appendFile(path, JSON.stringify(filtered) + '\n');
    },
    async read24hCost() {
      try {
        const raw = await readFile(path, 'utf-8');
        const cutoff = Date.now() - 24 * 3600 * 1000;
        let sum = 0;
        for (const line of raw.split('\n')) {
          if (!line.trim()) continue;
          let r;
          try { r = JSON.parse(line); } catch { continue; }
          if (!r.totalCostUsd) continue;
          const ts = new Date(r.ts).getTime();
          if (ts >= cutoff) sum += r.totalCostUsd;
        }
        return sum;
      } catch (err) {
        if (err.code === 'ENOENT') return 0;
        throw err;
      }
    },
  };
}
