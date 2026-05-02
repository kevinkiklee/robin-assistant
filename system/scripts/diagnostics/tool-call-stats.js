#!/usr/bin/env node
// Per-turn tool-call statistics for Robin.
//
// --baseline: scan transcript JSONL files, compute per-turn rounds + reads, aggregate.
//             Writes JSON to docs/superpowers/specs/baselines/<dated>-tool-call-stats-baseline.json.
// --report  : (added in Task 9) aggregates user-data/runtime/state/turn-stats.log.

import { readFileSync, readdirSync, statSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..', '..');

// Walk one transcript JSONL file. Group records into "turns": each turn ends
// at an assistant message that has only text content (no tool_use blocks).
// Returns [{ rounds, reads }, ...].
export function turnsFromTranscript(jsonl) {
  const lines = jsonl.split('\n').filter(Boolean);
  const turns = [];
  let curRounds = 0;
  let curReads = 0;
  let inTurn = false;

  for (const raw of lines) {
    let obj;
    try { obj = JSON.parse(raw); } catch { continue; }
    const role = obj.role ?? obj.message?.role;
    const content = obj.content ?? obj.message?.content;
    if (role === 'user') {
      // User message starts (or continues) a turn. Tool-result user messages
      // are mid-turn; first user text after final-answer assistant starts new turn.
      if (!inTurn) inTurn = true;
      continue;
    }
    if (role !== 'assistant') continue;

    const blocks = Array.isArray(content) ? content : [];
    const toolUses = blocks.filter((b) => b?.type === 'tool_use');
    if (toolUses.length > 0) {
      curRounds += 1;
      curReads += toolUses.filter((b) => b.name === 'Read').length;
    } else {
      // Text-only assistant message = end of turn.
      if (inTurn) {
        turns.push({ rounds: curRounds, reads: curReads });
        curRounds = 0;
        curReads = 0;
        inTurn = false;
      }
    }
  }
  return turns;
}

export function computeBaselineFromTranscripts(transcriptPaths) {
  const turns = [];
  for (const p of transcriptPaths) {
    let text;
    try { text = readFileSync(p, 'utf8'); } catch { continue; }
    turns.push(...turnsFromTranscript(text));
  }
  const n = turns.length;
  const meanRounds = n ? turns.reduce((s, t) => s + t.rounds, 0) / n : 0;
  const meanReads = n ? turns.reduce((s, t) => s + t.reads, 0) / n : 0;
  const sortedRounds = [...turns].map((t) => t.rounds).sort((a, b) => a - b);
  const medianRounds = n ? sortedRounds[Math.floor(n / 2)] : 0;
  return {
    turns,
    aggregate: {
      turns: n,
      meanRounds,
      medianRounds,
      meanReads,
    },
  };
}

function defaultTranscriptPaths(sinceMs) {
  const slug = REPO_ROOT.replace(/\//g, '-');
  const projectsDir = join(homedir(), '.claude', 'projects', slug);
  if (!existsSync(projectsDir)) return [];
  const out = [];
  function walk(dir) {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) walk(full);
      else if (name.endsWith('.jsonl') && st.mtimeMs >= sinceMs) out.push(full);
    }
  }
  walk(projectsDir);
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const mode = args.find((a) => a === '--baseline' || a === '--report') ?? '--baseline';
  if (mode === '--report') {
    console.error('--report not yet implemented (Task 9)');
    process.exit(2);
  }

  const sinceArgIdx = args.indexOf('--since-days');
  const sinceDays = sinceArgIdx >= 0 ? Number(args[sinceArgIdx + 1]) : 14;
  const sinceMs = Date.now() - sinceDays * 24 * 60 * 60 * 1000;

  const paths = defaultTranscriptPaths(sinceMs);
  const result = computeBaselineFromTranscripts(paths);

  const outDir = join(REPO_ROOT, 'docs/superpowers/specs/baselines');
  mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  const outFile = join(outDir, `${stamp}-tool-call-stats-baseline.json`);
  writeFileSync(outFile, JSON.stringify({
    generated: new Date().toISOString(),
    transcriptCount: paths.length,
    sinceDays,
    ...result,
  }, null, 2));
  console.log(`Baseline written: ${outFile}`);
  console.log(`Turns analyzed: ${result.aggregate.turns}`);
  console.log(`Mean rounds/turn: ${result.aggregate.meanRounds.toFixed(2)}`);
  console.log(`Median rounds/turn: ${result.aggregate.medianRounds}`);
  console.log(`Mean reads/turn: ${result.aggregate.meanReads.toFixed(2)}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
