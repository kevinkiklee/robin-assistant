import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export function writePidfile(path: string, pid: number = process.pid): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, String(pid), 'utf8');
}

export function readPidfile(path: string): number | null {
  if (!existsSync(path)) return null;
  const content = readFileSync(path, 'utf8').trim();
  const pid = Number.parseInt(content, 10);
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

export function removePidfile(path: string): void {
  if (existsSync(path)) unlinkSync(path);
}

export function isProcessAlive(pid: number): boolean {
  try {
    // signal 0 doesn't kill but checks existence + perms
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
