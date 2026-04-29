#!/usr/bin/env node
// Claude Code lifecycle hook handler.
//
// Modes:
//   --on-stop          fires after every assistant turn. Drains host
//                      auto-memory back to user-data/memory/inbox.md so
//                      the Local Memory rule holds within seconds, not
//                      hours.
//   --on-pre-tool-use  fires before every tool call. Reads the JSON event
//                      from stdin and rewrites Write/Edit calls targeting
//                      ~/.claude/projects/<workspace>/memory/* to
//                      user-data/memory/inbox.md so the bypass never
//                      reaches disk.
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

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');

function autoMemoryDir() {
  const slug = REPO_ROOT.replace(/\//g, '-');
  return join(homedir(), '.claude', 'projects', slug, 'memory');
}

function isAutoMemoryPath(p) {
  return /\.claude\/projects\/[^/]+\/memory\//.test(p);
}

async function onStop() {
  // Drain auto-memory in the background so the user's next response isn't
  // blocked. Discard output unless --debug.
  const debug = process.argv.includes('--debug');
  const args = [join(REPO_ROOT, 'system', 'scripts', 'migrate-auto-memory.js'), '--apply'];
  if (debug) args.push('--json');

  const child = spawn('node', args, {
    cwd: REPO_ROOT,
    detached: true,
    stdio: debug ? 'inherit' : 'ignore',
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
  const mode = process.argv[2];
  if (mode === '--on-stop') return onStop();
  if (mode === '--on-pre-tool-use') return onPreToolUse();
  console.error('Usage: claude-code-hook.js --on-stop | --on-pre-tool-use');
  process.exit(2);
}

main();
