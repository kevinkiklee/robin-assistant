import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import type { Job, JobManifest } from './types.ts';

/**
 * Resolve the builtin-jobs root from THIS module's location, not process.cwd()
 * (under launchd the daemon's cwd is user-data/). Mirrors the integration loader's
 * resolveBuiltinIntegrationsRoot: this file lives at
 * `<root>/{system|dist}/jobs/_runtime/loader.{ts|js}`, builtins under `../builtin`.
 */
export function resolveBuiltinJobsRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidate = join(here, '..', 'builtin');
  if (existsSync(candidate)) return candidate;
  return join(process.cwd(), 'system/jobs/builtin');
}

/**
 * Enumerate the instance names of every job that has a directory on disk, WITHOUT
 * importing its code (parses only `job.yaml`). Mirrors listOnDiskIntegrationNames.
 * Used by the orphan-state GC so a currently-installed job's `integration_state`
 * cursor (e.g. feed-watch's cursor) is never mistaken for a removed
 * integration and deleted. A removed job's state IS still GC'd — the set is keyed
 * on directories present, so deleting the job dir correctly drops its state next boot.
 */
export function listOnDiskJobNames(rootDirs: string[]): Set<string> {
  const names = new Set<string>();
  for (const root of rootDirs) {
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root)) {
      if (entry.startsWith('_') || entry.startsWith('.')) continue;
      const full = join(root, entry);
      if (!statSync(full).isDirectory()) continue;
      const manifestPath = join(full, 'job.yaml');
      if (!existsSync(manifestPath)) continue;
      // Mirror loadOne()'s instanceName: multi-instance dirs (<base>--<instance>)
      // namespace by dir name; others by manifest.name.
      if (entry.includes('--')) {
        names.add(entry);
        continue;
      }
      try {
        const manifest = parseYaml(readFileSync(manifestPath, 'utf8')) as JobManifest;
        if (manifest?.name) names.add(manifest.name);
      } catch {
        names.add(entry); // unparseable manifest → treat dir as present
      }
    }
  }
  return names;
}

export interface LoadedJob {
  manifest: JobManifest;
  module: Job;
  rootDir: string;
  /** Effective unique name used for scheduling. Equals manifest.name unless dir is <name>--<instance>. */
  instanceName: string;
}

// Mirrors integration loader: prefer .js when running compiled, .ts when running via tsx.
const LOADER_IS_COMPILED = import.meta.url.endsWith('.js');

async function loadOne(dir: string): Promise<LoadedJob | null> {
  const manifestPath = join(dir, 'job.yaml');
  if (!existsSync(manifestPath)) return null;
  const manifest = parseYaml(readFileSync(manifestPath, 'utf8')) as JobManifest;
  const dirName = basename(dir);
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
  if (!entry) throw new Error(`job ${manifest.name}: missing index.ts/index.js`);
  const url = `file://${resolve(entry)}`;
  const mod = await import(url);
  const job: Job = mod.job ?? mod.default;
  if (!job) throw new Error(`job ${manifest.name}: index must export 'job' or default`);
  return { manifest, module: job, rootDir: dir, instanceName };
}

export async function loadJobs(rootDirs: string[]): Promise<LoadedJob[]> {
  const result: LoadedJob[] = [];
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
          `job loader: failed to load ${full}: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
  }
  return result;
}
