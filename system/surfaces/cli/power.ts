import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { loadPolicies } from '../../kernel/config/load.ts';
import { resolveUserDataDir } from '../../lib/paths.ts';

function parseDurationMs(s: string): number {
  if (s.endsWith('h')) return Number.parseInt(s, 10) * 3600 * 1000;
  if (s.endsWith('m')) return Number.parseInt(s, 10) * 60 * 1000;
  if (s.endsWith('s')) return Number.parseInt(s, 10) * 1000;
  return Number.parseInt(s, 10);
}

function writePolicies(userData: string, next: unknown): void {
  const path = join(userData, 'config', 'policies.yaml');
  mkdirSync(join(userData, 'config'), { recursive: true });
  writeFileSync(path, stringifyYaml(next));
}

/** The `robin pause` / `robin resume` policy write, for an explicit instance. */
export function setPowerState(userData: string, state: 'paused' | 'active'): void {
  const p = loadPolicies(userData);
  p.power.state = state;
  p.power.set_by = 'user';
  p.power.since = new Date().toISOString();
  delete p.power.reason;
  writePolicies(userData, p);
}

export function runPause(): void {
  setPowerState(resolveUserDataDir(), 'paused');
  console.log('Robin paused. Scheduled jobs will not run until `robin resume`.');
}

export function runResume(): void {
  setPowerState(resolveUserDataDir(), 'active');
  console.log('Robin active.');
}

export function runIncognito(durationStr?: string): void {
  const userData = resolveUserDataDir();
  const p = loadPolicies(userData);
  if (durationStr === 'off') {
    p.capture.enabled = true;
    delete (p.capture as { expires_at?: string }).expires_at;
    writePolicies(userData, p);
    console.log('Incognito off — capture enabled.');
    return;
  }
  p.capture.enabled = false;
  if (durationStr && durationStr !== 'permanent') {
    const ms = parseDurationMs(durationStr);
    (p.capture as { expires_at?: string }).expires_at = new Date(Date.now() + ms).toISOString();
  } else {
    delete (p.capture as { expires_at?: string }).expires_at;
  }
  writePolicies(userData, p);
  console.log(`Incognito ${durationStr ?? 'permanent'} — capture disabled.`);
}

/**
 * A manual mode change: the power monitor won't override it until a quiet-hours
 * or metered rule next starts, and never treats it as its own to undo.
 */
function setNetworkManually(p: ReturnType<typeof loadPolicies>, mode: 'online' | 'offline'): void {
  p.network.mode = mode;
  p.network.set_by = 'user';
  p.network.since = new Date().toISOString();
  delete p.network.reason;
  delete p.network.prior_mode;
}

export function runOffline(): void {
  const userData = resolveUserDataDir();
  const p = loadPolicies(userData);
  setNetworkManually(p, 'offline');
  writePolicies(userData, p);
  console.log('Robin offline — scheduled work halted until `robin online`.');
}

export function runOnline(): void {
  const userData = resolveUserDataDir();
  const p = loadPolicies(userData);
  setNetworkManually(p, 'online');
  writePolicies(userData, p);
  console.log('Robin online.');
}

export function runStatus(json: boolean = false): void {
  const userData = resolveUserDataDir();
  const p = loadPolicies(userData);
  if (json) {
    console.log(JSON.stringify(p, null, 2));
    return;
  }
  const expiresAt = (p.capture as { expires_at?: string }).expires_at;
  const captureLine = `  capture: ${p.capture.enabled ? 'on' : 'off'}${
    expiresAt ? ` (until ${expiresAt})` : ''
  }`;
  /* biome-ignore-start lint/suspicious/noConsole: CLI output */
  console.log('Robin status:');
  const auto = (set: string | undefined, reason: string | undefined) =>
    set === 'auto' && reason ? ` (auto: ${reason})` : '';
  console.log(`  power:   ${p.power.state}${auto(p.power.set_by, p.power.reason)}`);
  console.log(captureLine);
  console.log(`  network: ${p.network.mode}${auto(p.network.set_by, p.network.reason)}`);
  /* biome-ignore-end lint/suspicious/noConsole: CLI output */
}
