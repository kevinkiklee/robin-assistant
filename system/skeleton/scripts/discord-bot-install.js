#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { writeFile, unlink, mkdir, access, constants } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROBIN_ROOT = resolve(__dirname, '../../');
const LABEL = 'com.robin.discord-bot';
const PLIST_PATH = resolve(homedir(), 'Library/LaunchAgents', `${LABEL}.plist`);
const SCRIPT_PATH = resolve(__dirname, 'discord-bot.js');
const LOG_DIR = resolve(ROBIN_ROOT, 'user-data/state/logs');

async function findNode() {
  const which = spawnSync('which', ['node'], { encoding: 'utf-8' });
  if (which.status !== 0) throw new Error('node not on PATH');
  return which.stdout.trim();
}

function plist({ nodePath, scriptPath, robinRoot, logPath, errPath }) {
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
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>${logPath}</string>
  <key>StandardErrorPath</key><string>${errPath}</string>
  <key>ProcessType</key><string>Interactive</string>
</dict>
</plist>
`;
}

async function install() {
  await mkdir(LOG_DIR, { recursive: true });
  await access(SCRIPT_PATH, constants.R_OK);
  const nodePath = await findNode();
  const body = plist({
    nodePath,
    scriptPath: SCRIPT_PATH,
    robinRoot: ROBIN_ROOT,
    logPath: resolve(LOG_DIR, 'discord-bot.log'),
    errPath: resolve(LOG_DIR, 'discord-bot.log'),
  });
  await writeFile(PLIST_PATH, body);
  console.log(`[install] wrote ${PLIST_PATH}`);

  const uid = userInfo().uid;
  const domain = `gui/${uid}`;

  const boot = spawnSync('launchctl', ['bootstrap', domain, PLIST_PATH], { encoding: 'utf-8' });
  if (boot.status !== 0) {
    console.error(`[install] launchctl bootstrap failed: ${boot.stderr.trim() || boot.stdout.trim()}`);
    console.error(`[install] is the bot already loaded? try: launchctl bootout ${domain}/${LABEL}`);
    process.exit(1);
  }
  console.log(`[install] bootstrapped under ${domain}`);
  console.log(`[install] tail logs:  tail -f ${resolve(LOG_DIR, 'discord-bot.log')}`);
}

async function uninstall() {
  const uid = userInfo().uid;
  const domain = `gui/${uid}`;
  const boot = spawnSync('launchctl', ['bootout', `${domain}/${LABEL}`], { encoding: 'utf-8' });
  if (boot.status !== 0) {
    console.warn(`[uninstall] bootout: ${boot.stderr.trim() || boot.stdout.trim()}`);
  } else {
    console.log('[uninstall] bootout OK');
  }
  try { await unlink(PLIST_PATH); console.log(`[uninstall] removed ${PLIST_PATH}`); } catch {}
}

const cmd = process.argv[2];
if (cmd === '--uninstall') uninstall().catch(e => { console.error(e); process.exit(1); });
else install().catch(e => { console.error(e); process.exit(1); });
