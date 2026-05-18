import { requireSecret, saveSecret } from '../../../../config/secrets.js';
import { getAccessToken } from '../../_auth/token-cache.js';
import { getThread } from '../client.js';
import { wrapUntrusted } from '../../../../cognition/discretion/wrap-untrusted.js';

const SENSITIVE_HEADERS = new Set(['Subject', 'From', 'To', 'Reply-To', 'Cc']);

function wrapField(text, msgId) {
  return wrapUntrusted(text ?? '', { source: 'gmail', eventId: msgId, trust: 'untrusted' });
}

function decodeBody(parts) {
  if (!Array.isArray(parts)) return null;
  for (const part of parts) {
    if (part.mimeType === 'text/plain' && part.body?.data) {
      return Buffer.from(part.body.data, 'base64url').toString('utf8');
    }
    // Recurse into multipart
    if (Array.isArray(part.parts)) {
      const nested = decodeBody(part.parts);
      if (nested != null) return nested;
    }
  }
  return null;
}

export function wrapThreadMessages(thread) {
  if (!thread || !Array.isArray(thread.messages)) return thread;
  return {
    ...thread,
    messages: thread.messages.map((msg) => {
      const msgId = msg.id;

      const snippet = msg.snippet != null ? wrapField(msg.snippet, msgId) : msg.snippet;

      const headers = Array.isArray(msg.payload?.headers)
        ? msg.payload.headers.map((h) =>
            SENSITIVE_HEADERS.has(h.name) ? { ...h, value: wrapField(h.value, msgId) } : h,
          )
        : msg.payload?.headers;

      const rawBody = decodeBody(msg.payload?.parts);
      const body = rawBody != null ? wrapField(rawBody, msgId) : null;

      const payload = msg.payload != null ? { ...msg.payload, headers } : msg.payload;

      return { ...msg, snippet, payload, body };
    }),
  };
}

function buildSecrets() {
  return {
    GOOGLE_OAUTH_REFRESH_TOKEN: requireSecret('GOOGLE_OAUTH_REFRESH_TOKEN'),
    GOOGLE_OAUTH_CLIENT_ID: requireSecret('GOOGLE_OAUTH_CLIENT_ID'),
    GOOGLE_OAUTH_CLIENT_SECRET: requireSecret('GOOGLE_OAUTH_CLIENT_SECRET'),
  };
}

export function createGmailGetThreadTool() {
  return {
    name: 'gmail_get_thread',
    description: 'Fetch a Gmail thread by ID; returns full message bodies.',
    inputSchema: {
      type: 'object',
      properties: { thread_id: { type: 'string' } },
      required: ['thread_id'],
    },
    handler: async (args) => {
      try {
        const accessToken = await getAccessToken({
          provider: 'google',
          secrets: buildSecrets(),
          saveSecret,
        });
        const thread = await getThread({ accessToken, threadId: args.thread_id });
        return { thread: wrapThreadMessages(thread) };
      } catch (e) {
        if (/missing secret/.test(e.message)) {
          throw new Error(
            'gmail not authenticated; run: robin secrets import --from <v1-user-data>',
          );
        }
        throw e;
      }
    },
  };
}
