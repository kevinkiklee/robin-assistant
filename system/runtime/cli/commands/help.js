const NAME_WIDTH = 22;

function render(node, indent = '  ') {
  const lines = [];
  for (const [key, entry] of Object.entries(node)) {
    if (entry.subcommands) {
      const helpLine = entry.help ? `   ${entry.help}` : '';
      lines.push(`${indent}${key} <subcommand>${helpLine}`);
      // Always recurse — even leaf-only subcommand groups have per-leaf
      // `help` text we want to surface. (Previously these collapsed to a
      // comma-separated key list, hiding the help.)
      lines.push(...render(entry.subcommands, `${indent}  `));
    } else {
      const helpLine = entry.help ?? '';
      lines.push(`${indent}${key.padEnd(NAME_WIDTH)} ${helpLine}`);
    }
  }
  return lines;
}

export function renderHelp(commands) {
  const out = [
    'robin v6 — SurrealDB-first personal AI memory',
    '',
    'USAGE',
    '  robin <command> [args]',
    '  robin --version | -v',
    '  robin --help    | -h',
    '',
    'COMMANDS',
    ...render(commands),
    '',
    'ENVIRONMENT',
    '  ROBIN_HOME                          override the data directory (default: chosen at install)',
    '  ROBIN_DEBUG                         print full stack traces on CLI errors and hook failures',
    '  ROBIN_SKIP_FIRST_RUN                disable the auto-install on first non-install command',
    '  ROBIN_DAEMON_REQUEST_TIMEOUT_MS     CLI→daemon HTTP timeout (default 60000)',
    '  ROBIN_INTEGRATION_TIMEOUT_MS        per-sync hard cap; aborts the sync signal (default off)',
    '',
    '  Install-time toggles (ROBIN_SKIP_MCP, ROBIN_SKIP_HOOKS, etc.) are documented',
    '  in docs/install.md.',
  ];
  return out.join('\n');
}
