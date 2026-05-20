import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { Integration, IntegrationManifest } from './types.ts';

export interface LoadedIntegration {
  manifest: IntegrationManifest;
  module: Integration;
  rootDir: string;
  /** Effective unique name used for scheduling + KV namespacing. Equals manifest.name unless dir is <name>--<instance>. */
  instanceName: string;
}

async function loadOne(dir: string): Promise<LoadedIntegration | null> {
  const manifestPath = join(dir, 'integration.yaml');
  if (!existsSync(manifestPath)) return null;
  const manifest = parseYaml(readFileSync(manifestPath, 'utf8')) as IntegrationManifest;
  const dirName = basename(dir);
  // Allow multi-instance via <base>--<instance> directory naming
  const instanceName = dirName.includes('--') ? dirName : manifest.name;
  const entryTs = join(dir, 'index.ts');
  const entryJs = join(dir, 'index.js');
  const entry = existsSync(entryTs) ? entryTs : existsSync(entryJs) ? entryJs : null;
  if (!entry) throw new Error(`integration ${manifest.name}: missing index.ts/index.js`);
  // Use file:// URL for dynamic ESM import
  const url = `file://${resolve(entry)}`;
  const mod = await import(url);
  const integration: Integration = mod.integration ?? mod.default;
  if (!integration)
    throw new Error(`integration ${manifest.name}: index must export 'integration' or default`);
  return { manifest, module: integration, rootDir: dir, instanceName };
}

export async function loadIntegrations(rootDirs: string[]): Promise<LoadedIntegration[]> {
  const result: LoadedIntegration[] = [];
  for (const root of rootDirs) {
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root)) {
      if (entry.startsWith('_') || entry.startsWith('.')) continue;
      const full = join(root, entry);
      if (!statSync(full).isDirectory()) continue;
      try {
        const loaded = await loadOne(full);
        if (loaded) result.push(loaded);
      } catch (err) {
        // biome-ignore lint/suspicious/noConsole: surface load failures to the operator
        console.error(
          `integration loader: failed to load ${full}: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
  }
  return result;
}
