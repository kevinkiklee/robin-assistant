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
  const drainArgs = [join(REPO_ROOT, 'system', 'scripts', 'migrate-auto-memory.js'), '--apply'];
  if (args.debug) drainArgs.push('--json');

  const child = spawn('node', drainArgs, {
    cwd: REPO_ROOT,
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

async function main() {
  const args = parseArgs(process.argv);
  if (args.mode === 'on-stop') return onStop(args);
  if (args.mode === 'on-pre-tool-use') return onPreToolUse(args);
  console.error('Usage: claude-code-hook.js --on-stop | --on-pre-tool-use');
  process.exit(2);
}

main();
