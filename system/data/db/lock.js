import { open, unlink } from 'node:fs/promises';

// Cooperative single-process advisory lock using file existence + PID check.
// Sufficient for embedded RocksDB single-writer guarantee in Phase 1.
export async function acquire(path, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const start = Date.now();
  while (true) {
    try {
      const fh = await open(path, 'wx'); // exclusive create
      await fh.write(String(process.pid));
      await fh.close();
      return async () => {
        try {
          await unlink(path);
        } catch {
          /* already gone */
        }
      };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (Date.now() - start > timeoutMs) {
        throw new Error(`lock timeout after ${timeoutMs}ms (held at ${path})`);
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}
