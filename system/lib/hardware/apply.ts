import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import type { HardwareProfile } from './detect.ts';

export function writeHardwareYaml(userDataDir: string, hw: HardwareProfile): string {
  const path = join(userDataDir, 'config', 'hardware.yaml');
  mkdirSync(dirname(path), { recursive: true });
  const doc = {
    detected: hw,
    runtime: chooseRuntimeDefaults(hw.profile),
    scheduling: { prefer_overnight: { enabled: true, start: '02:00', end: '06:00' } },
  };
  writeFileSync(path, stringifyYaml(doc));
  return path;
}

function chooseRuntimeDefaults(profile: string): Record<string, unknown> {
  switch (profile) {
    case 'm5-max-64gb':
    case 'm5-max-128gb':
      return { ollama_backend: 'mlx', max_concurrent_models: 3, thread_budget: 12, thermal_cooldown_ms: 90_000, thermal_trigger_min_runtime_ms: 300_000 };
    case 'm5-pro-48gb':
    case 'm4-apple-silicon':
      return { ollama_backend: 'mlx', max_concurrent_models: 2, thread_budget: 8, thermal_cooldown_ms: 120_000 };
    case 'm-air-low-ram':
    case 'm2-m3-apple-silicon':
      return { ollama_backend: 'mlx', max_concurrent_models: 1, thread_budget: 4 };
    case 'linux-x86-32gb':
      return { ollama_backend: 'llama-cpp', max_concurrent_models: 1, thread_budget: 8 };
    case 'cloud-only':
    default:
      return { ollama_backend: 'none', max_concurrent_models: 0 };
  }
}
