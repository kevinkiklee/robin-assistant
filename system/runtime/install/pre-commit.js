// Git pre-commit installer (Phase 4a §5.F).
//
// Lifts v1's `system/scripts/cli/install-hooks.js` + `hooks/pre-commit.js`
// privacy logic. NOT bundled into `robin install` — it's invoked from inside
// the user's project repo via `robin pre-commit install`.
//
// The hook content shells out to `node` running our `robin pre-commit run`
// dispatcher; the dispatcher imports `runPreCommit` from this same module to
// scan the staged diff for `.env` / `secrets/` paths and credential patterns.
// On a hit, the hook exits non-zero and refuses the commit.

import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  forgetHostTouchpoint,
  packageRootDir,
  recordHostTouchpoint,
} from '../../config/data-store.js';
import { SECRET_PATTERNS } from '../../io/outbound/patterns.js';

// Identity marker — any hook file containing this token (also implicitly via
// the absolute path to our run script) is owned by robin.
const HOOK_MARKER = 'robin pre-commit run';

function preCommitRunScriptPath() {
  return join(packageRootDir(), 'bin', 'robin');
}

function hookContent() {
  const robinBin = preCommitRunScriptPath();
  return `#!/usr/bin/env bash
# ${HOOK_MARKER} — installed by robin-assistant
exec node "${robinBin}" pre-commit run "$@"
`;
}

function gitTopLevel(cwd) {
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd,
    encoding: 'utf8',
  });
  if (r.status !== 0) return null;
  const out = (r.stdout || '').trim();
  return out.length > 0 ? out : null;
}

/**
 * Install our pre-commit hook in the git repo at `cwd`.
 *
 * - Refuses if cwd is not inside a git repo.
 * - Refuses to overwrite an unrelated existing hook.
 * - Idempotent: if the existing hook already references our run script,
 *   reports `installed: true` without rewriting.
 *
 * @param {{cwd: string}} args
 * @returns {Promise<{installed: boolean, reason?: string, path?: string}>}
 */
export async function installPreCommit({ cwd } = {}) {
  if (!cwd || typeof cwd !== 'string') {
    throw new TypeError('installPreCommit: cwd is required');
  }
  const top = gitTopLevel(cwd);
  if (!top) {
    return { installed: false, reason: 'not a git repo' };
  }
  const hookDir = join(top, '.git', 'hooks');
  if (!existsSync(hookDir)) {
    mkdirSync(hookDir, { recursive: true });
  }
  const hookPath = join(hookDir, 'pre-commit');
  const ourPath = preCommitRunScriptPath();

  if (existsSync(hookPath)) {
    let existing = '';
    try {
      existing = readFileSync(hookPath, 'utf8');
    } catch {
      existing = '';
    }
    if (existing.includes(ourPath) || existing.includes(HOOK_MARKER)) {
      return { installed: true, path: hookPath };
    }
    return {
      installed: false,
      reason: 'existing pre-commit hook present (not robin-owned); leaving alone',
      path: hookPath,
    };
  }

  // Atomic-ish write: tmp + rename, then chmod. Record in unified manifest.
  await recordHostTouchpoint(
    {
      kind: 'git-precommit-hook',
      path: hookPath,
      marker: HOOK_MARKER,
      installedAt: new Date().toISOString(),
    },
    () => {
      const tmp = `${hookPath}.tmp`;
      writeFileSync(tmp, hookContent(), { mode: 0o755 });
      renameSync(tmp, hookPath);
      chmodSync(hookPath, 0o755);
    },
  );
  return { installed: true, path: hookPath };
}

/**
 * Remove our pre-commit hook if (and only if) it points at our run script.
 *
 * @param {{cwd: string}} args
 * @returns {Promise<{uninstalled: boolean, reason?: string, path?: string}>}
 */
export async function uninstallPreCommit({ cwd } = {}) {
  if (!cwd || typeof cwd !== 'string') {
    throw new TypeError('uninstallPreCommit: cwd is required');
  }
  const top = gitTopLevel(cwd);
  if (!top) {
    return { uninstalled: false, reason: 'not a git repo' };
  }
  const hookPath = join(top, '.git', 'hooks', 'pre-commit');
  if (!existsSync(hookPath)) {
    return { uninstalled: false, reason: 'no pre-commit hook present', path: hookPath };
  }
  let existing = '';
  try {
    existing = readFileSync(hookPath, 'utf8');
  } catch {
    return { uninstalled: false, reason: 'cannot read hook', path: hookPath };
  }
  const ourPath = preCommitRunScriptPath();
  if (!existing.includes(ourPath) && !existing.includes(HOOK_MARKER)) {
    return {
      uninstalled: false,
      reason: 'pre-commit hook is not robin-owned; leaving alone',
      path: hookPath,
    };
  }
  unlinkSync(hookPath);
  await forgetHostTouchpoint({ kind: 'git-precommit-hook', path: hookPath });
  return { uninstalled: true, path: hookPath };
}

// ----- Diff scanning -----

function defaultRunGitDiff() {
  const r = spawnSync('git', ['diff', '--cached', '--unified=0'], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (r.status !== 0 && r.status !== null) {
    // Non-zero from `git diff` is unusual; fall through with whatever stdout we got.
  }
  return r.stdout || '';
}

// Path-shape rules: any staged path matching one of these is unsafe.
const UNSAFE_PATH_RULES = [
  { name: 'dotenv-path', test: (p) => /(^|\/)\.env(\.|$|\/)/.test(p) },
  { name: 'secrets-path', test: (p) => /(^|\/)secrets\//.test(p) },
];

/**
 * Parse `git diff --cached --unified=0` into a set of staged paths and the
 * added-line text per path. Robust to rename/copy headers ("rename to",
 * "copy to") — we only care about the destination side.
 */
function parseStagedDiff(diff) {
  const files = new Map(); // path -> { added: string }
  let curPath = null;
  let curAdded = '';
  const flush = () => {
    if (curPath !== null) {
      const prev = files.get(curPath);
      const next = prev ? prev.added + curAdded : curAdded;
      files.set(curPath, { added: next });
    }
    curPath = null;
    curAdded = '';
  };

  const lines = diff.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('diff --git ')) {
      flush();
      // Example: diff --git a/path/to/x b/path/to/x
      const m = line.match(/ b\/(.+)$/);
      curPath = m ? m[1] : null;
      curAdded = '';
      continue;
    }
    if (line.startsWith('+++ ')) {
      // +++ b/path or +++ /dev/null
      const m = line.match(/^\+\+\+ b\/(.+)$/);
      if (m) curPath = m[1];
      continue;
    }
    if (line.startsWith('rename to ') || line.startsWith('copy to ')) {
      const idx = line.indexOf(' to ');
      curPath = line.slice(idx + 4).trim();
      continue;
    }
    if (line.startsWith('+') && !line.startsWith('+++')) {
      curAdded += `${line.slice(1)}\n`;
    }
  }
  flush();
  return files;
}

/**
 * Scan `git diff --cached` for forbidden paths and credential/secret patterns
 * in added lines.
 *
 * @param {{runGitDiff?: () => string}} [deps]
 * @returns {Promise<{ok: boolean, findings: Array<{path: string, pattern: string}>}>}
 */
export async function checkStagedDiffForSecrets({ runGitDiff } = {}) {
  const fn = runGitDiff ?? defaultRunGitDiff;
  const diff = fn();
  const findings = [];

  if (!diff || diff.trim() === '') {
    return { ok: true, findings };
  }

  const files = parseStagedDiff(diff);
  for (const [path, { added }] of files.entries()) {
    for (const rule of UNSAFE_PATH_RULES) {
      if (rule.test(path)) {
        findings.push({ path, pattern: rule.name });
      }
    }
    for (const sp of SECRET_PATTERNS) {
      if (sp.regex.test(added)) {
        findings.push({ path, pattern: sp.name });
      }
    }
  }
  return { ok: findings.length === 0, findings };
}

/**
 * Run as `node bin/robin pre-commit run` from `.git/hooks/pre-commit`.
 *
 * Refuses the commit on any finding by writing one stderr line per finding
 * and exiting 1. Clean diff exits 0.
 */
export async function runPreCommit({
  runGitDiff,
  stderr = (s) => process.stderr.write(`${s}\n`),
  exit = (code) => process.exit(code),
} = {}) {
  const r = await checkStagedDiffForSecrets({ runGitDiff });
  if (r.ok) {
    exit(0);
    return;
  }
  for (const f of r.findings) {
    stderr(`Robin pre-commit: blocked — ${f.pattern} in ${f.path}`);
  }
  exit(1);
}

// Internal helpers exposed for tests.
export const _internals = {
  hookContent,
  preCommitRunScriptPath,
  parseStagedDiff,
  HOOK_MARKER,
};
