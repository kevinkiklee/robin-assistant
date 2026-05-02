export class AuthError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = 'AuthError';
    this.status = status;
    this.body = body;
  }
}

const DEFAULT_RETRY_DELAY_MS = 500;

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

export async function fetchJson(url, init = {}, opts = {}) {
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const maxRetries = opts.maxRetries ?? 3;
  const baseDelayMs = opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;

  let lastBody = '';
  let lastStatus = 0;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await fetchImpl(url, init);
    if (res.ok) return res.json();
    lastStatus = res.status;
    lastBody = await res.text();
    if (res.status === 401 || res.status === 403) {
      throw new AuthError(`HTTP ${res.status} on ${url}`, { status: res.status, body: lastBody });
    }
    const retryable = res.status === 429 || (res.status >= 500 && res.status < 600);
    if (!retryable || attempt === maxRetries) break;
    const delay = baseDelayMs * Math.pow(2, attempt);
    await sleep(delay);
  }
  throw new Error(`HTTP ${lastStatus} on ${url}: ${lastBody}`);
}
