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
