import { readFile, rename, unlink, writeFile } from 'node:fs/promises';

export async function readDaemonState(path) {
  try {
    const raw = await readFile(path, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

export async function writeDaemonState(path, data) {
  const tmp = `${path}.tmp.${process.pid}`;
  await writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await rename(tmp, path);
}

export async function clearDaemonState(path) {
  try {
    await unlink(path);
  } catch {
    /* idempotent */
  }
}
