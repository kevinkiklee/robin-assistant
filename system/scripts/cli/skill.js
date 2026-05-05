// `robin skill *` — install and manage external Claude SKILL.md skills under
// user-data/skills/external/. See
// docs/superpowers/specs/2026-05-04-external-skill-compat-layer.md.

import { mkdirSync, cpSync, existsSync, readFileSync, rmSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { resolveCliWorkspaceDir } from '../lib/workspace-root.js';
import {
  externalDir,
  loadInstalledManifest,
  addManifestEntry,
  removeManifestEntry,
  validateSkill,
  generateIndex,
  resolveInstallTarget,
  lightScan,
} from '../lib/external-skill-loader.js';
import { loadManifest, writeManifest } from '../lib/manifest.js';

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
  if (sub === 'uninstall') return cmdUninstall(rest);
  if (sub === 'update') return cmdUpdate(rest);
  if (sub === 'doctor') return cmdDoctor(rest);
  if (sub === 'restore') return cmdRestore();
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
  // Capture the upstream commit hash from the staging checkout BEFORE we
  // copy/rename the folder — once the .git directory is gone (or the staged
  // folder is moved into the parent repo's working tree), `git rev-parse
  // HEAD` would walk up and resolve to the parent repo's HEAD, recording the
  // wrong commit.
  let stagedCommit = '';
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
      const ch = spawnSync('git', ['-C', dest, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
      if (ch.status === 0) stagedCommit = ch.stdout.trim();
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
      const ch = spawnSync('git', ['-C', repoDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
      if (ch.status === 0) stagedCommit = ch.stdout.trim();
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

    // Commit hash (if git source) was captured from the staging checkout
    // above — `git rev-parse HEAD` against finalDest would resolve to the
    // parent repo's HEAD when no .git is present.
    const commit = resolved.kind === 'local' ? '' : stagedCommit;

    // Manifest entry + INDEX regen.
    addManifestEntry(ws, {
      name: skillName,
      source: resolved.kind === 'local' ? `file://${resolved.localPath}` : target,
      commit,
      installedAt: new Date().toISOString(),
      trust: 'untrusted-mixed',
    });
    const sec = loadManifest(ws);
    if (sec) {
      if (!sec.externalSkills.knownNames.includes(skillName)) {
        sec.externalSkills.knownNames.push(skillName);
        sec.externalSkills.knownNames.sort();
        writeManifest(ws, sec);
      }
    }
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

function cmdUninstall(argv) {
  const name = argv[0];
  if (!name) {
    process.stderr.write('usage: robin skill uninstall <name>\n');
    return 2;
  }
  const ws = resolveCliWorkspaceDir();
  const folder = join(externalDir(ws), name);
  const manifest = loadInstalledManifest(ws);
  const inManifest = manifest.skills.find((s) => s.name === name);
  if (!existsSync(folder) && !inManifest) {
    process.stderr.write(`skill not found: ${name}\n`);
    return 1;
  }
  if (existsSync(folder)) rmSync(folder, { recursive: true, force: true });
  removeManifestEntry(ws, name);
  const sec = loadManifest(ws);
  if (sec) {
    sec.externalSkills.knownNames = sec.externalSkills.knownNames.filter((n) => n !== name);
    writeManifest(ws, sec);
  }
  generateIndex(ws);
  process.stdout.write(`uninstalled: ${name}\n`);
  return 0;
}

function cmdUpdate(argv) {
  const ws = resolveCliWorkspaceDir();
  const manifest = loadInstalledManifest(ws);
  const targetName = argv[0];
  const targets = targetName
    ? manifest.skills.filter((s) => s.name === targetName)
    : manifest.skills;
  if (targetName && targets.length === 0) {
    process.stderr.write(`not installed: ${targetName}\n`);
    return 1;
  }
  let failures = 0;
  for (const entry of targets) {
    if (entry.source.startsWith('file://')) {
      process.stdout.write(`skipping ${entry.name}: local-path source (no upstream to pull)\n`);
      continue;
    }
    const folder = join(externalDir(ws), entry.name);
    if (!existsSync(join(folder, '.git'))) {
      process.stdout.write(`skipping ${entry.name}: not a git checkout\n`);
      continue;
    }
    const r = spawnSync('git', ['-C', folder, 'pull', '--ff-only'], { stdio: 'inherit' });
    if (r.error) {
      process.stderr.write(`update failed for ${entry.name}: could not run git: ${r.error.message}\n`);
      failures += 1;
      continue;
    }
    if (r.status !== 0) {
      process.stderr.write(`update failed for ${entry.name}: git pull exited non-zero\n`);
      failures += 1;
      continue;
    }
    const ch = spawnSync('git', ['-C', folder, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
    if (ch.status === 0) {
      addManifestEntry(ws, { ...entry, commit: ch.stdout.trim() });
    }
  }
  generateIndex(ws);
  return failures === 0 ? 0 : 1;
}

function cmdDoctor(argv) {
  const fix = argv.includes('--fix');
  const ws = resolveCliWorkspaceDir();
  const findings = [];

  // Always regenerate INDEX.md (idempotent, harmless).
  generateIndex(ws);

  // Check 1: each manifest entry has a real folder.
  const manifest = loadInstalledManifest(ws);
  const orphans = [];
  for (const entry of manifest.skills) {
    const folder = join(externalDir(ws), entry.name);
    if (!existsSync(folder)) {
      findings.push(`orphan manifest entry: ${entry.name} (folder missing)`);
      orphans.push(entry.name);
    }
  }

  // Check 2: each external folder validates and is in the manifest.
  const dir = externalDir(ws);
  if (existsSync(dir)) {
    for (const entry of readdirSync(dir)) {
      if (entry === 'INDEX.md' || entry.startsWith('.')) continue;
      const folderPath = join(dir, entry);
      let st;
      try { st = statSync(folderPath); } catch { continue; }
      if (!st.isDirectory()) continue;
      const v = validateSkill(folderPath);
      if (!v.ok) {
        findings.push(`invalid folder ${entry}: ${v.reason}`);
        continue;
      }
      const inManifest = manifest.skills.some((s) => s.name === v.skill.name);
      if (!inManifest) {
        findings.push(`unmanaged folder: ${entry} (not in manifest — reinstall with source URL)`);
      }
    }
  }

  // Print findings.
  for (const f of findings) process.stderr.write(`drift: ${f}\n`);

  if (fix && orphans.length > 0) {
    for (const name of orphans) removeManifestEntry(ws, name);
    process.stdout.write(`fixed: removed ${orphans.length} orphan manifest entries\n`);
    generateIndex(ws);
    return 0;
  }

  if (findings.length > 0) {
    process.stderr.write('run `robin skill doctor --fix` to auto-correct.\n');
    return 1;
  }
  process.stdout.write('skill: ok\n');
  return 0;
}

function cmdRestore() {
  const ws = resolveCliWorkspaceDir();
  const manifest = loadInstalledManifest(ws);
  if (manifest.skills.length === 0) {
    process.stdout.write('nothing to restore — manifest is empty.\n');
    return 0;
  }
  let failures = 0;
  for (const entry of manifest.skills) {
    const folder = join(externalDir(ws), entry.name);
    if (existsSync(folder)) {
      process.stdout.write(`already present: ${entry.name}\n`);
      continue;
    }
    const source = entry.source.startsWith('file://') ? entry.source.slice('file://'.length) : entry.source;
    process.stdout.write(`restoring: ${entry.name} from ${source}\n`);
    // Remove the existing manifest entry first so install doesn't reject as duplicate.
    removeManifestEntry(ws, entry.name);
    const exit = cmdInstall([source]);
    if (exit !== 0) {
      // Reinstate the entry on failure for accurate accounting.
      addManifestEntry(ws, entry);
      failures += 1;
    }
  }
  return failures === 0 ? 0 : 1;
}
