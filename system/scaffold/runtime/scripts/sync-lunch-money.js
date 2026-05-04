#!/usr/bin/env node
// Template — auto-copied to user-data/runtime/scripts/ by system/scripts/diagnostics/startup-check.js
// on first run (scaffold-sync). Imports use paths relative to user-data/runtime/scripts/,
// so this file is NOT runnable in place — only after it's been copied.
import { join } from 'node:path';
import { hostname } from 'node:os';
import { resolveWorkspaceDir } from '../../../system/scripts/lib/workspace-root.js';
import { requireSecret } from '../../../system/scripts/sync/lib/secrets.js';
import { loadCursor, saveCursor } from '../../../system/scripts/sync/lib/cursor.js';
import { updateIndex } from '../../../system/scripts/sync/lib/index-updater.js';
import { acquireLock, releaseLock } from '../../../system/scripts/jobs/lib/atomic.js';
import { buildEntityRegistry } from '../../../system/scripts/wiki-graph/lib/build-entity-registry.js';
import { applyEntityLinks } from '../../../system/scripts/wiki-graph/lib/apply-entity-links.js';
import { LunchMoneyClient } from './lib/lunch-money/client.js';
import {
  writeAccountsSnapshot,
  writeTransactions,
  writeInvestmentLedger,
} from './lib/lunch-money/writer.js';

const BACKFILL_START = '2024-01-01';
const OVERLAP_DAYS = 7;
const SOURCE = 'lunch-money';
const FINANCE_REL_DIR = 'user-data/memory/knowledge/finance/lunch-money';

function todayISO() {
  return new Date().toISOString();
}

// Insert wiki-graph entity links into a memory file we just wrote.
// Best-effort; never throw to the caller.
async function linkAfterWrite(workspaceDir, registry, wsRelPath) {
  if (!registry || !wsRelPath.startsWith('user-data/memory/')) return;
  const memRelPath = wsRelPath.slice('user-data/memory/'.length);
  try {
    await applyEntityLinks(workspaceDir, memRelPath, registry);
  } catch (err) {
    console.warn(`sync-lunch-money: applyEntityLinks(${memRelPath}) failed: ${err.message}`);
  }
}

function shiftDate(iso, days) {
  const d = new Date(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export async function syncLunchMoney({ workspaceDir, dryRun = false }) {
  let registry = null;
  try {
    registry = await buildEntityRegistry(workspaceDir);
  } catch (err) {
    console.warn(`sync-lunch-money: registry unavailable, skipping link insertion (${err.message})`);
  }

  const apiKey = requireSecret(workspaceDir, 'LUNCH_MONEY_API_KEY');

  const financeDir = join(workspaceDir, FINANCE_REL_DIR);
  const cursor = loadCursor(workspaceDir, SOURCE);

  const now = todayISO();
  const today = now.slice(0, 10);
  const startDate = cursor.last_sync_date
    ? shiftDate(cursor.last_sync_date, -OVERLAP_DAYS)
    : BACKFILL_START;

  const client = new LunchMoneyClient(apiKey);

  console.log(`[sync-lunch-money] fetching accounts...`);
  const [plaidAccounts, assets] = await Promise.all([
    client.getPlaidAccounts(),
    client.getAssets(),
  ]);
  console.log(
    `[sync-lunch-money]   ${plaidAccounts.length} Plaid accounts, ${assets.length} manual assets`
  );

  console.log(`[sync-lunch-money] fetching transactions ${startDate} → ${today}...`);
  const transactions = await client.getTransactions({ start_date: startDate, end_date: today });
  console.log(`[sync-lunch-money]   ${transactions.length} transactions`);

  if (dryRun) {
    console.log('[sync-lunch-money] dry-run: skipping writes');
    return { accounts: plaidAccounts.length, assets: assets.length, transactions: transactions.length };
  }

  console.log(`[sync-lunch-money] writing files to ${financeDir}`);
  const accountsWritten = writeAccountsSnapshot(financeDir, { plaidAccounts, assets, syncedAt: now }) ?? [];
  const txWritten = writeTransactions(financeDir, transactions) ?? [];
  const invWritten = writeInvestmentLedger(financeDir, plaidAccounts, today) ?? [];
  for (const sub of [...accountsWritten, ...txWritten, ...invWritten]) {
    await linkAfterWrite(workspaceDir, registry, `${FINANCE_REL_DIR}/${sub}`);
  }

  saveCursor(workspaceDir, SOURCE, {
    last_attempt_at: now,
    last_success_at: now,
    last_sync_date: today,
    error_count: 0,
    last_error: null,
    auth_status: 'ok',
    cursor: { transactions_pulled: transactions.length },
  });

  await updateIndex(workspaceDir, { skipIfLocked: true });

  console.log('[sync-lunch-money] done.');
  return { accounts: plaidAccounts.length, assets: assets.length, transactions: transactions.length };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const workspaceDir = resolveWorkspaceDir(import.meta.url);
  const dryRun = process.argv.includes('--dry-run');

  // When invoked via the unified job runner (`robin run sync-lunch-money`),
  // the runner already holds the per-job lock at
  // user-data/runtime/state/jobs/locks/sync-lunch-money.lock and sets ROBIN_WORKSPACE.
  // When invoked directly from a terminal we hold the lock ourselves so two
  // concurrent invocations (manual + cron) don't double-fetch the API and
  // race on cursor writes.
  const underRunner = !!process.env.ROBIN_WORKSPACE;
  const lockPath = join(workspaceDir, 'user-data/runtime/state/jobs/locks/sync-lunch-money.lock');
  let acquired = false;

  async function run() {
    if (!underRunner) {
      const r = acquireLock(lockPath, { host: hostname() });
      if (r === 'held') {
        console.log('[sync-lunch-money] another instance is running (lock held); exiting.');
        return;
      }
      acquired = true;
    }
    try {
      await syncLunchMoney({ workspaceDir, dryRun });
    } finally {
      if (acquired) releaseLock(lockPath);
    }
  }

  run().catch((err) => {
    try {
      saveCursor(workspaceDir, SOURCE, {
        last_attempt_at: todayISO(),
        last_error: err.message,
        error_count: (loadCursor(workspaceDir, SOURCE).error_count ?? 0) + 1,
        auth_status: err.name === 'AuthError' ? 'needs_reauth' : 'unknown',
      });
    } catch { /* ignore */ }
    if (acquired) {
      try { releaseLock(lockPath); } catch { /* ignore */ }
    }
    console.error(`[sync-lunch-money] failed: ${err.message}`);
    process.exit(1);
  });
}
