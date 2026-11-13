// State files for the blind key window. None holds a key value (the window
// stores hashes only). Each is written 0600 via tmp + rename.

import { randomBytes } from 'node:crypto';
import { linkSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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

export const ARM_TTL_MS = 10_000;

/**
 * Writes tmp then moves it into place. `exclusive` publishes with `link`, which
 * fails with EEXIST instead of replacing an existing file, so the record appears
 * complete or not at all.
 */
function writeJson(path: string, value: unknown, exclusive = false): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  try {
    writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
    if (exclusive) {
      linkSync(tmp, path);
      rmSync(tmp, { force: true });
    } else {
      renameSync(tmp, path);
    }
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

function readJson<T>(path: string): T | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
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
    return readJson<SecretOp>(secretsPaths(userData).op) ?? null;
  } catch {
    return null;
  }
}

export function clearOp(userData: string): void {
  remove(secretsPaths(userData).op);
}

/** Null only when absent; throws on unparseable content so guards fail closed. */
export function readWindow(userData: string): SecretWindow | null {
  const w = readJson<unknown>(secretsPaths(userData).window);
  if (w === undefined) return null;
  if (!isWindowShape(w)) throw new Error('secret window file has an invalid shape');
  return w;
}

function isWindowShape(v: unknown): v is SecretWindow {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  const strs = ['sessionId', 'provider', 'name', 'clipboardHashAtArm', 'openedAt', 'expiresAt'];
  return (
    strs.every((k) => typeof o[k] === 'string') &&
    Number.isInteger(o.tabId) &&
    Array.isArray(o.scriptHashes) &&
    o.scriptHashes.every((h) => typeof h === 'string') &&
    (o.status === 'open' || o.status === 'saved' || o.status === 'aborted')
  );
}

export function writeWindow(userData: string, w: SecretWindow): void {
  writeJson(secretsPaths(userData).window, w);
}

export function updateWindow(userData: string, patch: Partial<SecretWindow>): void {
  const cur = readWindow(userData);
  if (!cur || cur.status !== 'open') return;
  writeWindow(userData, { ...cur, ...patch });
}

export function closeWindow(userData: string): void {
  remove(secretsPaths(userData).window);
}

/** With `{ exclusive: true }`, throws an EEXIST error instead of replacing an existing record. */
export function writeArmSession(
  userData: string,
  s: { sessionId: string; tabId: number; at: string },
  opts: { exclusive?: boolean } = {},
): void {
  writeJson(secretsPaths(userData).armSession, s, opts.exclusive === true);
}

export function takeArmSession(
  userData: string,
  now: Date,
): { sessionId: string; tabId: number } | null {
  const p = secretsPaths(userData).armSession;
  const claim = `${p}.claim-${process.pid}-${randomBytes(4).toString('hex')}`;
  try {
    renameSync(p, claim);
  } catch {
    return null;
  }
  let s: { sessionId: string; tabId: number; at: string } | null;
  try {
    s = JSON.parse(readFileSync(claim, 'utf8'));
  } catch {
    s = null;
  } finally {
    remove(claim);
  }
  if (!s || typeof s !== 'object') return null;
  const age = now.getTime() - new Date(s.at).getTime();
  if (!Number.isFinite(age) || age < 0 || age > ARM_TTL_MS) return null;
  return { sessionId: s.sessionId, tabId: s.tabId };
}

export function isExpired(w: SecretWindow, now: Date): boolean {
  const exp = new Date(w.expiresAt).getTime();
  return Number.isNaN(exp) || now.getTime() >= exp;
}
