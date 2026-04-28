import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSecrets, requireSecret } from './lib/load-secrets.js';
import { LunchMoneyClient } from './lib/lunch-money-client.js';
import { writeAccountsSnapshot, writeTransactions, writeInvestmentLedger } from './lib/finance-writer.js';
import { writeMemoryIndex } from './regenerate-memory-index.js';

const BACKFILL_START = '2024-01-01';
const OVERLAP_DAYS = 7;

function todayISO() {
  return new Date().toISOString();
}

function shiftDate(iso, days) {
  const d = new Date(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export async function fetchLunchMoney({ workspaceDir }) {
  loadSecrets(workspaceDir);
  const apiKey = requireSecret('LUNCH_MONEY_API_KEY');

  const stateDir = join(workspaceDir, 'user-data/state');
  const statePath = join(stateDir, 'lunch-money-sync.json');
  const financeDir = join(workspaceDir, 'user-data/memory/knowledge/finance/lunch-money');

  let state = {};
  if (existsSync(statePath)) {
    state = JSON.parse(readFileSync(statePath, 'utf-8'));
  }

  const now = todayISO();
  const today = now.slice(0, 10);
  const startDate = state.last_sync ? shiftDate(state.last_sync, -OVERLAP_DAYS) : BACKFILL_START;

  const client = new LunchMoneyClient(apiKey);

  console.log(`[lunch-money] fetching accounts...`);
  const [plaidAccounts, assets] = await Promise.all([
    client.getPlaidAccounts(),
    client.getAssets(),
  ]);
  console.log(`[lunch-money]   ${plaidAccounts.length} Plaid accounts, ${assets.length} manual assets`);

  console.log(`[lunch-money] fetching transactions ${startDate} → ${today}...`);
  const transactions = await client.getTransactions({ start_date: startDate, end_date: today });
  console.log(`[lunch-money]   ${transactions.length} transactions`);

  console.log(`[lunch-money] writing files to ${financeDir}`);
  writeAccountsSnapshot(financeDir, { plaidAccounts, assets, syncedAt: now });
  writeTransactions(financeDir, transactions);
  writeInvestmentLedger(financeDir, plaidAccounts, today);

  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    statePath,
    JSON.stringify({ last_sync: today, last_run_at: now, transactions_pulled: transactions.length }, null, 2) + '\n'
  );

  writeMemoryIndex(join(workspaceDir, 'user-data/memory'));

  console.log(`[lunch-money] done.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const workspaceDir = fileURLToPath(new URL('../..', import.meta.url));
  fetchLunchMoney({ workspaceDir }).catch((err) => {
    console.error(`[lunch-money] failed: ${err.message}`);
    process.exit(1);
  });
}
