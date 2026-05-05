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
  list [--full]                 List installed external skills (--full: tabular form with commits)
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
  if (sub === 'list') return cmdList(rest);
  if (sub === 'show') return cmdShow(rest);
  if (sub === 'uninstall') return cmdUninstall(rest);
  if (sub === 'update') return cmdUpdate(rest);
  if (sub === 'doctor') return cmdDoctor(rest);
  if (sub === 'restore') return cmdRestore();
  process.stderr.write(`unknown skill subcommand: ${sub}\n${HELP}`);
  return 2;
}

function cmdList(argv) {
  const ws = resolveCliWorkspaceDir();
  if (argv.includes('--full')) {
    const manifest = loadInstalledManifest(ws);
    if (manifest.skills.length === 0) {
      process.stdout.write('No external skills installed.\n');
      return 0;
    }
    process.stdout.write('name\tcommit\tinstalledAt\tsource\n');
    for (const s of manifest.skills) {
      process.stdout.write(`${s.name}\t${s.commit || '(local)'}\t${s.installedAt}\t${s.source}\n`);
    }
    return 0;
  }
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

// fetchToStaging — clone/copy the source into a fresh staging dir under
// externalDir(ws). Returns { stageRoot, stagedFolder, commit } on success
// or throws Error on failure. Caller is responsible for moving `stagedFolder`
// to its final destination AND for cleaning up `stageRoot` in `finally`.
//
// `commit` is captured BEFORE the staged folder is copied/moved out — once
// the .git directory is gone (or the staged folder is moved into the parent
// repo's working tree), `git rev-parse HEAD` would walk up parent directories
// and resolve to the wrapping repo's HEAD, recording the wrong commit.
//
// `opts.commit` (optional) — if set on a git source, do a full clone (no
// `--depth 1`) and `git checkout <commit>` to pin. Without it, shallow clone.
function fetchToStaging(ws, resolved, opts = {}) {
  const stageRoot = join(externalDir(ws), '.staging-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8));
  mkdirSync(stageRoot, { recursive: true });

  const pinCommit = opts.commit || '';

  if (resolved.kind === 'local') {
    const dest = join(stageRoot, resolved.defaultName);
    cpSync(resolved.localPath, dest, { recursive: true });
    return { stageRoot, stagedFolder: dest, commit: '' };
  }

  if (resolved.kind === 'git-root') {
    const dest = join(stageRoot, resolved.defaultName);
    const cloneArgs = pinCommit
      ? ['clone', resolved.cloneUrl, dest]
      : ['clone', '--depth', '1', resolved.cloneUrl, dest];
    const r = spawnSync('git', cloneArgs, { stdio: 'inherit' });
    if (r.error) throw new Error(`could not run git: ${r.error.message}`);
    if (r.status !== 0) throw new Error('git clone exited non-zero');
    if (pinCommit) {
      const co = spawnSync('git', ['-C', dest, 'checkout', pinCommit], { stdio: 'inherit' });
      if (co.error) throw new Error(`could not run git: ${co.error.message}`);
      if (co.status !== 0) throw new Error(`git checkout ${pinCommit} exited non-zero`);
    }
    let commit = '';
    const ch = spawnSync('git', ['-C', dest, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
    if (ch.status === 0) commit = ch.stdout.trim();
    return { stageRoot, stagedFolder: dest, commit };
  }

  if (resolved.kind === 'git-subdir') {
    const repoDir = join(stageRoot, '_repo');
    const cloneArgs = pinCommit
      ? ['clone', '--branch', resolved.branch, resolved.cloneUrl, repoDir]
      : ['clone', '--depth', '1', '--branch', resolved.branch, resolved.cloneUrl, repoDir];
    const r = spawnSync('git', cloneArgs, { stdio: 'inherit' });
    if (r.error) throw new Error(`could not run git: ${r.error.message}`);
    if (r.status !== 0) throw new Error('git clone exited non-zero');
    if (pinCommit) {
      const co = spawnSync('git', ['-C', repoDir, 'checkout', pinCommit], { stdio: 'inherit' });
      if (co.error) throw new Error(`could not run git: ${co.error.message}`);
      if (co.status !== 0) throw new Error(`git checkout ${pinCommit} exited non-zero`);
    }
    let commit = '';
    const ch = spawnSync('git', ['-C', repoDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
    if (ch.status === 0) commit = ch.stdout.trim();
    const subPath = join(repoDir, resolved.subPath);
    if (!existsSync(subPath)) {
      throw new Error(`subdirectory ${resolved.subPath} not found in repo`);
    }
    const dest = join(stageRoot, resolved.defaultName);
    cpSync(subPath, dest, { recursive: true });
    rmSync(repoDir, { recursive: true, force: true });
    return { stageRoot, stagedFolder: dest, commit };
  }

  throw new Error(`unsupported install kind: ${resolved.kind}`);
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

  let stageRoot;
  try {
    let staged;
    try {
      staged = fetchToStaging(ws, resolved);
    } catch (err) {
      process.stderr.write(`install failed: ${err.message}\n`);
      return 1;
    }
    stageRoot = staged.stageRoot;
    const stagedFolder = staged.stagedFolder;
    const stagedCommit = staged.commit;

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

    // Manifest entry + INDEX regen.
    addManifestEntry(ws, {
      name: skillName,
      source: resolved.kind === 'local' ? `file://${resolved.localPath}` : target,
      commit: stagedCommit,
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

    // Detect scripts shipped (any files in scripts/ subdir).
    const scriptsDir = join(finalDest, 'scripts');
    let scriptsList = '';
    if (existsSync(scriptsDir)) {
      try {
        const entries = readdirSync(scriptsDir).filter((e) => !e.startsWith('.'));
        if (entries.length > 0) scriptsList = entries.join(', ');
      } catch { /* ignore */ }
    }

    process.stdout.write(`installed: ${skillName}\n`);
    process.stdout.write(`  description: ${validation.skill.description}\n`);
    process.stdout.write(`  source:      ${target}\n`);
    process.stdout.write(`  body:        user-data/skills/external/${skillName}/SKILL.md\n`);
    if (scriptsList) {
      process.stdout.write(`  scripts:     ${scriptsList}\n`);
    }
    process.stdout.write('  trust:       untrusted-mixed\n');
    if (scriptsList) {
      process.stdout.write('  hint:        scripts shipped — you may need to install their dependencies (npm/pip/etc.) inside the skill folder.\n');
    }
    return 0;
  } catch (err) {
    process.stderr.write(`install failed: ${err.message}\n`);
    return 1;
  } finally {
    if (stageRoot) rmSync(stageRoot, { recursive: true, force: true });
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

// resolveSourceForRefetch — turn a manifest entry's `source` into the input
// `resolveInstallTarget` expects. file:// URLs need their scheme stripped so
// the local-path branch matches.
function resolveSourceForRefetch(source) {
  return source.startsWith('file://') ? source.slice('file://'.length) : source;
}

// updateGitSubdir — re-fetch a git-subdir skill. Same pattern as install but
// the destination already exists, so we replace it atomically (rmSync then
// cpSync). Returns the new commit hash, or throws.
function refetchAndReplace(ws, entry, resolved, opts = {}) {
  const folder = join(externalDir(ws), entry.name);
  let stageRoot;
  try {
    const staged = fetchToStaging(ws, resolved, opts);
    stageRoot = staged.stageRoot;

    const validation = validateSkill(staged.stagedFolder);
    if (!validation.ok) {
      throw new Error(validation.reason);
    }
    if (validation.skill.name !== entry.name) {
      throw new Error(`upstream skill name "${validation.skill.name}" no longer matches installed name "${entry.name}"`);
    }

    // Replace the existing folder atomically-ish: rm + cpSync.
    if (existsSync(folder)) rmSync(folder, { recursive: true, force: true });
    mkdirSync(externalDir(ws), { recursive: true });
    cpSync(staged.stagedFolder, folder, { recursive: true });

    return staged.commit;
  } finally {
    if (stageRoot) rmSync(stageRoot, { recursive: true, force: true });
  }
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
    let resolved;
    try {
      resolved = resolveInstallTarget(resolveSourceForRefetch(entry.source));
    } catch (err) {
      process.stderr.write(`update failed for ${entry.name}: ${err.message}\n`);
      failures += 1;
      continue;
    }

    if (resolved.kind === 'local') {
      // Defensive — should be impossible since file:// already handled above.
      process.stdout.write(`skipping ${entry.name}: local-path source (no upstream to pull)\n`);
      continue;
    }

    if (resolved.kind === 'git-root') {
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
      process.stdout.write(`updated: ${entry.name}\n`);
      continue;
    }

    if (resolved.kind === 'git-subdir') {
      // git-subdir installs have no .git in the skill folder — re-fetch the
      // repo, copy the subdir over the existing folder.
      try {
        process.stdout.write(`updating ${entry.name} from ${entry.source}\n`);
        const newCommit = refetchAndReplace(ws, entry, resolved);
        addManifestEntry(ws, { ...entry, commit: newCommit });
        process.stdout.write(`updated: ${entry.name}\n`);
      } catch (err) {
        process.stderr.write(`update failed for ${entry.name}: ${err.message}\n`);
        failures += 1;
      }
      continue;
    }

    process.stderr.write(`update failed for ${entry.name}: unsupported source kind ${resolved.kind}\n`);
    failures += 1;
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
  let nonOrphanFindings = 0;
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
        nonOrphanFindings += 1;
        continue;
      }
      const inManifest = manifest.skills.some((s) => s.name === v.skill.name);
      if (!inManifest) {
        findings.push(`unmanaged folder: ${entry} (not in manifest — reinstall with source URL)`);
        nonOrphanFindings += 1;
      }
    }
  }

  // Print findings.
  for (const f of findings) process.stderr.write(`drift: ${f}\n`);

  if (fix && orphans.length > 0) {
    for (const name of orphans) removeManifestEntry(ws, name);
    process.stdout.write(`fixed: removed ${orphans.length} orphan manifest entries\n`);
    generateIndex(ws);
    if (nonOrphanFindings > 0) {
      process.stderr.write('note: some findings remain (invalid or unmanaged folders) — manual action required.\n');
      return 1;
    }
    return 0;
  }

  if (findings.length > 0) {
    process.stderr.write('run `robin skill doctor --fix` to auto-correct orphan entries.\n');
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
    const sourceForLog = entry.source;
    process.stdout.write(`restoring: ${entry.name} from ${sourceForLog}\n`);
    try {
      reinstallFromManifest(ws, entry);
    } catch (err) {
      process.stderr.write(`restore failed for ${entry.name}: ${err.message}\n`);
      failures += 1;
    }
  }
  generateIndex(ws);
  return failures === 0 ? 0 : 1;
}

// reinstallFromManifest — re-fetch a skill at its recorded commit (when the
// source is a git URL) and write it into externalDir. Preserves the original
// `installedAt` timestamp; updates `commit` only if the recorded one is empty
// (legacy entries) and a new value is captured. Throws on failure.
function reinstallFromManifest(ws, entry) {
  let resolved;
  try {
    resolved = resolveInstallTarget(resolveSourceForRefetch(entry.source));
  } catch (err) {
    throw new Error(`unrecognized source ${entry.source}: ${err.message}`);
  }

  // Pin to the recorded commit for git sources. Local sources have no commit.
  const opts = resolved.kind === 'local' ? {} : { commit: entry.commit || '' };

  // For local sources we just re-copy the folder.
  // For git-root and git-subdir we use the same refetch helper as update.
  // refetchAndReplace expects the destination to already exist (or not) — it
  // rmSyncs then cpSyncs. That's the same semantic we need here.
  const newCommit = refetchAndReplace(ws, entry, resolved, opts);

  // Preserve installedAt; preserve commit if pinned (newCommit will equal
  // entry.commit when pinned). For legacy entries with empty commit, record
  // whatever the fetch saw.
  const finalCommit = entry.commit && entry.commit.length > 0 ? entry.commit : newCommit;
  addManifestEntry(ws, {
    ...entry,
    commit: finalCommit,
    // installedAt preserved via spread above.
  });
}
