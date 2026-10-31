#!/usr/bin/env node
// Refuse personal data in what git is about to record. The repo is public; the
// operator's data lives in gitignored user-data/, and every past leak was a value
// COPIED from memory into a test fixture or comment — so this scans content, not
// paths. Plain JS with no native deps so the git hooks can run it under any Node.
//
//   node system/scripts/private-scan.mjs --staged          # pre-commit: staged blobs
//   node system/scripts/private-scan.mjs --range A B       # pre-push: each commit in A..B
//   node system/scripts/private-scan.mjs --tracked [--deep]  # guard test; --deep adds copied-text audit
//
// What it looks for:
//   - terms from user-data/config/operator.yaml (name, aliases, home label, private_terms)
//   - names Robin's own memory holds for people, medications and financial accounts
//     (read-only via the sqlite3 CLI) — so a new person or prescription is covered
//     without anyone updating a list
//   - deployment hostnames from the operator's secrets file (hosts only, never values)
//   - shapes: US phone numbers, personal-mailbox addresses, card/account last-4s
//   - copied text: added lines sharing a 6-word run with the operator's personal notes,
//     corrections and beliefs (a fact can leak with no name in it)
//
// Exit 0 clean, 1 findings, 2 usage error. A line ending in `privacy-scan:allow`
// is skipped (for the scanner's own fixtures). Findings print file:line and the
// matched term (or 6-word run) only, never the surrounding text.

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SKIP_FILES = new Set(['pnpm-lock.yaml']);
const MAX_BYTES = 2 * 1024 * 1024;
const ALLOW_MARK = 'privacy-scan:allow';

// Card/account suffixes that are conventional placeholders, never real.
const PLACEHOLDER_LAST4 = new Set(['0000', '1111', '1234', '4242', '5678', '9999']);
// Words a person entity can be named that are too common to scan for alone.
const COMMON_NAMES = new Set(['home', 'mom', 'dad', 'user', 'operator', 'robin', 'claude']);

function userDataDir() {
  if (process.env.ROBIN_USER_DATA_DIR) return process.env.ROBIN_USER_DATA_DIR;
  const xdgConfig = process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config');
  const pointer = join(xdgConfig, 'robin', 'user-data-dir');
  if (existsSync(pointer)) {
    const dir = readFileSync(pointer, 'utf8').trim();
    if (dir) return dir;
  }
  const local = join(REPO, 'user-data');
  if (existsSync(local)) return local;
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'robin');
}

// A dependency-free reader for the few operator.yaml keys this needs (name, aliases,
// private_terms, home.label). Deliberately no `yaml` import: a missing package must
// never switch the check off (agent worktrees and scratch clones have no node_modules).
function unquote(v) {
  const t = v.trim();
  const q = /^(["'])(.*)\1$/.exec(t);
  if (q) return q[2];
  return t.replace(/\s+#.*$/, '').trim();
}

function flowList(v) {
  const m = /^\[(.*)\]\s*(?:#.*)?$/.exec(v.trim());
  return m ? m[1].split(',').map(unquote).filter(Boolean) : null;
}

function readOperatorYaml(text) {
  const lines = text.split('\n');
  const out = { name: null, aliases: [], private_terms: [], private_sources: [], label: null };
  for (let i = 0; i < lines.length; i++) {
    const top = /^([A-Za-z_]+):\s*(.*)$/.exec(lines[i]);
    if (!top) continue;
    const [, key, rest] = top;
    // Indented continuation lines belonging to this key.
    const block = [];
    for (let j = i + 1; j < lines.length && /^(\s+|$)/.test(lines[j]) && lines[j] !== ''; j++) {
      block.push(lines[j]);
    }
    if (key === 'name' && rest) out.name = unquote(rest);
    if (key === 'aliases' || key === 'private_terms' || key === 'private_sources') {
      const inline = rest ? flowList(rest) : null;
      out[key] =
        inline ??
        block
          .map((l) => /^\s+-\s+(.+)$/.exec(l)?.[1])
          .filter(Boolean)
          .map(unquote);
    }
    if (key === 'home') {
      const src = rest || block.join('\n');
      const m = /(?:^|[{,\s])label:\s*("[^"]*"|'[^']*'|[^,}\n]+)/.exec(src);
      if (m) out.label = unquote(m[1]);
    }
  }
  return out;
}

function operatorTerms(ud) {
  const file = join(ud, 'config', 'operator.yaml');
  if (!existsSync(file)) return [];
  const raw = readOperatorYaml(readFileSync(file, 'utf8'));
  const first = raw.name ? raw.name.split(/\s+/)[0] : null;
  return [first, ...raw.aliases, raw.label, ...raw.private_terms];
}

// Deployment hostnames from the operator's secrets file: a URL there is a real
// endpoint (a tunnel, a blob store). Only hosts are taken — never values — and only
// subdomain hosts (a bare apex like a public product domain is fine to mention),
// minus loopback and well-known provider APIs.
const PUBLIC_HOST_SUFFIXES = [
  'anthropic.com',
  'openai.com',
  'googleapis.com',
  'google.com',
  'github.com',
  'githubusercontent.com',
  'discord.com',
  'vercel.com',
  'cloudflare.com',
  'amazonaws.com',
  'example.com',
];

function envHosts(ud) {
  const file = join(ud, 'config', 'secrets', '.env');
  if (!existsSync(file)) return [];
  const hosts = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*[A-Za-z_][A-Za-z0-9_]*\s*=\s*["']?(https?:\/\/[^\s"']+)/.exec(line);
    if (!m) continue;
    let host;
    try {
      host = new URL(m[1]).hostname.toLowerCase();
    } catch {
      continue;
    }
    if (host === 'localhost' || /^[\d.]+$/.test(host) || host.includes(':')) continue;
    if (host.split('.').length < 3) continue;
    if (PUBLIC_HOST_SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`))) continue;
    hosts.push(host);
  }
  return hosts;
}

// Lowercase dictionary words ("grant", "baker") can't stand alone as a first-name
// term; proper names are capitalized in the system word list, so they stay in.
let dictionary = null;
function isCommonWord(w) {
  if (dictionary === null) {
    dictionary = new Set();
    for (const f of ['/usr/share/dict/words', '/usr/dict/words']) {
      if (!existsSync(f)) continue;
      for (const word of readFileSync(f, 'utf8').split('\n')) {
        if (word && word[0] === word[0].toLowerCase()) dictionary.add(word);
      }
      break;
    }
  }
  return dictionary.has(w.toLowerCase());
}

function memoryTerms(ud) {
  const db = join(ud, 'state', 'db', 'robin.sqlite');
  if (!existsSync(db)) return [];
  let out;
  try {
    out = execFileSync(
      'sqlite3',
      [
        '-readonly',
        '-separator',
        '\t',
        db,
        "SELECT type, canonical_name FROM entities WHERE type IN ('person','medication','financial_account')",
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 },
    );
  } catch {
    return []; // no sqlite3 binary, locked or migrating DB — the yaml terms still apply
  }
  const terms = [];
  for (const line of out.split('\n')) {
    const [type, name] = line.split('\t');
    if (!name) continue;
    const n = name.trim();
    if (type === 'person') {
      const parts = n.split(/\s+/);
      if (parts.length >= 2 && n.length >= 6) terms.push(n); // "First Last"
      const first = parts[0];
      if (first.length >= 3 && !COMMON_NAMES.has(first.toLowerCase()) && !isCommonWord(first)) {
        terms.push(first);
      }
    } else if (type === 'medication') {
      if (n.length >= 5) terms.push(n);
    } else if (type === 'financial_account') {
      if (n.length >= 8 && /\s/.test(n)) terms.push(n.replace(/\s*[⋯…*x•]+\s*\d{4}$/, '').trim());
    }
  }
  return terms;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// --- Copied memory text -------------------------------------------------------
// A fixture can leak a fact without naming anyone (a quoted preference, a habit).
// So added lines are also compared, as runs of SHINGLE
// words, against the operator's personal text: profile docs, corrections, beliefs,
// plus whatever operator.yaml lists under `private_sources` (paths under user-data;
// a trailing `*` globs). The list lives there because the file NAMES are personal.
const SHINGLE = 6;
// Apostrophes only inside a word ("don't"); a quote next to a word is code, not text.
const words = (t) => t.toLowerCase().match(/[a-z0-9]+(?:'[a-z0-9]+)*/g) ?? [];

function listSourceFiles(ud, entry) {
  const abs = join(ud, entry);
  const star = abs.indexOf('*');
  const out = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const f = join(dir, e.name);
      if (e.isDirectory()) walk(f);
      else if (f.endsWith('.md')) out.push(f);
    }
  };
  if (star === -1) {
    if (!existsSync(abs)) return out;
    if (statSync(abs).isDirectory()) walk(abs);
    else out.push(abs);
    return out;
  }
  const dir = dirname(abs);
  const [pre, post] = [basename(abs.slice(0, star)), abs.slice(star + 1)];
  if (!existsSync(dir)) return out;
  for (const n of readdirSync(dir))
    if (n.startsWith(pre) && n.endsWith(post)) out.push(join(dir, n));
  return out;
}

function sqliteText(db, sql) {
  try {
    return execFileSync('sqlite3', ['-readonly', db, sql], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 15000,
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch {
    return '';
  }
}

let shingleSet;
function personalShingles(ud) {
  if (shingleSet !== undefined) return shingleSet;
  const parts = [];
  const file = join(ud, 'config', 'operator.yaml');
  const sources = existsSync(file)
    ? readOperatorYaml(readFileSync(file, 'utf8')).private_sources
    : [];
  for (const entry of ['content/profile', ...sources]) {
    for (const f of listSourceFiles(ud, entry)) parts.push(readFileSync(f, 'utf8'));
  }
  const db = join(ud, 'state', 'db', 'robin.sqlite');
  if (existsSync(db)) {
    parts.push(sqliteText(db, "SELECT what || ' ' || correction FROM corrections"));
    // Beliefs about the operator's life, not about Robin's own machinery.
    parts.push(
      sqliteText(
        db,
        `SELECT c.body FROM events e JOIN events_content c ON c.id = e.content_ref
          WHERE e.kind = 'belief.update' AND c.body IS NOT NULL
            AND lower(c.body) NOT GLOB '*robin*' AND lower(c.body) NOT GLOB '*daemon*'
            AND lower(c.body) NOT GLOB '*mcp*' AND lower(c.body) NOT GLOB '*biographer*'
            AND lower(c.body) NOT GLOB '*sql*' AND c.body NOT GLOB '*.ts*'`,
      ),
    );
  }
  // Code, URLs, markup and paths quoted in notes are engineering, not personal.
  const text = parts
    .join('\n')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[\w./-]+\/[\w./-]+/g, ' ');
  const w = words(text);
  shingleSet = new Set();
  for (let i = 0; i + SHINGLE <= w.length; i++) shingleSet.add(w.slice(i, i + SHINGLE).join(' '));
  return shingleSet;
}

function scanCopied(path, text, findings, lineNumbers) {
  const set = personalShingles(userDataDir());
  if (set.size === 0) return;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trimEnd().endsWith(ALLOW_MARK)) continue;
    const w = words(lines[i]);
    for (let j = 0; j + SHINGLE <= w.length; j++) {
      const run = w.slice(j, j + SHINGLE).join(' ');
      if (set.has(run)) {
        findings.push(
          `${path}:${lineNumbers ? lineNumbers[i] : i + 1}: copied-memory-text: "${run}"`,
        );
        break;
      }
    }
  }
}

async function buildMatchers() {
  const ud = userDataDir();
  const terms = [...operatorTerms(ud), ...memoryTerms(ud), ...envHosts(ud)]
    .filter((t) => typeof t === 'string')
    .map((t) => t.trim())
    .filter((t) => t.length >= 3);
  const uniq = [...new Set(terms.map((t) => t.toLowerCase()))];
  const matchers = [];
  if (uniq.length) {
    // Longest first so "Jane Q. Doe" wins over "Jane".
    uniq.sort((a, b) => b.length - a.length);
    const re = new RegExp(
      `(?<![A-Za-z0-9])(?:${uniq.map(escapeRe).join('|')})(?![A-Za-z0-9])`,
      'i',
    );
    matchers.push({ kind: 'term', re });
  }
  // US phone numbers; 555 exchanges are fictional by convention and allowed.
  matchers.push({
    kind: 'phone',
    re: /(?<![\d-])\(?[2-9]\d{2}\)?[-. ]?(?!555)[2-9]\d{2}[-. ]\d{4}(?![\d-])/,
  });
  matchers.push({
    kind: 'personal-email',
    re: /[\w.+-]+@(?:gmail|googlemail|yahoo|icloud|me|mac|hotmail|outlook|live|aol|proton|protonmail)\.(?:com|me|net)\b/i,
  });
  matchers.push({
    kind: 'account-last4',
    re: /(?:ending in|ends in|[⋯…•]+|\*{3,}|x{4,})\s?(\d{4})(?!\d)/i,
    accept: (m) => !PLACEHOLDER_LAST4.has(m[1]),
  });
  return { matchers, termCount: uniq.length };
}

function scanText(path, text, matchers, findings, lineNumbers) {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trimEnd().endsWith(ALLOW_MARK)) continue;
    for (const m of matchers) {
      const hit = m.re.exec(line);
      if (hit && (!m.accept || m.accept(hit))) {
        findings.push(`${path}:${lineNumbers ? lineNumbers[i] : i + 1}: ${m.kind}: ${hit[0]}`);
      }
    }
  }
}

// Git runs hooks from the work-tree root, and tests point it at a scratch repo:
// operate on the current directory, not on this script's own checkout.
const CWD = process.cwd();
const git = (args) =>
  execFileSync('git', args, { encoding: 'utf8', cwd: CWD, maxBuffer: 256 * 1024 * 1024 });
const isBinary = (s) => s.includes('\0');

/** Added lines per file from a unified diff, with their line numbers in the new version. */
function addedLines(diff) {
  let file = null;
  let lineNo = 0;
  const added = new Map();
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      file = line.startsWith('+++ b/') ? line.slice(6) : null;
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      lineNo = Number(hunk[1]);
      continue;
    }
    if (file && !SKIP_FILES.has(file) && line.startsWith('+')) {
      if (!added.has(file)) added.set(file, { text: [], nums: [] });
      added.get(file).text.push(line.slice(1));
      added.get(file).nums.push(lineNo++);
    } else if (line.startsWith(' ')) lineNo++;
  }
  return added;
}

async function main() {
  const [mode, a, b] = process.argv.slice(2);
  const deep = process.argv.includes('--deep');
  if (!['--staged', '--tracked', '--range'].includes(mode) || (mode === '--range' && !(a && b))) {
    console.error('usage: private-scan.mjs --staged | --tracked [--deep] | --range <from> <to>');
    process.exit(2);
  }
  const { matchers } = await buildMatchers();
  const findings = [];

  if (mode === '--staged' || mode === '--tracked') {
    const listing =
      mode === '--staged'
        ? git(['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMR'])
        : git(['ls-files', '-z']);
    for (const f of listing.split('\0').filter(Boolean)) {
      if (SKIP_FILES.has(f)) continue;
      let text;
      try {
        if (mode === '--staged') text = git(['show', `:${f}`]);
        else {
          if (statSync(join(CWD, f)).size > MAX_BYTES) continue;
          text = readFileSync(join(CWD, f), 'utf8');
        }
      } catch {
        continue; // deleted in the working tree, or a submodule
      }
      if (text.length > MAX_BYTES || isBinary(text)) continue;
      scanText(f, text, matchers, findings);
      // Whole-tree copied-text matching is an audit (--deep); idioms make it noisy on
      // old text, so the hooks apply it to newly added lines only.
      if (mode === '--tracked' && deep) scanCopied(f, text, findings);
    }
    if (mode === '--staged') {
      // The identity this commit will carry — `git var` reflects -c and env overrides,
      // so a session passing `-c user.email=<personal mailbox>` is stopped here, not
      // only later at push time.
      const ident = ['GIT_AUTHOR_IDENT', 'GIT_COMMITTER_IDENT']
        .map((v) => {
          try {
            return git(['var', v]).replace(/\s+\d+\s+[+-]\d{4}\s*$/, '');
          } catch {
            return '';
          }
        })
        .join('\n');
      scanText('commit identity', ident, matchers, findings);
      const diff = git([
        'diff',
        '--cached',
        '--unified=0',
        '--no-color',
        '--no-ext-diff',
        '--diff-filter=ACMR',
      ]);
      for (const [f, { text, nums }] of addedLines(diff)) {
        const joined = text.join('\n');
        if (!isBinary(joined)) scanCopied(f, joined, findings, nums);
      }
    }
  } else {
    // Every commit in the range on its own — a value added in one commit and removed
    // in the next is still published — plus each commit's message and identities.
    const zero = /^0+$/.test(a);
    const commits = git(
      zero
        ? ['rev-list', '--reverse', b, '--not', '--remotes']
        : ['rev-list', '--reverse', `${a}..${b}`],
    )
      .split('\n')
      .filter(Boolean);
    for (const c of commits) {
      const short = c.slice(0, 7);
      const meta = git(['show', '-s', '--format=%an <%ae>%n%cn <%ce>%n%B', c]);
      scanText(`commit ${short} (message/author)`, meta, matchers, findings);
      const diff = git([
        'diff-tree',
        '-p',
        '-r',
        '--root',
        '--unified=0',
        '--no-color',
        '--no-ext-diff',
        c,
      ]);
      for (const [f, { text, nums }] of addedLines(diff)) {
        const joined = text.join('\n');
        if (!isBinary(joined)) {
          scanText(`${f} @${short}`, joined, matchers, findings, nums);
          scanCopied(`${f} @${short}`, joined, findings, nums);
        }
      }
    }
  }

  if (findings.length) {
    console.error(`private-scan: ${findings.length} personal-data finding(s):`);
    for (const f of findings) console.error(`  ${f}`);
    console.error(
      'Replace with fictional values (Sam Rivera, Acme, 555-0142). Personal values belong in\n' +
        'user-data/ and are read at runtime via system/lib/operator-profile.ts.',
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`private-scan: ${err?.message ?? err}`);
  process.exit(3);
});
