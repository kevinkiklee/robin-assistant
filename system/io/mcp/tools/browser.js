// Browser-automation MCP tool — wraps Playwright for sites Robin's
// integrations don't cover (Glass.photo, gallery announcements, brokerage
// screenshots, etc.).
//
// Playwright is an optional peer dependency. The tool returns
// { ok: false, reason: 'playwright_unavailable' } when not installed.
// Install: `pnpm add -E playwright && pnpm exec playwright install chromium`.
//
// One persistent Chromium per daemon (lazy-launched on first call). Per-call
// contexts are cheap (~50ms) and isolated from each other. Pool restarts
// after MAX_USES_PER_BROWSER to bound memory creep.

let pwModulePromise = null;
let browser = null;
let usesSinceLaunch = 0;
const MAX_USES_PER_BROWSER = 200;
const DEFAULT_TIMEOUT_MS = 30_000;

async function getPlaywright() {
  if (pwModulePromise == null) {
    pwModulePromise = import('playwright').catch(() => null);
  }
  return pwModulePromise;
}

async function getBrowser() {
  const pw = await getPlaywright();
  if (!pw) return null;
  if (browser && usesSinceLaunch < MAX_USES_PER_BROWSER) return browser;
  if (browser) {
    try { await browser.close(); } catch { /* ignore */ }
  }
  browser = await pw.chromium.launch({ headless: true });
  usesSinceLaunch = 0;
  return browser;
}

function isPrivateOrLocalUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    if (!/^https?:$/.test(u.protocol)) return true;
    const host = u.hostname.toLowerCase();
    if (host === 'localhost' || host.endsWith('.local')) return true;
    if (host === '127.0.0.1' || host.startsWith('169.254.') || host.startsWith('10.')) return true;
    if (host.startsWith('192.168.')) return true;
    // 172.16-172.31 (RFC1918)
    const m = /^172\.(\d{1,3})\./.exec(host);
    if (m) { const n = Number(m[1]); if (n >= 16 && n <= 31) return true; }
    return false;
  } catch {
    return true;
  }
}

async function withContext(profile, fn) {
  const b = await getBrowser();
  if (!b) return { ok: false, reason: 'playwright_unavailable', hint: 'pnpm add playwright && playwright install chromium' };
  let ctx;
  try {
    ctx = await b.newContext({
      userAgent: 'RobinBot/1.0 (+https://askrobin.io)',
      viewport: { width: 1280, height: 800 },
    });
    usesSinceLaunch += 1;
    const result = await fn(ctx);
    return result;
  } catch (e) {
    return { ok: false, reason: 'playwright_error', error: String(e?.message ?? e) };
  } finally {
    try { if (ctx) await ctx.close(); } catch { /* ignore */ }
  }
}

export function createBrowserVisitTool() {
  return {
    name: 'browser_visit',
    description: 'Navigate to a URL with a headless browser and return the rendered text. Use for sites that need JS to populate content.',
    inputSchema: {
      type: 'object',
      properties: {
        url:       { type: 'string', minLength: 1, maxLength: 2048 },
        timeout_ms:{ type: 'number', minimum: 1000, maximum: 60_000 },
      },
      required: ['url'],
    },
    handler: async ({ url, timeout_ms = DEFAULT_TIMEOUT_MS }) => {
      if (isPrivateOrLocalUrl(url)) return { ok: false, reason: 'url_blocked', error: 'private/local URLs disallowed' };
      return withContext(null, async (ctx) => {
        const page = await ctx.newPage();
        try {
          const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeout_ms });
          const text = await page.evaluate(() => document.body?.innerText || '');
          return {
            ok: true,
            url,
            final_url: page.url(),
            status: resp?.status() ?? null,
            title: await page.title(),
            text: text.slice(0, 50_000),
            truncated: text.length > 50_000,
          };
        } finally {
          await page.close();
        }
      });
    },
  };
}

export function createBrowserScreenshotTool() {
  return {
    name: 'browser_screenshot',
    description: 'Take a PNG screenshot of a URL (full page by default; pass `selector` to crop). Returns base64 image data and metadata.',
    inputSchema: {
      type: 'object',
      properties: {
        url:        { type: 'string', minLength: 1, maxLength: 2048 },
        selector:   { type: 'string', maxLength: 256 },
        full_page:  { type: 'boolean', default: true },
        timeout_ms: { type: 'number', minimum: 1000, maximum: 60_000 },
      },
      required: ['url'],
    },
    handler: async ({ url, selector, full_page = true, timeout_ms = DEFAULT_TIMEOUT_MS }) => {
      if (isPrivateOrLocalUrl(url)) return { ok: false, reason: 'url_blocked' };
      return withContext(null, async (ctx) => {
        const page = await ctx.newPage();
        try {
          await page.goto(url, { waitUntil: 'networkidle', timeout: timeout_ms });
          let buf;
          if (selector) {
            const handle = await page.waitForSelector(selector, { timeout: 5000 });
            buf = await handle.screenshot({ type: 'png' });
          } else {
            buf = await page.screenshot({ type: 'png', fullPage: full_page });
          }
          return {
            ok: true,
            url,
            final_url: page.url(),
            content_type: 'image/png',
            base64: buf.toString('base64'),
            size_bytes: buf.length,
          };
        } finally {
          await page.close();
        }
      });
    },
  };
}

export function createBrowserExtractTool() {
  return {
    name: 'browser_extract',
    description: 'Extract text from one or more CSS selectors on a URL. Returns array of {selector, count, items[]} where each item is .textContent.',
    inputSchema: {
      type: 'object',
      properties: {
        url:        { type: 'string', minLength: 1, maxLength: 2048 },
        selectors:  { type: 'array', items: { type: 'string', maxLength: 256 }, minItems: 1, maxItems: 20 },
        timeout_ms: { type: 'number', minimum: 1000, maximum: 60_000 },
      },
      required: ['url', 'selectors'],
    },
    handler: async ({ url, selectors, timeout_ms = DEFAULT_TIMEOUT_MS }) => {
      if (isPrivateOrLocalUrl(url)) return { ok: false, reason: 'url_blocked' };
      return withContext(null, async (ctx) => {
        const page = await ctx.newPage();
        try {
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeout_ms });
          const results = await Promise.all(
            selectors.map(async (sel) => {
              try {
                const items = await page.$$eval(sel, (els) =>
                  els.slice(0, 200).map((e) => (e.textContent ?? '').trim()).filter(Boolean),
                );
                return { selector: sel, count: items.length, items };
              } catch (e) {
                return { selector: sel, count: 0, items: [], error: String(e?.message ?? e) };
              }
            }),
          );
          return { ok: true, url, final_url: page.url(), results };
        } finally {
          await page.close();
        }
      });
    },
  };
}

// Internal: expose pool teardown for daemon shutdown.
export async function closeBrowser() {
  if (browser) {
    try { await browser.close(); } catch { /* ignore */ }
    browser = null;
    usesSinceLaunch = 0;
  }
}

// Exported for tests.
export const __test__ = { isPrivateOrLocalUrl };
