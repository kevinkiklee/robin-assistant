// Template — auto-copied to user-data/scripts/lib/lunch-money/ by scaffold-sync.
// Imports resolve only after copy; not runnable in place.
import { fetchJson, AuthError } from '../../../../system/scripts/lib/sync/http.js';

const BASE = 'https://dev.lunchmoney.app/v1';

export { AuthError };

export class LunchMoneyClient {
  constructor(apiKey) {
    if (!apiKey) throw new Error('Lunch Money API key required');
    this.apiKey = apiKey;
  }

  async request(path, params = {}) {
    const url = new URL(BASE + path);
    for (const [k, v] of Object.entries(params)) {
      if (v != null) url.searchParams.set(k, String(v));
    }
    return fetchJson(url.toString(), {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });
  }

  async getPlaidAccounts() {
    const data = await this.request('/plaid_accounts');
    return data.plaid_accounts ?? [];
  }

  async getAssets() {
    const data = await this.request('/assets');
    return data.assets ?? [];
  }

  async getTransactions({ start_date, end_date }) {
    const all = [];
    let offset = 0;
    const limit = 500;
    while (true) {
      const data = await this.request('/transactions', {
        start_date,
        end_date,
        limit,
        offset,
      });
      const page = data.transactions ?? [];
      all.push(...page);
      const hasMore = data.has_more ?? page.length === limit;
      if (!hasMore || page.length === 0) break;
      offset += page.length;
    }
    return all;
  }
}
