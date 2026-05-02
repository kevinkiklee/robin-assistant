// Template — auto-copied to user-data/scripts/lib/lunch-money/ by scaffold-sync.
// Imports resolve only after copy; not runnable in place.
//
// Each `write*` function returns an array of workspace-relative paths it wrote
// (e.g. ['user-data/memory/knowledge/finance/lunch-money/accounts-snapshot.md']).
// The caller uses this list to apply post-write entity links via the wiki-graph
// linker. Callers that don't need the list can ignore the return value.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseFrontmatter, stringifyFrontmatter } from '../../../../system/scripts/lib/memory-index.js';

const TX_HEADER = '| date | payee | amount | account | category (LM) | notes | id |';
const TX_DIVIDER = '|------|-------|--------|---------|---------------|-------|-----|';
const INV_HEADER = '| date | balance | change |';
const INV_DIVIDER = '|------|---------|--------|';

function slugify(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function fmtMoney(n) {
  if (n == null) return '';
  const num = Number(n);
  const sign = num < 0 ? '-' : '';
  const abs = Math.abs(num);
  return `${sign}$${abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtAmount(n) {
  if (n == null) return '';
  const num = Number(n);
  return num.toFixed(2);
}

function escapeCell(s) {
  return String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

export function writeAccountsSnapshot(financeDir, { plaidAccounts, assets, syncedAt }) {
  mkdirSync(financeDir, { recursive: true });
  const groups = { Banking: [], 'Credit Cards': [], Investments: [], Loans: [], Other: [], 'Manual Assets': [] };

  for (const a of plaidAccounts) {
    const row = {
      name: a.name || a.display_name || '(unnamed)',
      institution: a.institution_name || '',
      balance: a.balance,
      currency: a.currency || 'usd',
      lastUpdate: a.balance_last_update || a.last_import || '',
    };
    const type = (a.type || '').toLowerCase();
    if (type === 'depository' || type === 'cash') groups.Banking.push(row);
    else if (type === 'credit') groups['Credit Cards'].push(row);
    else if (type === 'investment' || type === 'brokerage') groups.Investments.push(row);
    else if (type === 'loan') groups.Loans.push(row);
    else groups.Other.push(row);
  }
  for (const a of assets) {
    groups['Manual Assets'].push({
      name: a.name || a.display_name || '(unnamed)',
      institution: a.institution_name || '',
      balance: a.balance,
      currency: a.currency || 'usd',
      lastUpdate: a.balance_as_of || '',
    });
  }

  const lines = [];
  lines.push(`# Account Balances — ${syncedAt.slice(0, 10)}`);
  lines.push('');
  lines.push(`Auto-pulled from Lunch Money. Last sync: ${syncedAt}`);
  lines.push('');
  for (const [section, rows] of Object.entries(groups)) {
    if (rows.length === 0) continue;
    lines.push(`## ${section}`);
    lines.push('');
    lines.push('| account | institution | balance | last update |');
    lines.push('|---------|-------------|---------|-------------|');
    for (const r of rows) {
      lines.push(`| ${escapeCell(r.name)} | ${escapeCell(r.institution)} | ${fmtMoney(r.balance)} | ${escapeCell(r.lastUpdate)} |`);
    }
    lines.push('');
  }

  const body = lines.join('\n');
  const out = stringifyFrontmatter(
    { description: 'Current balances — all accounts from Lunch Money (auto-pulled)', trust: 'untrusted', 'trust-source': 'sync-lunch-money' },
    body
  );
  writeFileSync(join(financeDir, 'accounts-snapshot.md'), out);
  return ['accounts-snapshot.md'];
}

export function writeTransactions(financeDir, transactions) {
  const txDir = join(financeDir, 'transactions');
  mkdirSync(txDir, { recursive: true });

  const byMonth = new Map();
  for (const tx of transactions) {
    const date = tx.date;
    if (!date) continue;
    const month = date.slice(0, 7);
    if (!byMonth.has(month)) byMonth.set(month, []);
    byMonth.get(month).push(tx);
  }

  const written = [];
  for (const [month, txs] of byMonth) {
    const path = join(txDir, `${month}.md`);
    const existingIds = new Set();
    let body = '';
    if (existsSync(path)) {
      const content = readFileSync(path, 'utf-8');
      const parsed = parseFrontmatter(content);
      body = parsed.body;
      for (const line of body.split('\n')) {
        const m = line.match(/\|\s*([a-zA-Z0-9_-]+)\s*\|\s*$/);
        if (m) existingIds.add(m[1]);
      }
    }

    const newRows = [];
    const seen = new Set(existingIds);
    for (const tx of txs) {
      const id = String(tx.id ?? tx.external_id ?? '');
      if (!id || seen.has(id)) continue;
      seen.add(id);
      newRows.push({
        date: tx.date,
        payee: tx.payee || tx.original_name || '',
        amount: tx.amount,
        account: tx.plaid_account_name || tx.asset_name || '',
        category: tx.category_name || '',
        notes: tx.notes || '',
        id,
      });
    }

    newRows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

    let nextBody;
    if (existingIds.size === 0) {
      const lines = [
        `# Transactions — ${month}`,
        '',
        'Auto-pulled from Lunch Money. Robin re-categorizes at read-time; the `category (LM)` column is Lunch Money\'s raw category.',
        '',
        TX_HEADER,
        TX_DIVIDER,
      ];
      for (const r of newRows) {
        lines.push(`| ${r.date} | ${escapeCell(r.payee)} | ${fmtAmount(r.amount)} | ${escapeCell(r.account)} | ${escapeCell(r.category)} | ${escapeCell(r.notes)} | ${r.id} |`);
      }
      nextBody = lines.join('\n') + '\n';
    } else {
      const trimmed = body.replace(/\n+$/, '');
      const appended = newRows
        .map(r => `| ${r.date} | ${escapeCell(r.payee)} | ${fmtAmount(r.amount)} | ${escapeCell(r.account)} | ${escapeCell(r.category)} | ${escapeCell(r.notes)} | ${r.id} |`)
        .join('\n');
      nextBody = appended ? `${trimmed}\n${appended}\n` : `${trimmed}\n`;
    }

    const out = stringifyFrontmatter(
      { description: `Lunch Money transactions for ${month} (auto-pulled)`, trust: 'untrusted', 'trust-source': 'sync-lunch-money' },
      nextBody
    );
    writeFileSync(path, out);
    written.push(`transactions/${month}.md`);
  }
  return written;
}

export function writeInvestmentLedger(financeDir, plaidAccounts, dateISO) {
  const invAccounts = plaidAccounts.filter(a => {
    const type = (a.type || '').toLowerCase();
    return type === 'investment' || type === 'brokerage';
  });
  if (invAccounts.length === 0) return [];

  const invDir = join(financeDir, 'investments');
  mkdirSync(invDir, { recursive: true });
  const today = dateISO.slice(0, 10);

  const written = [];
  for (const a of invAccounts) {
    const slug = slugify(`${a.institution_name || ''}-${a.name || a.display_name || 'account'}`);
    const path = join(invDir, `${slug}.md`);
    const balance = Number(a.balance);

    let priorRows = [];
    let prevBalance = null;
    if (existsSync(path)) {
      const content = readFileSync(path, 'utf-8');
      const parsed = parseFrontmatter(content);
      const rowRe = /^\|\s*(\d{4}-\d{2}-\d{2})\s*\|\s*([^|]+)\s*\|\s*([^|]*)\s*\|$/;
      for (const line of parsed.body.split('\n')) {
        const m = line.match(rowRe);
        if (m) priorRows.push({ date: m[1], balance: m[2].trim(), change: m[3].trim() });
      }
      priorRows = priorRows.filter(r => r.date !== today);
      const last = priorRows[priorRows.length - 1];
      if (last) {
        const num = Number(last.balance.replace(/[$,]/g, ''));
        if (!Number.isNaN(num)) prevBalance = num;
      }
    }

    const change = prevBalance == null ? '' : fmtMoney(balance - prevBalance);
    priorRows.push({ date: today, balance: fmtMoney(balance), change });
    priorRows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

    const lines = [
      `# ${a.institution_name ? `${a.institution_name} — ` : ''}${a.name || a.display_name || 'Account'} — Balance History`,
      '',
      'Auto-pulled daily from Lunch Money.',
      '',
      INV_HEADER,
      INV_DIVIDER,
      ...priorRows.map(r => `| ${r.date} | ${r.balance} | ${r.change} |`),
      '',
    ];
    const desc = `${a.institution_name || a.name || 'Investment'} — daily balance ledger (auto-pulled)`;
    const out = stringifyFrontmatter({ description: desc, trust: 'untrusted', 'trust-source': 'sync-lunch-money' }, lines.join('\n'));
    writeFileSync(path, out);
    written.push(`investments/${slug}.md`);
  }
  return written;
}
