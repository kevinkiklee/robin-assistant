// preflight.js — 5-step session pre-flight pipeline.
// Previously embedded in startup-check.js; extracted so callers can import
// directly without pulling in the startup-check CLI shim.
//
// Returns { findings: [{ level: 'FATAL'|'WARN'|'INFO', message: string }] }

import { existsSync, readdirSync, statSync, copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { migrateConfig } from '../migrate/lib/config-migrate.js';
import { checkChangelog } from './changelog-notify.js';
import { runPendingMigrations } from '../migrate/apply.js';
import { validateInDir } from './validate.js';
import { resolveCliWorkspaceDir } from './workspace-root.js';

export async function runPreflight(workspaceDir) {
  // Resolve via the validating helper when no override is passed. Catches the
  // user-data/-as-cwd case loudly instead of producing a misleading "user-data/
  // missing" finding from join(<root>/user-data, 'user-data').
  if (!workspaceDir) workspaceDir = resolveCliWorkspaceDir();
  const findings = [];
  const ud = join(workspaceDir, 'user-data');

  if (!existsSync(ud)) {
    findings.push({ level: 'FATAL', message: 'user-data/ missing — run `npm install` to bootstrap' });
    return { findings };
  }

  // 1. Config migrate
  try {
    const cm = await migrateConfig(workspaceDir);
    if (cm.added.length) findings.push({ level: 'INFO', message: `config: added fields ${cm.added.join(', ')}` });
    if (cm.removed.length) findings.push({ level: 'WARN', message: `config: unrecognized fields ${cm.removed.join(', ')}` });
  } catch (err) {
    findings.push({ level: 'FATAL', message: `config migrate failed: ${err.message}` });
    return { findings };
  }

  // 2. Pending migrations
  try {
    const m = await runPendingMigrations(workspaceDir);
    if (m.applied.length) findings.push({ level: 'INFO', message: `migrations: applied ${m.applied.join(', ')}` });
  } catch (err) {
    findings.push({ level: 'FATAL', message: `migration failed: ${err.message}` });
    return { findings };
  }

  // 3. File presence (delegates to validate library)
  const v = await validateInDir(workspaceDir);
  if (v.issues > 0) findings.push({ level: 'WARN', message: `${v.issues} validation issue(s)` });

  // 4. New-scaffold detection
  const skel = join(workspaceDir, 'system/scaffold');
  if (existsSync(skel)) {
    const newFiles = [];
    function scan(rel = '') {
      for (const entry of readdirSync(join(skel, rel))) {
        if (entry === '.gitkeep') continue;
        const sp = join(rel, entry);
        const sFull = join(skel, sp);
        const uFull = join(ud, sp);
        if (statSync(sFull).isDirectory()) {
          if (!existsSync(uFull)) mkdirSync(uFull, { recursive: true });
          scan(sp);
        } else if (!existsSync(uFull)) {
          mkdirSync(join(uFull, '..'), { recursive: true });
          copyFileSync(sFull, uFull);
          newFiles.push(sp);
        }
      }
    }
    scan('');
    if (newFiles.length) findings.push({ level: 'INFO', message: `new files from upstream: ${newFiles.join(', ')}` });
  }

  // 5. CHANGELOG notice
  const cl = await checkChangelog(workspaceDir);
  if (cl.notice) findings.push({ level: 'INFO', message: `CHANGELOG: ${cl.notice.split('\n')[0]}` });

  return { findings };
}
