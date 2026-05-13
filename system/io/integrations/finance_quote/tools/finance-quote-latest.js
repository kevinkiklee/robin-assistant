import { surql } from 'surrealdb';

export function createFinanceQuoteLatestTool({ db }) {
  return {
    name: 'finance_quote_latest',
    description:
      'Returns the latest captured market quote for a ticker (or one row per ticker if no ticker is given). Pulls from the finance_quote integration.',
    inputSchema: {
      type: 'object',
      properties: {
        ticker: { type: 'string', description: 'Optional ticker symbol (case-insensitive).' },
      },
    },
    handler: async (args = {}) => {
      const t = (args.ticker ?? '').toString().trim().toUpperCase();
      if (t) {
        const [rows] = await db
          .query(
            surql`SELECT id, content, ts, meta FROM events
                  WHERE source = 'finance_quote' AND meta.ticker = ${t}
                  ORDER BY ts DESC LIMIT 1`,
          )
          .collect();
        const row = rows[0];
        return { quote: row ? { ...row, id: String(row.id) } : null };
      }
      const [rows] = await db
        .query(
          surql`SELECT id, content, ts, meta FROM events
                WHERE source = 'finance_quote'
                ORDER BY ts DESC LIMIT 200`,
        )
        .collect();
      const byTicker = new Map();
      for (const r of rows) {
        const tk = r.meta?.ticker;
        if (!tk || byTicker.has(tk)) continue;
        byTicker.set(tk, { ...r, id: String(r.id) });
      }
      return { quotes: [...byTicker.values()] };
    },
  };
}
