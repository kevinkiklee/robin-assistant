#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { homedir, userInfo } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROBIN_ROOT = resolve(__dirname, '../../../');
const STATE_DIR = resolve(ROBIN_ROOT, 'user-data/ops/state/services');
const LOG_DIR = STATE_DIR;
const EVENTS_PATH = resolve(LOG_DIR, 'discord-bot.events.jsonl');
const SESSIONS_PATH = resolve(STATE_DIR, 'discord-sessions.json');
const STATUS_PATH = resolve(STATE_DIR, 'discord-bot.status.json');
const REPORT_PATH = resolve(LOG_DIR, 'discord-bot-health.md');

const LABEL = 'com.robin.discord-bot-health';
const PLIST_PATH = resolve(homedir(), 'Library/LaunchAgents', `${LABEL}.plist`);
const SCRIPT_PATH = resolve(__dirname, 'discord-bot-health.js');

const PERIOD_DAYS = 7;
const PERIOD_MS = PERIOD_DAYS * 24 * 3600 * 1000;

async function readJsonl(path) {
  try {
    const raw = await readFile(path, 'utf-8');
    return raw.trim().split('\n').filter(Boolean).map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

async function readJson(path) {
  try { return JSON.parse(await readFile(path, 'utf-8')); }
  catch { return null; }
}

function fmtTs(ts) { return ts ? ts.replace('T', ' ').slice(0, 19) + 'Z' : '—'; }

export function analyzeEvents(events, { now = Date.now(), periodMs = PERIOD_MS } = {}) {
  const cutoff = now - periodMs;
  const recent = events.filter(e => e?.ts && new Date(e.ts).getTime() >= cutoff);
  const totals = { runs: 0, ok: 0, error: 0, channelGone: 0, helpNewCancel: 0 };
  const errorTypeCounts = {};
  const errorSamples = [];
  let cost = 0;
  let lastError = null;

  for (const e of recent) {
    if (e.event === 'run' && e.status === 'ok') { totals.runs++; totals.ok++; }
    if (e.event === 'run' && e.status === 'error') {
      totals.runs++; totals.error++;
      const code = e.error?.match(/code['"]?\s*[:=]\s*['"]?([A-Z_]+)/)?.[1] || 'UNKNOWN';
      errorTypeCounts[code] = (errorTypeCounts[code] || 0) + 1;
      lastError = e;
      if (errorSamples.length < 3) errorSamples.push(e);
    }
    if (e.event === 'reply' && e.status === 'channel_gone') totals.channelGone++;
    if (['help', 'new', 'cancel'].includes(e.event)) totals.helpNewCancel++;
    if (typeof e.totalCostUsd === 'number' && Number.isFinite(e.totalCostUsd)) cost += e.totalCostUsd;
  }

  const errorRate = totals.runs ? totals.error / totals.runs : 0;
  let verdict;
  if (totals.runs === 0) verdict = 'IDLE — no runs in the last week';
  else if (totals.error === 0) verdict = 'GREEN — no errors';
  else if (errorRate < 0.1) verdict = 'YELLOW — occasional errors';
  else verdict = 'RED — frequent errors, investigate';

  return { totals, errorTypeCounts, errorSamples, cost, errorRate, verdict, lastError };
}

export function formatReport(analysis, { sessionCount = 0, status = null, now = new Date() } = {}) {
  const { totals, errorTypeCounts, errorSamples, cost, errorRate, verdict, lastError } = analysis;
  const lines = [];
  lines.push(`# Discord Bot Health — last ${PERIOD_DAYS} days`);
  lines.push('');
  lines.push(`Generated: ${now.toISOString()}`);
  lines.push(`Verdict:   **${verdict}**`);
  lines.push('');
  lines.push(`## Summary`);
  lines.push('');
  lines.push(`- Runs: **${totals.runs}** (ok: ${totals.ok}, error: ${totals.error})`);
  lines.push(`- Error rate: ${(errorRate * 100).toFixed(1)}%`);
  lines.push(`- /help, /new, /cancel events: ${totals.helpNewCancel}`);
  lines.push(`- Channel-gone events: ${totals.channelGone}`);
  lines.push(`- 7-day cost: $${cost.toFixed(4)}`);
  lines.push(`- Active sessions right now: ${sessionCount}`);
  lines.push(`- Bot last self-state: ${status ? `${status.state} @ ${fmtTs(status.ts)}` : 'unknown (no status file)'}`);
  lines.push('');

  if (totals.error > 0) {
    lines.push(`## Error breakdown`);
    lines.push('');
    for (const [code, count] of Object.entries(errorTypeCounts).sort((a, b) => b[1] - a[1])) {
      lines.push(`- ${code}: ${count}`);
    }
    lines.push('');
    lines.push(`Last error: \`${fmtTs(lastError.ts)}\` key=${lastError.conversationKey || '—'}`);
    lines.push('');
    if (errorSamples.length) {
      lines.push(`## Sample error tails (oldest first, max 3)`);
      lines.push('');
      for (const e of errorSamples) {
        const tail = (e.error || '').replaceAll('```', '` ` `').slice(-400);
        lines.push(`### ${fmtTs(e.ts)} key=${e.conversationKey || '—'}`);
        lines.push('```');
        lines.push(tail || '(no stderr captured)');
        lines.push('```');
        lines.push('');
      }
    }
  }

  return lines.join('\n');
}

async function check() {
  const events = await readJsonl(EVENTS_PATH);
  const sessions = (await readJson(SESSIONS_PATH)) || {};
  const status = await readJson(STATUS_PATH);
  const analysis = analyzeEvents(events);
  const body = formatReport(analysis, { sessionCount: Object.keys(sessions).length, status });
  await writeFile(REPORT_PATH, body);
  const { verdict, totals, cost } = analysis;
  console.log(`[health] verdict=${verdict.split(' ')[0]} runs=${totals.runs} errors=${totals.error} cost=$${cost.toFixed(4)}`);
  console.log(`[health] wrote ${REPORT_PATH}`);
}

function plist({ nodePath, scriptPath, robinRoot, logPath }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${scriptPath}</string>
  </array>
  <key>WorkingDirectory</key><string>${robinRoot}</string>
  <key>RunAtLoad</key><false/>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Weekday</key><integer>0</integer>
    <key>Hour</key><integer>9</integer>
    <key>Minute</key><integer>0</integer>
  </dict>
  <key>StandardOutPath</key><string>${logPath}</string>
  <key>StandardErrorPath</key><string>${logPath}</string>
</dict>
</plist>
`;
}

async function install() {
  const body = plist({
    nodePath: process.execPath,
    scriptPath: SCRIPT_PATH,
    robinRoot: ROBIN_ROOT,
    logPath: resolve(LOG_DIR, 'discord-bot-health.log'),
  });
  await writeFile(PLIST_PATH, body);
  console.log(`[health-install] wrote ${PLIST_PATH}`);
  const uid = userInfo().uid;
  const boot = spawnSync('launchctl', ['bootstrap', `gui/${uid}`, PLIST_PATH], { encoding: 'utf-8' });
  if (boot.status !== 0) {
    console.error(`[health-install] bootstrap failed: ${boot.stderr.trim() || boot.stdout.trim()}`);
    process.exit(1);
  }
  console.log(`[health-install] scheduled: every Sunday 09:00 local`);
  console.log(`[health-install] report → ${REPORT_PATH}`);
}

async function uninstall() {
  const uid = userInfo().uid;
  const boot = spawnSync('launchctl', ['bootout', `gui/${uid}/${LABEL}`], { encoding: 'utf-8' });
  if (boot.status !== 0) console.warn(`[health-uninstall] bootout: ${boot.stderr.trim()}`);
  else console.log('[health-uninstall] bootout OK');
  try { await unlink(PLIST_PATH); console.log(`[health-uninstall] removed ${PLIST_PATH}`); } catch {}
}

const cmd = process.argv[2];
if (cmd === '--install') install().catch(e => { console.error(e); process.exit(1); });
else if (cmd === '--uninstall') uninstall().catch(e => { console.error(e); process.exit(1); });
else check().catch(e => { console.error(e); process.exit(1); });
