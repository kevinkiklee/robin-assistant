import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Cloud-role marker. Absent = a normal single-machine Robin (every guard is a
 * no-op). `mac-locked` = Robin moved to a VM; this copy must not run.
 * `vm-dry-run` = a rehearsal copy that serves HTTP but never ticks integrations
 * or jobs. `vm-primary` = the live VM.
 */
export type CloudRole = 'mac-locked' | 'vm-dry-run' | 'vm-primary';

export interface CloudRoleRecord {
  role: CloudRole;
  host?: string;
  /** ISO timestamp the role was set. */
  at: string;
  commit?: string;
}

const ROLES: readonly string[] = ['mac-locked', 'vm-dry-run', 'vm-primary'];

export function rolePath(userData: string): string {
  return join(userData, 'state', 'runtime', 'cloud-role.json');
}

/** Missing or corrupt marker reads as `null` (no role). */
export function readRole(userData: string): CloudRoleRecord | null {
  try {
    const raw = JSON.parse(readFileSync(rolePath(userData), 'utf8')) as unknown;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
    const r = raw as Record<string, unknown>;
    if (typeof r.role !== 'string' || !ROLES.includes(r.role)) return null;
    if (typeof r.at !== 'string') return null;
    const rec: CloudRoleRecord = { role: r.role as CloudRole, at: r.at };
    if (typeof r.host === 'string') rec.host = r.host;
    if (typeof r.commit === 'string') rec.commit = r.commit;
    return rec;
  } catch {
    return null;
  }
}

/** Atomic tmp + rename write. */
export function writeRole(userData: string, rec: CloudRoleRecord): void {
  const path = rolePath(userData);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(rec, null, 2)}\n`);
  renameSync(tmp, path);
}

export function clearRole(userData: string): void {
  try {
    unlinkSync(rolePath(userData));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

const LOCKED_CLI_ALLOWED: ReadonlySet<string> = new Set([
  'cloud',
  'help',
  '--help',
  '-h',
  'version',
  '--version',
]);

/** Commands a locked Mac copy may still run. */
export function cliAllowedWhenLocked(cmd: string | undefined): boolean {
  return cmd === undefined || LOCKED_CLI_ALLOWED.has(cmd);
}

/** The refusal printed by the CLI under `mac-locked`. */
export function lockedCliMessage(rec: CloudRoleRecord): string {
  const host = rec.host ?? 'the VM';
  return `This Mac's Robin is locked — Robin runs on ${host}. Use: ssh ${host}, or robin cloud rollback.`;
}

/**
 * The integration/job run guard: a dry-run VM and a locked Mac never tick
 * integrations (a second copy ticking would rotate the shared WHOOP token family).
 */
export function assertCanRunIntegrations(userData: string): void {
  const rec = readRole(userData);
  if (rec && (rec.role === 'vm-dry-run' || rec.role === 'mac-locked')) {
    throw new Error(`cloud role ${rec.role}: integrations are held`);
  }
}

/**
 * CLI guard: the refusal text when this Mac is locked and `cmd` isn't allowed,
 * else null.
 */
export function lockedCliRefusal(userData: string, cmd: string | undefined): string | null {
  const rec = readRole(userData);
  if (rec?.role !== 'mac-locked' || cliAllowedWhenLocked(cmd)) return null;
  return lockedCliMessage(rec);
}
