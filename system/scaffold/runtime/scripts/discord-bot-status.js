#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { userInfo } from 'node:os';
import { createEventLog } from './lib/discord/event-log.js';
import { createSessionStore } from './lib/discord/session-store.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROBIN_ROOT = resolve(__dirname, '../../../');
const STATE_DIR = resolve(ROBIN_ROOT, 'user-data/runtime/state/services');
const LOG_DIR = STATE_DIR;
const SESSIONS_PATH = resolve(STATE_DIR, 'discord-sessions.json');
const EVENTS_PATH = resolve(LOG_DIR, 'discord-bot.events.jsonl');
const STATUS_PATH = resolve(STATE_DIR, 'discord-bot.status.json');
const LABEL = 'com.robin.discord-bot';
const WATCHDOG_LABEL = 'com.robin.discord-bot-watchdog';

function pad(s, n) { return (s + ' '.repeat(n)).slice(0, n); }

async function main() {
  // 1) launchd state — bot + watchdog
  const uid = userInfo().uid;
  const list = spawnSync('launchctl', ['print', `gui/${uid}/${LABEL}`], { encoding: 'utf-8' });
  const loaded = list.status === 0;
  console.log(`launchd:    ${loaded ? 'loaded' : 'NOT loaded'}`);
  const wList = spawnSync('launchctl', ['print', `gui/${uid}/${WATCHDOG_LABEL}`], { encoding: 'utf-8' });
  const wLoaded = wList.status === 0;
  console.log(`watchdog:   ${wLoaded ? 'loaded' : 'NOT loaded'}`);

  // 2) Last self-reported state
  try {
    const s = JSON.parse(await readFile(STATUS_PATH, 'utf-8'));
    console.log(`last state: ${s.state} @ ${s.ts}`);
  } catch { console.log('last state: unknown (no status file)'); }

  // 3) Sessions
  try {
    const store = await createSessionStore({ path: SESSIONS_PATH });
    const file = JSON.parse(await readFile(SESSIONS_PATH, 'utf-8').catch(() => '{}'));
    const keys = Object.keys(file);
    console.log(`sessions:   ${keys.length}`);
    for (const k of keys) {
      const ageMs = Date.now() - new Date(file[k].lastActiveAt).getTime();
      const ageMin = Math.round(ageMs / 60000);
      console.log(`  ${pad(k, 32)} idle=${ageMin}m  cid=${file[k].claudeSessionId}`);
    }
  } catch (err) { console.log(`sessions:   (none)`); }

  // 4) 24h cost
  try {
    const log = createEventLog({ path: EVENTS_PATH });
    const cost = await log.read24hCost();
    console.log(`24h cost:   $${cost.toFixed(4)}`);
  } catch { console.log(`24h cost:   (no events log)`); }

  // 5) Tail of events log (last 10)
  try {
    const raw = await readFile(EVENTS_PATH, 'utf-8');
    const lines = raw.trim().split('\n').slice(-10);
    console.log(`recent events:`);
    for (const line of lines) {
      try { const r = JSON.parse(line); console.log(`  ${r.ts}  ${r.event || 'run'}  ${r.status}  key=${r.conversationKey || '-'}  latency=${r.latencyMs ?? '-'}ms`); }
      catch {}
    }
  } catch { console.log('recent events: (none)'); }
}

main().catch(err => { console.error(err); process.exit(1); });
