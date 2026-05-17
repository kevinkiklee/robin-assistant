#!/usr/bin/env node
// Capture daemon log volume baseline. Two modes:
//   --idle 3m   : passive 3-minute observation
//   --active 3m : same duration, but drive `recall` + `remember` traffic
//
// Reads ${HOME}/<user-data>/runtime/logs/daemon.log via tail -F.
// Writes raw lines + tokenized pattern counts to stdout.

import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import process from 'node:process';

const args = process.argv.slice(2);
const mode = args[0]; // --idle or --active
const duration = args[1] || '3m';
if (!['--idle', '--active'].includes(mode)) {
  console.error('usage: log-baseline.js --idle|--active 3m');
  process.exit(2);
}

const durationMs = parseDuration(duration);

function parseDuration(s) {
  const m = /^(\d+)([smh])$/.exec(s);
  if (!m) throw new Error(`bad duration: ${s}`);
  const mult = { s: 1000, m: 60_000, h: 3_600_000 }[m[2]];
  return Number(m[1]) * mult;
}

function tokenize(line) {
  return line
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z/g, '<TS>')
    .replace(/\b\d+ms\b/g, '<MS>ms')
    .replace(/\b\d{3,}\b/g, '<N>')
    .replace(/[a-z_]+:[A-Za-z0-9_]{4,}/g, '<ID>')
    .trim();
}

async function run() {
  const home = await resolveRobinHome();
  const logPath = resolve(home, 'runtime', 'logs', 'daemon.log');

  const lines = [];
  const startOffset = await fileSize(logPath);

  if (mode === '--active') {
    spawnActiveTraffic(durationMs);
  }

  await sleep(durationMs);

  const endOffset = await fileSize(logPath);
  const fresh = await readRange(logPath, startOffset, endOffset);
  for (const l of fresh.split('\n').filter(Boolean)) lines.push(l);

  const patterns = new Map();
  for (const l of lines) {
    const t = tokenize(l);
    patterns.set(t, (patterns.get(t) ?? 0) + 1);
  }

  const sorted = [...patterns.entries()].sort((a, b) => b[1] - a[1]);
  console.log(`# Log baseline (${mode}, ${duration})`);
  console.log(`# Total lines: ${lines.length}`);
  console.log(`# Unique patterns: ${patterns.size}`);
  console.log(`# Top 10 patterns:`);
  for (const [p, c] of sorted.slice(0, 10)) {
    console.log(`${c.toString().padStart(6)}  ${p}`);
  }
}

async function resolveRobinHome() {
  const { readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const candidates = [
    resolve(process.cwd(), '.robin-home'),
    join(process.env.HOME, 'Library', 'Application Support', 'Robin', 'install.json'),
  ];
  for (const path of candidates) {
    try {
      const txt = await readFile(path, 'utf8');
      const parsed = JSON.parse(txt);
      if (parsed?.home) return parsed.home;
    } catch {}
  }
  throw new Error('cannot resolve robin home from .robin-home or install.json');
}

async function fileSize(path) {
  const { stat } = await import('node:fs/promises');
  return (await stat(path)).size;
}

async function readRange(path, start, end) {
  const { open } = await import('node:fs/promises');
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(end - start);
    await fh.read(buf, 0, end - start, start);
    return buf.toString('utf8');
  } finally {
    await fh.close();
  }
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function spawnActiveTraffic(ms) {
  const trafficScript = resolve(process.cwd(), 'system/scripts/log-baseline-traffic.js');
  const proc = spawn('node', [trafficScript, String(ms)], {
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  proc.unref();
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
