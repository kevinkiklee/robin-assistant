import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { resolveBuiltinIntegrationsRoot } from '../../integrations/_runtime/gc.ts';
import { resolveBuiltinJobsRoot } from '../../jobs/_runtime/loader.ts';
import { parsePlatforms, platformSkipLabel, runsOnThisPlatform } from '../../lib/platform.ts';

export interface PlatformSkip {
  /** Instance name (dir name for multi-instance dirs, else manifest.name). */
  name: string;
  kind: 'integration' | 'job';
  /** Scheduler job name, e.g. `integration.chrome.tick` / `job.foo.run`. */
  jobName: string;
  reason: string;
}

/** One entry per manifest found; `skip` is set only when it is platform-skipped. */
function scanRoot(root: string, file: string, kind: PlatformSkip['kind'], platform: string) {
  const out: Array<{ jobName: string; skip: PlatformSkip | null }> = [];
  if (!existsSync(root)) return out;
  for (const entry of readdirSync(root)) {
    if (entry.startsWith('_') || entry.startsWith('.')) continue;
    const full = join(root, entry);
    try {
      if (!statSync(full).isDirectory()) continue;
      const manifestPath = join(full, file);
      if (!existsSync(manifestPath)) continue;
      const manifest = parseYaml(readFileSync(manifestPath, 'utf8')) as {
        name?: string;
        platforms?: unknown;
      };
      const platforms = parsePlatforms(manifest?.platforms);
      const name = entry.includes('--') ? entry : (manifest.name ?? entry);
      const jobName = kind === 'integration' ? `integration.${name}.tick` : `job.${name}.run`;
      const skipped = platforms && !runsOnThisPlatform({ platforms }, platform);
      out.push({
        jobName,
        skip: skipped ? { name, kind, jobName, reason: platformSkipLabel({ platforms }) } : null,
      });
    } catch {
      // Unparseable manifest: can't tell, so it is not treated as skipped.
    }
  }
  return out;
}

/**
 * Integrations and jobs whose `platforms:` excludes this OS, read from disk
 * (YAML only, no module import). One source of truth for the health invariants
 * and `robin integrations`, so they all agree on what is skipped.
 */
export function listPlatformSkips(
  userData: string,
  platform: string = process.platform,
  roots: { integrations?: string[]; jobs?: string[] } = {},
): PlatformSkip[] {
  const integrationRoots = roots.integrations ?? [
    join(userData, 'extensions', 'integrations'),
    resolveBuiltinIntegrationsRoot(),
  ];
  const jobRoots = roots.jobs ?? [join(userData, 'extensions', 'jobs'), resolveBuiltinJobsRoot()];
  const seen = new Set<string>();
  const out: PlatformSkip[] = [];
  // User-data is scanned first and shadows a same-named builtin, skipped or not.
  const add = (list: ReturnType<typeof scanRoot>) => {
    for (const e of list) {
      if (seen.has(e.jobName)) continue;
      seen.add(e.jobName);
      if (e.skip) out.push(e.skip);
    }
  };
  for (const r of integrationRoots) add(scanRoot(r, 'integration.yaml', 'integration', platform));
  for (const r of jobRoots) add(scanRoot(r, 'job.yaml', 'job', platform));
  return out;
}
