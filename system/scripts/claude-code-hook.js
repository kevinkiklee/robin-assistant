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

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, statSync, appendFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

import { writeSessionBlock } from './lib/handoff.js';
import { mostRecentSessionId } from './lib/sessions.js';
// applyRedaction(text) -> { redacted: string, count: number }
import { applyRedaction } from './lib/sync/redact.js';
import { readTurnJson, appendWriteIntent, mintTurnId, writeTurnJson, readWriteIntents, pruneWriteIntents, readRetry, incrementRetry } from './lib/turn-state.js';
import { appendPerfLog } from './lib/perf-log.js';
import { classifyTier, scanEntityAliases } from './lib/capture-keyword-scan.js';
import { readEntities, collectEntities, writeEntitiesAtomic } from './lib/entity-index.js';
import { recall, formatRecallHits } from './lib/recall.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');

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

const CORRECTIVE_MSG =
  'Capture before ending the turn. Either (a) write a tagged line to user-data/memory/inbox.md per AGENTS.md capture-rules, or (b) emit "<!-- no-capture-needed: <one-line reason> -->" if nothing in this turn warrants capture. This is enforced; second pass is allowed once.\n';

function captureEnforcementEnabled(ws) {
  if ((process.env.ROBIN_CAPTURE_ENFORCEMENT ?? '').toLowerCase() === 'off') return false;
  try {
    const cfg = JSON.parse(readFileSync(join(ws, 'user-data/robin.config.json'), 'utf8'));
    return cfg?.memory?.capture_enforcement?.enabled !== false;
  } catch {
    return true;
  }
}

function readRetryBudget(ws) {
  try {
    const cfg = JSON.parse(readFileSync(join(ws, 'user-data/robin.config.json'), 'utf8'));
    return cfg?.memory?.capture_enforcement?.retry_budget ?? 1;
  } catch { return 1; }
}

// Scan the most recent assistant text message for a no-capture-needed marker.
// Parses JSONL backward so we only match the CURRENT turn's response, not stale
// markers from prior turns still in the tail window. Skips tool_use/tool_result
// records — only text content counts.
function tailScanForNoCaptureMarker(transcriptPath, maxBytes = 256 * 1024) {
  if (!transcriptPath || !existsSync(transcriptPath)) return null;
  try {
    const fd = readFileSync(transcriptPath);
    const buf = fd.length > maxBytes ? fd.subarray(fd.length - maxBytes) : fd;
    const lines = buf.toString('utf8').split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      let obj;
      try { obj = JSON.parse(lines[i]); } catch { continue; }
      const role = obj.role ?? obj.message?.role;
      if (role !== 'assistant') continue;
      const content = obj.content ?? obj.message?.content;
      let text = '';
      if (typeof content === 'string') text = content;
      else if (Array.isArray(content)) {
        text = content
          .filter((c) => c?.type === 'text' || typeof c?.text === 'string')
          .map((c) => c.text ?? '')
          .join('\n');
      }
      if (!text) continue;
      const m = text.match(/<!--\s*no-capture-needed:\s*([^>]+?)\s*-->/);
      return m ? { reason: m[1].trim() } : null;
    }
    return null;
  } catch {
    return null;
  }
}

function appendEnforcementLog(ws, line) {
  try {
    const file = join(ws, 'user-data/state/capture-enforcement.log');
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, line);
  } catch { /* best-effort */ }
}

async function verifyCapture(ws, event) {
  if (!captureEnforcementEnabled(ws)) return { allow: true, outcome: 'disabled' };

  const turn = readTurnJson(ws);
  if (!turn?.turn_id) return { allow: true, outcome: 'no-turn-state' };

  if (turn.tier === 1) return { allow: true, outcome: 'skipped-trivial', turnId: turn.turn_id, tier: 1 };

  const intents = readWriteIntents(ws, turn.turn_id);
  if (intents.length > 0) return { allow: true, outcome: 'captured', turnId: turn.turn_id, tier: turn.tier };

  const marker = tailScanForNoCaptureMarker(event?.transcript_path);
  const tier = turn.tier;
  // Debug: log scan inputs to help diagnose first-call misses.
  try {
    appendFileSync(join(ws, 'user-data/state/capture-enforcement-debug.log'),
      `${new Date().toISOString()}\t${turn.turn_id}\ttier=${tier}\tpath=${event?.transcript_path ?? 'NONE'}\tmarker=${marker ? 'YES:' + marker.reason.slice(0,50) : 'NO'}\n`);
  } catch { /* */ }
  if (marker) {
    if (tier === 2 || (tier === 3 && marker.reason && marker.reason.length > 0)) {
      return { allow: true, outcome: 'marker-pass', turnId: turn.turn_id, tier };
    }
  }

  const budget = readRetryBudget(ws);
  const attempts = readRetry(ws, turn.turn_id);
  if (attempts < budget) {
    incrementRetry(ws, turn.turn_id);
    return { allow: false, outcome: 'retried', turnId: turn.turn_id, tier };
  }
  return { allow: true, outcome: 'retried-failed', turnId: turn.turn_id, tier };
}

async function onStop(args) {
  const ws = args.workspace ?? process.env.ROBIN_WORKSPACE ?? REPO_ROOT;

  // Read event from stdin (Claude Code passes session_id, transcript_path, ...).
  let event = {};
  try {
    const stdin = await readStdin();
    if (stdin) event = JSON.parse(stdin);
  } catch { /* keep event = {} */ }

  // Capture verification — gate before any other Stop-time work.
  let verifyResult = { allow: true, outcome: 'error' };
  try {
    verifyResult = await verifyCapture(ws, event);
  } catch { /* fail-open */ }

  appendEnforcementLog(ws,
    `${new Date().toISOString()}\t${verifyResult.turnId ?? '-'}\t${verifyResult.tier ?? '-'}\t${verifyResult.outcome}\n`);

  if (!verifyResult.allow) {
    process.stderr.write(CORRECTIVE_MSG);
    process.exit(2);
  }

  // Prune turn-writes.log to last hour.
  try { pruneWriteIntents(ws); } catch { /* */ }

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
  if (!target) {
    process.exit(0);
  }

  // Logs go to the active workspace, which differs from REPO_ROOT under the
  // multi-host test harness and any out-of-tree install. Prefer ROBIN_WORKSPACE.
  const ws = process.env.ROBIN_WORKSPACE || REPO_ROOT;

  // 1. Existing: block writes to host auto-memory paths.
  if (isAutoMemoryPath(target)) {
    process.stderr.write(
      `Local Memory rule (immutable): writes to ${target} are forbidden. Append to user-data/memory/inbox.md with a [tag] line instead.\n`,
    );
    process.exit(2);
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
      const { applyRedaction } = await import('./lib/sync/redact.js');
      const { count } = applyRedaction(content);
      if (count > 0) {
        try {
          const { appendPolicyRefusal } = await import('./lib/policy-refusals-log.js');
          const { fnv1a64 } = await import('./lib/sync/untrusted-index.js');
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
        process.exit(2);
      }
    }

    // 3. Cycle-2c: high-stakes destination audit (allow + log).
    try {
      const { isHighStakesDestination, appendHighStakesWrite } = await import('./lib/high-stakes-log.js');
      const { fnv1a64 } = await import('./lib/sync/untrusted-index.js');
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

  // Cycle-3: write-intent log for capture enforcement.
  if (isMemoryWrite) {
    try {
      const turn = readTurnJson(ws);
      if (turn?.turn_id) {
        appendWriteIntent(ws, {
          turn_id: turn.turn_id,
          target: target.replace(/^.*user-data\/memory\//, 'user-data/memory/'),
          tool: toolName,
        });
      }
    } catch { /* fail-open */ }
  }

  process.exit(0);
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
  const ws = args.workspace ?? process.env.ROBIN_WORKSPACE ?? REPO_ROOT;
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

    // Cycle-3: write-intent log for Bash redirections to user-data/memory/.
    try {
      const memWriteRe = />>?\s*[^\s]*user-data\/memory\//;
      if (memWriteRe.test(cmd)) {
        const turn = readTurnJson(ws);
        if (turn?.turn_id) {
          const m = cmd.match(/(user-data\/memory\/[^\s;|&)]+)/);
          appendWriteIntent(ws, {
            turn_id: turn.turn_id,
            target: m?.[1] ?? 'user-data/memory/',
            tool: 'bash',
          });
        }
      }
    } catch { /* fail-open */ }

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

function appendRecallLog(ws, { turnId, entitiesMatched, hitsInjected, bytesInjected }) {
  try {
    const file = join(ws, 'user-data/state/recall.log');
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${new Date().toISOString()}\t${turnId}\t${entitiesMatched.join(',')}\t${hitsInjected}\t${bytesInjected}\n`);
  } catch { /* best-effort */ }
}

async function onUserPromptSubmit(args) {
  const ws = args.workspace ?? process.env.ROBIN_WORKSPACE ?? REPO_ROOT;
  const start = Date.now();
  try {
    const stdin = await readStdin();
    let event = {};
    try { event = JSON.parse(stdin); } catch { /* fail-open */ }

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

    const tierResult = classifyTier({ userMessage, entityAliases: aliasIndex });

    // Inherit entities from the previous assistant message ("schedule it" pattern).
    const fromAssistant = scanLastAssistantMessage(event.transcript_path, aliasIndex);
    const allEntitiesMatched = [...new Set([...tierResult.entitiesMatched, ...fromAssistant])];

    const turnId = mintTurnId(sessionId);
    writeTurnJson(ws, {
      turn_id: turnId,
      user_words: tierResult.wc,
      tier: tierResult.tier,
      entities_matched: allEntitiesMatched,
    });

    if (allEntitiesMatched.length > 0) {
      const matchedEntities = entityList
        .filter((e) => allEntitiesMatched.includes(e.name) || e.aliases.some((a) => allEntitiesMatched.includes(a)))
        .slice(0, 5);
      const patterns = matchedEntities.flatMap((e) => [e.name, ...e.aliases]);
      const r = recall(ws, patterns, { topN: matchedEntities.length * 3 });
      const formatted = formatRecallHits(r);
      if (formatted) {
        const block = `<!-- relevant memory (auto-loaded based on entities in your message) -->\n${formatted}\n<!-- /relevant memory -->\n`;
        process.stdout.write(block);
        appendRecallLog(ws, {
          turnId,
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
    process.exit(0);
  } catch (err) {
    try { appendPerfLog(ws, { hook: 'UserPromptSubmit', duration_ms: Date.now() - start, reason: `error:${err.message}` }); } catch { /* */ }
    process.exit(0); // fail-open
  }
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.mode === 'on-stop') return onStop(args);
  if (args.mode === 'on-pre-tool-use') return onPreToolUse(args);
  if (args.mode === 'on-pre-bash') return onPreBash(args);
  if (args.mode === 'on-user-prompt-submit') return onUserPromptSubmit(args);
  console.error('Usage: claude-code-hook.js --on-stop | --on-pre-tool-use | --on-pre-bash | --on-user-prompt-submit');
  process.exit(2);
}

main();
