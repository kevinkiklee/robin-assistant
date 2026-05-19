import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { resolveUserDataDir } from '../../lib/paths.ts';
import { loadPolicies } from '../../kernel/config/load.ts';

function parseDurationMs(s: string): number {
  if (s.endsWith('h')) return Number.parseInt(s) * 3600 * 1000;
  if (s.endsWith('m')) return Number.parseInt(s) * 60 * 1000;
  if (s.endsWith('s')) return Number.parseInt(s) * 1000;
  return Number.parseInt(s);
}

function writePolicies(userData: string, next: unknown): void {
  const path = join(userData, 'config', 'policies.yaml');
  writeFileSync(path, stringifyYaml(next));
}

export function runPause(): void {
  const userData = resolveUserDataDir();
  const p = loadPolicies(userData);
  p.power.state = 'paused';
  writePolicies(userData, p);
  // biome-ignore lint/suspicious/noConsole: CLI output
  console.log('Robin paused. Scheduled jobs will not run until `robin resume`.');
}

export function runResume(): void {
  const userData = resolveUserDataDir();
  const p = loadPolicies(userData);
  p.power.state = 'active';
  writePolicies(userData, p);
  // biome-ignore lint/suspicious/noConsole: CLI output
  console.log('Robin active.');
}

export function runIncognito(durationStr?: string): void {
  const userData = resolveUserDataDir();
  const p = loadPolicies(userData);
  p.capture.enabled = false;
  if (durationStr && durationStr !== 'permanent') {
    const ms = parseDurationMs(durationStr);
    (p.capture as { expires_at?: string }).expires_at = new Date(Date.now() + ms).toISOString();
  } else {
    delete (p.capture as { expires_at?: string }).expires_at;
  }
  writePolicies(userData, p);
  // biome-ignore lint/suspicious/noConsole: CLI output
  console.log(`Incognito ${durationStr ?? 'permanent'} — capture disabled.`);
}

export function runOffline(): void {
  const userData = resolveUserDataDir();
  const p = loadPolicies(userData);
  p.network.mode = 'offline';
  writePolicies(userData, p);
  // biome-ignore lint/suspicious/noConsole: CLI output
  console.log('Robin offline — no outbound network calls.');
}

export function runOnline(): void {
  const userData = resolveUserDataDir();
  const p = loadPolicies(userData);
  p.network.mode = 'online';
  writePolicies(userData, p);
  // biome-ignore lint/suspicious/noConsole: CLI output
  console.log('Robin online.');
}

export function runStatus(json: boolean = false): void {
  const userData = resolveUserDataDir();
  const p = loadPolicies(userData);
  if (json) {
    // biome-ignore lint/suspicious/noConsole: CLI output
    console.log(JSON.stringify(p, null, 2));
    return;
  }
  // biome-ignore lint/suspicious/noConsole: CLI output
  console.log('Robin status:');
  console.log(`  power:   ${p.power.state}`);
  console.log(
    `  capture: ${p.capture.enabled ? 'on' : 'off'}${(p.capture as { expires_at?: string }).expires_at ? ` (until ${(p.capture as { expires_at?: string }).expires_at})` : ''}`,
  );
  console.log(`  network: ${p.network.mode}`);
}
