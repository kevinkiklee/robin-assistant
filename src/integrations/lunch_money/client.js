const ROLLING_DAYS = 14;

async function lmFetch(path, { apiKey, fetchFn = globalThis.fetch, signal }) {
  const r = await fetchFn(`https://dev.lunchmoney.app${path}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal,
  });
  if (!r.ok) throw new Error(`lunch_money ${path} failed: ${r.status}`);
  return await r.json();
}

export async function listTransactions({ apiKey, startDate, endDate, fetchFn, signal }) {
  const params = new URLSearchParams({ start_date: startDate, end_date: endDate });
  return await lmFetch(`/v1/transactions?${params}`, { apiKey, fetchFn, signal });
}

export function transactionToEvent(t) {
  const amount = Number.parseFloat(t.amount);
  const sign = t.is_income ? '+' : '-';
  return {
    source: 'lunch_money',
    content: `${t.payee ?? '(no payee)'} · ${sign}$${amount.toFixed(2)} · ${t.category_name ?? 'uncategorized'}`,
    ts: new Date(t.date),
    external_id: String(t.id),
    meta: {
      lm_id: t.id,
      account_id: t.asset_id ?? t.plaid_account_id ?? null,
      payee: t.payee,
      amount,
      currency: t.currency,
      category: t.category_name,
      date: t.date,
      status: t.status,
      plaid_account_id: t.plaid_account_id,
    },
  };
}

export function rollingStartDate(savedCursorDate, today = new Date()) {
  const minus14 = new Date(today.getTime() - ROLLING_DAYS * 86400_000).toISOString().slice(0, 10);
  if (!savedCursorDate) return minus14;
  return savedCursorDate < minus14 ? minus14 : savedCursorDate;
}

export { ROLLING_DAYS };
