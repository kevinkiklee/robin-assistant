// `robin skill *` — install and manage external Claude SKILL.md skills under
// user-data/skills/external/. See
// docs/superpowers/specs/2026-05-04-external-skill-compat-layer.md.

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
  process.stderr.write(`unknown skill subcommand: ${sub}\n${HELP}`);
  return 2;
}
