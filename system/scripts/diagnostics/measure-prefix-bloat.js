#!/usr/bin/env node
// Measure prefix bloat from a Claude Code session JSONL.
//
// Two measurement modes:
//
// 1. usage-based (PRIMARY): aggregates the `usage` field on assistant
//    messages. Each turn's prefix = input_tokens + cache_creation + cache_read.
//    This is the deterministic signal used pre/post a plugin prune.
//
// 2. reminder-based (FALLBACK): parses <system-reminder> blocks for skill
//    bullets and deferred-tool lines. Some sessions DO embed these visibly
//    (skill installs, tool announcements); most don't. Useful when the
//    skill list is observable in the JSONL.
//
// CLI:
//   measure-prefix-bloat <session.jsonl>            # both modes, JSON out
//   measure-prefix-bloat --usage-only <path>        # usage-based only
//   measure-prefix-bloat --reminder-only <path>     # reminder-based only

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { measure } from '../lib/tokenizer.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..', '..');

const SKILLS_HEADER = /skills are available for use with the Skill tool/i;
const DEFERRED_HEADER = /deferred tools are now available/i;

function* iterRecords(jsonl) {
  for (const raw of jsonl.split('\n')) {
    if (!raw) continue;
    let obj;
    try { obj = JSON.parse(raw); } catch { continue; }
    yield obj;
  }
}

// --- usage-based ---

export function measureTokenUsageFromJsonl(path, options = {}) {
  const text = readFileSync(path, 'utf8');
  const turns = [];
  for (const obj of iterRecords(text)) {
    if (obj.type !== 'assistant') continue;
    const usage = obj.message?.usage ?? obj.usage;
    if (!usage) continue;
    const fresh = usage.input_tokens ?? 0;
    const cacheWrite = usage.cache_creation_input_tokens ?? 0;
    const cacheRead = usage.cache_read_input_tokens ?? 0;
    const out = usage.output_tokens ?? 0;
    const eph1h = usage.cache_creation?.ephemeral_1h_input_tokens ?? 0;
    const eph5m = usage.cache_creation?.ephemeral_5m_input_tokens ?? 0;
    turns.push({
      fresh,
      cacheWrite,
      cacheRead,
      output: out,
      ephemeral_1h: eph1h,
      ephemeral_5m: eph5m,
      prefix: fresh + cacheWrite + cacheRead,
    });
    if (options.firstTurnOnly) break;
  }
  const n = turns.length;
  if (n === 0) return { turns: 0, mean: null, sum: null };
  const sum = turns.reduce((acc, t) => ({
    fresh: acc.fresh + t.fresh,
    cacheWrite: acc.cacheWrite + t.cacheWrite,
    cacheRead: acc.cacheRead + t.cacheRead,
    output: acc.output + t.output,
    ephemeral_1h: acc.ephemeral_1h + t.ephemeral_1h,
    ephemeral_5m: acc.ephemeral_5m + t.ephemeral_5m,
    prefix: acc.prefix + t.prefix,
  }), { fresh: 0, cacheWrite: 0, cacheRead: 0, output: 0, ephemeral_1h: 0, ephemeral_5m: 0, prefix: 0 });
  const mean = Object.fromEntries(Object.entries(sum).map(([k, v]) => [k, v / n]));
  return { turns: n, mean, sum };
}

// --- reminder-based ---

function extractSystemReminders(jsonl) {
  const out = [];
  for (const obj of iterRecords(jsonl)) {
    const content = obj.content ?? obj.message?.content;
    let blocks;
    if (Array.isArray(content)) blocks = content;
    else if (typeof content === 'string') blocks = [{ type: 'text', text: content }];
    else continue;
    for (const b of blocks) {
      if (b?.type !== 'text') continue;
      const text = b.text ?? '';
      if (!text.includes('<system-reminder>')) continue;
      const re = /<system-reminder>([\s\S]*?)<\/system-reminder>/g;
      let m;
      while ((m = re.exec(text)) !== null) out.push(m[1]);
    }
  }
  return out;
}

function countSkillBullets(reminder) {
  let count = 0;
  for (const line of reminder.split('\n')) {
    if (/^\s*-\s+[\w:.-]+:\s+/.test(line)) count += 1;
  }
  return count;
}

function countDeferredToolLines(reminder) {
  let inSection = false;
  let count = 0;
  for (const line of reminder.split('\n')) {
    if (DEFERRED_HEADER.test(line)) { inSection = true; continue; }
    if (!inSection) continue;
    const t = line.trim();
    if (/^[A-Za-z][\w_]*$/.test(t)) count += 1;
    else if (/^mcp__[\w_]+__[\w_]+$/.test(t)) count += 1;
  }
  return count;
}

export function measurePrefixBloatFromJsonl(path) {
  const text = readFileSync(path, 'utf8');
  const reminders = extractSystemReminders(text);
  let skillCount = 0;
  let deferredToolCount = 0;
  let totalBytes = 0;
  let totalText = '';
  for (const r of reminders) {
    if (SKILLS_HEADER.test(r)) skillCount += countSkillBullets(r);
    if (DEFERRED_HEADER.test(r)) deferredToolCount += countDeferredToolLines(r);
    totalBytes += Buffer.byteLength(r, 'utf8');
    totalText += r + '\n';
  }
  const m = measure(totalText);
  return {
    reminderCount: reminders.length,
    skillCount,
    deferredToolCount,
    bytes: totalBytes,
    tokens: m.tokens,
    lines: m.lines,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const flags = args.filter((a) => a.startsWith('--'));
  const positional = args.filter((a) => !a.startsWith('--'));
  const path = positional[0];
  if (!path) {
    console.error('Usage: measure-prefix-bloat [--usage-only|--reminder-only] <session.jsonl>');
    console.error('Capture a fresh session JSONL from ~/.claude/projects/<slug>/');
    process.exit(2);
  }
  const usageOnly = flags.includes('--usage-only');
  const reminderOnly = flags.includes('--reminder-only');
  const firstTurnOnly = flags.includes('--first-turn');
  const out = { source: path };
  if (!reminderOnly) out.usage = measureTokenUsageFromJsonl(path, { firstTurnOnly });
  if (!usageOnly) out.reminder = measurePrefixBloatFromJsonl(path);
  console.log(JSON.stringify(out, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
