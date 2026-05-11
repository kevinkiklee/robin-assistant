// HTTP request handler for the in-daemon DB browser.
// Mounted under /db/ inside src/daemon/server.js so it shares dbHandle.
//
// Security:
//   - All endpoints are loopback-only (the daemon binds 127.0.0.1).
//   - Validates Host header against expected port (DNS-rebind defence).
//   - Validates Origin header on POST.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compactFieldDef } from './static/browse-utils.js';
import { ARCHITECTURE, TABLE_INFO, shortDescription } from './table-info.js';
import { isHostAllowed, isOriginAllowed, readJsonBody, sendJson, sendText } from './utils.js';
import {
  getAnalysisCard,
  getDashboard,
  getEntityProfile,
  getEntitySearch,
  getInfo,
  getTableInfo,
  getTrend,
  runQuery,
} from './views.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = join(__dirname, 'static');

// Static files served under /db/static/<name>.
const STATIC_MODULE_FILES = new Set([
  'browse-utils.js',
  'browse-saved.js',
  'browse-cards.js',
  'browse-explainers.js',
  'browse-view.js',
  'browse-view-charts.js',
  'browse-view-dashboard.js',
  'browse-view-analysis.js',
  'browse-view-trends.js',
  'browse-view-inventory.js',
  'browse-view-profile.js',
]);

const HTML_PATH = join(STATIC_DIR, 'index.html');

const DEFAULT_BODY_MAX = 1_000_000;

let cachedHtml = null;
const staticCache = new Map();

function readHtml() {
  if (cachedHtml == null) cachedHtml = readFileSync(HTML_PATH, 'utf8');
  return cachedHtml;
}
function readStatic(name) {
  if (!STATIC_MODULE_FILES.has(name)) return null;
  if (!staticCache.has(name)) {
    try {
      staticCache.set(name, readFileSync(join(STATIC_DIR, name), 'utf8'));
    } catch {
      staticCache.set(name, null);
    }
  }
  return staticCache.get(name);
}

// Returns an async (req, res) => boolean handler. Returns true if the request
// was handled (response written). False means the caller should try other
// routes — used by the daemon to route /db/* here while keeping /internal/* etc.
// at the top of its chain.
export function createBrowserHandler({ db, expectedPort, bodyMax = DEFAULT_BODY_MAX } = {}) {
  return async function handleBrowser(req, res) {
    const rawUrl = req.url ?? '/';
    const path = rawUrl.split('?', 1)[0].replace(/\/+$/, '') || '/';

    // Only handle paths under /db.
    if (path !== '/db' && !path.startsWith('/db/')) return false;

    try {
      if (!isHostAllowed(req.headers.host, expectedPort)) {
        sendJson(res, 403, { error: 'host not allowed' });
        return true;
      }
      if (
        req.method !== 'GET' &&
        req.method !== 'HEAD' &&
        !isOriginAllowed(req.headers.origin, expectedPort)
      ) {
        sendJson(res, 403, { error: 'origin not allowed' });
        return true;
      }

      const sub = path === '/db' ? '' : path.slice('/db'.length);

      // Root HTML.
      if (
        (req.method === 'GET' || req.method === 'HEAD') &&
        (sub === '' || sub === '/' || sub === '/index.html')
      ) {
        sendText(res, 200, readHtml(), 'text/html; charset=utf-8');
        return true;
      }

      // Static modules.
      if ((req.method === 'GET' || req.method === 'HEAD') && sub.startsWith('/static/')) {
        const name = sub.slice('/static/'.length);
        const src = readStatic(name);
        if (src == null) {
          sendJson(res, 404, { error: 'static module not found' });
          return true;
        }
        sendText(res, 200, src, 'application/javascript; charset=utf-8');
        return true;
      }

      // /api/info
      if (req.method === 'GET' && sub === '/api/info') {
        sendJson(res, 200, await getInfo(db, { TABLE_INFO, shortDescription }));
        return true;
      }

      // /api/architecture
      if (req.method === 'GET' && sub === '/api/architecture') {
        sendJson(res, 200, ARCHITECTURE);
        return true;
      }

      // /api/view/dashboard
      if (req.method === 'GET' && sub === '/api/view/dashboard') {
        sendJson(res, 200, await getDashboard(db));
        return true;
      }
      // /api/view/search?q=...
      if (req.method === 'GET' && sub === '/api/view/search') {
        const u = new URL(rawUrl, 'http://x');
        sendJson(res, 200, await getEntitySearch(db, u.searchParams.get('q') || ''));
        return true;
      }
      // /api/view/entity/<slug>
      const entityMatch =
        req.method === 'GET' && /^\/api\/view\/entity\/([A-Za-z0-9._\-]{1,128})$/.exec(sub);
      if (entityMatch) {
        const data = await getEntityProfile(db, entityMatch[1]);
        if (!data) {
          sendJson(res, 404, { error: 'entity not found' });
          return true;
        }
        sendJson(res, 200, data);
        return true;
      }
      // /api/view/analysis/<card>
      const analysisMatch =
        req.method === 'GET' && /^\/api\/view\/analysis\/([a-z0-9_\-]{1,32})$/.exec(sub);
      if (analysisMatch) {
        const data = await getAnalysisCard(db, analysisMatch[1]);
        if (!data) {
          sendJson(res, 404, { error: 'unknown card' });
          return true;
        }
        sendJson(res, 200, data);
        return true;
      }
      // /api/view/trends?metric=...&range=...
      if (req.method === 'GET' && sub === '/api/view/trends') {
        const u = new URL(rawUrl, 'http://x');
        const data = await getTrend(
          db,
          u.searchParams.get('metric'),
          u.searchParams.get('range') || '90d',
        );
        if (!data) {
          sendJson(res, 404, { error: 'unknown metric' });
          return true;
        }
        sendJson(res, 200, data);
        return true;
      }

      // /api/table/<name>
      const tableMatch =
        req.method === 'GET' && /^\/api\/table\/([A-Za-z_][A-Za-z0-9_]{0,63})$/.exec(sub);
      if (tableMatch) {
        sendJson(res, 200, await getTableInfo(db, tableMatch[1], { TABLE_INFO, compactFieldDef }));
        return true;
      }

      // /api/query (POST)
      if (sub === '/api/query') {
        if (req.method !== 'POST') {
          res.setHeader('Allow', 'POST');
          sendJson(res, 405, { error: 'method not allowed' });
          return true;
        }
        const body = await readJsonBody(req, bodyMax);
        if (!body.sql || typeof body.sql !== 'string') {
          sendJson(res, 400, { error: 'missing sql (string)' });
          return true;
        }
        sendJson(res, 200, await runQuery(db, body.sql));
        return true;
      }

      sendJson(res, 404, { error: 'not found' });
      return true;
    } catch (e) {
      const status = Number.isInteger(e?.statusCode) ? e.statusCode : 500;
      sendJson(res, status, { error: String(e?.message ?? e) });
      return true;
    }
  };
}
