#!/usr/bin/env node
// Claude Code lifecycle hook handler.
//
// Modes:
//   --on-stop          fires after every assistant turn. Writes a session-handoff
//                      auto-line to session-handoff.md and hot.md, then drains
//                      host auto-memory back to user-data/memory/inbox.md so
//                      the Local Memory rule holds within seconds, not hours.
//   --on-pre-tool-use  fires before every tool call. Reads the JSON event
//                      from stdin and BLOCKS Write/Edit/NotebookEdit calls
//                      targeting ~/.claude/projects/<workspace>/memory/* by
//                      exiting with code 2, so the bypass never reaches disk.
//   --on-pre-bash      cycle-2a: fires before every Bash tool call. Reads the
//                      proposed command from stdin event, scans against
//                      bash-sensitive-patterns.js, blocks (exit 2) on match.
//                      Refusal logged to user-data/state/policy-refusals.log
//                      with kind=bash. Top-level try/catch fail-closed —
//                      uncaught error in the hook also blocks (exit 2).
//
// Exit code 0 = allow the tool call to proceed (after any rewrite).
// Exit code 2 = block the tool call (with a stderr message Claude Code
// surfaces back to the model).
//
// Hooks are registered in .claude/settings.json. They run in this
// workspace's working directory.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

import { writeSessionBlock } from './lib/handoff.js';
import { mostRecentSessionId } from './lib/sessions.js';
// applyRedaction(text) -> { redacted: string, count: number }
import { applyRedaction } from './lib/sync/redact.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');

function parseArgs(argv) {
  const args = { mode: null, workspace: null, drain: true, debug: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--on-stop') args.mode = 'on-stop';
    else if (a === '--on-pre-tool-use') args.mode = 'on-pre-tool-use';
    else if (a === '--on-pre-bash') args.mode = 'on-pre-bash';
    else if (a === '--no-drain') args.drain = false;
    else if (a === '--debug') args.debug = true;
    else if (a === '--workspace') args.workspace = argv[++i];
  }
  return args;
}

function autoMemoryDir() {
  const slug = REPO_ROOT.replace(/\//g, '-');
  return join(homedir(), '.claude', 'projects', slug, 'memory');
}

function isAutoMemoryPath(p) {
  return /\.claude\/projects\/[^/]+\/memory\//.test(p);
}

function readInboxTail(ws, n) {
  const file = join(ws, 'user-data/memory/inbox.md');
  if (!existsSync(file)) return [];
  const text = readFileSync(file, 'utf8');
  const bullets = text.split('\n').filter((l) => /^- \[[a-z?|]+\] /.test(l));
  const tail = bullets.slice(-n);
  return tail.map((l) => applyRedaction(l).redacted);
}

function countInboxBullets(ws) {
  const file = join(ws, 'user-data/memory/inbox.md');
  if (!existsSync(file)) return 0;
  const text = readFileSync(file, 'utf8');
  return text.split('\n').filter((l) => /^- \[/.test(l)).length;
}

function writeAutoLine(ws) {
  const sid = mostRecentSessionId(ws, 'claude-code');
  if (!sid) return;
  const now = new Date().toISOString();
  const inboxTail = readInboxTail(ws, 3);
  const inboxCount = countInboxBullets(ws);
  const body = [
    `ended: ${now} (auto)`,
    `inbox bullets: ${inboxCount}`,
    `last items:`,
    ...inboxTail.map((line) => `  - ${line}`),
  ].join('\n');
  const handoffFile = join(ws, 'user-data/memory/self-improvement/session-handoff.md');
  const hotFile = join(ws, 'user-data/memory/hot.md');
  writeSessionBlock(handoffFile, sid, body);
  writeSessionBlock(hotFile, sid, body, { maxBlocks: 3, position: 'top' });
}

async function onStop(args) {
  const ws = args.workspace ?? REPO_ROOT;

  // Write session-handoff auto-line synchronously. Failure must not block drain.
  try {
    writeAutoLine(ws);
  } catch (err) {
    process.stderr.write(`[claude-code-hook] writeAutoLine failed: ${err.message}\n`);
  }

  if (!args.drain) {
    process.exit(0);
  }

  // Drain auto-memory in the background so the user's next response isn't
  // blocked. Discard output unless --debug.
  //
  // The migrate-auto-memory.js script always lives in the package (REPO_ROOT)
  // — that's where the code is. But the WORKSPACE it targets is `ws`, which
  // may differ from REPO_ROOT when --workspace is passed. Set cwd + the
  // ROBIN_WORKSPACE env var so the drain operates on the right user-data tree.
  const drainArgs = [join(REPO_ROOT, 'system', 'scripts', 'migrate-auto-memory.js'), '--apply'];
  if (args.debug) drainArgs.push('--json');

  // Cycle-2a: spawn with explicit safe env so subprocess never inherits
  // secrets even if some future code path leaks them back into process.env.
  const { safeEnv } = await import('./lib/safe-env.js');
  const child = spawn('node', drainArgs, {
    cwd: ws,
    env: safeEnv({ ROBIN_WORKSPACE: ws }),
    detached: true,
    stdio: args.debug ? 'inherit' : 'ignore',
  });
  child.unref();
  process.exit(0);
}

async function onPreToolUse() {
  // Read the hook event JSON from stdin.
  const stdin = await readStdin();
  let event;
  try {
    event = JSON.parse(stdin);
  } catch {
    // Malformed input — allow the tool to proceed.
    process.exit(0);
  }

  const toolName = event.tool_name ?? event.name;
  if (toolName !== 'Write' && toolName !== 'Edit' && toolName !== 'NotebookEdit') {
    process.exit(0);
  }

  const target = event.tool_input?.file_path ?? event.input?.file_path;
  if (!target || !isAutoMemoryPath(target)) {
    process.exit(0);
  }

  // Block the write with a clear message to the model.
  process.stderr.write(
    `Local Memory rule (immutable): writes to ${target} are forbidden. Append to user-data/memory/inbox.md with a [tag] line instead.\n`,
  );
  process.exit(2);
}

function readStdin() {
  return new Promise((resolveStdin) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (buf += chunk));
    process.stdin.on('end', () => resolveStdin(buf));
    // Safety: if no stdin within 100ms, return empty.
    setTimeout(() => resolveStdin(buf), 100);
  });
}

async function onPreBash(args) {
  const ws = args.workspace ?? REPO_ROOT;
  // Top-level try/catch fail-closed: any uncaught error in the hook
  // blocks rather than silently letting the command through.
  try {
    const stdin = await readStdin();
    let event;
    try {
      event = stdin ? JSON.parse(stdin) : {};
    } catch {
      // Malformed input: fail-closed.
      throw new Error('hook event JSON is malformed');
    }

    const cmd = event.tool_input?.command ?? event.input?.command ?? '';
    if (!cmd) {
      // No command to inspect — let it through.
      process.exit(0);
    }

    const { checkBashCommand } = await import('./lib/bash-sensitive-patterns.js');
    const result = checkBashCommand(cmd);

    if (result.blocked) {
      try {
        const { appendPolicyRefusal } = await import('./lib/policy-refusals-log.js');
        const { fnv1a64 } = await import('./lib/sync/untrusted-index.js');
        appendPolicyRefusal(ws, {
          kind: 'bash',
          target: 'local-bash',
          layer: result.name,
          reason: result.why,
          contentHash: fnv1a64(cmd),
        });
      } catch { /* logging best-effort */ }
      process.stderr.write(`POLICY_REFUSED [bash:${result.name}]: ${result.why}\n`);
      process.exit(2);
    }

    process.exit(0);
  } catch (err) {
    // Fail-closed.
    try {
      const { appendPolicyRefusal } = await import('./lib/policy-refusals-log.js');
      appendPolicyRefusal(ws, {
        kind: 'bash',
        target: 'local-bash',
        layer: 'hook-internal-error',
        reason: `HOOK_INTERNAL_ERROR: ${err?.message || String(err)}`,
        contentHash: '',
      });
    } catch { /* nested logging failure ignored */ }
    process.stderr.write(`POLICY_REFUSED [bash:hook-internal-error]: ${err?.message || String(err)}\n`);
    process.exit(2);
  }
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.mode === 'on-stop') return onStop(args);
  if (args.mode === 'on-pre-tool-use') return onPreToolUse(args);
  if (args.mode === 'on-pre-bash') return onPreBash(args);
  console.error('Usage: claude-code-hook.js --on-stop | --on-pre-tool-use | --on-pre-bash');
  process.exit(2);
}

main();
