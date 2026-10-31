import { ingest } from '../../../brain/memory/ingest.ts';
import { getGoogleAccessToken } from '../../_auth/oauth-google.ts';
import { makeGoogleGet } from '../../_runtime/google-api.ts';
import type { Integration, IntegrationContext } from '../../_runtime/types.ts';

const API_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';
const gmailGet = makeGoogleGet('gmail', API_BASE);

interface MessageListItem {
  id: string;
  threadId: string;
}

interface MessagePart {
  mimeType?: string;
  headers?: Array<{ name: string; value: string }>;
  body?: { data?: string };
  parts?: MessagePart[];
}

interface Message {
  id: string;
  threadId: string;
  snippet: string;
  payload?: MessagePart;
  internalDate?: string;
}

interface ListResponse {
  messages?: MessageListItem[];
  nextPageToken?: string;
  resultSizeEstimate?: number;
}

function header(msg: Message, name: string): string | null {
  return (
    msg.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? null
  );
}

/**
 * Extract plain-text body from a `format=full` message payload. Prefers a
 * `text/plain` part anywhere in the MIME tree; falls back to decoding whatever
 * top-level body data exists (simple non-multipart messages).
 */
function bodyText(part: MessagePart | undefined): string | null {
  if (!part) return null;
  if (part.mimeType?.startsWith('text/plain') && part.body?.data) {
    return Buffer.from(part.body.data, 'base64url').toString('utf8');
  }
  for (const p of part.parts ?? []) {
    const text = bodyText(p);
    if (text) return text;
  }
  if (part.body?.data) return Buffer.from(part.body.data, 'base64url').toString('utf8');
  return null;
}

export const integration: Integration = {
  async tick(ctx) {
    let token: string;
    try {
      token = await getGoogleAccessToken(ctx, 'GMAIL');
    } catch (err) {
      return { status: 'skipped', message: err instanceof Error ? err.message : String(err) };
    }

    // Filter out Gmail's auto-tabbed promo/social/forum mail, then take
    // recent inbox traffic regardless of read state — mail is often read on
    // another device before the daemon ticks, so `is:unread` silently dropped
    // everything personally-relevant. `category:updates` stays IN: Gmail
    // auto-files transactional mail there (deposit confirmations, shipping,
    // Search Console alerts), and excluding it made the brief report "no new
    // mail" on days with real inbox traffic. Content-hash dedup in `ingest()`
    // keeps re-ingestion of already-seen messages cheap.
    const exclude = '-category:promotions -category:social -category:forums';
    const lastSyncTs = ctx.state.get('last_sync_ts');
    const q = lastSyncTs
      ? `in:inbox ${exclude} after:${Math.floor(Number.parseInt(lastSyncTs, 10) / 1000)}`
      : `in:inbox ${exclude} newer_than:1d`;

    const list = await gmailGet<ListResponse>(
      ctx,
      `/messages?q=${encodeURIComponent(q)}&maxResults=25`,
      token,
    );
    let ingested = 0;
    for (const m of list.messages ?? []) {
      const msg = await gmailGet<Message>(
        ctx,
        `/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
        token,
      );
      const from = header(msg, 'From') ?? 'unknown';
      const subject = header(msg, 'Subject') ?? '(no subject)';
      const summary = `[gmail] From: ${from}\nSubject: ${subject}\n\n${msg.snippet}`;
      await ingest(ctx.db, ctx.llm, {
        kind: 'integration.gmail.message',
        source: 'gmail',
        content: summary,
        payload: { id: msg.id, threadId: msg.threadId, from, subject },
      });
      ingested++;
    }
    ctx.state.set('last_sync_ts', String(Date.now()));

    // Sent-mail leg: feeds the voice-profile corpus and draft diffing
    // (docs/design/2026-08-08-voice-profile-plan.md, Task 7). Full body text is
    // needed, so fetch format=full. No category excludes — Gmail doesn't tab
    // sent mail. Own cursor and its own try/catch so a sent-leg failure logs a
    // warning but never breaks inbox sync.
    try {
      const lastSentTs = ctx.state.get('last_sent_sync_ts');
      const sentQ = lastSentTs
        ? `in:sent after:${Math.floor(Number.parseInt(lastSentTs, 10) / 1000)}`
        : 'in:sent newer_than:1d';
      const sentList = await gmailGet<ListResponse>(
        ctx,
        `/messages?q=${encodeURIComponent(sentQ)}&maxResults=25`,
        token,
      );
      for (const m of sentList.messages ?? []) {
        const msg = await gmailGet<Message>(ctx, `/messages/${m.id}?format=full`, token);
        const to = header(msg, 'To') ?? 'unknown';
        const subject = header(msg, 'Subject') ?? '(no subject)';
        const body = bodyText(msg.payload) ?? msg.snippet;
        await ingest(ctx.db, ctx.llm, {
          kind: 'integration.gmail.sent',
          source: 'gmail',
          content: `[gmail sent] To: ${to}\nSubject: ${subject}\n\n${body}`,
          payload: { id: msg.id, threadId: msg.threadId, to, subject },
        });
        ingested++;
      }
      ctx.state.set('last_sent_sync_ts', String(Date.now()));
    } catch (err) {
      ctx.log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'gmail sent-mail sync failed; inbox sync unaffected',
      );
    }

    return { status: 'ok', ingested };
  },

  async health(ctx) {
    const last = ctx.state.get('last_sync_ts');
    if (!process.env.GMAIL_REFRESH_TOKEN)
      return { ok: false, message: 'GMAIL_REFRESH_TOKEN not set' };
    return {
      ok: true,
      message: last
        ? `last sync: ${new Date(Number.parseInt(last, 10)).toISOString()}`
        : 'never synced',
    };
  },
};

export const actions = {
  async search(
    params: { q: string; max?: number },
    ctx: IntegrationContext,
  ): Promise<MessageListItem[]> {
    const token = await getGoogleAccessToken(ctx, 'GMAIL');
    const list = await gmailGet<ListResponse>(
      ctx,
      `/messages?q=${encodeURIComponent(params.q)}&maxResults=${params.max ?? 25}`,
      token,
    );
    return list.messages ?? [];
  },
  async get_thread(
    params: { id: string },
    ctx: IntegrationContext,
  ): Promise<{ id: string; messages: Message[] }> {
    const token = await getGoogleAccessToken(ctx, 'GMAIL');
    const thread = await gmailGet<{ id: string; messages: Message[] }>(
      ctx,
      `/threads/${params.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
      token,
    );
    return thread;
  },
  async preview(
    params: { q: string },
    ctx: IntegrationContext,
  ): Promise<Array<{ id: string; from: string; subject: string; snippet: string }>> {
    const token = await getGoogleAccessToken(ctx, 'GMAIL');
    const list = await gmailGet<ListResponse>(
      ctx,
      `/messages?q=${encodeURIComponent(params.q)}&maxResults=10`,
      token,
    );
    const out: Array<{ id: string; from: string; subject: string; snippet: string }> = [];
    for (const m of list.messages ?? []) {
      const msg = await gmailGet<Message>(
        ctx,
        `/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`,
        token,
      );
      out.push({
        id: msg.id,
        from: header(msg, 'From') ?? '',
        subject: header(msg, 'Subject') ?? '',
        snippet: msg.snippet,
      });
    }
    return out;
  },
};
