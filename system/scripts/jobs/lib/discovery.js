// Job discovery: read system/jobs/ + user-data/ops/jobs/, parse, validate, and
// return effective definitions (with overrides merged).

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseJobFrontmatter, validateJobDef, mergeOverride } from './frontmatter.js';
import { validateCron } from './cron.js';
import { jobsPaths } from './paths.js';

function listDefs(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md') && f !== 'README.md')
    .map((f) => ({
      filename: f,
      path: join(dir, f),
      content: readFileSync(join(dir, f), 'utf-8'),
    }));
}

// Returns { jobs: Map<name, EffectiveDef>, errors: [{path, errors}] }.
//
// EffectiveDef: { name, frontmatter, body, sourcePath, overridePath?, isOverride }
export function discoverJobs(workspaceDir) {
  const paths = jobsPaths(workspaceDir);
  const systemEntries = listDefs(paths.systemJobsDir);
  const userEntries = listDefs(paths.userJobsDir);

  const errors = [];

  function parseEntries(entries, source) {
    const out = new Map();
    for (const entry of entries) {
      const parsed = parseJobFrontmatter(entry.content);
      // Override files may omit `name:` and rely on the `override:` target.
      const name = parsed.frontmatter.name || parsed.frontmatter.override;
      if (!name) {
        errors.push({ path: entry.path, errors: ['missing name (or override:)'] });
        continue;
      }
      out.set(name, { ...parsed, sourcePath: entry.path, source });
    }
    return out;
  }

  const systemDefs = parseEntries(systemEntries, 'system');
  const userDefs = parseEntries(userEntries, 'user');

  const jobs = new Map();

  // Start with system jobs.
  for (const [name, def] of systemDefs) {
    jobs.set(name, {
      name,
      frontmatter: def.frontmatter,
      body: def.body,
      sourcePath: def.sourcePath,
      isOverride: false,
    });
  }

  // Apply user-data jobs (overrides or full defs).
  for (const [name, ud] of userDefs) {
    const isShallow = !!ud.frontmatter.override;
    const targetName = ud.frontmatter.override || name;

    if (isShallow) {
      const sys = systemDefs.get(targetName);
      if (!sys) {
        errors.push({
          path: ud.sourcePath,
          errors: [`override target "${targetName}" not found in system/jobs/`],
        });
        continue;
      }
      const merged = mergeOverride(
        { frontmatter: sys.frontmatter, body: sys.body },
        { frontmatter: ud.frontmatter, body: ud.body }
      );
      jobs.set(targetName, {
        name: targetName,
        frontmatter: merged.frontmatter,
        body: merged.body,
        sourcePath: sys.sourcePath,
        overridePath: ud.sourcePath,
        isOverride: true,
      });
    } else {
      // Full def: replaces system if same name, else stand-alone user job.
      jobs.set(name, {
        name,
        frontmatter: ud.frontmatter,
        body: ud.body,
        sourcePath: ud.sourcePath,
        overridePath: systemDefs.has(name) ? ud.sourcePath : undefined,
        isOverride: systemDefs.has(name),
      });
    }
  }

  // Validate every effective def.
  for (const [name, def] of jobs) {
    const r = validateJobDef({ frontmatter: def.frontmatter, body: def.body });
    if (!r.valid) {
      errors.push({ path: def.sourcePath, name, errors: r.errors });
      continue;
    }
    if (def.frontmatter.schedule) {
      const cv = validateCron(def.frontmatter.schedule);
      if (!cv.valid) {
        errors.push({ path: def.sourcePath, name, errors: [`invalid cron: ${cv.error}`] });
      }
    }
  }

  return { jobs, errors };
}

export function loadJob(workspaceDir, name) {
  const { jobs, errors } = discoverJobs(workspaceDir);
  const def = jobs.get(name);
  if (!def) {
    return { def: null, errors: [{ name, errors: [`job "${name}" not found`] }] };
  }
  const jobErrors = errors.filter((e) => e.name === name);
  return { def, errors: jobErrors };
}
