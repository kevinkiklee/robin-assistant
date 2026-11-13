// State files for the blind key window. None holds a key value (the window
// stores hashes only). Each is written 0600 via tmp + rename.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DeliveryTarget } from './deliveries.ts';
import { secretsPaths } from './store.ts';

export interface SecretOp {
  provider: string;
  name: string;
  mode: 'create' | 'rotate' | 'get' | 'manual';
  targets: DeliveryTarget[];
  startedAt: string;
}

export interface SecretWindow {
  sessionId: string;
  tabId: number;
  provider: string;
  name: string;
  scriptHashes: string[];
  clipboardHashAtArm: string;
  openedAt: string;
  expiresAt: string;
  status: 'open' | 'saved' | 'aborted';
}

const ARM_TTL_MS = 10_000;

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
  renameSync(tmp, path);
}

function readJson<T>(path: string): T | null {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
  return JSON.parse(raw) as T;
}

function remove(path: string): void {
  rmSync(path, { force: true });
}

export function writeOp(userData: string, op: SecretOp): void {
  writeJson(secretsPaths(userData).op, op);
}

export function readOp(userData: string): SecretOp | null {
  try {
    return readJson<SecretOp>(secretsPaths(userData).op);
  } catch {
    return null;
  }
}

export function clearOp(userData: string): void {
  remove(secretsPaths(userData).op);
}

/** Null only when absent; throws on unparseable content so guards fail closed. */
export function readWindow(userData: string): SecretWindow | null {
  return readJson<SecretWindow>(secretsPaths(userData).window);
}

export function writeWindow(userData: string, w: SecretWindow): void {
  writeJson(secretsPaths(userData).window, w);
}

export function updateWindow(userData: string, patch: Partial<SecretWindow>): void {
  const cur = readWindow(userData);
  if (!cur) return;
  writeWindow(userData, { ...cur, ...patch });
}

export function closeWindow(userData: string): void {
  remove(secretsPaths(userData).window);
}

export function writeArmSession(
  userData: string,
  s: { sessionId: string; tabId: number; at: string },
): void {
  writeJson(secretsPaths(userData).armSession, s);
}

export function takeArmSession(
  userData: string,
  now: Date,
): { sessionId: string; tabId: number } | null {
  const p = secretsPaths(userData).armSession;
  let s: { sessionId: string; tabId: number; at: string } | null;
  try {
    s = readJson(p);
  } catch {
    s = null;
  }
  remove(p);
  if (!s) return null;
  const age = now.getTime() - new Date(s.at).getTime();
  if (!Number.isFinite(age) || age < 0 || age > ARM_TTL_MS) return null;
  return { sessionId: s.sessionId, tabId: s.tabId };
}

export function isExpired(w: SecretWindow, now: Date): boolean {
  return now.getTime() > new Date(w.expiresAt).getTime();
}
