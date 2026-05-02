import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname, join, basename } from 'node:path';

export async function createSessionStore({ path }) {
  await mkdir(dirname(path), { recursive: true });
  let data = {};
  try {
    const raw = await readFile(path, 'utf-8');
    try {
      data = JSON.parse(raw);
    } catch {
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const corruptPath = join(dirname(path), `${basename(path, '.json')}.corrupt-${ts}.json`);
      await rename(path, corruptPath);
      data = {};
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    data = {};
  }

  async function persist() {
    const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tmp, JSON.stringify(data, null, 2));
    await rename(tmp, path);
  }

  return {
    getSession(key) {
      return data[key] ?? null;
    },
    async setSession(key, claudeSessionId) {
      data[key] = { claudeSessionId, lastActiveAt: new Date().toISOString() };
      await persist();
    },
    async touch(key) {
      if (!data[key]) return;
      data[key].lastActiveAt = new Date().toISOString();
      await persist();
    },
    async drop(key) {
      if (!(key in data)) return;
      delete data[key];
      await persist();
    },
    async expireIdle({ dm, thread }) {
      const now = Date.now();
      const dropped = new Set();
      for (const [key, entry] of Object.entries(data)) {
        const age = now - new Date(entry.lastActiveAt).getTime();
        const ttl = key.startsWith('dm-') ? dm : thread;
        if (age > ttl) {
          delete data[key];
          dropped.add(key);
        }
      }
      if (dropped.size) await persist();
      return dropped;
    },
  };
}
