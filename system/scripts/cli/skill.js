// `robin skill *` — install and manage external Claude SKILL.md skills under
// user-data/skills/external/. See
// docs/superpowers/specs/2026-05-04-external-skill-compat-layer.md.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveCliWorkspaceDir } from '../lib/workspace-root.js';
import { externalDir, loadInstalledManifest } from '../lib/external-skill-loader.js';

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
