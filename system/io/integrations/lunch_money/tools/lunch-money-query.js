import { BoundQuery } from 'surrealdb';

export function createLunchMoneyQueryTool({ db }) {
  return {
    name: 'lunch_money_query',
    description:
      'Query captured Lunch Money transactions. Filters: since, until, payee_contains, min_amount, category.',
    inputSchema: {
      type: 'object',
      properties: {
        since: { type: 'string', format: 'date' },
        until: { type: 'string', format: 'date' },
        payee_contains: { type: 'string' },
        min_amount: { type: 'number' },
        category: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
      },
    },
    handler: async (args) => {
      const filters = ["source = 'lunch_money'"];
      const bindings = {};
      if (args.since) {
        filters.push('meta.date >= $since');
        bindings.since = args.since;
      }
      if (args.until) {
        filters.push('meta.date <= $until');
        bindings.until = args.until;
      }
      if (args.payee_contains) {
        filters.push('string::contains(string::lowercase(meta.payee), string::lowercase($pq))');
        bindings.pq = args.payee_contains;
      }
      if (typeof args.min_amount === 'number') {
        filters.push('meta.amount >= $minAmt');
        bindings.minAmt = args.min_amount;
      }
      if (args.category) {
        filters.push('meta.category = $cat');
        bindings.cat = args.category;
      }
      const limit = Math.min(args.limit ?? 50, 200);
      const sql = `SELECT id, content, ts, meta FROM events WHERE ${filters.join(' AND ')} ORDER BY ts DESC LIMIT ${limit}`;
      const [rows] = await db.query(new BoundQuery(sql, bindings)).collect();
      return { transactions: rows.map((r) => ({ ...r, id: String(r.id) })) };
    },
  };
}
