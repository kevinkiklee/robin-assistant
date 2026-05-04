// `robin trust [...]` — read-only inspection surface for the action-trust
// state machine.
//
// Subcommands:
//   robin trust                  default summary (counts)
//   robin trust status           full AUTO/ASK/NEVER + Open trust entries
//   robin trust pending          just the Action-trust section of needs-your-input.md
//   robin trust history [--days N]  ## Closed entries from action-trust.md
//   robin trust class <slug>     everything about one class
//
// Reads only:
//   user-data/runtime/config/policies.md
//   user-data/memory/self-improvement/action-trust.md
//   user-data/runtime/state/needs-your-input.md
//
// runTrust(argv, workspaceRoot?) returns { exitCode }. The workspace param
// is exposed for tests; production callers from bin/robin.js resolve via
// resolveCliWorkspaceDir().

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveCliWorkspaceDir } from '../lib/workspace-root.js';
import { readSections } from '../lib/needs-input.js';

const POLICIES_REL = 'user-data/runtime/config/policies.md';
const TRUST_REL = 'user-data/memory/self-improvement/action-trust.md';

function readSafe(absPath) {
  try {
    return readFileSync(absPath, 'utf8');
  } catch {
    return null;
  }
}

// Parse a `## NAME` section out of a markdown file. Returns the body text
// (everything between `## NAME` and the next `## ` heading or EOF). JS regex
// has no \Z; we manually slice on the next `## ` heading.
function extractH2Section(text, name) {
  if (!text) return null;
  const startRe = new RegExp(`^## ${escapeRe(name)}\\s*\\n`, 'm');
  const startMatch = text.match(startRe);
  if (!startMatch) return null;
  const startIdx = startMatch.index + startMatch[0].length;
  const rest = text.slice(startIdx);
  const nextHeading = rest.search(/^## /m);
  return nextHeading === -1 ? rest : rest.slice(0, nextHeading);
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Parse `## AUTO\n- foo\n- bar` into ['foo', 'bar'].
// Strips trailing comments (` # ...`) and empty lines.
function parseClassList(sectionBody) {
  if (!sectionBody) return [];
  return sectionBody
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('- '))
    .map((l) => l.slice(2).split('#')[0].trim())
    .filter(Boolean);
}

// Read policies.md into { auto, ask, never } slug arrays.
function readPolicies(workspaceRoot) {
  const text = readSafe(join(workspaceRoot, POLICIES_REL));
  if (!text) return { auto: [], ask: [], never: [] };
  return {
    auto: parseClassList(extractH2Section(text, 'AUTO')),
    ask: parseClassList(extractH2Section(text, 'ASK')),
    never: parseClassList(extractH2Section(text, 'NEVER')),
  };
}

// Parse action-trust.md `## Open` section into {slug, fields, raw}[].
// Each entry is a `### slug` heading followed by `- key: value` lines.
function parseEntries(sectionBody) {
  if (!sectionBody) return [];
  const entries = [];
  const lines = sectionBody.split('\n');
  let current = null;
  const rawLines = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const h = line.match(/^###\s+(.+?)\s*$/);
    if (h) {
      if (current) {
        current.raw = rawLines.join('\n').trim();
        entries.push(current);
        rawLines.length = 0;
      }
      current = { slug: h[1].trim(), fields: {} };
      rawLines.push(line);
      continue;
    }
    if (!current) continue;
    rawLines.push(line);
    const kv = line.match(/^-\s+([\w-]+):\s*(.*)$/);
    if (kv) current.fields[kv[1]] = kv[2].trim();
  }
  if (current) {
    current.raw = rawLines.join('\n').trim();
    entries.push(current);
  }
  return entries;
}

function readTrust(workspaceRoot) {
  const text = readSafe(join(workspaceRoot, TRUST_REL));
  if (!text) return { open: [], closed: [] };
  return {
    open: parseEntries(extractH2Section(text, 'Open')),
    closed: parseEntries(extractH2Section(text, 'Closed')),
  };
}

function countPendingPromotions(workspaceRoot) {
  const sections = readSections(workspaceRoot);
  const body = sections['Action-trust promotion proposals'];
  if (!body) return 0;
  // Count <!-- proposal-id:... --> markers; fall back to **slug** headings.
  const idMatches = body.match(/<!--\s*proposal-id:/g);
  if (idMatches) return idMatches.length;
  return (body.match(/\*\*[^*]+\*\*/g) || []).length;
}

// ---- subcommand handlers ----

function cmdSummary(workspaceRoot) {
  const policies = readPolicies(workspaceRoot);
  const trust = readTrust(workspaceRoot);
  const pending = countPendingPromotions(workspaceRoot);
  const lines = [
    'Action-trust summary',
    `  AUTO:  ${policies.auto.length}`,
    `  ASK:   ${policies.ask.length}`,
    `  NEVER: ${policies.never.length}`,
    `  Open trust entries: ${trust.open.length}`,
    `  Pending promotions: ${pending}`,
    '',
    'Subcommands: status | pending | history [--days N] | class <slug>',
  ];
  process.stdout.write(lines.join('\n') + '\n');
  return { exitCode: 0 };
}

function cmdStatus(workspaceRoot) {
  const policies = readPolicies(workspaceRoot);
  const trust = readTrust(workspaceRoot);
  const out = [];
  out.push('# Action-trust status');
  out.push('');
  out.push('## AUTO');
  for (const slug of policies.auto) out.push(`  - ${slug}`);
  if (policies.auto.length === 0) out.push('  (none)');
  out.push('');
  out.push('## ASK');
  for (const slug of policies.ask) out.push(`  - ${slug}`);
  if (policies.ask.length === 0) out.push('  (none)');
  out.push('');
  out.push('## NEVER');
  for (const slug of policies.never) out.push(`  - ${slug}`);
  if (policies.never.length === 0) out.push('  (none)');
  out.push('');
  out.push('## Open trust entries');
  if (trust.open.length === 0) out.push('  (none)');
  for (const e of trust.open) {
    const successes = e.fields.successes || '?';
    const corrections = e.fields.corrections || '?';
    const last = e.fields['last-action'] || e.fields.last_action || '?';
    out.push(`  - ${e.slug}: successes=${successes} corrections=${corrections} last=${last}`);
  }
  process.stdout.write(out.join('\n') + '\n');
  return { exitCode: 0 };
}

function cmdPending(workspaceRoot) {
  const sections = readSections(workspaceRoot);
  const body = sections['Action-trust promotion proposals'];
  if (!body) {
    process.stdout.write('No pending action-trust items.\n');
    return { exitCode: 0 };
  }
  process.stdout.write('## Action-trust promotion proposals\n\n');
  process.stdout.write(body.replace(/\s+$/, '') + '\n');
  return { exitCode: 0 };
}

function cmdHistory(workspaceRoot, argv) {
  const trust = readTrust(workspaceRoot);
  let days = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--days' && argv[i + 1]) {
      days = Number(argv[i + 1]);
      i++;
    } else if (argv[i].startsWith('--days=')) {
      days = Number(argv[i].slice('--days='.length));
    }
  }
  let entries = trust.closed;
  if (Number.isFinite(days)) {
    const cutoffMs = Date.now() - days * 24 * 3600 * 1000;
    entries = entries.filter((e) => {
      const d = e.fields.date;
      if (!d) return true; // include undated entries
      const t = Date.parse(`${d}T00:00:00Z`);
      return Number.isFinite(t) && t >= cutoffMs;
    });
  }
  if (entries.length === 0) {
    process.stdout.write('No history entries.\n');
    return { exitCode: 0 };
  }
  process.stdout.write('# Action-trust history (## Closed)\n\n');
  for (const e of entries) {
    process.stdout.write(`### ${e.slug}\n`);
    for (const [k, v] of Object.entries(e.fields)) {
      process.stdout.write(`- ${k}: ${v}\n`);
    }
    process.stdout.write('\n');
  }
  return { exitCode: 0 };
}

function cmdClass(workspaceRoot, argv) {
  const slug = argv[0];
  if (!slug) {
    process.stderr.write('Usage: robin trust class <slug>\n');
    return { exitCode: 2 };
  }
  const policies = readPolicies(workspaceRoot);
  const trust = readTrust(workspaceRoot);
  let state = '(unknown)';
  if (policies.auto.includes(slug)) state = 'AUTO';
  else if (policies.ask.includes(slug)) state = 'ASK';
  else if (policies.never.includes(slug)) state = 'NEVER';
  const open = trust.open.find((e) => e.slug === slug);
  const closed = trust.closed.filter((e) => e.slug === slug || e.slug.startsWith(`${slug} `));
  if (state === '(unknown)' && !open && closed.length === 0) {
    process.stdout.write(`Class "${slug}" not found in policies, trust ledger, or history.\n`);
    return { exitCode: 0 };
  }
  process.stdout.write(`# ${slug}\n\n`);
  process.stdout.write(`State: ${state}\n\n`);
  if (open) {
    process.stdout.write('## Open trust counters\n');
    for (const [k, v] of Object.entries(open.fields)) {
      process.stdout.write(`- ${k}: ${v}\n`);
    }
    process.stdout.write('\n');
  }
  if (closed.length > 0) {
    process.stdout.write('## History\n');
    for (const e of closed) {
      process.stdout.write(`### ${e.slug}\n`);
      for (const [k, v] of Object.entries(e.fields)) {
        process.stdout.write(`- ${k}: ${v}\n`);
      }
      process.stdout.write('\n');
    }
  }
  return { exitCode: 0 };
}

export async function runTrust(argv = [], workspaceRoot) {
  const ws = workspaceRoot || resolveCliWorkspaceDir();
  const sub = argv[0];
  if (!sub) return cmdSummary(ws);
  if (sub === 'status') return cmdStatus(ws);
  if (sub === 'pending') return cmdPending(ws);
  if (sub === 'history') return cmdHistory(ws, argv.slice(1));
  if (sub === 'class') return cmdClass(ws, argv.slice(1));
  process.stderr.write(`unknown trust subcommand: ${sub}\n`);
  process.stderr.write('Subcommands: status | pending | history [--days N] | class <slug>\n');
  return { exitCode: 2 };
}
