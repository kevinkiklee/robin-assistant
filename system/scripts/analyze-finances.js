import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRules, categorizeAll, summarizeByCategory } from './lib/categorize.js';

function parseTransactionFile(path) {
  const content = readFileSync(path, 'utf-8');
  const rows = [];
  for (const line of content.split('\n')) {
    if (!line.startsWith('| 20')) continue;
    const cells = line.split('|').map(c => c.trim());
    if (cells.length < 8) continue;
    rows.push({
      date: cells[1],
      payee: cells[2],
      amount: parseFloat(cells[3]),
      account: cells[4],
      category: cells[5],
      notes: cells[6],
      id: cells[7],
    });
  }
  return rows;
}

function fmt(n) {
  const sign = n < 0 ? '-' : '';
  return `${sign}$${Math.abs(n).toFixed(2).padStart(9)}`;
}

export function analyze({ workspaceDir, month }) {
  const rulesPath = join(workspaceDir, 'user-data/memory/knowledge/finance/categorization-rules.md');
  const txDir = join(workspaceDir, 'user-data/memory/knowledge/finance/lunch-money/transactions');

  if (!existsSync(txDir)) {
    throw new Error(`No transactions found at ${txDir}. Run \`npm run sync-lunch-money\` first.`);
  }

  const files = readdirSync(txDir).filter(f => f.endsWith('.md')).sort();
  const file = month ? `${month}.md` : files[files.length - 1];
  if (!files.includes(file)) {
    throw new Error(`No transaction file for ${file.replace('.md', '')}. Available: ${files.map(f => f.replace('.md','')).join(', ')}`);
  }

  const bundle = loadRules(rulesPath);
  const txs = parseTransactionFile(join(txDir, file));
  const enriched = categorizeAll(txs, bundle);

  const real = enriched.filter(t => t.robin.category !== 'Internal' && t.robin.category !== 'Income');
  const internal = enriched.filter(t => t.robin.category === 'Internal');
  const income = enriched.filter(t => t.robin.category === 'Income');

  const realSpend = real.filter(t => t.amount > 0);
  const realRefunds = real.filter(t => t.amount < 0);

  const monthLabel = file.replace('.md', '');

  console.log(`# Spending Analysis — ${monthLabel}`);
  console.log('');
  console.log(`Rules loaded: ${bundle.rules.length} payee rules + ${bundle.remaps.size} category remaps`);
  console.log(`Transactions: ${enriched.length} total`);
  console.log(`  • ${income.length} income, ${internal.length} internal (transfers/CC payments), ${real.length} real activity`);
  console.log('');
  console.log('## Totals');
  console.log('');
  console.log(`| metric | amount |`);
  console.log(`|---|---|`);
  console.log(`| Income | ${fmt(income.reduce((s, t) => s - t.amount, 0))} |`);
  console.log(`| Real outflow | ${fmt(realSpend.reduce((s, t) => s + t.amount, 0))} |`);
  console.log(`| Refunds/credits | ${fmt(realRefunds.reduce((s, t) => s - t.amount, 0))} |`);
  console.log(`| Net real spending | ${fmt(realSpend.reduce((s, t) => s + t.amount, 0) + realRefunds.reduce((s, t) => s + t.amount, 0))} |`);
  console.log('');

  console.log('## By category (real spending only, sorted by total)');
  console.log('');
  console.log(`| category | total | count |`);
  console.log(`|---|---|---|`);
  for (const row of summarizeByCategory(realSpend)) {
    console.log(`| ${row.category} | ${fmt(row.total)} | ${row.count} |`);
  }
  console.log('');

  const uncategorized = real.filter(t => t.robin.category === 'Uncategorized');
  if (uncategorized.length > 0) {
    console.log('## Uncategorized payees (consider adding rules)');
    console.log('');
    const counts = new Map();
    for (const t of uncategorized) {
      const key = t.payee || '(empty)';
      const cur = counts.get(key) || { count: 0, total: 0 };
      cur.count += 1;
      cur.total += t.amount;
      counts.set(key, cur);
    }
    const top = [...counts.entries()]
      .sort((a, b) => Math.abs(b[1].total) - Math.abs(a[1].total))
      .slice(0, 15);
    console.log(`| payee | total | count |`);
    console.log(`|---|---|---|`);
    for (const [payee, { total, count }] of top) {
      console.log(`| ${payee} | ${fmt(total)} | ${count} |`);
    }
    console.log('');
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const workspaceDir = fileURLToPath(new URL('../..', import.meta.url));
  const month = process.argv[2] || null;
  try {
    analyze({ workspaceDir, month });
  } catch (err) {
    console.error(`[analyze-finances] ${err.message}`);
    process.exit(1);
  }
}
