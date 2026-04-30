// `robin watch ...` CLI surface.
// Pure printf + ANSI; no chalk, no cli-table dep. Sub-100ms cold start.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  slugify,
  watchPath,
  watchStatePath,
  listWatches,
  readWatchState,
  writeWatchState,
  parseWatchFile,
  serializeWatchFile,
} from '../lib/watches.js';

const ANSI = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
};
const useColor = !process.env.NO_COLOR && process.stdout.isTTY;
const c = (code, s) => (useColor ? `${code}${s}${ANSI.reset}` : s);

function stripAnsi(s) {
  return String(s).replace(/\x1b\[[0-9;]*m/g, '');
}

function table(rows, headers) {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => stripAnsi(String(r[i] ?? '—')).length))
  );
  const sep = () => widths.map((w) => '-'.repeat(w)).join('  ');
  const line = (cells) =>
    cells
      .map((cell, i) => {
        const s = String(cell ?? '—');
        const len = stripAnsi(s).length;
        return s + ' '.repeat(Math.max(0, widths[i] - len));
      })
      .join('  ');
  const out = [c(ANSI.bold, line(headers)), sep()];
  for (const r of rows) out.push(line(r));
  return out.join('\n');
}

function workspaceDir() {
  return process.env.ROBIN_WORKSPACE || process.cwd();
}

// ---------------------------------------------------------------------------
// Collision-safe id generation
// ---------------------------------------------------------------------------

/**
 * Generate a watch id from a topic, handling collisions by appending -2, -3, etc.
 */
function uniqueId(ws, topic) {
  const base = slugify(topic);
  if (!existsSync(watchPath(ws, base))) return base;
  for (let n = 2; n <= 99; n++) {
    const candidate = `${base}-${n}`;
    if (!existsSync(watchPath(ws, candidate))) return candidate;
  }
  throw new Error(`Too many watches with slug "${base}"`);
}

// ---------------------------------------------------------------------------
// robin watch add
// ---------------------------------------------------------------------------

export function cmdWatchAdd(args) {
  const ws = workspaceDir();

  // Parse flags
  const flags = {};
  const positional = [];
  let i = 0;
  while (i < args.length) {
    const a = args[i];
    if (a === '--notify') { flags.notify = true; i++; }
    else if (a === '--cadence' && args[i + 1]) { flags.cadence = args[i + 1]; i += 2; }
    else if (a.startsWith('--cadence=')) { flags.cadence = a.split('=')[1]; i++; }
    else if (a === '--query' && args[i + 1]) { flags.query = args[i + 1]; i += 2; }
    else if (a.startsWith('--query=')) { flags.query = a.split('=').slice(1).join('='); i++; }
    else if (a === '--bootstrap') { flags.bootstrap = true; i++; }
    else { positional.push(a); i++; }
  }

  const topic = positional[0];
  if (!topic) {
    process.stderr.write(
      'usage: robin watch add "<topic>" [--cadence daily|weekly|hourly] [--query <q>] [--notify]\n'
    );
    process.exit(2);
  }

  const cadence = flags.cadence || 'daily';
  if (!['daily', 'weekly', 'hourly'].includes(cadence)) {
    process.stderr.write(`invalid cadence: ${cadence}. Must be one of: daily, weekly, hourly\n`);
    process.exit(2);
  }

  const id = uniqueId(ws, topic);
  const query = flags.query || topic;
  const notify = flags.notify === true;
  const today = new Date().toISOString().slice(0, 10);

  // Ensure watches dir
  const watchesDir = join(ws, 'user-data/memory/watches');
  if (!existsSync(watchesDir)) mkdirSync(watchesDir, { recursive: true });

  const frontmatter = {
    id,
    topic,
    query,
    sources: [],
    cadence,
    last_run_at: null,
    notify,
    enabled: true,
    created_at: today,
  };
  const body = `# Watch: ${topic}\n\n(Add notes here: why this matters, what to look for.)\n`;
  const content = serializeWatchFile(frontmatter, body);

  const path = watchPath(ws, id);
  writeFileSync(path, content);

  // Initialize state file
  writeWatchState(ws, id, {
    fingerprints: [],
    last_run_at: null,
    consecutive_failures: 0,
  });

  process.stdout.write(`Created watch: ${c(ANSI.cyan, id)}\n`);
  process.stdout.write(`  topic:   ${topic}\n`);
  process.stdout.write(`  cadence: ${cadence}\n`);
  process.stdout.write(`  query:   ${query}\n`);
  process.stdout.write(`  path:    ${path}\n`);
  process.stdout.write(`\n`);
  process.stdout.write(
    `  Run ${c(ANSI.dim, `robin watch run ${id} --bootstrap`)} to seed fingerprints (first run, no inbox write).\n`
  );
  process.stdout.write(
    `  Enable the watch-topics job with ${c(ANSI.dim, 'robin jobs enable watch-topics')} for automatic runs.\n`
  );
}

// ---------------------------------------------------------------------------
// robin watch list
// ---------------------------------------------------------------------------

export function cmdWatchList(args) {
  const ws = workspaceDir();
  const watches = listWatches(ws);

  if (watches.length === 0) {
    process.stdout.write('No watches found.\n');
    process.stdout.write(`Add one with: robin watch add "<topic>"\n`);
    return;
  }

  const rows = watches.map((w) => [
    w.id,
    w.topic.length > 40 ? w.topic.slice(0, 38) + '..' : w.topic,
    w.cadence,
    w.enabled ? c(ANSI.green, 'yes') : c(ANSI.red, 'no'),
    w.last_run_at ? w.last_run_at.slice(0, 16) : '—',
    w.notify ? 'yes' : 'no',
  ]);

  process.stdout.write(table(rows, ['ID', 'TOPIC', 'CADENCE', 'ENABLED', 'LAST RUN', 'NOTIFY']) + '\n');
}

// ---------------------------------------------------------------------------
// robin watch disable / enable
// ---------------------------------------------------------------------------

function setWatchEnabled(args, enabled) {
  const id = args[0];
  if (!id) {
    process.stderr.write(`usage: robin watch ${enabled ? 'enable' : 'disable'} <id>\n`);
    process.exit(2);
  }
  const ws = workspaceDir();
  const path = watchPath(ws, id);
  if (!existsSync(path)) {
    process.stderr.write(`watch not found: ${id}\n`);
    process.exit(1);
  }

  const content = readFileSync(path, 'utf8');
  const { frontmatter, body } = parseWatchFile(content);
  frontmatter.enabled = enabled;
  const newContent = serializeWatchFile(frontmatter, body);
  writeFileSync(path, newContent);

  process.stdout.write(`${enabled ? 'Enabled' : 'Disabled'} watch: ${id}\n`);
}

export function cmdWatchDisable(args) {
  return setWatchEnabled(args, false);
}

export function cmdWatchEnable(args) {
  return setWatchEnabled(args, true);
}

// ---------------------------------------------------------------------------
// robin watch tail
// ---------------------------------------------------------------------------

export function cmdWatchTail(args) {
  const ws = workspaceDir();

  // Parse flags
  let watchId = null;
  let n = 10;
  for (const a of args) {
    if (a.startsWith('--n=')) n = parseInt(a.slice(4), 10);
    else if (!a.startsWith('-')) watchId = a;
  }

  const inboxPath = join(ws, 'user-data/memory/inbox.md');
  if (!existsSync(inboxPath)) {
    process.stdout.write('(inbox.md not found)\n');
    return;
  }

  const content = readFileSync(inboxPath, 'utf8');
  const lines = content.split('\n');

  // Filter for [watch:id] or [watch] tags
  const watchLines = lines.filter((l) => {
    if (watchId) {
      return l.includes(`[watch:${watchId}]`);
    }
    return l.match(/\[watch(:[^\]]+)?\]/);
  });

  const tail = watchLines.slice(-n);
  if (tail.length === 0) {
    process.stdout.write(watchId ? `No inbox items for watch: ${watchId}\n` : 'No [watch] items in inbox.\n');
    return;
  }
  process.stdout.write(tail.join('\n') + '\n');
}

// ---------------------------------------------------------------------------
// robin watch run
// ---------------------------------------------------------------------------

export function cmdWatchRun(args) {
  const ws = workspaceDir();

  const flags = {};
  const positional = [];
  for (const a of args) {
    if (a === '--dry-run') flags.dryRun = true;
    else if (a === '--bootstrap') flags.bootstrap = true;
    else positional.push(a);
  }

  const id = positional[0];
  if (!id) {
    process.stderr.write('usage: robin watch run <id> [--dry-run] [--bootstrap]\n');
    process.exit(2);
  }

  const path = watchPath(ws, id);
  if (!existsSync(path)) {
    process.stderr.write(`watch not found: ${id}\n`);
    process.exit(1);
  }

  const content = readFileSync(path, 'utf8');
  const { frontmatter } = parseWatchFile(content);

  if (flags.dryRun) {
    process.stdout.write(`[dry-run] watch: ${id}\n`);
    process.stdout.write(`  topic:   ${frontmatter.topic}\n`);
    process.stdout.write(`  query:   ${frontmatter.query}\n`);
    process.stdout.write(`  cadence: ${frontmatter.cadence}\n`);
    process.stdout.write(`  enabled: ${frontmatter.enabled}\n`);
    const state = readWatchState(ws, id);
    process.stdout.write(`  fingerprints: ${state.fingerprints.length} stored\n`);
    process.stdout.write(`  last_run_at:  ${state.last_run_at ?? '(never)'}\n`);
    process.stdout.write(`[dry-run] Would fetch via WebSearch query: "${frontmatter.query}"\n`);
    process.stdout.write(`[dry-run] Would write new hits to inbox.md with [watch:${id}] tag.\n`);
    return;
  }

  if (flags.bootstrap) {
    // Bootstrap run: seeds fingerprints without writing to inbox.
    // Real fetch requires agent-runtime / WebSearch host capability.
    process.stdout.write(`[bootstrap] watch: ${id}\n`);
    process.stdout.write(
      `  Bootstrap run — this must be run via the watch-topics agent-runtime job\n` +
      `  (requires WebSearch host capability). Running from CLI seeds state only.\n`
    );
    const state = readWatchState(ws, id);
    const now = new Date().toISOString();
    writeWatchState(ws, id, {
      ...state,
      last_run_at: state.last_run_at ?? now, // Don't overwrite if already set
      consecutive_failures: 0,
    });
    process.stdout.write(`  State initialized. fingerprints: ${state.fingerprints.length}\n`);
    return;
  }

  // Real run — requires agent-runtime with WebSearch
  process.stdout.write(
    `watch run: ${id}\n\n` +
    `  The actual fetch+summarize requires agent-runtime (WebSearch host capability).\n` +
    `  From the CLI, use:\n` +
    `    --dry-run    to preview what would happen\n` +
    `    --bootstrap  to initialize state (seeds fingerprints, no inbox write)\n\n` +
    `  To run the real fetch, invoke the watch-topics job from your agent:\n` +
    `    robin run watch-topics\n` +
    `  or enable it for hourly automatic execution:\n` +
    `    robin jobs enable watch-topics\n`
  );
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

export function dispatchWatch(args) {
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case 'add':
      return cmdWatchAdd(rest);
    case 'list':
    case 'ls':
      return cmdWatchList(rest);
    case 'disable':
      return cmdWatchDisable(rest);
    case 'enable':
      return cmdWatchEnable(rest);
    case 'tail':
      return cmdWatchTail(rest);
    case 'run':
      return cmdWatchRun(rest);
    case undefined:
    case '-h':
    case '--help':
    case 'help':
      process.stdout.write(WATCH_HELP);
      return;
    default:
      process.stderr.write(`unknown subcommand: watch ${sub}\n${WATCH_HELP}`);
      process.exit(2);
  }
}

export const WATCH_HELP = `robin watch — manage topics Robin actively follows

usage:
  robin watch add "<topic>" [--cadence daily|weekly|hourly] [--query <q>] [--notify]
  robin watch list
  robin watch enable <id>
  robin watch disable <id>
  robin watch tail [<id>] [--n=10]
  robin watch run <id> [--dry-run] [--bootstrap]

subcommands:
  add        Create a new watch. Slugifies topic to an id (collision-safe).
  list       Print a table of all watches.
  enable     Set enabled: true in the watch frontmatter.
  disable    Set enabled: false in the watch frontmatter.
  tail       Print recent [watch] items from inbox.md.
  run        Run a single watch. Requires --dry-run or --bootstrap from CLI;
             real fetch requires agent-runtime (watch-topics job).
`;
