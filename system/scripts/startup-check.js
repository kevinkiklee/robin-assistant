import { existsSync, readdirSync, statSync, copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { migrateConfig } from './lib/config-migrate.js';
import { checkChangelog } from './lib/changelog-notify.js';
import { runPendingMigrations } from './migrate.js';
import { validateInDir } from './lib/validate.js';

export async function runStartupCheck(workspaceDir = process.cwd()) {
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

  // 4. New-skeleton detection
  const skel = join(workspaceDir, 'system/skeleton');
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

function report(findings) {
  for (const f of findings) console.log(`${f.level}: ${f.message}`);
  if (findings.some(f => f.level === 'FATAL')) process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = await runStartupCheck();
  report(r.findings);
}
