import {
  accountToEvent,
  accountToSnapshotEvent,
  listAssets,
  listPlaidAccounts,
  listTransactions,
  rollingStartDate,
  transactionToEvent,
} from './client.js';

export async function sync(ctx) {
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  const startDate = rollingStartDate(ctx.cursor?.start_date ?? null, today);
  const apiKey = ctx.secrets.LUNCH_MONEY_API_KEY;
  const fetchOpts = { apiKey, fetchFn: ctx.fetchFn, signal: ctx.signal };
  const [txData, assetData, plaidData] = await Promise.all([
    listTransactions({ ...fetchOpts, startDate, endDate: todayStr }),
    listAssets(fetchOpts),
    listPlaidAccounts(fetchOpts),
  ]);
  const txEvents = (txData.transactions ?? []).map(transactionToEvent);
  const assetEvents = (assetData.assets ?? []).map((a) => accountToEvent(a, { kind: 'asset' }));
  const plaidEvents = (plaidData.plaid_accounts ?? []).map((a) =>
    accountToEvent(a, { kind: 'plaid' }),
  );
  // Daily snapshots — separate source so the upsert-by-day external_id
  // produces one row per account per day. Over time these become a balance
  // trend without bloating the "current state" lunch_money_account rows.
  const assetSnapshots = (assetData.assets ?? []).map((a) =>
    accountToSnapshotEvent(a, { kind: 'asset', dateStr: todayStr }),
  );
  const plaidSnapshots = (plaidData.plaid_accounts ?? []).map((a) =>
    accountToSnapshotEvent(a, { kind: 'plaid', dateStr: todayStr }),
  );
  const events = [
    ...txEvents,
    ...assetEvents,
    ...plaidEvents,
    ...assetSnapshots,
    ...plaidSnapshots,
  ];
  await ctx.capture(events);
  return { count: events.length, cursor: { start_date: todayStr } };
}
