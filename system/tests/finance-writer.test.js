import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  writeAccountsSnapshot,
  writeTransactions,
  writeInvestmentLedger,
} from '../scripts/lib/finance-writer.js';

function setupDir() {
  return mkdtempSync(join(tmpdir(), 'finance-writer-'));
}

test('writeAccountsSnapshot produces grouped markdown with frontmatter', () => {
  const dir = setupDir();
  writeAccountsSnapshot(dir, {
    plaidAccounts: [
      { name: 'Checking', institution_name: 'Chase', balance: 4231.10, type: 'depository' },
      { name: 'Sapphire', institution_name: 'Chase', balance: -823.45, type: 'credit' },
      { name: '401k', institution_name: 'Vanguard', balance: 145000, type: 'investment' },
    ],
    assets: [
      { name: 'Cash', institution_name: 'Wallet', balance: 200, balance_as_of: '2026-04-28' },
    ],
    syncedAt: '2026-04-28T14:00:00.000Z',
  });
  const content = readFileSync(join(dir, 'accounts-snapshot.md'), 'utf-8');
  assert.match(content, /^---\ndescription: Current balances/);
  assert.match(content, /## Banking/);
  assert.match(content, /## Credit Cards/);
  assert.match(content, /## Investments/);
  assert.match(content, /## Manual Assets/);
  assert.match(content, /\$4,231\.10/);
  assert.match(content, /-\$823\.45/);
  rmSync(dir, { recursive: true, force: true });
});

test('writeTransactions splits by month and dedupes by id on rerun', () => {
  const dir = setupDir();
  const txs = [
    { id: 'tx1', date: '2026-04-15', payee: 'Whole Foods', amount: -45.32, plaid_account_name: 'Sapphire', category_name: 'Groceries' },
    { id: 'tx2', date: '2026-04-20', payee: 'Salary', amount: 3500, plaid_account_name: 'Checking', category_name: 'Income' },
    { id: 'tx3', date: '2026-03-10', payee: 'Rent', amount: -2100, plaid_account_name: 'Checking', category_name: 'Housing' },
  ];
  writeTransactions(dir, txs);
  const apr = readFileSync(join(dir, 'transactions/2026-04.md'), 'utf-8');
  const mar = readFileSync(join(dir, 'transactions/2026-03.md'), 'utf-8');
  assert.match(apr, /Whole Foods/);
  assert.match(apr, /Salary/);
  assert.match(mar, /Rent/);
  assert.match(apr, /^---\ndescription: Lunch Money transactions/);

  // Re-run with one duplicate + one new transaction
  writeTransactions(dir, [
    { id: 'tx1', date: '2026-04-15', payee: 'Whole Foods', amount: -45.32, plaid_account_name: 'Sapphire', category_name: 'Groceries' },
    { id: 'tx4', date: '2026-04-25', payee: 'Coffee', amount: -5, plaid_account_name: 'Sapphire', category_name: 'Food' },
  ]);
  const apr2 = readFileSync(join(dir, 'transactions/2026-04.md'), 'utf-8');
  // tx1 appears once, tx4 appears once
  const tx1Count = (apr2.match(/tx1/g) || []).length;
  const tx4Count = (apr2.match(/tx4/g) || []).length;
  assert.equal(tx1Count, 1, 'duplicate tx1 should not be added');
  assert.equal(tx4Count, 1, 'new tx4 should be appended');
  rmSync(dir, { recursive: true, force: true });
});

test('writeInvestmentLedger appends daily rows with computed change', () => {
  const dir = setupDir();
  writeInvestmentLedger(
    dir,
    [{ name: '401k', institution_name: 'Vanguard', balance: 145000, type: 'investment' }],
    '2026-04-27'
  );
  writeInvestmentLedger(
    dir,
    [{ name: '401k', institution_name: 'Vanguard', balance: 145200, type: 'investment' }],
    '2026-04-28'
  );
  const path = join(dir, 'investments/vanguard-401k.md');
  assert.ok(existsSync(path));
  const content = readFileSync(path, 'utf-8');
  assert.match(content, /^---\ndescription: Vanguard/);
  assert.match(content, /\| 2026-04-27 \| \$145,000\.00 \|  \|/);
  assert.match(content, /\| 2026-04-28 \| \$145,200\.00 \| \$200\.00 \|/);

  // Same-day rerun should overwrite, not duplicate
  writeInvestmentLedger(
    dir,
    [{ name: '401k', institution_name: 'Vanguard', balance: 145300, type: 'investment' }],
    '2026-04-28'
  );
  const content2 = readFileSync(path, 'utf-8');
  const dayCount = (content2.match(/2026-04-28/g) || []).length;
  assert.equal(dayCount, 1, 'same-day row should be replaced, not duplicated');
  assert.match(content2, /\$145,300\.00/);
  rmSync(dir, { recursive: true, force: true });
});

test('writeInvestmentLedger skips non-investment accounts', () => {
  const dir = setupDir();
  writeInvestmentLedger(
    dir,
    [
      { name: 'Checking', institution_name: 'Chase', balance: 4000, type: 'depository' },
      { name: 'Sapphire', institution_name: 'Chase', balance: -800, type: 'credit' },
    ],
    '2026-04-28'
  );
  assert.equal(existsSync(join(dir, 'investments')), false);
  rmSync(dir, { recursive: true, force: true });
});
