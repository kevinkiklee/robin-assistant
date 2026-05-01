#!/usr/bin/env node
// Ensures the Robin Discord bot launchd job is installed and loaded.
// Runs every 5 minutes via its own launchd job. If the bot's plist is missing
// or the service is unloaded, the watchdog repairs it.

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { writeFile, unlink, mkdir, access, constants } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { createEventLog } from './lib/discord/event-log.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROBIN_ROOT = resolve(__dirname, '../../');
const STATE_DIR = resolve(ROBIN_ROOT, 'user-data/state');
const LOG_DIR = resolve(STATE_DIR, 'logs');
const EVENTS_PATH = resolve(LOG_DIR, 'discord-bot.events.jsonl');

const BOT_LABEL = 'com.robin.discord-bot';
const BOT_PLIST = resolve(homedir(), 'Library/LaunchAgents', `${BOT_LABEL}.plist`);
const BOT_INSTALL_SCRIPT = resolve(__dirname, 'discord-bot-install.js');

const LABEL = 'com.robin.discord-bot-watchdog';
const PLIST_PATH = resolve(homedir(), 'Library/LaunchAgents', `${LABEL}.plist`);
const SCRIPT_PATH = resolve(__dirname, 'discord-bot-watchdog.js');

const INTERVAL_SEC = 300;

function findNode() {
  // Use the running node binary's path so this works under launchd's
  // restricted PATH (where `which node` returns nothing for nvm-installed Node).
  return process.execPath;
}

async function fileExists(path) {
  try { await access(path, constants.R_OK); return true; } catch { return false; }
}

function isLoaded(label) {
  const uid = userInfo().uid;
  const r = spawnSync('launchctl', ['print', `gui/${uid}/${label}`]);
  return r.status === 0;
}

async function check() {
  await mkdir(LOG_DIR, { recursive: true });
  const log = createEventLog({ path: EVENTS_PATH });
  const uid = userInfo().uid;
  const domain = `gui/${uid}`;

  // Self-heal: rewrite own plist file if it's been deleted while we're still
  // loaded in launchd. Without this, a reboot would lose us silently.
  if (!(await fileExists(PLIST_PATH))) {
    const body = plistBody({
      nodePath: findNode(),
      scriptPath: SCRIPT_PATH,
      robinRoot: ROBIN_ROOT,
      logPath: resolve(LOG_DIR, 'discord-bot-watchdog.log'),
    });
    await writeFile(PLIST_PATH, body);
    await log.append({ event: 'watchdog', status: 'ok', message: 'self-heal-restored-own-plist' });
    console.log('[watchdog] restored own plist file');
  }

  if (!(await fileExists(BOT_PLIST))) {
    const r = spawnSync(process.execPath, [BOT_INSTALL_SCRIPT], { encoding: 'utf-8' });
    const detail = (r.stderr || r.stdout || '').trim().slice(-400);
    if (r.status !== 0) {
      await log.append({ event: 'watchdog', status: 'error', error: `reinstall-failed: ${detail}` });
      console.error(`[watchdog] reinstall failed: ${detail}`);
      return;
    }
    await log.append({ event: 'watchdog', status: 'ok', message: 'reinstalled-missing-plist' });
    console.log('[watchdog] reinstalled (plist was missing)');
    return;
  }

  if (!isLoaded(BOT_LABEL)) {
    const boot = spawnSync('launchctl', ['bootstrap', domain, BOT_PLIST], { encoding: 'utf-8' });
    if (boot.status !== 0) {
      const err = (boot.stderr || boot.stdout || '').trim();
      await log.append({ event: 'watchdog', status: 'error', error: `bootstrap-failed: ${err}` });
      console.error(`[watchdog] bootstrap failed: ${err}`);
      return;
    }
    await log.append({ event: 'watchdog', status: 'ok', message: 'rebootstrapped' });
    console.log('[watchdog] re-bootstrapped (service was unloaded)');
    return;
  }

  console.log(`[watchdog] ${new Date().toISOString()} ok`);
}

function plistBody({ nodePath, scriptPath, robinRoot, logPath }) {
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
  <key>RunAtLoad</key><true/>
  <key>StartInterval</key><integer>${INTERVAL_SEC}</integer>
  <key>StandardOutPath</key><string>${logPath}</string>
  <key>StandardErrorPath</key><string>${logPath}</string>
</dict>
</plist>
`;
}

async function install() {
  await mkdir(LOG_DIR, { recursive: true });
  await access(SCRIPT_PATH, constants.R_OK);
  const nodePath = findNode();
  const body = plistBody({
    nodePath,
    scriptPath: SCRIPT_PATH,
    robinRoot: ROBIN_ROOT,
    logPath: resolve(LOG_DIR, 'discord-bot-watchdog.log'),
  });
  await writeFile(PLIST_PATH, body);
  console.log(`[watchdog-install] wrote ${PLIST_PATH}`);

  const uid = userInfo().uid;
  const domain = `gui/${uid}`;
  if (isLoaded(LABEL)) {
    spawnSync('launchctl', ['bootout', `${domain}/${LABEL}`], { stdio: 'ignore' });
  }
  const boot = spawnSync('launchctl', ['bootstrap', domain, PLIST_PATH], { encoding: 'utf-8' });
  if (boot.status !== 0) {
    console.error(`[watchdog-install] bootstrap failed: ${boot.stderr.trim() || boot.stdout.trim()}`);
    process.exit(1);
  }
  console.log(`[watchdog-install] bootstrapped — checks every ${INTERVAL_SEC}s`);
}

async function uninstall() {
  const uid = userInfo().uid;
  const domain = `gui/${uid}`;
  const boot = spawnSync('launchctl', ['bootout', `${domain}/${LABEL}`], { encoding: 'utf-8' });
  if (boot.status !== 0) console.warn(`[watchdog-uninstall] bootout: ${boot.stderr.trim()}`);
  else console.log('[watchdog-uninstall] bootout OK');
  try { await unlink(PLIST_PATH); console.log(`[watchdog-uninstall] removed ${PLIST_PATH}`); } catch {}
}

const cmd = process.argv[2];
if (cmd === '--install') install().catch(e => { console.error(e); process.exit(1); });
else if (cmd === '--uninstall') uninstall().catch(e => { console.error(e); process.exit(1); });
else check().catch(e => { console.error(e); process.exit(1); });
