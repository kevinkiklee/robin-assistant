import { argvFor, COMMAND_REGISTRY, relatedFor } from './command-registry.js';
import { renderHelp } from './commands/help.js';
import { version } from './commands/version.js';
import { commands } from './commands.js';
import { appendRelated } from './help-formatter.js';

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
  // Don't run the first-run installer for unknown commands — printing a "first
  // run — running one-time setup..." line before a "unknown command" error is
  // a confusing UX, and the install can be slow.
  if (!Object.hasOwn(commands, cmd)) return;
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

// Map an argv path (e.g. ['jobs', 'list']) back to a registry name (e.g.
// 'jobs-list') by trying the registry's argvFor map in reverse.
function registryNameForPath(path) {
  for (const entry of COMMAND_REGISTRY) {
    const argv = argvFor(entry.name);
    if (!argv) continue;
    if (argv.length !== path.length) continue;
    let match = true;
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] !== path[i]) {
        match = false;
        break;
      }
    }
    if (match) return entry.name;
  }
  return null;
}

function printGroupHelp(node, path) {
  const choices = Object.keys(node);
  console.log(`usage: robin ${[...path, `<${choices.join('|')}>`].join(' ')}`);
  console.log('');
  console.log('subcommands:');
  for (const key of choices) {
    const entry = node[key];
    const help = entry.help ?? '';
    console.log(`  ${key.padEnd(20)} ${help}`);
  }
  const regName = registryNameForPath(path);
  if (regName) {
    const siblings = relatedFor(regName);
    if (siblings.length > 0) {
      console.log('');
      console.log(`Related: ${siblings.join(', ')}`);
    }
  }
}

function printLeafHelp(entry, path) {
  const regName = registryNameForPath(path);
  const summary = (() => {
    if (!regName) return null;
    const e = COMMAND_REGISTRY.find((x) => x.name === regName);
    return e?.summary ?? null;
  })();
  const helpLines = [`usage: robin ${path.join(' ')} [options]`, '', summary ?? entry.help ?? ''];
  if (summary && entry.help && entry.help !== summary) {
    helpLines.push(entry.help);
  }
  const text = helpLines.join('\n');
  console.log(regName ? appendRelated(text, regName) : text);
}

function wantsHelp(argv) {
  return argv.some((a) => a === '--help' || a === '-h');
}

export async function dispatchFor(node, argv, path = []) {
  const [head, ...rest] = argv;
  // Group-level --help: e.g. `robin jobs --help` → list subcommands.
  if (!path.length && (head === '--help' || head === '-h')) {
    // Already handled by main(); this is defensive.
    console.log(renderHelp(commands));
    return;
  }
  if (head === '--help' || head === '-h') {
    printGroupHelp(node, path);
    return;
  }
  const entry = node[head];
  if (!entry) {
    const where = path.length ? `\`robin ${path.join(' ')}\`` : 'robin';
    const choices = Object.keys(node).join('|');
    console.error(
      head
        ? `unknown ${path.length ? 'subcommand' : 'command'}: ${head}`
        : `${where} requires a subcommand`,
    );
    console.error(`usage: robin ${[...path, `<${choices}>`].join(' ')}`);
    console.error('run `robin --help` for usage');
    process.exit(1);
  }
  if (entry.subcommands) {
    if (!rest[0]) {
      const choices = Object.keys(entry.subcommands).join('|');
      console.error(`usage: robin ${[...path, head, `<${choices}>`].join(' ')}`);
      process.exit(1);
    }
    // Group --help: `robin jobs --help` lists subcommands.
    if (rest[0] === '--help' || rest[0] === '-h') {
      printGroupHelp(entry.subcommands, [...path, head]);
      return;
    }
    return dispatchFor(entry.subcommands, rest, [...path, head]);
  }
  // Leaf command --help: short-circuit before invoking the command.
  if (wantsHelp(rest)) {
    printLeafHelp(entry, [...path, head]);
    return;
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
