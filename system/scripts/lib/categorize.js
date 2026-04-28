import { readFileSync, existsSync } from 'node:fs';

const MATCH_TYPES = new Set(['exact', 'substring', 'regex']);

function parseSection(content, sectionTitle) {
  const out = [];
  const sectionRe = new RegExp(`^##\\s+${sectionTitle}\\b`, 'i');
  let inSection = false;
  for (const line of content.split('\n')) {
    if (sectionRe.test(line)) {
      inSection = true;
      continue;
    }
    if (inSection && /^##\s+/.test(line)) {
      inSection = false;
      continue;
    }
    if (!inSection) continue;
    if (!line.startsWith('|')) continue;
    if (/---/.test(line)) continue;
    const cells = line.split('|').map(c => c.trim()).filter(c => c.length > 0);
    out.push(cells);
  }
  return out;
}

export function loadRules(rulesPath) {
  if (!existsSync(rulesPath)) return { rules: [], remaps: new Map() };
  const content = readFileSync(rulesPath, 'utf-8');

  const rules = [];
  for (const cells of parseSection(content, 'Rules')) {
    if (cells.length < 3) continue;
    const [pattern, matchType, category] = cells;
    if (pattern.toLowerCase() === 'pattern') continue;
    if (!MATCH_TYPES.has(matchType.toLowerCase())) continue;
    rules.push({ pattern, matchType: matchType.toLowerCase(), category });
  }

  const remaps = new Map();
  for (const cells of parseSection(content, 'Category remaps')) {
    if (cells.length < 2) continue;
    const [lmCategory, robinCategory] = cells;
    if (lmCategory.toLowerCase().includes('lm category')) continue;
    remaps.set(lmCategory.toLowerCase(), robinCategory);
  }

  return { rules, remaps };
}

function matches(rule, payee) {
  if (!payee) return false;
  if (rule.matchType === 'exact') return payee === rule.pattern;
  if (rule.matchType === 'substring') {
    return payee.toLowerCase().includes(rule.pattern.toLowerCase());
  }
  if (rule.matchType === 'regex') {
    const m = rule.pattern.match(/^\/(.+)\/([a-z]*)$/);
    const re = m ? new RegExp(m[1], m[2]) : new RegExp(rule.pattern);
    return re.test(payee);
  }
  return false;
}

export function categorize(transaction, rulesOrBundle) {
  const bundle = Array.isArray(rulesOrBundle)
    ? { rules: rulesOrBundle, remaps: new Map() }
    : rulesOrBundle;
  const payee = transaction.payee || '';
  for (const rule of bundle.rules) {
    if (matches(rule, payee)) {
      return { category: rule.category, source: 'rule', matched: rule.pattern };
    }
  }
  const lmCatRaw = (transaction.category || transaction.cat || '').replace(/^[^a-zA-Z0-9]+/, '').trim();
  if (lmCatRaw) {
    const remapped = bundle.remaps?.get?.(lmCatRaw.toLowerCase());
    if (remapped) return { category: remapped, source: 'remap', matched: lmCatRaw };
    return { category: lmCatRaw, source: 'lunch-money' };
  }
  return { category: 'Uncategorized', source: 'fallback' };
}

export function categorizeAll(transactions, bundle) {
  return transactions.map(t => ({ ...t, robin: categorize(t, bundle) }));
}

export function summarizeByCategory(enriched) {
  const groups = new Map();
  for (const t of enriched) {
    const key = t.robin.category;
    if (!groups.has(key)) groups.set(key, { total: 0, count: 0 });
    const g = groups.get(key);
    g.total += t.amount;
    g.count += 1;
  }
  return [...groups.entries()]
    .map(([category, { total, count }]) => ({ category, total, count }))
    .sort((a, b) => b.total - a.total);
}
