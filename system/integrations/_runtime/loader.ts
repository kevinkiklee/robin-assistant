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

// Production (dist) loaders import .ts via dynamic `import()` and crash on
// `ERR_UNKNOWN_FILE_EXTENSION`. Detect the runtime by inspecting the loader's
// own URL — if we're a compiled .js, prefer the extension's .js; if we're TS
// (running via tsx in `pnpm dev`), prefer the .ts source so edits live-reload.
const LOADER_IS_COMPILED = import.meta.url.endsWith('.js');

async function loadOne(dir: string): Promise<LoadedIntegration | null> {
  const manifestPath = join(dir, 'integration.yaml');
  if (!existsSync(manifestPath)) return null;
  const manifest = parseYaml(readFileSync(manifestPath, 'utf8')) as IntegrationManifest;
  const dirName = basename(dir);
  // Allow multi-instance via <base>--<instance> directory naming
  const instanceName = dirName.includes('--') ? dirName : manifest.name;
  const entryTs = join(dir, 'index.ts');
  const entryJs = join(dir, 'index.js');
  const entry = LOADER_IS_COMPILED
    ? existsSync(entryJs)
      ? entryJs
      : existsSync(entryTs)
        ? entryTs
        : null
    : existsSync(entryTs)
      ? entryTs
      : existsSync(entryJs)
        ? entryJs
        : null;
  if (!entry) throw new Error(`integration ${manifest.name}: missing index.ts/index.js`);
  // Use file:// URL for dynamic ESM import
  const url = `file://${resolve(entry)}`;
  const mod = await import(url);
  const integration: Integration = mod.integration ?? mod.default;
  if (!integration)
    throw new Error(`integration ${manifest.name}: index must export 'integration' or default`);
  return { manifest, module: integration, rootDir: dir, instanceName };
}

/**
 * Enumerate the instance names of every integration that has a directory on disk,
 * WITHOUT importing its code. This is deliberately resilient: a directory whose
 * `index.ts` fails to compile still counts as "present" (it parses only the
 * manifest), so callers can distinguish "integration removed from disk" from
 * "integration present but failed to load this boot". State cleanup keys off
 * THIS set, never the loaded set — otherwise a transient compile error would
 * look identical to a deletion and wrongly GC the integration's OAuth tokens.
 */
export function listOnDiskIntegrationNames(rootDirs: string[]): Set<string> {
  const names = new Set<string>();
  for (const root of rootDirs) {
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root)) {
      if (entry.startsWith('_') || entry.startsWith('.')) continue;
      const full = join(root, entry);
      if (!statSync(full).isDirectory()) continue;
      const manifestPath = join(full, 'integration.yaml');
      if (!existsSync(manifestPath)) continue;
      // Multi-instance dirs (<base>--<instance>) namespace by the dir name; others
      // by manifest.name — mirror loadOne()'s instanceName derivation exactly so
      // the on-disk set matches the names used for KV namespacing.
      if (entry.includes('--')) {
        names.add(entry);
        continue;
      }
      try {
        const manifest = parseYaml(readFileSync(manifestPath, 'utf8')) as IntegrationManifest;
        if (manifest?.name) names.add(manifest.name);
      } catch {
        // Unparseable manifest → fall back to the dir name so we still treat the
        // directory as present (never GC a present-but-malformed integration).
        names.add(entry);
      }
    }
  }
  return names;
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
