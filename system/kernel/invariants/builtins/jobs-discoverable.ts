import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RobinDb } from '../../../brain/memory/db.ts';
import { resolveUserDataDir } from '../../../lib/paths.ts';
import type { Invariant } from '../types.ts';

/**
 * For every `job.<name>.run` job pending or recently completed in the scheduler queue,
 * confirm there's a loadable manifest+entry under one of the known job roots
 * (system/jobs/builtin or user-data/extensions/jobs).
 *
 * Why this exists: an earlier session mid-restructure deleted daily-brief's
 * `index.ts`/`job.yaml` while leaving its cron schedule intact AND leaving prompt.md
 * behind, so the directory still existed and the loader silently skipped it. The
 * scheduler kept enqueuing `job.daily-brief.run` rows that had no handler. The only
 * symptom was "robin brief" returning "daily-brief job not found", and even that was
 * only visible on manual invocation — the cron-driven attempts would have logged
 * "no handler registered for job" warnings nobody reads.
 *
 * Severity `warning`: the daemon is still functional, but specific scheduled work is
 * silently no-op'ing. Fires when ≥1 scheduled job name has no loadable counterpart.
 */
export function jobsDiscoverableInvariant(db: RobinDb): Invariant {
  return {
    name: 'jobs.discoverable',
    severity: 'warning',
    symptom: 'A scheduled job has no loadable code — every fire silently no-ops.',
    cause:
      "The job's index.ts/index.js or job.yaml was deleted (e.g. mid-restructure) while its cron row in the jobs table remained.",
    fix: 'Either restore the missing files under user-data/extensions/jobs/<name>/ (or system/jobs/builtin/<name>/) OR delete the orphan cron row from the jobs table and restart the daemon.',
    check: () => {
      try {
        const here = dirname(fileURLToPath(import.meta.url));
        // here = .../system/invariants/builtins or .../dist/invariants/builtins.
        // The runtime-relevant job roots are dist/jobs/builtin (when running compiled)
        // and user-data/extensions/jobs (always). The source-tree builtin path
        // (system/jobs/builtin) is included too for `pnpm dev` runs.
        const roots = [
          join(here, '..', '..', '..', 'jobs', 'builtin'), // .../system/jobs/builtin or .../dist/jobs/builtin
          join(resolveUserDataDir(), 'extensions', 'jobs'),
        ];

        // Extract the job name by trimming the literal `job.` prefix (4 chars) and
        // `.run` suffix (4 chars). The earlier replace-twice approach broke on names
        // containing `.job.` substrings ("real-job.run" → replace removed the `job.`
        // inside the name itself → "real-run"). substr is unambiguous.
        const names = db
          .prepare(
            `SELECT DISTINCT substr(name, 5, length(name) - 8) AS jname
               FROM jobs WHERE name LIKE 'job.%.run'`,
          )
          .all() as Array<{ jname: string }>;
        if (names.length === 0) return { ok: true };

        const orphaned: string[] = [];
        for (const { jname } of names) {
          let found = false;
          for (const root of roots) {
            const dir = join(root, jname);
            if (!existsSync(dir)) continue;
            // A job is loadable when it has BOTH a manifest (job.yaml) and an entry
            // (index.ts or index.js). prompt.md alone — the surviving file from the
            // exact incident this invariant guards against — doesn't count.
            const hasManifest = existsSync(join(dir, 'job.yaml'));
            const hasEntry = existsSync(join(dir, 'index.ts')) || existsSync(join(dir, 'index.js'));
            if (hasManifest && hasEntry) {
              found = true;
              break;
            }
          }
          if (!found) orphaned.push(jname);
        }
        if (orphaned.length === 0) return { ok: true };
        return {
          ok: false,
          message: `orphan jobs (scheduled but no loadable code): ${orphaned.join(', ')}`,
          remediation: 'restore the missing files or remove the orphan rows from the jobs table',
        };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}
