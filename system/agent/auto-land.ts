// Auto-land for K's remediation branches (2026-10-31: requested so the
// reliability audit's fixes land without a manual step). K used to stop at a review branch, so every
// fix the nightly audit asked for waited on the operator — branches piled up and
// the same incidents recurred. Now a K branch lands on its own when it clears a
// deterministic gate, and anything that doesn't stays a review branch exactly as
// before:
//
//   1. scope   — only `system/` code, never K's own leash or a security boundary
//   2. size    — small diffs only (a big rewrite is a design change, not a fix)
//   3. proof   — the diff must carry a test (a fix without a regression test
//                can't show it fixed anything)
//   4. overlap — never touch a file the operator has uncommitted work in
//   5. reach   — no new network, subprocess, secrets, dynamic-code or (in
//                non-test code) env/URL access, and no new imports in non-test
//                code (K reads logs that can carry outside text; a fix never
//                needs a new egress path, an injected one would)
//   6. loosen  — no raised threshold, downgraded severity, early pass, dropped
//                invariant, or removed/skipped assertion (silencing a check
//                isn't fixing it)
//   7. verify  — typecheck, lint, and the full test suite pass in the worktree,
//                inside a seatbelt sandbox with a scrubbed environment (the
//                checks execute K's code), and leave the worktree unchanged
//
// A branch that already has commits ahead of main is held too (K can't commit,
// so they aren't its fix). Then it commits on the branch, merges into main,
// rebuilds, and restarts the daemon. A failed build reverts the merge, and a
// probation check after the restart (land-probation.ts) reverts it if the
// daemon doesn't stay up.

import { type ExecFileSyncOptions, execFileSync, spawn } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, normalize } from 'node:path';
import { pruneWorktree } from './worktree.ts';

export const AUTO_LAND_LIMITS = { maxFiles: 8, maxChangedLines: 400 } as const;

/**
 * Paths a remediation may never land unreviewed: K's own sandbox, deny callback
 * and runner (including this file) and the job that dispatches it; policy config
 * (spend caps, this feature's own switch); every surface (CLI, MCP tool lists,
 * remote auth); the publish/outbound discretion gates; the audit that grades K
 * and hands it work; and applied migrations. On top of this list, every module
 * the agent runtime imports is protected too (agentRuntimeClosure) — a hand-kept
 * list alone missed lib/paths.ts and kernel/config/schema.ts (security review,
 * 2026-10-31).
 */
const PROTECTED: readonly RegExp[] = [
  /^system\/agent\//,
  /^system\/jobs\/builtin\/agent-runner\//,
  /^system\/kernel\/config\//,
  /^system\/surfaces\//,
  /^system\/lib\/publish\//,
  /^system\/lib\/discretion\//,
  /^system\/lib\/notify\//,
  /^system\/lib\/remediation-request\.ts$/,
  /^system\/lib\/secrets\//,
  /^system\/scripts\//,
  /^system\/brain\/cognition\/capture/,
  /^system\/brain\/cognition\/(reliability-audit|jobs)\.ts$/,
  /\/migrations\//,
];

/**
 * Where an unreviewed fix may land at all (2026-10-31, operator decision): the
 * reliability code the nightly audit's findings live in — invariants, the
 * health monitor and its helpers, the scheduler, and the integration/job
 * runtime glue. Everything else in system/ (integrations themselves, memory,
 * cognition, surfaces, libraries) goes to review even when it passes the gate:
 * the gate is static analysis, and security-relevant code gets a human look.
 */
const LANDABLE: readonly RegExp[] = [
  /^system\/kernel\/invariants\//,
  /^system\/kernel\/runtime\/(?:health-monitor|host-sleep|loop-lag|boot-classification|repair-breaker|shutdown-stamp|pidfile)(?:\.test)?\.ts$/,
  /^system\/kernel\/scheduler\//,
  /^system\/integrations\/_runtime\//,
  /^system\/jobs\/_runtime\//,
];

const IMPORT_RE = /(?:from|import)\s*\(?\s*['"](\.{1,2}\/[^'"]+)['"]/g;

/**
 * Every repo file reachable by relative import from `roots` — the code K's
 * runner actually loads. `read` returns a file's source, or null when absent.
 */
export function importClosure(roots: string[], read: (path: string) => string | null): Set<string> {
  const seen = new Set<string>();
  const stack = roots.map((r) => normalize(r));
  while (stack.length > 0) {
    const file = stack.pop() as string;
    if (seen.has(file)) continue;
    const src = read(file);
    if (src === null) continue;
    seen.add(file);
    for (const m of src.matchAll(IMPORT_RE)) {
      let target = normalize(join(dirname(file), m[1] as string));
      if (target.endsWith('.js')) target = `${target.slice(0, -3)}.ts`;
      stack.push(target);
    }
  }
  return seen;
}

/** The agent runtime's import closure, read from `root` (a checkout or worktree). */
export function agentRuntimeClosure(root: string): Set<string> {
  const roots = readdirSync(join(root, 'system', 'agent'), { recursive: true })
    .map(String)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((f) => join('system', 'agent', f));
  roots.push('system/jobs/builtin/agent-runner/index.ts');
  return importClosure(roots, (p) => {
    try {
      return readFileSync(join(root, p), 'utf8');
    } catch {
      return null;
    }
  });
}

/** Run a command; returns stdout. Throws on a nonzero exit (execFileSync semantics). */
export type Exec = (
  cmd: string,
  args: string[],
  opts: {
    cwd: string;
    timeoutMs?: number;
  },
) => string;

const realExec: Exec = (cmd, args, opts) => {
  const o: ExecFileSyncOptions = {
    cwd: opts.cwd,
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: opts.timeoutMs ?? 300_000,
    maxBuffer: 32 * 1024 * 1024,
  };
  return execFileSync(cmd, args, o) as unknown as string;
};

export interface AutoLandOpts {
  repoRoot: string;
  worktree: string;
  branch: string;
  /** One-line description for the commit subject (K's change summary). */
  title: string;
  exec?: Exec;
  /** Injected in tests: the worktree's `.git` pointer file reader. */
  readGitPointer?: (path: string) => string;
  /** Injected in tests: the suite's sandbox failures at the branch base. */
  baselineFailures?: (c: BaselineCtx) => SuiteResult | null;
  /** Injected in tests: whether a test's new same-dir import can reach out. */
  reachCapable?: (file: string, spec: string) => boolean;
  /** Injected in tests: kill a run's leftovers. */
  reap?: (exec: Exec, privDir: string) => void;
  /** Injected in tests: create/remove the private TMPDIR, list /private/tmp. */
  makePrivDir?: () => string;
  removePrivDir?: (dir: string) => void;
  tmpEntries?: () => string[];
  /** Injected in tests; default process.platform (the gate's sandbox is macOS seatbelt). */
  platform?: string;
  /** Injected in tests; default $HOME. */
  home?: string;
  /** Injected in tests; defaults to agentRuntimeClosure(worktree). */
  runtimeClosure?: () => Set<string>;
  /** Injected in tests; defaults to the real prune. */
  prune?: (repoRoot: string, worktree: string, branch: string) => void;
  log?: (m: string) => void;
}

export interface AutoLandResult {
  landed: boolean;
  /** Why it was held for review, or what landed. */
  reason: string;
  files: string[];
  commit?: string;
}

/** Paths in `git status --porcelain` output (post-rename path for renames). */
function statusPaths(out: string): string[] {
  return out
    .split('\n')
    .map((l) => l.slice(3).split(' -> ').pop()?.trim() ?? '')
    .filter(Boolean);
}

/** Why this file set can't land unreviewed, or null when it passes scope + proof. */
export function scopeViolation(files: string[], runtime: Set<string> = new Set()): string | null {
  if (files.length === 0) return 'no changes';
  if (files.length > AUTO_LAND_LIMITS.maxFiles) {
    return `${files.length} files changed (limit ${AUTO_LAND_LIMITS.maxFiles})`;
  }
  const outside = files.filter((f) => !f.startsWith('system/'));
  if (outside.length > 0) return `touches files outside system/: ${outside.join(', ')}`;
  const guarded = files.filter((f) => runtime.has(f) || PROTECTED.some((re) => re.test(f)));
  if (guarded.length > 0) return `touches protected paths: ${guarded.join(', ')}`;
  const elsewhere = files.filter((f) => !LANDABLE.some((re) => re.test(f)));
  if (elsewhere.length > 0) {
    return `outside the auto-land scope (reliability code only): ${elsewhere.join(', ')}`;
  }
  if (!files.some((f) => f.endsWith('.test.ts'))) return 'no test in the diff';
  return null;
}

/**
 * Egress patterns in added lines. Every file (tests too — a landed test runs
 * unsandboxed the next time anyone runs `pnpm test`): network, subprocess,
 * dynamic code/imports, indirect global access, and the secrets store. Non-test
 * code additionally may not add URLs or touch the environment. A remediation
 * that needs any of this is a design change and waits for review.
 */
const REACH_ANY =
  /\bfetch\b|\bXMLHttpRequest\b|\bWebSocket\b|['"](?:node:)?(?:child_process|net|http|https|http2|dgram|tls|dns|worker_threads|vm|undici)['"]|\bchild_process\b|(?<![.\w])(?:spawn|spawnSync|exec|execSync|execFile|execFileSync|fork)\b|\beval\b|new\s+Function\b|\bimport\s*\(|\brequire\b|globalThis\s*\[|process\s*\[|Reflect\.(?:get|apply)\b|\bdlopen\b|process\.binding\b|process\.(?:stdout|exit|exitCode|reallyExit|abort|kill|_rawDebug)\b|process\.(?:on|once|prependListener)\s*\(\s*['"](?:exit|beforeExit)['"]|\/dev\/(?:stdout|stderr|fd\/)|writeSync\s*\(\s*[12]\b|['"](?:node:)?v8['"]|\.node['"]|loadEnvFile|secrets/;
const REACH_CODE = /\bhttps?:\/\/|process\.env\b/;

export interface FileChange {
  removed: string[];
  added: string[];
}

/**
 * Parse a unified diff into per-file removed/added lines, structurally: a file
 * section starts only at a column-0 `diff --git`, its `---`/`+++` headers are read
 * only before the section's first `@@`, and after that every line is content
 * (hunk lines always carry a ` `/`+`/`-`/`\\` prefix). An added line whose text is
 * `++ b/x.test.ts` therefore can't pose as a header and re-label the file.
 */
export function parsePatch(patch: string): Map<string, FileChange> {
  const out = new Map<string, FileChange>();
  let cur: FileChange | null = null;
  let inHunk = false;
  let oldName = '';
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      cur = null;
      inHunk = false;
      oldName = '';
      continue;
    }
    if (!inHunk) {
      if (line.startsWith('--- ')) oldName = line.slice(4).replace(/^a\//, '').trim();
      else if (line.startsWith('+++ ')) {
        const name = line.slice(4).trim();
        const file = name === '/dev/null' ? oldName : name.replace(/^b\//, '');
        cur = { removed: [], added: [] };
        out.set(file, cur);
      } else if (line.startsWith('@@')) inHunk = cur !== null;
      continue;
    }
    if (line.startsWith('@@')) continue;
    if (line.startsWith('+')) cur?.added.push(line.slice(1).trim());
    else if (line.startsWith('-')) cur?.removed.push(line.slice(1).trim());
  }
  return out;
}

/**
 * Module specifiers a source text imports — static, multi-line, re-exports,
 * dynamic `import('x')` and `require('x')` — via the TypeScript scanner, not a
 * line regex. Loaded lazily: only a land attempt pays for the compiler.
 */
export function importSpecs(src: string): Set<string> {
  const ts = createRequire(import.meta.url)('typescript') as typeof import('typescript');
  const info = ts.preProcessFile(src, true, true);
  return new Set(info.importedFiles.map((f) => f.fileName));
}

/** Built-ins with no way out of the process (no network, no subprocess, no native load). */
const INERT_BUILTINS = new Set([
  'node:test',
  'node:assert',
  'node:assert/strict',
  'node:path',
  'node:url',
  'node:util',
  'node:os',
  'node:fs',
  'node:fs/promises',
  'node:crypto',
  'node:events',
  'node:buffer',
  'node:string_decoder',
  'node:timers',
  'node:timers/promises',
]);

/**
 * Whether `spec`, imported from `file`, can reach the network or other processes:
 * any module in its import closure (read from `root`) has egress-shaped code or
 * imports a package / non-inert built-in.
 */
export function reachCapableImport(root: string, file: string, spec: string): boolean {
  const target = join(dirname(file), spec);
  const closure = importClosure([target], (p) => {
    try {
      return readFileSync(join(root, p), 'utf8');
    } catch {
      return null;
    }
  });
  if (closure.size === 0) return true; // unresolvable → assume the worst
  for (const p of closure) {
    let src: string;
    try {
      src = readFileSync(join(root, p), 'utf8');
    } catch {
      return true;
    }
    if (REACH_ANY.test(src)) return true;
    // A package or non-inert built-in anywhere in the closure is a way out the
    // text patterns can't see (an upload client, a DB driver, http).
    for (const spec of importSpecs(src)) {
      if (!spec.startsWith('.') && !INERT_BUILTINS.has(spec)) return true;
    }
  }
  return false;
}

/**
 * The only imports a test may add: the test harness, inert built-ins, and modules
 * in its own directory (the code under test) whose import closure can't reach out. A landed test runs unsandboxed the
 * next time anyone runs the suite, so it may not pull in a notifier, an
 * integration, or anything else that reaches out.
 */
const TEST_IMPORT_OK =
  /^(?:node:(?:test|assert|assert\/strict|fs|os|path|url)|\.\/[^/]+\.(?:ts|js|mjs|json))$/;

/**
 * Why the patch's reach can't land unreviewed, or null. Every file's added lines
 * are matched for egress (tests included — a landed test runs unsandboxed the
 * next time anyone runs the suite); non-test code also may not add URLs, env
 * access, or ANY new import, since an existing helper (a Discord notifier, an
 * HTTP integration) is egress no pattern can see; tests may add only harness,
 * inert built-in, and same-directory imports (TEST_IMPORT_OK). `importsAdded(file)` lists the
 * specifiers the staged file imports that its HEAD version didn't.
 */
export function reachViolation(
  patch: string,
  importsAdded: (file: string) => string[] = () => [],
  reachCapable: (file: string, spec: string) => boolean = () => true,
): string | null {
  const reach: string[] = [];
  const fresh: string[] = [];
  for (const [file, c] of parsePatch(patch)) {
    const isTest = file.endsWith('.test.ts');
    for (const text of c.added) {
      const m = text.match(REACH_ANY) ?? (isTest ? null : text.match(REACH_CODE));
      if (m) reach.push(`${file}: ${m[0].trim()}`);
    }
    for (const spec of importsAdded(file)) {
      // A same-directory import is still a way out if the module (or anything it
      // imports) can reach the network/processes — a test next to an integration
      // may not import it.
      const ok =
        isTest &&
        TEST_IMPORT_OK.test(spec) &&
        (spec.startsWith('node:') || !reachCapable(file, spec));
      if (!ok) fresh.push(`${file} ← ${spec}`);
    }
  }
  if (reach.length > 0) {
    return `adds network/process/env access: ${[...new Set(reach)].slice(0, 3).join('; ')}`;
  }
  if (fresh.length > 0) return `adds imports: ${fresh.slice(0, 3).join('; ')}`;
  return null;
}

// ── Integrity guard. Line patterns can be dodged by aliasing (`const p =
//    process; p.stdout`), destructuring, optional chaining or splitting an
//    expression across lines. So for every changed file — tests included — the
//    WHOLE staged text is compared with HEAD, and a NEW occurrence of any of these
//    holds: a `process` reference beyond a few inert properties (stdout, exit,
//    kill, the event stream…), globalThis/global/Reflect, console internals,
//    /dev paths, or writes to a numeric file descriptor. Counting (not presence)
//    keeps the 48 files that already use them legitimately landable.

const PROCESS_OK = new Set([
  'env',
  'cwd',
  'platform',
  'execPath',
  'pid',
  'argv',
  'hrtime',
  'nextTick',
  'memoryUsage',
  'version',
  'versions',
  'arch',
  'uptime',
  'getuid',
  'emitWarning',
]);

/** Sensitive constructs, captured with their member so each use is distinct. */
const SENSITIVE =
  /\bprocess\b(?:\s*(?:\?\.|\.)\s*(\w+)|\s*\[)?|\bglobalThis\b(?:\s*(?:\?\.|\.)\s*\w+)?|\bglobal\s*[.[]\s*\w*|\bReflect\b(?:\s*\.\s*\w+)?|\bconsole\s*(?:\.\s*_\w*|\[)|\/dev\/\w*|\b(?:write|writeSync|writeFile|writeFileSync|createWriteStream|appendFileSync)\s*\(\s*\d|\beval\b|\bFunction\b|\.\s*constructor\b|\bset(?:Timeout|Interval|Immediate)\s*\(\s*['"`]/g;
const ENV_ASSIGN = /\bprocess\s*\.\s*env\s*(?:\.\s*\w+|\[[^\]]*\])\s*(?:=(?!=)|\+=|\|\|=|\?\?=)/g;
/** `process.env` used as a value (passed, aliased, Object.assign'd, deleted
 *  from) rather than a plain named read like `process.env.HOME`. */
const ENV_AS_VALUE =
  /\bdelete\s+process\s*\.\s*env\b|\bprocess\s*\.\s*env\b(?!\s*(?:\.\s*\w+|\[\s*['"][^'"]+['"]\s*\]))/g;

/**
 * Source with comments removed and formatting normalized (TypeScript printer),
 * so a comment can't stand in for code and a split expression can't hide.
 * Unparseable or non-script text is returned as-is.
 */
function codeOnly(file: string, src: string): string {
  if (!src) return src;
  try {
    const ts = createRequire(import.meta.url)('typescript') as typeof import('typescript');
    const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, false);
    return ts.createPrinter({ removeComments: true }).printFile(sf);
  } catch {
    return src;
  }
}

/** Multiset of sensitive-construct contexts (`process.stdout`, `process.env=`, …). */
export function sensitiveContexts(file: string, src: string): Map<string, number> {
  const code = codeOnly(file, src);
  const out = new Map<string, number>();
  const add = (k: string) => out.set(k, (out.get(k) ?? 0) + 1);
  for (const m of code.matchAll(SENSITIVE)) {
    if (m[1] && PROCESS_OK.has(m[1])) continue; // process.env/cwd/… — inert reads
    add(m[0].replace(/\s+/g, ''));
  }
  for (const m of code.matchAll(ENV_ASSIGN)) add(`env-assign:${m[0].replace(/\s+/g, '')}`);
  for (const m of code.matchAll(ENV_AS_VALUE)) add(`env-value:${m[0].replace(/\s+/g, '')}`);
  return out;
}

/**
 * For every changed script file (tests included), any sensitive context the
 * staged file uses more often than HEAD did holds — compared as a multiset of
 * exact contexts, so removing one existing use can't pay for adding another.
 * `staged`/`head` return null for "absent at that rev".
 */
export function integrityViolation(
  files: string[],
  staged: (file: string) => string | null,
  head: (file: string) => string | null,
): string | null {
  const hits: string[] = [];
  for (const file of files.filter((f) => /\.(?:[cm]?[jt]sx?)$/.test(f))) {
    const now = sensitiveContexts(file, staged(file) ?? '');
    const before = sensitiveContexts(file, head(file) ?? '');
    for (const [ctx, n] of now) if (n > (before.get(ctx) ?? 0)) hits.push(`${file}: ${ctx}`);
  }
  return hits.length > 0
    ? `touches process/runtime internals: ${hits.slice(0, 3).join('; ')}`
    : null;
}

// ── Weakening guard. The cheapest way to make an alert stop is to make the check
//    more lenient — raise a threshold, downgrade a severity, return early, drop an
//    invariant, or delete the assertion that fails. That passes every test and
//    "fixes" nothing. A remediation that loosens a check or a test is a judgement
//    call, so it waits for review; a fix may only add checks and assertions.

/** Check code: where a loosened number or an early pass silences an alert. */
const CHECK_CODE = /^system\/kernel\/(?:invariants\/|runtime\/(?:health-monitor|alert-store)\.ts$)/;
const NUMBER = /\b\d[\d_]*(?:\.\d+)?\b/g;
const ASSERTION = /\bassert\b|\bexpect\s*\(|^\s*(?:test|it|describe)\s*\(/;
const TEST_DISABLED =
  /\b(?:test|it|describe)\.(?:skip|todo|only)\b|\{\s*(?:skip|todo|only)\s*:\s*true/;
const EARLY_PASS = /return\s*\{\s*(?:ok|passed)\s*:\s*true\b/;

/** Removed lines with no identical added line (so a move or re-indent isn't a loss). */
function lost(c: FileChange): string[] {
  const added = new Map<string, number>();
  for (const a of c.added) added.set(a, (added.get(a) ?? 0) + 1);
  return c.removed.filter((r) => {
    const n = added.get(r) ?? 0;
    if (n > 0) {
      added.set(r, n - 1);
      return false;
    }
    return true;
  });
}

const count = (lines: string[], re: RegExp) => lines.filter((l) => re.test(l)).length;

/** Why the patch loosens a check or a test, or null. */
export function weakeningViolation(patch: string): string | null {
  const reasons: string[] = [];
  for (const [file, c] of parsePatch(patch)) {
    const gone = lost(c);
    const fresh = c.added.filter((a) => !c.removed.includes(a));
    if (file.endsWith('.test.ts')) {
      const asserts = gone.filter((l) => ASSERTION.test(l));
      if (asserts.length > 0) {
        reasons.push(`${file}: removes or rewrites ${asserts.length} assertion/test line(s)`);
      }
      if (fresh.some((l) => TEST_DISABLED.test(l))) reasons.push(`${file}: skips or narrows tests`);
      continue;
    }
    for (const r of gone) {
      for (const m of r.matchAll(/\b(\w+Invariant)\s*\(/g)) {
        if (!c.added.some((a) => a.includes(`${m[1]}(`))) reasons.push(`${file}: drops ${m[1]}`);
      }
    }
    if (!CHECK_CODE.test(file)) continue;
    const shape = (l: string) => l.replace(NUMBER, '#');
    const moved = gone.filter(
      (r) => /\d/.test(r) && fresh.some((a) => a !== r && shape(a) === shape(r)),
    );
    if (moved.length > 0) reasons.push(`${file}: changes a threshold (${moved[0]?.slice(0, 80)})`);
    if (
      count(gone, /'critical'/) > count(fresh, /'critical'/) ||
      (count(gone, /'warning'/) > count(fresh, /'warning'/) &&
        count(fresh, /'info'/) > count(gone, /'info'/))
    ) {
      reasons.push(`${file}: downgrades a severity`);
    }
    if (fresh.some((l) => EARLY_PASS.test(l))) reasons.push(`${file}: adds an early pass`);
  }
  return reasons.length > 0
    ? `loosens a check: ${[...new Set(reasons)].slice(0, 3).join('; ')}`
    : null;
}

export interface SandboxInputs {
  worktree: string;
  repoRoot: string;
  home: string;
  /** Private, throwaway TMPDIR/cache dir for this run (deleted afterwards). */
  privDir: string;
  /** Directory of the Node binary running the gate (the ABI native modules match). */
  nodeDir: string;
  /** TCP ports already listening on this machine — real local services. */
  listeningPorts: number[];
  /** Absolute paths already in /private/tmp and /private/var/tmp — other tools'
   *  files, never readable or writable from the sandbox. */
  tmpEntries: string[];
  /** Numeric uid (tsx names its shared cache dir after it). */
  uid: number;
}

/**
 * Programs the checks may run, by exact path: shells, git, and inert POSIX
 * utilities that test scripts and git hooks call. Never script interpreters
 * (python/perl/ruby/osascript can reach launchd or native APIs directly), never
 * networking tools, launchctl, open or security, never a compiler.
 */
const EXECUTABLE = [
  '/usr/bin/env',
  '/bin/sh',
  '/bin/bash',
  '/bin/zsh',
  '/bin/dash',
  '/Library/Developer/CommandLineTools/usr/bin/git',
  ...[
    'cat',
    'ls',
    'rm',
    'mkdir',
    'cp',
    'mv',
    'ln',
    'chmod',
    'echo',
    'test',
    '[',
    'pwd',
    'sleep',
    'date',
    'expr',
  ].map((b) => `/bin/${b}`),
  ...[
    'uname',
    'sw_vers',
    'sed',
    'awk',
    'grep',
    'egrep',
    'head',
    'tail',
    'tr',
    'wc',
    'sort',
    'uniq',
    'cut',
    'dirname',
    'basename',
    'readlink',
    'realpath',
    'mktemp',
    'find',
    'xargs',
    'tee',
    'diff',
    'cmp',
    'which',
    'true',
    'false',
    'printf',
    'od',
    'sqlite3',
    'touch',
    'stat',
    'comm',
    'paste',
  ].map((b) => `/usr/bin/${b}`),
];

/** Mach services the checks may never reach. */
const MACH_DENIED = [
  'com.apple.dnssd.service',
  'com.apple.coreservices.launchservicesd',
  'com.apple.coreservices.appleevents',
  'com.apple.SecurityServer',
  'com.apple.securityd',
  'com.apple.pasteboard.1',
];

/**
 * Shared-temp names other tools create predictably (caches, session dirs). The
 * checks may create new temp entries, but never one of these — even before it
 * exists — or an unsandboxed tool would later adopt a squatted dir.
 */
const SHARED_TMP_RESERVED = String.raw`^/private/(var/)?tmp/(\.|tsx-|claude-|node-compile-cache|jiti|esbuild|vite|com\.apple\.|launchd|robin|autoland-)`;

/** Shared temp dirs where the checks may create new entries (see the seal below). */
const SHARED_TMP = ['/private/tmp', '/private/var/tmp'];

/** Read-only toolchain/system locations the checks need (everything else is unreadable). */
const READABLE = [
  '/System',
  '/usr',
  '/bin',
  '/sbin',
  '/Library/Apple',
  '/Library/Developer/CommandLineTools',
  '/private/etc',
  '/private/var/db/timezone',
  '/opt/homebrew',
];

/**
 * Seatbelt profile for the gate's checks, which execute K-authored code (tests
 * included). Deny by default, allow by need — verified live 2026-10-31 against the
 * full suite:
 *  - network: TCP to loopback only (tests run their own mock servers), minus every
 *    port that was already listening (Discord RPC, dev servers, tunnels…); no UDP,
 *    no DNS.
 *  - reads: file contents only from the toolchain, the worktree, the repo's
 *    node_modules and the private dir — not user-data, not ~ (credentials, app
 *    data), not the live checkout.
 *  - writes: the worktree (minus its `.git` pointer — a rewritten one would aim the
 *    next unsandboxed git at a hostile config), the private dir, /dev, and NEW
 *    entries in /private/tmp (tests mkdtemp there; existing entries — other tools'
 *    files and caches — stay unwritable). No shared caches, so nothing poisoned
 *    here is ever read by an unsandboxed process.
 */
export function gateSandboxProfile(o: SandboxInputs): string {
  const q = (p: string) => JSON.stringify(p);
  const sub = (paths: string[]) => paths.map((p) => `(subpath ${q(p)})`).join(' ');
  const readable = [
    ...READABLE,
    join(o.home, '.nvm'),
    join(o.home, 'Library', 'pnpm'),
    o.nodeDir,
    o.worktree,
    join(o.repoRoot, 'node_modules'),
    o.privDir,
    '/dev',
    ...SHARED_TMP,
  ];
  const tmpTaken = o.tmpEntries.filter((e) => e !== o.privDir);
  const ports = o.listeningPorts.map((p) => `(remote tcp ${q(`localhost:${p}`)})`).join(' ');
  return [
    '(version 1)',
    '(allow default)',
    '(deny network*)',
    '(allow network* (local ip "localhost:*"))',
    // tsx and node:test talk over unix sockets in TMPDIR — only the private dir's.
    `(allow network* (local unix-socket ${sub([o.privDir])}))`,
    `(allow network-outbound (remote unix-socket ${sub([o.privDir])}))`,
    '(allow network-outbound (remote tcp "localhost:*"))',
    ...(ports ? [`(deny network-outbound ${ports})`] : []),
    // Services that act outside the sandbox on its behalf: DNS, launching apps
    // and URLs, Apple Events (driving other apps), the keychain, the clipboard.
    `(deny mach-lookup ${MACH_DENIED.map((n) => `(global-name ${q(n)})`).join(' ')})`,
    // Native code may only be mapped from system/toolchain paths and the repo's
    // node_modules — a test can't write a .node/.dylib and dlopen it.
    '(deny file-map-executable)',
    `(allow file-map-executable ${sub([
      '/System',
      '/usr/lib',
      '/Library/Apple',
      '/Library/Developer/CommandLineTools',
      '/opt/homebrew',
      o.nodeDir.replace(/\/bin$/, ''),
      join(o.repoRoot, 'node_modules'),
    ])})`,
    // Only the programs the checks run. Not launchctl (starts jobs outside the
    // sandbox), osascript/open, security, a compiler, or anything the checks
    // wrote — K can't write node_modules, and nothing else here is executable.
    '(deny process-exec)',
    `(allow process-exec ${[...EXECUTABLE, join(o.nodeDir, 'node')]
      .map((p) => `(literal ${q(p)})`)
      .join(' ')} ${sub([
      '/Library/Developer/CommandLineTools/usr/libexec/git-core',
      join(o.repoRoot, 'node_modules'),
    ])})`,
    '(deny file-read-data)',
    `(allow file-read-data ${sub(readable)} (literal "/") (literal ${q(o.home)}))`,
    '(deny file-write*)',
    `(allow file-write* ${sub([o.worktree, o.privDir, '/dev', ...SHARED_TMP])})`,
    // Shared temp dirs: tests (and children that drop TMPDIR, like the lab
    // sandbox's — then SQLite falls back to /var/tmp) may create NEW entries;
    // whatever was already there belongs to other tools and stays sealed.
    ...(tmpTaken.length > 0 ? [`(deny file-read-data file-write* ${sub(tmpTaken)})`] : []),
    // SBPL `#"…"` regex literals take backslashes verbatim — no JSON escaping.
    `(deny file-write* (regex #"${SHARED_TMP_RESERVED}"))`,
    `(allow file-write* ${sub([o.privDir])})`,
    // tsx's shared transform cache, READ-only (after the seal): children that drop
    // TMPDIR fall back to it. Writing it would poison later unsandboxed runs.
    `(allow file-read-data ${sub([`/private/tmp/tsx-${o.uid}`])})`,
    `(deny file-write* (literal ${q(join(o.worktree, '.git'))}) ${sub([join(o.worktree, '.git')])})`,
  ].join('\n');
}

/** Clean environment for the checks: no secrets, no global git config, private temp. */
export function gateEnv(o: SandboxInputs): string[] {
  return [
    `PATH=${[
      join(o.worktree, 'node_modules', '.bin'),
      o.nodeDir,
      '/Library/Developer/CommandLineTools/usr/bin', // real git, not the xcrun shim
      '/usr/bin',
      '/bin',
      '/usr/sbin',
      '/sbin',
    ].join(':')}`,
    // A fake, empty HOME: nothing in the real one (credentials, the user-data
    // pointer, app data) is reachable, so tests behave as on a fresh machine.
    `HOME=${join(o.privDir, 'home')}`,
    `TMPDIR=${o.privDir}`,
    `XDG_CACHE_HOME=${join(o.privDir, 'cache')}`,
    'LANG=en_US.UTF-8',
    'GIT_CONFIG_GLOBAL=/dev/null',
    'GIT_CONFIG_NOSYSTEM=1',
    'GIT_AUTHOR_NAME=robin-gate',
    'GIT_AUTHOR_EMAIL=gate@robin.invalid',
    'GIT_COMMITTER_NAME=robin-gate',
    'GIT_COMMITTER_EMAIL=gate@robin.invalid',
  ];
}

/**
 * Live listening TCP ports (lsof), or null when they can't be enumerated. The
 * profile only keeps local services unreachable by naming their ports, so an
 * unknown list fails closed (the caller holds) instead of opening all loopback.
 */
function listeningPorts(exec: Exec): number[] | null {
  try {
    const out = exec('/usr/sbin/lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fn'], { cwd: '/' });
    const ports = [...new Set([...out.matchAll(/:(\d+)$/gm)].map((m) => Number(m[1])))];
    return ports.length > 0 ? ports.sort((a, b) => a - b) : null;
  } catch {
    return null;
  }
}

/**
 * Failed test cases from the node:test JUnit report, keyed by file (relative to
 * the run's root) plus the full suite path — `file :: outer > inner > name` —
 * with a count per key. The runner writes the report itself, so nothing a test
 * prints can forge or hide an entry, and two tests named alike in different
 * places never collide.
 */
export function junitFailures(xml: string, roots: string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const c of junitCases(xml, roots)) if (c.failed) out.set(c.key, (out.get(c.key) ?? 0) + 1);
  return out;
}

/** Every test case in the report, pass or fail, in report order. */
export function junitCases(
  xml: string,
  roots: string[],
): Array<{ file: string; key: string; failed: boolean }> {
  const out: Array<{ file: string; key: string; failed: boolean }> = [];
  const suites: string[] = [];
  const attr = (attrs: string, k: string) => attrs.match(new RegExp(`\\s${k}="([^"]*)"`))?.[1];
  const caseOf = (attrs: string) => {
    let file = attr(attrs, 'file') ?? '?';
    for (const r of roots) if (file.startsWith(`${r}/`)) file = file.slice(r.length + 1);
    return { file, key: `${file} :: ${[...suites, attr(attrs, 'name') ?? '?'].join(' > ')}` };
  };
  // An open (non-self-closed) testcase fails on a `failure` attribute OR a
  // nested <failure> element (node:test writes both) — counted once.
  let open: { file: string; key: string; failed: boolean } | null = null;
  for (const m of xml.matchAll(/<(\/?)(testsuite|testcase|failure)\b([^>]*?)(\/?)>/g)) {
    const [, close, tag, attrs = '', selfClose] = m;
    if (tag === 'testsuite') {
      if (close) suites.pop();
      else if (!selfClose) suites.push(attr(attrs, 'name') ?? '');
    } else if (tag === 'testcase') {
      if (close) {
        if (open) out.push(open);
        open = null;
      } else if (selfClose) {
        out.push({ ...caseOf(attrs), failed: /\sfailure="/.test(attrs) });
      } else {
        open = { ...caseOf(attrs), failed: /\sfailure="/.test(attrs) };
      }
    } else if (tag === 'failure' && !close && open) {
      open.failed = true;
    }
  }
  return out;
}

/** file → its test-case keys (sorted, duplicates kept): what the file ran. */
export function junitInventory(xml: string, roots: string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const c of junitCases(xml, roots)) out.set(c.file, [...(out.get(c.file) ?? []), c.key]);
  for (const keys of out.values()) keys.sort();
  return out;
}

/**
 * Test files the diff doesn't touch must run exactly the cases they ran at the
 * base — same names, same count, pass or fail. Forging results (crafted runner
 * events, a swallowed failure) would have to reproduce another file's precise
 * inventory; a K change to non-test code can't legitimately alter it at all.
 */
export function inventoryDrift(
  candidate: Map<string, string[]>,
  base: Map<string, string[]>,
  touched: string[],
): string[] {
  const files = new Set([...candidate.keys(), ...base.keys()]);
  return [...files].filter(
    (f) =>
      !touched.includes(f) &&
      (candidate.get(f) ?? []).join('\n') !== (base.get(f) ?? []).join('\n'),
  );
}

/** A sandboxed suite run, read from its JUnit report. */
export interface SuiteResult {
  failures: Map<string, number>;
  inventory: Map<string, string[]>;
}

/**
 * Candidate failures the base can't explain: more failures under a key than the
 * base had, or ANY failure in a file the diff touches (a new test can't borrow a
 * known-incompatible test's name to hide in its count).
 */
export function freshFailures(
  candidate: Map<string, number>,
  base: Map<string, number>,
  touched: string[],
): string[] {
  return [...candidate].flatMap(([key, n]) => {
    const file = key.split(' :: ')[0] ?? '';
    return touched.includes(file) || n > (base.get(key) ?? 0) ? [key] : [];
  });
}

/** Point node:test's reporters: console (spec) to stderr, JUnit to stdout. */
export function withJunit(testScript: string): string | null {
  if (!/^node --test\b/.test(testScript)) return null;
  return testScript.replace(
    /^node --test\b/,
    'node --test --test-reporter=spec --test-reporter-destination=stderr --test-reporter=junit --test-reporter-destination=stdout',
  );
}

export interface BaselineCtx {
  repoRoot: string;
  /** The branch base commit. */
  head: string;
  makePriv: () => string;
  removePriv: (dir: string) => void;
  exec: Exec;
  suiteRun: (cwd: string, privDir: string) => SuiteResult | null;
}

/**
 * The suite's sandbox failures at the branch base: a detached worktree of HEAD
 * inside a fresh private dir of its own, sharing the repo's node_modules. Both
 * are removed afterwards.
 */
function defaultBaseline(c: BaselineCtx): SuiteResult | null {
  const privDir = c.makePriv();
  const base = join(privDir, 'base');
  try {
    c.exec('git', ['worktree', 'add', '--detach', base, c.head], { cwd: c.repoRoot });
    symlinkSync(join(c.repoRoot, 'node_modules'), join(base, 'node_modules'), 'dir');
    return c.suiteRun(base, privDir);
  } finally {
    try {
      c.exec('git', ['worktree', 'remove', '--force', base], { cwd: c.repoRoot });
    } catch {
      /* `git worktree prune` tidies the record once the dir is gone */
    }
    c.removePriv(privDir);
  }
}

/**
 * Kill processes a sandboxed run left behind: anything whose command line or
 * environment (ps -E) names its private dir. Best-effort — a leftover is still
 * confined by the sandbox it inherited, and the reserved `autoland-` temp prefix
 * keeps it out of every later private dir.
 */
function reapLeftovers(exec: Exec, privDir: string): void {
  try {
    const out = exec('/bin/ps', ['-Eww', '-x', '-o', 'pid=,command='], { cwd: '/' });
    for (const line of out.split('\n')) {
      const pid = Number.parseInt(line, 10);
      if (pid > 0 && pid !== process.pid && line.includes(privDir)) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }
    }
  } catch {
    /* ps unavailable — the sandbox still confines leftovers */
  }
}

function realpathOr(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

function firstLine(err: unknown): string {
  const e = err as { stdout?: string; stderr?: string; message?: string };
  const text = `${e.stdout ?? ''}\n${e.stderr ?? ''}`.trim() || e.message || String(err);
  const lines = text.split('\n').filter((l) => /error|fail|✖|not ok/i.test(l));
  return (lines[0] ?? text.split('\n')[0] ?? '').trim().slice(0, 200);
}

/**
 * Flags on every diff the gate reads, so what it validates is what lands:
 * --no-renames lists a rename's source AND destination (a protected file moved out
 * of a protected dir is still seen); --no-ext-diff/--no-textconv ignore any
 * .gitattributes diff driver that could show the validator different text; --text
 * diffs binaries as text instead of hiding them.
 */
export const GATE_DIFF_FLAGS = ['--no-renames', '--no-ext-diff', '--no-textconv', '--text'];

export function autoLand(opts: AutoLandOpts): AutoLandResult {
  const exec = opts.exec ?? realExec;
  const log = opts.log ?? (() => {});
  const { repoRoot, worktree, branch } = opts;
  const hold = (reason: string, files: string[] = []): AutoLandResult => {
    log(`auto-land: held ${branch} for review — ${reason}`);
    return { landed: false, reason, files };
  };

  // K's run could write anything in its worktree — including the `.git` pointer,
  // which decides what config (fsmonitor, filters, hooks) the gate's own git
  // commands obey. It must point into the repo's admin dir, which K can't write;
  // and every worktree git call runs with hooks, fsmonitor and signing off.
  const gitDotFile = join(worktree, '.git');
  const readGit = opts.readGitPointer ?? ((p: string) => readFileSync(p, 'utf8'));
  let pointerBefore: string;
  try {
    pointerBefore = readGit(gitDotFile);
  } catch (err) {
    return hold(`unreadable .git pointer: ${firstLine(err)}`);
  }
  const target = pointerBefore.trim().replace(/^gitdir:\s*/, '');
  if (!target.startsWith(`${join(repoRoot, '.git', 'worktrees')}/`) || target.includes('..')) {
    return hold(`.git pointer leaves the repo's worktree admin dir: ${target.slice(0, 120)}`);
  }
  const gitW = (args: string[]) =>
    exec(
      'git',
      [
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'core.fsmonitor=false',
        '-c',
        'commit.gpgsign=false',
        ...args,
      ],
      { cwd: worktree },
    );

  // K can't commit, so a branch already ahead of main carries history that isn't
  // K's fix — e.g. one cut before the 2026-10-31 history squash, whose merge would
  // drag 700+ pre-squash commits back into main. Only uncommitted work lands.
  const ahead = Number.parseInt(gitW(['rev-list', '--count', 'main..HEAD']).trim(), 10);
  if (ahead !== 0)
    return hold(`branch has ${ahead} commit(s) ahead of main — only uncommitted fixes auto-land`);

  // Stage everything (new files included) so one diff covers the whole change.
  gitW(['add', '-A']);
  // Diff against the branch's own base (HEAD — K can't commit), never the moving
  // `main` ref: main gains commits during a run, and diffing against it would
  // count those as part of K's change.
  const files = gitW(['diff', '--cached', '--name-only', 'HEAD', ...GATE_DIFF_FLAGS])
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  // Git control files change how git renders, merges and fetches — the gate's own
  // view. Case-insensitive: core.ignorecase repos (macOS) honour `.GitAttributes`.
  const control = files.find((f) => /(^|\/)\.(gitattributes|gitmodules|mailmap)$/i.test(f));
  if (control) return hold(`changes git control file ${control}`, files);

  // Fail closed: if the runtime's import graph can't be read, nothing lands.
  let runtime: Set<string>;
  try {
    runtime = (opts.runtimeClosure ?? (() => agentRuntimeClosure(worktree)))();
  } catch (err) {
    return hold(`could not map the agent runtime's imports: ${firstLine(err)}`, files);
  }
  const scope = scopeViolation(files, runtime);
  if (scope) return hold(scope, files);

  // Binary probe WITHOUT --text: with it, git never prints `-\t-`, so a binary would
  // be counted as ordinary lines instead of held.
  const probe = gitW([
    'diff',
    '--cached',
    '--numstat',
    'HEAD',
    ...GATE_DIFF_FLAGS.filter((f) => f !== '--text'),
  ]);
  if (probe.split('\n').some((l) => l.startsWith('-\t'))) return hold('binary change', files);
  const numstat = gitW(['diff', '--cached', '--numstat', 'HEAD', ...GATE_DIFF_FLAGS])
    .split('\n')
    .filter(Boolean);
  const changed = numstat.reduce((sum, l) => {
    const [add, del] = l.split('\t');
    return sum + (Number(add) || 0) + (Number(del) || 0);
  }, 0);
  if (changed > AUTO_LAND_LIMITS.maxChangedLines) {
    return hold(`${changed} lines changed (limit ${AUTO_LAND_LIMITS.maxChangedLines})`, files);
  }

  // Imports are compared on whole files (staged vs HEAD), so a multi-line or
  // dynamic import can't hide between diff lines.
  let importReadFailed = '';
  const show = (rev: string): Set<string> => {
    try {
      gitW(['cat-file', '-e', rev]);
    } catch {
      return new Set(); // genuinely absent (a new or deleted file)
    }
    try {
      return importSpecs(gitW(['show', rev]));
    } catch (err) {
      importReadFailed ||= `${rev}: ${firstLine(err)}`;
      return new Set();
    }
  };
  const importsAdded = (file: string): string[] => {
    const before = show(`HEAD:${file}`);
    return [...show(`:${file}`)].filter((spec) => !before.has(spec));
  };
  const patch = gitW(['diff', '--cached', 'HEAD', ...GATE_DIFF_FLAGS]);
  const reachResult = reachViolation(patch, importsAdded, (file, spec) =>
    (opts.reachCapable ?? ((f: string, sp: string) => reachCapableImport(worktree, f, sp)))(
      file,
      spec,
    ),
  );
  if (importReadFailed) return hold(`couldn't read a changed file: ${importReadFailed}`, files);
  if (reachResult) return hold(reachResult, files);
  // Only regular files land: a symlink would make every check above read its
  // target path while something else runs, and a gitlink pulls in a submodule.
  const odd = gitW(['diff', '--cached', '--raw', 'HEAD', ...GATE_DIFF_FLAGS])
    .split('\n')
    .filter((l) => l.startsWith(':'))
    .filter((l) => {
      const [, newMode] = l.slice(1).split(' ');
      return newMode !== '100644' && newMode !== '100755' && newMode !== '000000';
    });
  if (odd.length > 0) {
    return hold(`non-regular file mode: ${odd[0]?.split('\t').pop() ?? '?'}`, files);
  }

  // A read that fails for any reason but "absent at that rev" holds — never an
  // empty file that passes every check.
  let readFailed = '';
  const showAt = (rev: string): string | null => {
    try {
      gitW(['cat-file', '-e', rev]);
    } catch {
      return null; // genuinely absent
    }
    try {
      return gitW(['show', rev]);
    } catch (err) {
      readFailed ||= `${rev}: ${firstLine(err)}`;
      return null;
    }
  };
  const integrity = integrityViolation(
    files,
    (f) => showAt(`:${f}`),
    (f) => showAt(`HEAD:${f}`),
  );
  if (readFailed) return hold(`couldn't read a changed file: ${readFailed}`, files);
  if (integrity) return hold(integrity, files);
  const weakened = weakeningViolation(patch);
  if (weakened) return hold(weakened, files);

  const dirty = new Set(statusPaths(exec('git', ['status', '--porcelain'], { cwd: repoRoot })));
  const overlap = files.filter((f) => dirty.has(f));
  if (overlap.length > 0)
    return hold(`overlaps uncommitted work in main: ${overlap.join(', ')}`, files);

  // The checks execute K-authored code (its tests, and anything they import), so
  // they run inside the seatbelt profile with a clean environment — never with
  // the runner's secrets, network, or shared caches. No sandbox → nothing lands.
  // They call the tools directly (no pnpm/corepack, which reach for parent
  // package.json files and the network), and the suite command comes from HEAD's
  // package.json, which K can't change (it's outside system/).
  if ((opts.platform ?? process.platform) !== 'darwin') {
    return hold('no OS sandbox for the checks on this platform', files);
  }
  let testScript: string;
  try {
    testScript =
      (
        JSON.parse(gitW(['show', 'HEAD:package.json'])) as {
          scripts?: { test?: string };
        }
      ).scripts?.test ?? '';
  } catch {
    testScript = '';
  }
  if (!testScript) return hold('no test script in package.json', files);

  const makePriv =
    opts.makePrivDir ??
    (() => {
      const d = mkdtempSync('/private/tmp/autoland-');
      mkdirSync(join(d, 'home'));
      return d;
    });
  const removePriv =
    opts.removePrivDir ?? ((d: string) => rmSync(d, { recursive: true, force: true }));
  const ports = listeningPorts(exec);
  if (!ports) {
    return hold("couldn't enumerate listening ports — local services would be reachable", files);
  }
  const tmpEntries =
    opts.tmpEntries ?? (() => SHARED_TMP.flatMap((d) => readdirSync(d).map((e) => join(d, e))));
  /** Run argv in `cwd` inside a sandbox scoped to (cwd, privDir); returns '' or throws. */
  const sandboxed = (argv: string[], cwd: string, privDir: string) => {
    const inputs: SandboxInputs = {
      worktree: cwd,
      repoRoot,
      home: opts.home ?? process.env.HOME ?? '',
      privDir,
      nodeDir: dirname(process.execPath),
      listeningPorts: ports,
      tmpEntries: tmpEntries(),
      uid: process.getuid?.() ?? 501,
    };
    try {
      return exec(
        'sandbox-exec',
        ['-p', gateSandboxProfile(inputs), 'env', '-i', ...gateEnv(inputs), ...argv],
        { cwd, timeoutMs: 600_000 },
      );
    } finally {
      // Anything the run left behind (still sandboxed) is killed, best-effort.
      (opts.reap ?? reapLeftovers)(exec, privDir);
    }
  };
  // The JUnit report is the runner's own stdout (the console reporter goes to
  // stderr). Test files run in child processes whose output the runner consumes
  // as events: plain console output never reaches the report, and the reach
  // patterns hold any change that writes stdout/fd 1 directly, exits early,
  // hooks exit, or loads node:v8 (the event stream's serializer). The report
  // must be complete, list cases, and agree with the exit status.
  const suiteRun = (cwd: string, privDir: string): SuiteResult | null => {
    const script = withJunit(testScript) as string;
    let report: string;
    let exitOk = true;
    try {
      report = sandboxed(['sh', '-c', script], cwd, privDir);
    } catch (err) {
      exitOk = false;
      report = String((err as { stdout?: unknown }).stdout ?? '');
    }
    if (!/<\/testsuites>\s*$/.test(report) || !report.includes('<testcase')) return null;
    const roots = [cwd, realpathOr(cwd)];
    const failures = junitFailures(report, roots);
    // Exit status and report must tell the same story.
    if (exitOk === failures.size > 0) return null;
    return { failures, inventory: junitInventory(report, roots) };
  };
  if (!withJunit(testScript)) return hold("test script isn't a `node --test` command", files);

  // The base's sandbox failures are taken FIRST, before any K-authored code has
  // run, in their own private dir — so nothing the candidate does can shape them.
  // Some tests can't run in the sandbox at all (git-hooks tests exec hooks they
  // wrote); rather than loosen the sandbox, the candidate may add no NEW failure.
  const baseRun = (opts.baselineFailures ?? defaultBaseline)({
    repoRoot,
    head: gitW(['rev-parse', 'HEAD']).trim(),
    makePriv,
    removePriv,
    exec,
    suiteRun,
  });
  if (!baseRun) return hold('the suite at the base has no consistent report', files);

  const privDir = makePriv();
  try {
    // The full suite, not just the touched tests: a fix can break a neighbour.
    const tsFiles = files.filter((f) => /\.(ts|js|mjs|json)$/.test(f));
    for (const [name, argv] of [
      ['typecheck', ['node', 'node_modules/typescript/bin/tsc', '--noEmit']],
      ['lint', ['node', 'node_modules/@biomejs/biome/bin/biome', 'lint', ...tsFiles]],
    ] as Array<[string, string[]]>) {
      try {
        sandboxed(argv, worktree, privDir);
      } catch (err) {
        return hold(`${name} failed: ${firstLine(err)}`, files);
      }
    }
    const run = suiteRun(worktree, privDir);
    if (!run) return hold('tests failed without a consistent report', files);
    const drift = inventoryDrift(run.inventory, baseRun.inventory, files);
    if (drift.length > 0) {
      return hold(
        `test inventory changed in untouched file(s): ${drift.slice(0, 3).join(', ')}`,
        files,
      );
    }
    const failed = run.failures;
    const fresh = freshFailures(failed, baseRun.failures, files);
    if (fresh.length > 0) return hold(`tests failed: ${fresh.slice(0, 3).join(' | ')}`, files);
    if (failed.size > 0) {
      log(`auto-land: ${failed.size} test(s) also fail in the sandbox at the base — not the fix's`);
    }
  } finally {
    removePriv(privDir);
  }

  // The sandbox denies writes to the `.git` pointer; confirm it anyway before git
  // reads it again outside the sandbox.
  if (readGit(gitDotFile) !== pointerBefore) {
    return hold("the checks changed the worktree's .git pointer", files);
  }

  // The checks ran K's code with write access to the worktree. Whatever lands is
  // exactly what was staged and reviewed above: any edit or new file the checks
  // left behind holds it.
  const drift = [
    ...gitW(['diff', '--name-only', ...GATE_DIFF_FLAGS]).split('\n'),
    ...gitW(['ls-files', '--others', '--exclude-standard']).split('\n'),
  ].filter((l) => l.trim());
  if (drift.length > 0) {
    return hold(`the checks modified the worktree: ${drift.slice(0, 3).join(', ')}`, files);
  }

  const subject = opts.title.replace(/\s+/g, ' ').trim().slice(0, 72) || 'remediate health issue';
  const body =
    'Auto-landed by K (health remediation) after typecheck, lint and the full test suite passed.';
  try {
    gitW(['commit', '--no-verify', '-m', `fix(auto): ${subject}`, '-m', body]);
  } catch (err) {
    return hold(`commit failed: ${firstLine(err)}`, files);
  }

  try {
    exec('git', ['merge', '--no-ff', '-m', `Merge auto-fix: ${subject}`, branch], {
      cwd: repoRoot,
    });
  } catch (err) {
    try {
      exec('git', ['merge', '--abort'], { cwd: repoRoot });
    } catch {
      /* nothing to abort */
    }
    return hold(`merge into main failed: ${firstLine(err)}`, files);
  }
  const commit = exec('git', ['rev-parse', '--short', 'HEAD'], { cwd: repoRoot }).trim();

  try {
    exec('pnpm', ['build'], { cwd: repoRoot, timeoutMs: 600_000 });
  } catch (err) {
    // Never leave a merge live that the build rejects: revert it and rebuild so
    // dist/ matches the reverted tree. The branch survives for review.
    // If the reverted tree still won't build, the breakage is the live checkout's
    // own uncommitted work, not this fix — say so instead of blaming the fix.
    const why = firstLine(err);
    try {
      exec('git', ['revert', '-m', '1', '--no-edit', commit], { cwd: repoRoot });
    } catch (revertErr) {
      return hold(
        `build failed after merge and reverting ${commit} failed — main needs attention: ${firstLine(revertErr)}`,
        files,
      );
    }
    try {
      exec('pnpm', ['build'], { cwd: repoRoot, timeoutMs: 600_000 });
    } catch {
      return hold(
        `build is broken without this fix too (uncommitted work in main?) — ${commit} reverted, dist/ is stale: ${why}`,
        files,
      );
    }
    return hold(`build failed after merge (${commit} reverted): ${why}`, files);
  }

  (opts.prune ?? pruneWorktree)(repoRoot, worktree, branch);
  log(`auto-land: landed ${branch} as ${commit} (${files.length} files)`);
  return { landed: true, reason: `landed as ${commit}`, files, commit };
}

/**
 * Restart the launchd daemon onto the new build a few seconds from now, then run
 * the probation check (land-probation.ts) once it should have settled — all from
 * a fully detached shell, so the caller (a detached runner child) finishes its
 * own bookkeeping first and the kickstart can't take it down with the daemon.
 */
export function restartDaemonSoon(opts: {
  repoRoot: string;
  commit: string;
  branch: string;
  logPath?: string;
}): void {
  const uid = process.getuid?.() ?? 501;
  const q = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;
  const probation = [
    'pnpm exec tsx system/agent/land-probation.ts',
    `--commit=${q(opts.commit)}`,
    `--branch=${q(opts.branch)}`,
  ].join(' ');
  const out = opts.logPath ? ` >> ${q(opts.logPath)} 2>&1` : '';
  const child = spawn(
    'sh',
    [
      '-c',
      `sleep 10; launchctl kickstart -k gui/${uid}/io.robin-assistant.daemon; sleep 150; ${probation}${out}`,
    ],
    { cwd: opts.repoRoot, detached: true, stdio: 'ignore' },
  );
  child.unref();
}
