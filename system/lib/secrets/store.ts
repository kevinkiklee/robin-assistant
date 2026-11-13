import { execFileSync } from 'node:child_process';
import { appendFileSync, chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { readEnvFile, writeEnvKey } from './env-file.ts';

export function secretsPaths(userData: string): {
  vault: string;
  robinEnv: string;
  daemonEnv: string;
  redactFiles: string;
  window: string;
  op: string;
  armSession: string;
  deliveries: string;
  log: string;
} {
  const secrets = join(userData, 'config', 'secrets');
  const runtime = join(userData, 'state', 'runtime');
  return {
    vault: join(secrets, 'vault.env'),
    robinEnv: join(secrets, '.env'),
    daemonEnv: join(secrets, 'daemon.env'),
    redactFiles: join(secrets, 'redact-files.txt'),
    window: join(runtime, 'secret-window.json'),
    op: join(runtime, 'secret-op.json'),
    armSession: join(runtime, 'secret-arm-session.json'),
    deliveries: join(runtime, 'secret-deliveries.json'),
    log: join(runtime, 'secret-log.jsonl'),
  };
}

/** Throws for names that would enable paid credits or are not env-var shaped. */
export function assertNameAllowed(name: string): void {
  if (name === 'ANTHROPIC_API_KEY' || /^CLAUDE_CREDIT_KEY_/.test(name)) {
    throw new Error(`refused: ${name} would enable paid credits`);
  }
  if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) {
    throw new Error(`invalid name: ${name} (expected [A-Z_][A-Z0-9_]*)`);
  }
}

export function isSecretClassName(name: string): boolean {
  return /KEY|TOKEN|SECRET|PASSWORD/.test(name);
}

export function fingerprint(value: string): string {
  return `…${value.slice(-4)} (${value.length})`;
}

/** Default shape when a provider has no recipe: one line, no whitespace, ≥16 chars. */
export const defaultShape: RegExp = /^\S{16,}$/;

export function getMaster(userData: string, name: string): string | undefined {
  return readEnvFile(secretsPaths(userData).vault).get(name);
}

export function setMaster(userData: string, name: string, value: string): 'saved' | 'unchanged' {
  const { vault } = secretsPaths(userData);
  if (readEnvFile(vault).get(name) === value) return 'unchanged';
  mkdirSync(join(userData, 'config', 'secrets'), { recursive: true });
  writeEnvKey(vault, name, value);
  return 'saved';
}

function defaultLaunchctlGetenv(n: string): string | undefined {
  try {
    const out = execFileSync('launchctl', ['getenv', n], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}

/** Where an existing definition of `name` would override the one we deliver, or null. */
export function findShadowing(
  name: string,
  deps: {
    env: NodeJS.ProcessEnv;
    launchctlGetenv?: (n: string) => string | undefined;
    daemonEnvPath: string;
    target: 'robin-env' | 'env-local';
  },
): string | null {
  if (deps.env[name]) return 'shell environment';
  if ((deps.launchctlGetenv ?? defaultLaunchctlGetenv)(name)) return 'launchctl environment';
  if (deps.target === 'robin-env' && readEnvFile(deps.daemonEnvPath).has(name)) return 'daemon.env';
  return null;
}

/** Copy secret-class values (≥16 chars) from Robin's `.env` into the vault when absent. */
export function importRobinEnv(userData: string): string[] {
  const p = secretsPaths(userData);
  const vault = readEnvFile(p.vault);
  const imported: string[] = [];
  for (const [name, value] of readEnvFile(p.robinEnv)) {
    if (!isSecretClassName(name) || value.length < 16 || vault.has(name)) continue;
    setMaster(userData, name, value);
    imported.push(name);
  }
  return imported;
}

export function appendLog(
  userData: string,
  entry: { op: string; provider?: string; name: string; fingerprint?: string; session?: string },
): void {
  const { log } = secretsPaths(userData);
  mkdirSync(join(userData, 'state', 'runtime'), { recursive: true });
  appendFileSync(log, `${JSON.stringify({ ...entry, ts: new Date().toISOString() })}\n`, {
    mode: 0o600,
  });
  chmodSync(log, 0o600);
}
