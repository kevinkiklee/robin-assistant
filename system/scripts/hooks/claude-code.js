#!/usr/bin/env node
// Claude Code lifecycle hook handler.
//
// Modes:
//   --on-stop          fires after every assistant turn. Writes a session-handoff
//                      auto-line to session-handoff.md and hot.md, then drains
//                      host auto-memory back to user-data/memory/streams/inbox.md so
//                      the Local Memory rule holds within seconds, not hours.
//   --on-pre-tool-use  fires before every tool call. Reads the JSON event
//                      from stdin and BLOCKS Write/Edit/NotebookEdit calls
//                      targeting ~/.claude/projects/<workspace>/memory/* by
//                      exiting with code 2, so the bypass never reaches disk.
//   --on-pre-bash      cycle-2a: fires before every Bash tool call. Reads the
//                      proposed command from stdin event, scans against
//                      bash-sensitive-patterns.js, blocks (exit 2) on match.
//                      Refusal logged to user-data/runtime/state/telemetry/policy-refusals.log
//                      with kind=bash. Top-level try/catch fail-closed —
//                      uncaught error in the hook also blocks (exit 2).
//
// Exit code 0 = allow the tool call to proceed (after any rewrite).
// Exit code 2 = block the tool call (with a stderr message Claude Code
// surfaces back to the model).
//
// Hooks are registered in .claude/settings.json. They run in this
// workspace's working directory.

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, statSync, appendFileSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

import { writeSessionBlock } from '../capture/lib/handoff.js';
import { mostRecentSessionId } from '../lib/sessions.js';
// applyRedaction(text) -> { redacted: string, count: number }
import { applyRedaction } from '../sync/lib/redact.js';
import { appendPerfLog } from '../diagnostics/lib/perf-log.js';
import { scanEntityAliases } from '../capture/lib/capture-keyword-scan.js';
import { readEntities, collectEntities, writeEntitiesAtomic } from '../memory/lib/entity-index.js';
import { recall, formatRecallHits } from '../memory/lib/recall.js';
import { ExitSignal } from '../lib/exit-signal.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..', '..');

const RECALL_HIT_CAP = 3;

function parseArgs(argv) {
  const args = { mode: null, workspace: null, drain: true, debug: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--on-stop') args.mode = 'on-stop';
    else if (a === '--on-pre-tool-use') args.mode = 'on-pre-tool-use';
    else if (a === '--on-pre-bash') args.mode = 'on-pre-bash';
    else if (a === '--on-user-prompt-submit') args.mode = 'on-user-prompt-submit';
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

// Recursively scans a tool_input object for any string value that begins
// with one of the misrouted prefixes. Returns { path, bad, good, label } on
// first match, or null. Bounded by tool_input shape — these are small.
function findMisroutedPath(input, reroutes, depth = 0) {
  if (depth > 6) return null;
  if (typeof input === 'string') {
    for (const r of reroutes) {
      if (input.startsWith(r.bad)) return { path: input, ...r };
    }
    return null;
  }
  if (Array.isArray(input)) {
    for (const v of input) {
      const r = findMisroutedPath(v, reroutes, depth + 1);
      if (r) return r;
    }
    return null;
  }
  if (input && typeof input === 'object') {
    for (const v of Object.values(input)) {
      const r = findMisroutedPath(v, reroutes, depth + 1);
      if (r) return r;
    }
  }
  return null;
}

function readInboxTail(ws, n) {
  const file = join(ws, 'user-data/memory/streams/inbox.md');
  if (!existsSync(file)) return [];
  const text = readFileSync(file, 'utf8');
  const bullets = text.split('\n').filter((l) => /^- \[[a-z?|]+\] /.test(l));
  const tail = bullets.slice(-n);
  return tail.map((l) => applyRedaction(l).redacted);
}

function countInboxBullets(ws) {
  const file = join(ws, 'user-data/memory/streams/inbox.md');
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

// Reads the last 32KB of the transcript JSONL and counts rounds + Read calls
// in the most recent assistant turn (the one ending at the final-text message).
// Trend monitoring only — very long turns may push earlier rounds out of the
// 32KB window and undercount. Acceptable for the latency-proxy use case.
function lastAssistantTurnFromTranscript(transcriptPath) {
  if (!transcriptPath || !existsSync(transcriptPath)) return null;
  const buf = readFileSync(transcriptPath);
  const tail = buf.length > 32 * 1024 ? buf.subarray(buf.length - 32 * 1024) : buf;
  const lines = tail.toString('utf8').split('\n').filter(Boolean);
  // Walk records and find the most recent contiguous assistant turn.
  // A turn ends at a final-text assistant message (no tool_use).
  const records = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    try { records.unshift(JSON.parse(lines[i])); } catch { /* skip */ }
  }
  let rounds = 0;
  let reads = 0;
  let finalOutputTokens = 0;
  let foundFinal = false;
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i];
    const role = r.role ?? r.message?.role;
    if (role !== 'assistant') continue;
    const content = r.content ?? r.message?.content;
    const blocks = Array.isArray(content) ? content : [];
    const toolUses = blocks.filter((b) => b?.type === 'tool_use');
    if (!foundFinal && toolUses.length === 0) {
      foundFinal = true;
      // Capture output_tokens from the final-text message's usage.
      const usage = r.message?.usage ?? r.usage;
      finalOutputTokens = usage?.output_tokens ?? 0;
      continue;
    }
    if (foundFinal && toolUses.length === 0) break; // previous turn's final
    if (foundFinal) {
      rounds += 1;
      reads += toolUses.filter((b) => b.name === 'Read').length;
    }
  }
  return foundFinal ? { rounds, reads, finalOutputTokens } : null;
}

const VERBOSE_OUTPUT_THRESHOLD = 800;

// Spec §3.5: log when the final-text reply exceeds a soft token threshold
// AND the turn had no tool_use rounds (pure narrative). Trend visibility,
// not enforcement.
function appendVerboseOutputLog(ws, event, turn) {
  if (!turn) return;
  if (turn.rounds > 0) return; // tool-use turns can legitimately be long
  if (turn.finalOutputTokens <= VERBOSE_OUTPUT_THRESHOLD) return;
  const file = join(ws, 'user-data/runtime/state/telemetry/verbose-output.log');
  mkdirSync(dirname(file), { recursive: true });
  const line = [
    new Date().toISOString(),
    event.session_id ?? 'unknown',
    turn.finalOutputTokens,
  ].join('\t');
  appendFileSync(file, line + '\n');
}

function recallFiredInTranscript(transcriptPath) {
  if (!transcriptPath || !existsSync(transcriptPath)) return false;
  const buf = readFileSync(transcriptPath);
  const tail = buf.length > 32 * 1024 ? buf.subarray(buf.length - 32 * 1024) : buf;
  return /<!-- relevant memory:/.test(tail.toString('utf8'));
}

function memoryReadAfterRecall(transcriptPath) {
  if (!transcriptPath || !existsSync(transcriptPath)) return false;
  const buf = readFileSync(transcriptPath);
  const tail = buf.length > 32 * 1024 ? buf.subarray(buf.length - 32 * 1024) : buf;
  const text = tail.toString('utf8');
  if (!/<!-- relevant memory:/.test(text)) return false;
  // Coarse signal: any Read of a path under user-data/memory/ in the tail.
  return /"name"\s*:\s*"Read"[\s\S]*?"file_path"\s*:\s*"[^"]*user-data\/memory\//.test(text);
}

function appendTurnStats(ws, event) {
  const turn = lastAssistantTurnFromTranscript(event.transcript_path);
  if (!turn) return; // no completed turn to log
  const fired = recallFiredInTranscript(event.transcript_path);
  const reread = fired ? memoryReadAfterRecall(event.transcript_path) : false;
  const file = join(ws, 'user-data/runtime/state/turn-stats.log');
  mkdirSync(dirname(file), { recursive: true });
  const line = [
    new Date().toISOString(),
    event.session_id ?? 'unknown',
    turn.rounds,
    turn.reads,
    fired ? '1' : '0',
    reread ? '1' : '0',
  ].join('\t');
  appendFileSync(file, line + '\n');
}

async function onStop(args, stdinData) {
  const ws = args.workspace ?? process.env.ROBIN_WORKSPACE ?? REPO_ROOT;

  // Use pre-parsed stdin if provided (in-process); otherwise read from process.stdin.
  let event = {};
  try {
    if (stdinData !== undefined && stdinData !== null) {
      event = typeof stdinData === 'object' ? stdinData : (stdinData ? JSON.parse(stdinData) : {});
    } else {
      const stdin = await readStdin();
      event = stdin ? JSON.parse(stdin) : {};
    }
  } catch { /* fail-open */ }

  // Write session-handoff auto-line synchronously. Failure must not block drain.
  try {
    writeAutoLine(ws);
  } catch (err) {
    process.stderr.write(`[claude-code-hook] writeAutoLine failed: ${err.message}\n`);
  }

  // Per-turn telemetry (best-effort; never blocks the rest of the hook).
  try {
    appendTurnStats(ws, event);
  } catch (err) {
    process.stderr.write(`[claude-code-hook] appendTurnStats failed: ${err.message}\n`);
  }

  // Spec §3.5 — verbose output trend log. Best-effort; non-fatal.
  try {
    const turn = lastAssistantTurnFromTranscript(event.transcript_path);
    appendVerboseOutputLog(ws, event, turn);
  } catch (err) {
    process.stderr.write(`[claude-code-hook] appendVerboseOutputLog failed: ${err.message}\n`);
  }

  if (!args.drain) {
    return { exitCode: 0 };
  }

  // Drain auto-memory in the background so the user's next response isn't
  // blocked. Discard output unless --debug.
  //
  // The auto-memory.js script always lives in the package (REPO_ROOT)
  // — that's where the code is. But the WORKSPACE it targets is `ws`, which
  // may differ from REPO_ROOT when --workspace is passed. Set cwd + the
  // ROBIN_WORKSPACE env var so the drain operates on the right user-data tree.
  const drainArgs = [join(REPO_ROOT, 'system', 'scripts', 'capture', 'auto-memory.js'), '--apply'];
  if (args.debug) drainArgs.push('--json');

  // Cycle-2a: spawn with explicit safe env so subprocess never inherits
  // secrets even if some future code path leaks them back into process.env.
  const { safeEnv } = await import('../lib/safe-env.js');
  const child = spawn('node', drainArgs, {
    cwd: ws,
    env: safeEnv({ ROBIN_WORKSPACE: ws }),
    detached: true,
    stdio: args.debug ? 'inherit' : 'ignore',
  });
  child.unref();
  return { exitCode: 0 };
}

async function onPreToolUse(stdinData) {
  // Use pre-parsed stdin if provided (in-process); otherwise read from process.stdin.
  let event;
  try {
    if (stdinData !== undefined && stdinData !== null) {
      event = typeof stdinData === 'object' ? stdinData : JSON.parse(stdinData);
    } else {
      const stdin = await readStdin();
      event = JSON.parse(stdin);
    }
  } catch {
    // Malformed input — allow the tool to proceed.
    return { exitCode: 0 };
  }

  const toolName = event.tool_name ?? event.name;
  const toolInput = event.tool_input ?? event.input ?? {};

  // Logs go to the active workspace, which differs from REPO_ROOT under the
  // multi-host test harness and any out-of-tree install. Prefer ROBIN_WORKSPACE.
  const ws = process.env.ROBIN_WORKSPACE || REPO_ROOT;
  const wsClean = ws.replace(/\/+$/, '');

  // Misrouted-path guard (applies to ALL tools — Write/Edit/NotebookEdit AND
  // any MCP tool that takes a path argument, e.g. image-generation save paths).
  // Bare `<workspace>/artifacts/` and `<workspace>/backup/` are wrong; canonical
  // locations are under user-data/. Recurses through tool_input to catch any
  // string field whose value looks like a misrouted absolute path.
  const REROUTES = [
    { bad: `${wsClean}/artifacts/`, good: `${wsClean}/user-data/artifacts/`, label: 'artifacts' },
    { bad: `${wsClean}/backup/`,    good: `${wsClean}/user-data/backup/`,    label: 'backup' },
  ];
  const offending = findMisroutedPath(toolInput, REROUTES);
  if (offending) {
    const suggested = offending.good + offending.path.slice(offending.bad.length);
    process.stderr.write(
      `WRITE_REFUSED [${offending.label}]: ${toolName} would write to ${offending.path} ` +
      `(bare ${offending.label}/ at workspace root is misrouted). ` +
      `Canonical path is user-data/${offending.label}/. Retry with: ${suggested}\n`,
    );
    return { exitCode: 2 };
  }

  // Remaining checks only apply to file-content tools.
  if (toolName !== 'Write' && toolName !== 'Edit' && toolName !== 'NotebookEdit') {
    return { exitCode: 0 };
  }

  const target = toolInput.file_path;
  if (!target) {
    return { exitCode: 0 };
  }

  // 1. Existing: block writes to host auto-memory paths.
  if (isAutoMemoryPath(target)) {
    process.stderr.write(
      `Local Memory rule (immutable): writes to ${target} are forbidden. Append to user-data/memory/streams/inbox.md with a [tag] line instead.\n`,
    );
    return { exitCode: 2 };
  }

  // 2. Cycle-2c: PII backstop for writes to user-data/memory/.
  //    Lazy-import redact.js + log helpers to keep non-memory-path hooks fast.
  const memoryPrefix = '/user-data/memory/';
  const isMemoryWrite = target.includes(memoryPrefix);
  if (isMemoryWrite) {
    const content =
      event.tool_input?.content ??
      event.tool_input?.new_string ??
      '';
    if (typeof content === 'string' && content.length > 0) {
      const { applyRedaction } = await import('../sync/lib/redact.js');
      const { count } = applyRedaction(content);
      if (count > 0) {
        try {
          const { appendPolicyRefusal } = await import('../lib/policy-refusals-log.js');
          const { fnv1a64 } = await import('../sync/lib/untrusted-index.js');
          appendPolicyRefusal(ws, {
            kind: 'pii-bypass',
            target,
            layer: 'write-hook',
            reason: `${count} PII pattern(s) detected in proposed write`,
            contentHash: fnv1a64(content),
          });
        } catch { /* logging best-effort */ }
        process.stderr.write(
          `WRITE_REFUSED [pii]: ${count} PII pattern(s) detected in write to ${target}. ` +
          `Redact (e.g., replace SSN with [REDACTED:ssn]) before retrying.\n`
        );
        return { exitCode: 2 };
      }
    }

    // 3. Cycle-2c: high-stakes destination audit (allow + log).
    try {
      const { isHighStakesDestination, appendHighStakesWrite } = await import('../lib/high-stakes-log.js');
      const { fnv1a64 } = await import('../sync/lib/untrusted-index.js');
      if (isHighStakesDestination(target)) {
        const relPath = target.split('user-data/memory/')[1]
          ? 'user-data/memory/' + target.split('user-data/memory/')[1]
          : target;
        appendHighStakesWrite(ws, {
          target: relPath,
          contentHash: fnv1a64(content || ''),
        });
      }
    } catch { /* audit best-effort */ }
  }

  return { exitCode: 0 };
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

async function onPreBash(args, stdinData) {
  const ws = args.workspace ?? process.env.ROBIN_WORKSPACE ?? REPO_ROOT;
  // Top-level try/catch fail-closed: any uncaught error in the hook
  // blocks rather than silently letting the command through.
  try {
    let event;
    try {
      if (stdinData !== undefined && stdinData !== null) {
        event = typeof stdinData === 'object' ? stdinData : (stdinData ? JSON.parse(stdinData) : {});
      } else {
        const stdin = await readStdin();
        event = stdin ? JSON.parse(stdin) : {};
      }
    } catch {
      // Malformed input: fail-closed.
      throw new Error('hook event JSON is malformed');
    }

    const cmd = event.tool_input?.command ?? event.input?.command ?? '';
    if (!cmd) {
      // No command to inspect — let it through.
      return { exitCode: 0 };
    }

    const { checkBashCommand } = await import('../lib/bash-sensitive-patterns.js');
    const result = checkBashCommand(cmd);

    if (result.blocked) {
      try {
        const { appendPolicyRefusal } = await import('../lib/policy-refusals-log.js');
        const { fnv1a64 } = await import('../sync/lib/untrusted-index.js');
        appendPolicyRefusal(ws, {
          kind: 'bash',
          target: 'local-bash',
          layer: result.name,
          reason: result.why,
          contentHash: fnv1a64(cmd),
        });
      } catch { /* logging best-effort */ }
      process.stderr.write(`POLICY_REFUSED [bash:${result.name}]: ${result.why}\n`);
      return { exitCode: 2 };
    }

    return { exitCode: 0 };
  } catch (err) {
    // Fail-closed.
    try {
      const { appendPolicyRefusal } = await import('../lib/policy-refusals-log.js');
      appendPolicyRefusal(ws, {
        kind: 'bash',
        target: 'local-bash',
        layer: 'hook-internal-error',
        reason: `HOOK_INTERNAL_ERROR: ${err?.message || String(err)}`,
        contentHash: '',
      });
    } catch { /* nested logging failure ignored */ }
    process.stderr.write(`POLICY_REFUSED [bash:hook-internal-error]: ${err?.message || String(err)}\n`);
    return { exitCode: 2 };
  }
}

// Scan the most recent COMPLETE assistant message in a Claude Code transcript (.jsonl)
// for entity-alias hits. Tail-bounded read; fail-open on any I/O issue.
function scanLastAssistantMessage(transcriptPath, aliasIndex) {
  if (!transcriptPath || !existsSync(transcriptPath)) return [];
  try {
    const buf = readFileSync(transcriptPath);
    const tail = buf.length > 32 * 1024 ? buf.subarray(buf.length - 32 * 1024) : buf;
    const lines = tail.toString('utf8').split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const obj = JSON.parse(lines[i]);
        const role = obj.role ?? obj.message?.role;
        if (role !== 'assistant') continue;
        const content = typeof obj.content === 'string'
          ? obj.content
          : (Array.isArray(obj.content) ? obj.content.map((c) => c.text ?? '').join(' ') : (obj.message?.content ?? ''));
        if (!content) continue;
        return scanEntityAliases(String(content), aliasIndex);
      } catch { /* skip malformed jsonl line */ }
    }
  } catch { /* fail-open */ }
  return [];
}

// If any entity-bearing topic file is newer than ENTITIES.md, regenerate it inline.
// Cheap when nothing changed; bounded by entity-tree size.
function maybeRefreshEntitiesIndex(ws) {
  const entitiesFile = join(ws, 'user-data/memory/ENTITIES.md');
  if (!existsSync(entitiesFile)) return false;
  let entitiesMtime;
  try { entitiesMtime = statSync(entitiesFile).mtimeMs; } catch { return false; }
  // Cheap check: walk the memory tree and see if any md is newer than ENTITIES.md.
  const memDir = join(ws, 'user-data/memory');
  let staleFound = false;
  function walk(dir) {
    if (staleFound || !existsSync(dir)) return;
    let names;
    try { names = readdirSync(dir); } catch { return; }
    for (const name of names) {
      if (staleFound) return;
      if (name.startsWith('.') || name === 'ENTITIES.md' || name === 'ENTITIES-extended.md') continue;
      const full = join(dir, name);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) walk(full);
      else if (name.endsWith('.md') && st.mtimeMs > entitiesMtime) staleFound = true;
    }
  }
  walk(memDir);
  if (!staleFound) return false;
  try {
    const entities = collectEntities(ws);
    // Don't clobber a populated ENTITIES.md with an empty regen — that's a sign the
    // entity tree has no `type: entity` frontmatter (test fixtures, partial setups, etc.).
    if (entities.length === 0) return false;
    writeEntitiesAtomic(ws, entities);
    return true;
  } catch { return false; }
}

function appendRecallLog(ws, { sessionId, entitiesMatched, hitsInjected, bytesInjected }) {
  try {
    const file = join(ws, 'user-data/runtime/state/recall.log');
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${new Date().toISOString()}\t${sessionId}\t${entitiesMatched.join(',')}\t${hitsInjected}\t${bytesInjected}\n`);
  } catch { /* best-effort */ }
}

function scanEntitiesInMessage(text, aliases) {
  if (!text || !aliases.length) return [];
  return scanEntityAliases(String(text), aliases);
}

async function onUserPromptSubmit(args, stdinData) {
  const ws = args.workspace ?? process.env.ROBIN_WORKSPACE ?? REPO_ROOT;
  const start = Date.now();
  try {
    let event = {};
    try {
      if (stdinData !== undefined && stdinData !== null) {
        event = typeof stdinData === 'object' ? stdinData : (stdinData ? JSON.parse(stdinData) : {});
      } else {
        const stdin = await readStdin();
        event = stdin ? JSON.parse(stdin) : {};
      }
    } catch { /* fail-open */ }

    const sessionId = event.session_id ?? mostRecentSessionId(ws, 'claude-code') ?? 'unknown';
    const userMessage = event.user_message ?? event.prompt ?? '';

    // Refresh ENTITIES.md if any entity file has been touched since last regen.
    maybeRefreshEntitiesIndex(ws);

    const { entities: entityList } = readEntities(ws);
    const aliasIndex = [];
    for (const e of entityList) {
      aliasIndex.push(e.name);
      for (const a of e.aliases) aliasIndex.push(a);
    }

    // Inherit entities from the previous assistant message ("schedule it" pattern).
    const fromUser = scanEntitiesInMessage(userMessage, aliasIndex);
    const fromAssistant = scanLastAssistantMessage(event.transcript_path, aliasIndex);
    const allEntitiesMatched = [...new Set([...fromUser, ...fromAssistant])];

    if (allEntitiesMatched.length > 0) {
      const matchedEntities = entityList
        .filter((e) => allEntitiesMatched.includes(e.name) || e.aliases.some((a) => allEntitiesMatched.includes(a)))
        .slice(0, 5);
      const patterns = matchedEntities.flatMap((e) => [e.name, ...e.aliases]);
      const r = recall(ws, patterns, { topN: RECALL_HIT_CAP });
      const formatted = formatRecallHits(r);
      if (formatted) {
        // strip "-->" so entity names can't break out of the HTML comment
        const matchedNames = matchedEntities.map((e) => e.name.replace(/-->/g, '->')).join(', ');
        const block = `<!-- relevant memory: ${r.hits.length} hits for ${matchedNames} -->\n${formatted}\n<!-- /relevant memory -->\n`;
        process.stdout.write(block);
        appendRecallLog(ws, {
          sessionId,
          entitiesMatched: allEntitiesMatched,
          hitsInjected: r.hits.length,
          bytesInjected: block.length,
        });
      }
    }

    const elapsed = Date.now() - start;
    if (elapsed > 80) {
      appendPerfLog(ws, { hook: 'UserPromptSubmit', duration_ms: elapsed, reason: 'slow' });
    }
    return { exitCode: 0 };
  } catch (err) {
    try { appendPerfLog(ws, { hook: 'UserPromptSubmit', duration_ms: Date.now() - start, reason: `error:${err.message}` }); } catch { /* */ }
    return { exitCode: 0 }; // fail-open
  }
}

// ---------------------------------------------------------------------------
// Public API: callable in-process by the e2e test harness.
// ---------------------------------------------------------------------------

/**
 * Run the hook logic for the given mode without calling process.exit.
 *
 * @param {string} mode - 'on-stop' | 'on-pre-tool-use' | 'on-pre-bash' | 'on-user-prompt-submit'
 * @param {object} [opts]
 * @param {object|null} [opts.stdin] - Pre-parsed JSON event (harness passes object; subprocess reads from process.stdin)
 * @param {object} [opts.env] - Environment (currently unused; process.env is used directly by helpers)
 * @param {string} [opts.workspace] - Workspace directory (equivalent to --workspace flag)
 * @param {boolean} [opts.debug] - Enable debug output
 * @returns {Promise<{exitCode: number}>}
 */
export async function runHook(mode, { stdin = null, env = process.env, workspace, debug = false } = {}) {
  try {
    const args = { mode, workspace: workspace ?? null, drain: true, debug };

    if (mode === 'on-stop') return await onStop(args, stdin);
    if (mode === 'on-pre-tool-use') return await onPreToolUse(stdin);
    if (mode === 'on-pre-bash') return await onPreBash(args, stdin);
    if (mode === 'on-user-prompt-submit') return await onUserPromptSubmit(args, stdin);

    process.stderr.write('Usage: claude-code.js --on-stop | --on-pre-tool-use | --on-pre-bash | --on-user-prompt-submit\n');
    return { exitCode: 2 };
  } catch (e) {
    if (e instanceof ExitSignal) return { exitCode: e.code };
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Shell guard — subprocess invocation only.
// ---------------------------------------------------------------------------

async function readStdinSubprocess() {
  if (process.stdin.isTTY) return '';
  let data = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

const isMain = process.argv[1]
  && (() => {
    try {
      return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
    } catch {
      return false;
    }
  })();

if (isMain) {
  const args = parseArgs(process.argv);
  const stdinRaw = await readStdinSubprocess();
  let parsed = null;
  try { parsed = stdinRaw ? JSON.parse(stdinRaw) : null; } catch { parsed = null; }
  runHook(args.mode, { stdin: parsed, workspace: args.workspace, debug: args.debug })
    .then(({ exitCode }) => process.exit(exitCode))
    .catch((err) => {
      process.stderr.write(`hook error: ${err.stack || err.message}\n`);
      process.exit(2); // fail-closed
    });
}
