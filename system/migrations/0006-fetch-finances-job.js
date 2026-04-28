// Migration 0006: convert the existing fetch-finances launchd setup into a
// user-data/jobs/fetch-finances.md job def. Also unloads + removes the legacy
// launchd plist if it's still installed, so the new job system can install
// fresh entries without colliding with the old one. Idempotent.

import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

export const id = '0006-fetch-finances-job';
export const description = 'Create user-data/jobs/fetch-finances.md job def, replacing legacy launchd template.';

const FETCH_FINANCES_BODY = `---
name: fetch-finances
description: Pull Lunch Money accounts and transactions, write to memory.
runtime: node
enabled: true
schedule: "0 1 * * *"
command: node system/scripts/fetch-lunch-money.js
catch_up: true
timeout_minutes: 5
notify_on_failure: true
---

Pulls Plaid accounts, manual assets, and transactions from Lunch Money since
the last sync (with 7-day overlap). Writes accounts snapshot, transactions,
and the investment ledger to user-data/memory/knowledge/finance/lunch-money/
and regenerates the memory INDEX.md.

Requires LUNCH_MONEY_API_KEY in user-data/secrets/.env.
`;

function uninstallLegacyLaunchdPlist() {
  if (platform() !== 'darwin') return false;
  const plistPath = join(homedir(), 'Library/LaunchAgents/com.robin.fetch-finances.plist');
  if (!existsSync(plistPath)) return false;
  // bootout (modern syntax) — ignore failures; it may already be unloaded.
  const uid = process.getuid ? process.getuid() : 0;
  spawnSync('launchctl', ['bootout', `gui/${uid}/com.robin.fetch-finances`], { stdio: 'ignore' });
  // Remove the file regardless.
  try {
    unlinkSync(plistPath);
  } catch {
    // ignore
  }
  return true;
}

export async function up({ workspaceDir }) {
  const dir = join(workspaceDir, 'user-data/jobs');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'fetch-finances.md');
  let wroteJob = false;
  if (!existsSync(path)) {
    writeFileSync(path, FETCH_FINANCES_BODY);
    wroteJob = true;
  }
  const removedLegacy = uninstallLegacyLaunchdPlist();

  const summary = [];
  if (wroteJob) summary.push('wrote user-data/jobs/fetch-finances.md');
  if (removedLegacy) summary.push('uninstalled legacy launchd plist');
  if (summary.length > 0) console.log(`[0006] ${summary.join('; ')}`);
}
