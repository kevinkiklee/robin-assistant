import { BoundQuery } from 'surrealdb';
import { wrapUntrusted } from '../../../../cognition/discretion/wrap-untrusted.js';
import { parseGmailContent } from './gmail-shipments.js';

const RECEIPT_RE =
  /\breceipt\b|\binvoice\b|\bpayment\b|\bsubscription\b|\brenew(?:al|ed|s)?\b|\bbilled\b|\bcharged?\b|\bauto-?pay\b|\byour order\b|\bthanks? for your (?:order|purchase|payment)\b/i;
const PROMO_RE = /\b(?:sale|coupon|discount|% off|promo|deal|save \$|free trial)\b/i;
const AMOUNT_RE = /\$\s?(\d{1,5}(?:,\d{3})*(?:\.\d{2})?)/;

function senderDomain(from) {
  const m = from.match(/@([^>\s]+)/);
  if (!m) return null;
  const host = m[1].toLowerCase().replace(/[.>;,]+$/, '');
  const parts = host.split('.');
  if (parts.length < 2) return null;
  return parts.slice(-2).join('.');
}

function parseAmount(subject, snippet) {
  const subj = subject.match(AMOUNT_RE);
  if (subj) return Number(subj[1].replace(/,/g, ''));
  const body = snippet.match(AMOUNT_RE);
  if (body) return Number(body[1].replace(/,/g, ''));
  return null;
}

function isReceiptLike(subject) {
  if (PROMO_RE.test(subject)) return false;
  return RECEIPT_RE.test(subject);
}

export function classifyReceipt(event) {
  const { subject, from, snippet } = parseGmailContent(event.content ?? '');
  if (!isReceiptLike(subject)) return null;
  const amount = parseAmount(subject, snippet);
  if (amount == null || amount <= 0) return null;
  const domain = senderDomain(from);
  if (!domain) return null;
  return { domain, from, amount, ts: event.ts, subject };
}

function classifyCadence(medianDays) {
  if (medianDays >= 6 && medianDays <= 9) return 'weekly';
  if (medianDays >= 13 && medianDays <= 17) return 'biweekly';
  if (medianDays >= 26 && medianDays <= 35) return 'monthly';
  if (medianDays >= 85 && medianDays <= 95) return 'quarterly';
  if (medianDays >= 170 && medianDays <= 195) return 'semiannual';
  if (medianDays >= 350 && medianDays <= 380) return 'annual';
  return null;
}

function monthlyEquivalent(amount, cadence) {
  switch (cadence) {
    case 'weekly':
      return amount * 4.33;
    case 'biweekly':
      return amount * 2.17;
    case 'monthly':
      return amount;
    case 'quarterly':
      return amount / 3;
    case 'semiannual':
      return amount / 6;
    case 'annual':
      return amount / 12;
    default:
      return amount;
  }
}

function median(nums) {
  if (nums.length === 0) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function aggregateSubscriptions(receipts, { now, newSinceDays = 60 } = {}) {
  const nowDate = now instanceof Date ? now : new Date(now);
  // Bucket exact (domain, amount) for cadence inference. Tax variance lands in a separate
  // bucket, which is fine: price-change detection rescans full sender history below.
  const byKey = new Map();
  const bySender = new Map();
  for (const r of receipts) {
    const key = `${r.domain}|${r.amount.toFixed(2)}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(r);
    if (!bySender.has(r.domain)) bySender.set(r.domain, []);
    bySender.get(r.domain).push(r);
  }
  const subs = [];
  for (const [, group] of byKey) {
    if (group.length < 2) continue;
    group.sort((a, b) => new Date(a.ts) - new Date(b.ts));
    const gaps = [];
    for (let i = 1; i < group.length; i += 1) {
      gaps.push((new Date(group[i].ts) - new Date(group[i - 1].ts)) / 86_400_000);
    }
    const medianGap = median(gaps);
    const cadence = classifyCadence(medianGap);
    if (!cadence) continue;
    const latest = group[group.length - 1];
    const first = group[0];
    const history = [...bySender.get(latest.domain)].sort(
      (a, b) => new Date(a.ts) - new Date(b.ts),
    );
    let priorAmount = null;
    for (let i = history.length - 1; i >= 0; i -= 1) {
      if (history[i].amount !== latest.amount) {
        priorAmount = history[i].amount;
        break;
      }
    }
    const priceChange =
      priorAmount !== null
        ? {
            from: priorAmount,
            to: latest.amount,
            delta_pct: Math.round(((latest.amount - priorAmount) / priorAmount) * 1000) / 10,
          }
        : null;
    const ageDays = (nowDate - new Date(first.ts)) / 86_400_000;
    subs.push({
      service: latest.domain,
      amount: latest.amount,
      cadence,
      median_gap_days: Math.round(medianGap),
      charge_count: group.length,
      last_charged: latest.ts,
      first_seen: first.ts,
      age_days: Math.round(ageDays),
      is_new: ageDays <= newSinceDays,
      price_change: priceChange,
    });
  }
  subs.sort(
    (a, b) => monthlyEquivalent(b.amount, b.cadence) - monthlyEquivalent(a.amount, a.cadence),
  );
  return subs;
}

export function createGmailSubscriptionsTool({ db }) {
  return {
    name: 'gmail_subscriptions',
    description:
      'Detect recurring subscriptions from captured Gmail receipts. Groups receipts by sender + amount, infers cadence (weekly, biweekly, monthly, quarterly, semiannual, annual), flags newly-detected subs and price changes. Returns aggregate monthly and annual cost estimates. Operates on the last days_back days of captured mail (default 180).',
    inputSchema: {
      type: 'object',
      properties: {
        days_back: {
          type: 'integer',
          minimum: 30,
          maximum: 730,
          default: 180,
          description:
            'How many days of captured Gmail to scan. 180+ recommended for annual cadence detection.',
        },
        min_monthly: {
          type: 'number',
          minimum: 0,
          default: 0,
          description: 'Hide subscriptions whose monthly-equivalent is below this threshold.',
        },
      },
    },
    handler: async (args = {}) => {
      const daysBack = args.days_back ?? 180;
      const minMonthly = args.min_monthly ?? 0;
      const since = new Date(Date.now() - daysBack * 86_400_000).toISOString();
      const sql = `SELECT id, content, ts, meta FROM events WHERE source = 'gmail' AND ts >= $since ORDER BY ts DESC LIMIT 5000`;
      const [rows] = await db.query(new BoundQuery(sql, { since })).collect();
      const receipts = [];
      for (const r of rows) {
        const c = classifyReceipt(r);
        if (c) receipts.push(c);
      }
      const allRaw = aggregateSubscriptions(receipts, { now: new Date() });
      const allWrapped = allRaw.map((s) => ({
        ...s,
        service: wrapUntrusted(s.service ?? '', { source: 'gmail', trust: 'untrusted' }),
      }));
      const subs = allWrapped.filter((s) => monthlyEquivalent(s.amount, s.cadence) >= minMonthly);
      const monthlyTotal = subs.reduce((sum, s) => sum + monthlyEquivalent(s.amount, s.cadence), 0);
      return {
        subscriptions: subs,
        count: subs.length,
        monthly_total_estimated: Math.round(monthlyTotal * 100) / 100,
        annual_total_estimated: Math.round(monthlyTotal * 12 * 100) / 100,
        new_in_window: subs.filter((s) => s.is_new).length,
        price_changes: subs.filter((s) => s.price_change).length,
      };
    },
  };
}
