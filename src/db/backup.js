import { spawnSync } from 'node:child_process';
import { readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
}

async function pruneOldBackups(backupDir) {
  const retentionDays = Number(process.env.ROBIN_BACKUP_RETENTION_DAYS ?? 30);
  if (retentionDays <= 0) return;

  const maxAgeMs = retentionDays * 86400 * 1000;

  let files;
  try {
    files = await readdir(backupDir);
  } catch (e) {
    if (e.code === 'ENOENT') return;
    throw e;
  }

  for (const f of files) {
    if (!f.endsWith('.tar')) continue;
    const filePath = join(backupDir, f);
    let st;
    try {
      st = await stat(filePath);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    if (Date.now() - st.mtimeMs > maxAgeMs) {
      await unlink(filePath);
    }
  }
}

// Tar `srcDir` into `backupDir/<timestamp>.tar`. Returns archive path, or null if srcDir is empty.
export async function snapshot(srcDir, backupDir) {
  let entries;
  try {
    entries = await readdir(srcDir);
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
  if (entries.length === 0) return null;
  await pruneOldBackups(backupDir);
  const archive = join(backupDir, `${timestamp()}.tar`);
  const result = spawnSync('tar', ['-cf', archive, '-C', srcDir, '.'], { stdio: 'pipe' });
  if (result.status !== 0) {
    throw new Error(`tar failed (status=${result.status}): ${result.stderr?.toString()}`);
  }
  return archive;
}
