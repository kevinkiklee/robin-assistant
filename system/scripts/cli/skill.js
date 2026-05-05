// `robin skill *` — install and manage external Claude SKILL.md skills under
// user-data/skills/external/. See
// docs/superpowers/specs/2026-05-04-external-skill-compat-layer.md.

import { mkdirSync, cpSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { resolveCliWorkspaceDir } from '../lib/workspace-root.js';
import {
  externalDir,
  loadInstalledManifest,
  addManifestEntry,
  validateSkill,
  generateIndex,
  resolveInstallTarget,
  lightScan,
} from '../lib/external-skill-loader.js';

const HELP = `usage: robin skill <subcommand>

  install <git-url-or-path>     Install an external skill
  uninstall <name>              Remove an installed external skill
  list                          List installed external skills
  show <name>                   Print SKILL.md body and manifest entry
  update [<name>]               Pull latest from upstream (no re-scan)
  doctor [--fix]                Validate folders, regenerate INDEX.md
  restore                       Reinstall everything in installed-skills.json
`;

export async function dispatchSkill(argv) {
  const sub = argv[0];
  const rest = argv.slice(1);
  if (!sub || sub === '-h' || sub === '--help' || sub === 'help') {
    process.stdout.write(HELP);
    return 0;
  }
  if (sub === 'install') return cmdInstall(rest);
  if (sub === 'list') return cmdList();
  if (sub === 'show') return cmdShow(rest);
  process.stderr.write(`unknown skill subcommand: ${sub}\n${HELP}`);
  return 2;
}

function cmdList() {
  const ws = resolveCliWorkspaceDir();
  const indexPath = join(externalDir(ws), 'INDEX.md');
  if (!existsSync(indexPath)) {
    process.stdout.write('No external skills installed (INDEX.md not found).\n');
    return 0;
  }
  process.stdout.write(readFileSync(indexPath, 'utf8'));
  return 0;
}

function cmdShow(argv) {
  const name = argv[0];
  if (!name) {
    process.stderr.write('usage: robin skill show <name>\n');
    return 2;
  }
  const ws = resolveCliWorkspaceDir();
  const skillFile = join(externalDir(ws), name, 'SKILL.md');
  if (!existsSync(skillFile)) {
    process.stderr.write(`skill not found: ${name}\n`);
    return 1;
  }
  const manifest = loadInstalledManifest(ws);
  const entry = manifest.skills.find((s) => s.name === name);
  if (entry) {
    process.stdout.write(`-- manifest entry --\n${JSON.stringify(entry, null, 2)}\n\n`);
  }
  process.stdout.write(readFileSync(skillFile, 'utf8'));
  return 0;
}

function cmdInstall(argv) {
  const target = argv[0];
  if (!target) {
    process.stderr.write('usage: robin skill install <git-url-or-path>\n');
    return 2;
  }
  const ws = resolveCliWorkspaceDir();
  let resolved;
  try {
    resolved = resolveInstallTarget(target);
  } catch (err) {
    process.stderr.write(`install failed: ${err.message}\n`);
    return 1;
  }

  // Stage to a temp folder first so we can validate before committing.
  const stageRoot = join(externalDir(ws), '.staging-' + Date.now());
  mkdirSync(stageRoot, { recursive: true });

  let stagedFolder;
  try {
    if (resolved.kind === 'local') {
      const dest = join(stageRoot, resolved.defaultName);
      cpSync(resolved.localPath, dest, { recursive: true });
      stagedFolder = dest;
    } else if (resolved.kind === 'git-root') {
      const dest = join(stageRoot, resolved.defaultName);
      const r = spawnSync('git', ['clone', '--depth', '1', resolved.cloneUrl, dest], { stdio: 'inherit' });
      if (r.error) {
        process.stderr.write(`install failed: could not run git: ${r.error.message}\n`);
        return 1;
      }
      if (r.status !== 0) {
        process.stderr.write('install failed: git clone exited non-zero\n');
        return 1;
      }
      stagedFolder = dest;
    } else if (resolved.kind === 'git-subdir') {
      const repoDir = join(stageRoot, '_repo');
      const r = spawnSync('git', ['clone', '--depth', '1', '--branch', resolved.branch, resolved.cloneUrl, repoDir], { stdio: 'inherit' });
      if (r.error) {
        process.stderr.write(`install failed: could not run git: ${r.error.message}\n`);
        return 1;
      }
      if (r.status !== 0) {
        process.stderr.write('install failed: git clone exited non-zero\n');
        return 1;
      }
      const subPath = join(repoDir, resolved.subPath);
      if (!existsSync(subPath)) {
        process.stderr.write(`install failed: subdirectory ${resolved.subPath} not found in repo\n`);
        return 1;
      }
      const dest = join(stageRoot, resolved.defaultName);
      cpSync(subPath, dest, { recursive: true });
      rmSync(repoDir, { recursive: true, force: true });
      stagedFolder = dest;
    }

    // Validate.
    const validation = validateSkill(stagedFolder);
    if (!validation.ok) {
      process.stderr.write(`install failed: ${validation.reason}\n`);
      return 1;
    }
    const skillName = validation.skill.name;

    // Collision checks.
    const finalDest = join(externalDir(ws), skillName);
    if (existsSync(finalDest)) {
      process.stderr.write(`install failed: skill "${skillName}" is already installed\n`);
      return 1;
    }
    const jobFile = join(ws, 'system', 'jobs', `${skillName}.md`);
    if (existsSync(jobFile)) {
      process.stderr.write(`install failed: name collision with system protocol "${skillName}"\n`);
      return 1;
    }

    // Light scan (advisory).
    const scan = lightScan(stagedFolder);
    if (scan.warnings.length > 0) {
      process.stderr.write('warning: light scan flagged the following:\n');
      for (const w of scan.warnings) process.stderr.write(`  - ${w}\n`);
      process.stderr.write('  (advisory only; runtime hooks remain authoritative)\n');
    }

    // Commit: move from staging to final.
    mkdirSync(externalDir(ws), { recursive: true });
    cpSync(stagedFolder, finalDest, { recursive: true });

    // Resolve commit hash if git source.
    let commit = '';
    if (resolved.kind !== 'local') {
      const r = spawnSync('git', ['-C', finalDest, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
      if (r.status === 0) commit = r.stdout.trim();
    }

    // Manifest entry + INDEX regen.
    addManifestEntry(ws, {
      name: skillName,
      source: resolved.kind === 'local' ? `file://${resolved.localPath}` : target,
      commit,
      installedAt: new Date().toISOString(),
      trust: 'untrusted-mixed',
    });
    generateIndex(ws);

    process.stdout.write(`installed: ${skillName}\n`);
    process.stdout.write(`  source: ${target}\n`);
    process.stdout.write(`  body:   user-data/skills/external/${skillName}/SKILL.md\n`);
    process.stdout.write('  trust:  untrusted-mixed\n');
    process.stdout.write('  hint:   if SKILL.md mentions node/python/ruby scripts, you may need to install dependencies inside the skill folder.\n');
    return 0;
  } catch (err) {
    process.stderr.write(`install failed: ${err.message}\n`);
    return 1;
  } finally {
    rmSync(stageRoot, { recursive: true, force: true });
  }
}
