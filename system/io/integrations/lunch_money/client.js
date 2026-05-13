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

// Build a stable dedup key that survives Lunch Money's id reassignment
// when a pending Plaid transaction clears (LM mints a new `id` for the
// cleared row even though it's the same logical transaction). Earlier
// builds used `String(t.id)` as `external_id`, which let both the
// pending and cleared rows persist as separate events.
//
// Preference order:
//   1. Plaid's transaction_id (if LM surfaced it via plaid_metadata) —
//      this is the upstream-canonical id, stable across pending/cleared.
//   2. Composite of (date, plaid_account_id, amount, original_name) —
//      stable bank-side fields. `original_name` is the raw bank
//      description and survives LM's payee re-mapping.
//   3. Raw LM id, as a last resort for manual / Plaid-less rows.
function stableExternalId(t, amount) {
  let plaidTxId = null;
  if (t.plaid_metadata) {
    try {
      const pm =
        typeof t.plaid_metadata === 'string' ? JSON.parse(t.plaid_metadata) : t.plaid_metadata;
      plaidTxId = pm?.transaction_id ?? null;
    } catch {
      /* malformed metadata — fall through */
    }
  }
  if (plaidTxId) return `plaid:${plaidTxId}`;
  if (t.plaid_account_id) {
    const norm = (t.original_name ?? t.payee ?? '')
      .toString()
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
    return `lm-stable:${t.date}|${t.plaid_account_id}|${amount.toFixed(2)}|${norm}`;
  }
  return `lm:${t.id}`;
}

export function transactionToEvent(t) {
  const amount = Number.parseFloat(t.amount);
  const sign = t.is_income ? '+' : '-';
  return {
    source: 'lunch_money',
    content: `${t.payee ?? '(no payee)'} · ${sign}$${amount.toFixed(2)} · ${t.category_name ?? 'uncategorized'}`,
    ts: new Date(t.date),
    external_id: stableExternalId(t, amount),
    meta: {
      lm_id: t.id,
      account_id: t.asset_id ?? t.plaid_account_id ?? null,
      payee: t.payee,
      original_name: t.original_name ?? null,
      amount,
      is_income: !!t.is_income,
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
