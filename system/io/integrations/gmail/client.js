const SKIP_LABELS_DEFAULT = ['TRASH', 'SPAM', 'CATEGORY_PROMOTIONS'];
const FIRST_SYNC_CAP = 500;
const PAGE_SIZE = 100;
// Max bytes of body text to store. Bound the per-row cost on first sync
// (~500 emails × 8KB = 4MB ceiling) and cap embedding compute. Bodies
// past this are truncated with a "[truncated…]" marker so downstream
// recall knows it isn't seeing the tail.
const BODY_MAX_BYTES = 8192;

async function gmailFetch(path, { accessToken, fetchFn = globalThis.fetch, signal }) {
  const r = await fetchFn(`https://gmail.googleapis.com/gmail/v1/users/me${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal,
  });
  if (r.status === 401) {
    const err = new Error('gmail 401');
    err.code = 'auth_expired';
    throw err;
  }
  if (r.status === 404 || r.status === 410) {
    const err = new Error(`gmail history expired: ${r.status}`);
    err.code = 'history_expired';
    throw err;
  }
  if (!r.ok) throw new Error(`gmail ${path} failed: ${r.status}`);
  return await r.json();
}

export async function listMessages({ accessToken, q = '', pageToken, fetchFn, signal }) {
  const params = new URLSearchParams({ maxResults: String(PAGE_SIZE), q });
  if (pageToken) params.set('pageToken', pageToken);
  return await gmailFetch(`/messages?${params}`, { accessToken, fetchFn, signal });
}

export async function getMessage({ accessToken, id, fetchFn, signal }) {
  // format=full returns headers + the full MIME tree with base64url-encoded
  // body parts. Trades ~5-50KB per message vs format=metadata's ~1KB, but
  // gives recall the actual content to embed against instead of just a
  // ~100-char snippet. Bodies are capped to BODY_MAX_BYTES downstream.
  return await gmailFetch(`/messages/${id}?format=full`, { accessToken, fetchFn, signal });
}

export async function listHistory({ accessToken, startHistoryId, pageToken, fetchFn, signal }) {
  const params = new URLSearchParams({ startHistoryId, historyTypes: 'messageAdded' });
  if (pageToken) params.set('pageToken', pageToken);
  return await gmailFetch(`/history?${params}`, { accessToken, fetchFn, signal });
}

export async function getProfile({ accessToken, fetchFn, signal }) {
  return await gmailFetch('/profile', { accessToken, fetchFn, signal });
}

export async function getThread({ accessToken, threadId, fetchFn, signal }) {
  return await gmailFetch(`/threads/${threadId}`, { accessToken, fetchFn, signal });
}

// Walk a Gmail MIME payload and return the best text body found. Gmail
// nests parts under `payload.parts` (recursively for multipart/* types)
// and base64url-encodes leaf-part bodies in `body.data`. We prefer
// text/plain; fall back to text/html with tags stripped. Inline
// attachments and unknown mime types are skipped.
export function extractBody(payload) {
  if (!payload) return '';
  const plain = findPart(payload, 'text/plain');
  if (plain) {
    const text = decodePart(plain);
    if (text) return text;
  }
  const html = findPart(payload, 'text/html');
  if (html) {
    const raw = decodePart(html);
    if (raw) return stripHtml(raw);
  }
  // Single-part messages stash content on payload.body directly without
  // any parts[] tree. Fall back to that when no walkable subtree exists.
  if (payload.body?.data) {
    const raw = base64UrlDecode(payload.body.data);
    if (payload.mimeType === 'text/html') return stripHtml(raw);
    return raw;
  }
  return '';
}

function findPart(part, wantMime) {
  if (part.mimeType === wantMime && part.body?.data) return part;
  for (const child of part.parts ?? []) {
    const hit = findPart(child, wantMime);
    if (hit) return hit;
  }
  return null;
}

function decodePart(part) {
  if (!part?.body?.data) return '';
  return base64UrlDecode(part.body.data);
}

function base64UrlDecode(s) {
  if (!s) return '';
  // Gmail uses base64url (-,_ instead of +,/) without padding. Buffer
  // accepts both alphabets via 'base64url' on Node 16+; this is the
  // fast path. The replace+padStart is a fallback for environments
  // where 'base64url' isn't recognized (older Node, edge runtimes).
  try {
    return Buffer.from(s, 'base64url').toString('utf8');
  } catch {
    const padded = s.replace(/-/g, '+').replace(/_/g, '/');
    const padLen = (4 - (padded.length % 4)) % 4;
    return Buffer.from(padded + '='.repeat(padLen), 'base64').toString('utf8');
  }
}

// Strip HTML for the rare email that has no text/plain alternative.
// This is deliberately minimal — marketing HTML soup gets reduced to
// readable text, not perfectly preserved structure. Recall + the
// outbound-policy taint gate are the downstream consumers and both
// work fine on flattened text.
export function stripHtml(html) {
  if (!html) return '';
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(p|div|tr|li|h[1-6])\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number.parseInt(n, 10)))
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function truncateBody(body, max = BODY_MAX_BYTES) {
  if (!body) return '';
  // Byte-length cap, not codepoint count. UTF-8 multi-byte chars near
  // the cutoff get sliced cleanly because Buffer.byteLength counts the
  // encoded form.
  if (Buffer.byteLength(body, 'utf8') <= max) return body;
  // Drop chars from the tail until we fit. For ASCII-heavy bodies this
  // is one slice; for emoji-dense content it iterates a few times.
  let out = body;
  while (Buffer.byteLength(out, 'utf8') > max - 16) out = out.slice(0, -64);
  return `${out.replace(/\s+$/, '')}\n…[truncated]`;
}

export function buildEventFromMessage(msg) {
  const headers = msg.payload?.headers ?? [];
  const get = (name) =>
    headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';
  const subject = get('Subject');
  const from = get('From');
  const snippet = msg.snippet ?? '';
  const labels = msg.labelIds ?? [];
  const body = truncateBody(extractBody(msg.payload));
  // content layout: header line (subject + from) → snippet (preview) →
  // blank line → body. Blank line separator means the embedder can
  // attend to the body without the snippet duplicating tokens at the
  // boundary. Empty bodies (no walkable part) collapse to the legacy
  // header+snippet shape so downstream consumers don't see trailing
  // whitespace.
  const contentLines = [`Subject: ${subject} | From: ${from}`, snippet];
  if (body) contentLines.push('', body);
  return {
    source: 'gmail',
    content: contentLines.join('\n'),
    ts: new Date(Number.parseInt(msg.internalDate, 10)),
    external_id: msg.id,
    meta: {
      gmail_id: msg.id,
      thread_id: msg.threadId,
      labels,
      internal_date: msg.internalDate,
      body,
    },
  };
}

export function shouldSkipMessage(msg, skipLabels = SKIP_LABELS_DEFAULT) {
  const labels = msg.labelIds ?? [];
  return labels.some((l) => skipLabels.includes(l));
}

export { BODY_MAX_BYTES, FIRST_SYNC_CAP, PAGE_SIZE, SKIP_LABELS_DEFAULT };
