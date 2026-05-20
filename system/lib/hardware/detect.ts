import { execSync } from 'node:child_process';
import { arch, cpus, platform, totalmem } from 'node:os';

export interface HardwareProfile {
  cpu: string;
  arch: string;
  ram_gb: number;
  os: string;
  profile: string;
}

export function detectHardware(): HardwareProfile {
  const ramGb = Math.round(totalmem() / 1024 ** 3);
  const cpuModel = cpus()[0]?.model ?? 'unknown';
  const os = `${platform()}-${getOsVersion()}`;
  const a = arch();
  const profile = chooseProfile(cpuModel, ramGb, a, platform());
  return { cpu: cpuModel, arch: a, ram_gb: ramGb, os, profile };
}

function getOsVersion(): string {
  try {
    if (platform() === 'darwin') {
      return execSync('sw_vers -productVersion', { encoding: 'utf8' }).trim();
    }
    if (platform() === 'linux') {
      return execSync('uname -r', { encoding: 'utf8' }).trim();
    }
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

function chooseProfile(cpu: string, ramGb: number, a: string, plat: string): string {
  const isApple = a === 'arm64' && plat === 'darwin';
  if (isApple && /M5/.test(cpu) && ramGb >= 120) return 'm5-max-128gb';
  if (isApple && /M5/.test(cpu) && ramGb >= 60) return 'm5-max-64gb';
  if (isApple && /M5/.test(cpu) && ramGb >= 40) return 'm5-pro-48gb';
  if (isApple && /M4/.test(cpu)) return 'm4-apple-silicon';
  if (isApple && /M[23]/.test(cpu)) return 'm2-m3-apple-silicon';
  if (isApple && ramGb < 24) return 'm-air-low-ram';
  if (plat === 'linux' && a === 'x64' && ramGb >= 24) return 'linux-x86-32gb';
  return 'cloud-only';
}
