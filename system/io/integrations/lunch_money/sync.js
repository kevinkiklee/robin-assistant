import { listTransactions, rollingStartDate, transactionToEvent } from './client.js';

export async function sync(ctx) {
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  const startDate = rollingStartDate(ctx.cursor?.start_date ?? null, today);
  const data = await listTransactions({
    apiKey: ctx.secrets.LUNCH_MONEY_API_KEY,
    startDate,
    endDate: todayStr,
    fetchFn: ctx.fetchFn,
    signal: ctx.signal,
  });
  const events = (data.transactions ?? []).map(transactionToEvent);
  await ctx.capture(events);
  return { count: events.length, cursor: { start_date: todayStr } };
}
