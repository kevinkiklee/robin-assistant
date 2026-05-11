function render(node, indent = '  ') {
  const lines = [];
  for (const [key, entry] of Object.entries(node)) {
    if (entry.subcommands) {
      const helpLine = entry.help ? `   ${entry.help}` : '';
      lines.push(`${indent}${key} <subcommand>${helpLine}`);
      // If any sub has its own subcommands, recurse another level
      const nested = Object.values(entry.subcommands).some((e) => e.subcommands);
      if (nested) {
        lines.push(...render(entry.subcommands, `${indent}  `));
      } else {
        lines.push(`${indent}  ${Object.keys(entry.subcommands).join(', ')}`);
      }
    } else {
      const helpLine = entry.help ?? '';
      lines.push(`${indent}${key.padEnd(22)} ${helpLine}`);
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
    '  ROBIN_HOME              override the data directory (default: chosen at install)',
  ];
  return out.join('\n');
}

// Back-compat shim: some callers may import { help } from this module.
// Lazily resolve the registry to avoid a circular import.
export function help() {
  import('../commands.js').then(({ commands }) => {
    console.log(renderHelp(commands));
  });
}
