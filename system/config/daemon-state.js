import { chmod, readFile, rename, unlink, writeFile } from 'node:fs/promises';

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
  // The state file contains the daemon's per-boot auth_token; restrict reads
  // to the owner so other local users can't read it and hit /internal/*
  // endpoints. Loopback binding already blocks remote access; this defends
  // against multi-user machines and processes running under different uids.
  const tmp = `${path}.tmp.${process.pid}`;
  await writeFile(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
  await rename(tmp, path);
  await chmod(path, 0o600);
}

export async function clearDaemonState(path) {
  try {
    await unlink(path);
  } catch {
    /* idempotent */
  }
}
