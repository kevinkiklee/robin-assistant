import { renderHelp } from './commands/help.js';
import { version } from './commands/version.js';
import { commands } from './commands.js';

// Commands that manage install state themselves, are pure metadata, or are
// invoked by hooks/MCP/launchd in non-user contexts where first-run auto-setup
// would be surprising or recursive.
const SKIP_FIRST_RUN_INIT = new Set([
  'install',
  'uninstall',
  'doctor',
  'migrate',
  'import-v1',
  'hook',
  'mcp',
  '--help',
  '-h',
  '--version',
  '-v',
]);

async function ensureFirstRunInstall(cmd) {
  if (cmd === undefined || SKIP_FIRST_RUN_INIT.has(cmd)) return;
  if (process.env.ROBIN_HOME) return;
  if (process.env.ROBIN_SKIP_FIRST_RUN) return;
  const { pointerExists } = await import('../../config/data-store.js');
  if (pointerExists()) return;
  console.log('Robin: first run — running one-time setup...');
  console.log('');
  const { install } = await import('./commands/install.js');
  await install(['--auto']);
  console.log('');
  console.log('Robin: setup complete. Continuing...');
  console.log('');
}

export async function main(argv) {
  const head = argv[0];
  if (head === '--version' || head === '-v') return version();
  if (!head || head === '--help' || head === '-h') {
    console.log(renderHelp(commands));
    return;
  }
  await ensureFirstRunInstall(head);
  return dispatchFor(commands, argv);
}

export async function dispatchFor(node, argv) {
  const [head, ...rest] = argv;
  const entry = node[head];
  if (!entry) {
    console.error(`unknown command: ${head}`);
    console.error('run `robin --help` for usage');
    process.exit(1);
  }
  if (entry.subcommands) {
    if (!rest[0]) {
      console.error(`usage: <${Object.keys(entry.subcommands).join('|')}>`);
      process.exit(1);
    }
    return dispatchFor(entry.subcommands, rest);
  }
  // Test escape hatch
  if (typeof entry.fn === 'function') return entry.fn(rest);
  const mod = await import(entry.import);
  const fn = mod[entry.export];
  if (typeof fn !== 'function') {
    throw new Error(`registry: ${entry.import} has no export ${entry.export}`);
  }
  return fn(rest);
}
