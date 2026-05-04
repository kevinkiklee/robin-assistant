// preflight.js — 6-step session pre-flight pipeline.
// Previously embedded in startup-check.js; extracted so callers can import
// directly without pulling in the startup-check CLI shim.
//
// Returns { findings: [{ level: 'FATAL'|'WARN'|'INFO', message: string }] }

import {
  existsSync,
  readdirSync,
  statSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { migrateConfig } from '../migrate/lib/config-migrate.js';
import { checkChangelog } from './changelog-notify.js';
import { runPendingMigrations } from '../migrate/apply.js';
import { validateInDir } from './validate.js';
import { resolveCliWorkspaceDir } from './workspace-root.js';

function hashHooksBlock(settingsText) {
  try {
    const obj = JSON.parse(settingsText);
    const hooks = obj.hooks ?? {};
    const canonical = JSON.stringify(hooks, Object.keys(hooks).sort());
    return createHash('sha256').update(canonical).digest('hex');
  } catch {
    return null;
  }
}

/**
 * Detect whether a hook hash mismatch is upstream-driven (clean checkout of
 * a newer .claude/settings.json) versus a local user customization.
 *
 * Returns:
 *   { isUpstreamDriven: true,  reason: 'matches-head' }       → safe to auto-snapshot
 *   { isUpstreamDriven: false, reason: 'in-sync' }            → no drift
 *   { isUpstreamDriven: false, reason: 'local-customization' }→ working tree differs from HEAD
 *   { isUpstreamDriven: false, reason: 'no-git-head' }        → not a git repo / no HEAD
 *   { isUpstreamDriven: false, reason: 'missing-files' }      → settings or manifest missing
 */
export function detectUpstreamHookChange(workspaceDir) {
  const settingsPath = join(workspaceDir, '.claude/settings.json');
  const manifestPath = join(workspaceDir, 'user-data/runtime/security/manifest.json');

  if (!existsSync(settingsPath) || !existsSync(manifestPath)) {
    return { isUpstreamDriven: false, reason: 'missing-files' };
  }

  const currentHooksHash = hashHooksBlock(readFileSync(settingsPath, 'utf8'));
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    return { isUpstreamDriven: false, reason: 'missing-files' };
  }
  const recordedHash = manifest.hooksHash ?? null;

  if (currentHooksHash === recordedHash) {
    return { isUpstreamDriven: false, reason: 'in-sync' };
  }

  let headSettingsText;
  try {
    headSettingsText = execFileSync('git', ['show', 'HEAD:.claude/settings.json'], {
      cwd: workspaceDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    return { isUpstreamDriven: false, reason: 'no-git-head' };
  }

  const headHooksHash = hashHooksBlock(headSettingsText);
  if (currentHooksHash === headHooksHash) {
    return { isUpstreamDriven: true, reason: 'matches-head' };
  }
  return { isUpstreamDriven: false, reason: 'local-customization' };
}

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

  // 6. Auto-snapshot manifest on upstream-driven hook changes.
  // If `.claude/settings.json` hooks differ from the manifest's recorded hash
  // BUT match what's at git HEAD, this is a clean upstream upgrade — re-snapshot
  // the manifest so tamper-detection doesn't fire on next session start.
  // Local customizations (working tree differs from HEAD) still surface drift.
  try {
    const upstream = detectUpstreamHookChange(workspaceDir);
    if (upstream.isUpstreamDriven) {
      const snapshotScript = join(
        workspaceDir,
        'system/scripts/diagnostics/manifest-snapshot.js',
      );
      if (existsSync(snapshotScript)) {
        const r = spawnSync(
          process.execPath,
          [snapshotScript, '--apply', '--confirm-trust-current-state'],
          { cwd: workspaceDir, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' },
        );
        if (r.status === 0) {
          findings.push({
            level: 'INFO',
            message: 'manifest: auto-snapshotted (upstream-driven hook change)',
          });
        } else {
          findings.push({
            level: 'WARN',
            message: `manifest auto-snapshot failed: ${(r.stderr || '').trim().split('\n')[0] || `exit ${r.status}`}`,
          });
        }
      }
    }
  } catch (err) {
    findings.push({ level: 'WARN', message: `manifest auto-snapshot error: ${err.message}` });
  }

  return { findings };
}
