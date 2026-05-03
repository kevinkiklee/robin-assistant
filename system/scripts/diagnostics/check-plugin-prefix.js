#!/usr/bin/env node
// Plugin/skill drift detector.
//
// Parses a Claude Code session JSONL, extracts skills from the
// system-reminder, and flags any whose namespace isn't on the whitelist.
//
// Whitelist source: system/scripts/diagnostics/lib/plugin-whitelist.json
// (or a CLI --whitelist arg for ad-hoc checks).
//
// Exit code: 0 if no drift, 1 if drift detected, 2 on usage error.
//
// Limitations: only works when the session JSONL contains the skills-list
// system-reminder (some sessions don't embed it; in that case the script
// returns skillsSeen=0 and no drift, which is informational, not a clean
// "passed" signal). Use measure-prefix-bloat (--usage-only) for the
// deterministic per-session signal.

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const DEFAULT_WHITELIST_PATH = join(REPO_ROOT, 'system', 'scripts', 'diagnostics', 'lib', 'plugin-whitelist.json');

function* iterRecords(jsonl) {
  for (const raw of jsonl.split('\n')) {
    if (!raw) continue;
    let obj;
    try { obj = JSON.parse(raw); } catch { continue; }
    yield obj;
  }
}

function extractSkillEntries(jsonl) {
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
      const re = /<system-reminder>([\s\S]*?)<\/system-reminder>/g;
      let m;
      while ((m = re.exec(text)) !== null) {
        const r = m[1];
        if (!/skills are available/i.test(r)) continue;
        for (const line of r.split('\n')) {
          const lm = line.match(/^\s*-\s+([\w:.-]+):\s+/);
          if (lm) out.push(lm[1]);
        }
      }
    }
  }
  return out;
}

export function detectPluginDrift(jsonlPath, whitelist) {
  const text = readFileSync(jsonlPath, 'utf8');
  const skills = extractSkillEntries(text);
  const wlSet = new Set(whitelist);
  const unexpected = new Set();
  for (const s of skills) {
    const ns = s.includes(':') ? s.split(':')[0] : s;
    if (!wlSet.has(ns)) unexpected.add(ns);
  }
  return { skillsSeen: skills.length, unexpected: [...unexpected].sort() };
}

async function main() {
  const args = process.argv.slice(2);
  const positional = args.filter((a) => !a.startsWith('--'));
  const path = positional[0];
  if (!path) {
    console.error('Usage: check-plugin-prefix <session.jsonl> [--whitelist path/to/whitelist.json]');
    process.exit(2);
  }
  const wlIdx = args.indexOf('--whitelist');
  const wlPath = wlIdx >= 0 ? args[wlIdx + 1] : DEFAULT_WHITELIST_PATH;
  if (!existsSync(wlPath)) {
    console.error(`Whitelist not found: ${wlPath}`);
    process.exit(2);
  }
  const whitelist = JSON.parse(readFileSync(wlPath, 'utf8')).whitelist;
  const result = detectPluginDrift(path, whitelist);
  console.log(JSON.stringify(result, null, 2));
  if (result.unexpected.length > 0) process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
