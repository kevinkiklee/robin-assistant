import { BoundQuery } from 'surrealdb';

// Lunch Money asset types that count toward "liquid" net position.
// Excludes credit (liability), loan, investment, real estate, vehicle, other_asset.
const LIQUID_TYPES = new Set(['cash', 'checking', 'savings']);
// Types that count as outstanding debt (subtract from net position).
const DEBT_TYPES = new Set(['credit', 'credit card', 'loan', 'student loan']);

function bucket(meta) {
  const t = (meta?.type ?? '').toLowerCase();
  const sub = (meta?.subtype ?? '').toLowerCase();
  if (LIQUID_TYPES.has(t) || LIQUID_TYPES.has(sub)) return 'liquid';
  if (DEBT_TYPES.has(t) || DEBT_TYPES.has(sub)) return 'debt';
  if (t === 'investment' || t === 'brokerage' || sub === '401k' || sub === 'ira') return 'investment';
  return 'other';
}

export function createLunchMoneyAccountsTool({ db }) {
  return {
    name: 'lunch_money_accounts',
    description:
      'Lunch Money account balances (bank, HYSA, credit, investment). Returns per-account rows plus aggregates: liquid_total, debt_total, investment_total, net_position (liquid - debt). Optional `bucket` filter narrows to one category. Excludes closed/inactive accounts and those flagged excluded_from_totals.',
    inputSchema: {
      type: 'object',
      properties: {
        bucket: {
          type: 'string',
          enum: ['liquid', 'debt', 'investment', 'other'],
          description: 'Filter to a single bucket. Omit for all accounts.',
        },
        include_excluded: {
          type: 'boolean',
          default: false,
          description: 'Include accounts marked excluded_from_totals (closed, inactive).',
        },
      },
    },
    handler: async (args = {}) => {
      const sql = `SELECT id, content, ts, meta FROM events WHERE source = 'lunch_money_account' ORDER BY ts DESC`;
      const [rows] = await db.query(new BoundQuery(sql, {})).collect();
      const accounts = [];
      const totals = { liquid: 0, debt: 0, investment: 0, other: 0 };
      for (const r of rows) {
        const b = bucket(r.meta);
        const excluded = !!r.meta?.excluded_from_totals;
        if (!args.include_excluded && excluded) continue;
        if (args.bucket && b !== args.bucket) continue;
        const balance = Number(r.meta?.balance ?? 0);
        accounts.push({
          id: String(r.id),
          content: r.content,
          ts: r.ts,
          bucket: b,
          balance,
          meta: r.meta,
        });
        totals[b] = (totals[b] ?? 0) + balance;
      }
      const round = (n) => Math.round(n * 100) / 100;
      return {
        accounts,
        liquid_total: round(totals.liquid),
        debt_total: round(totals.debt),
        investment_total: round(totals.investment),
        other_total: round(totals.other),
        net_position: round(totals.liquid - totals.debt),
      };
    },
  };
}
