import { ingest } from '../../../brain/memory/ingest.ts';
import { getGoogleAccessToken } from '../../_auth/oauth-google.ts';
import type { Integration, IntegrationContext } from '../../_runtime/types.ts';

const API_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';

interface MessageListItem {
  id: string;
  threadId: string;
}

interface Message {
  id: string;
  threadId: string;
  snippet: string;
  payload?: { headers?: Array<{ name: string; value: string }> };
  internalDate?: string;
}

interface ListResponse {
  messages?: MessageListItem[];
  nextPageToken?: string;
  resultSizeEstimate?: number;
}

async function gmailGet<T>(ctx: IntegrationContext, path: string, token: string): Promise<T> {
  const res = await ctx.fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`gmail ${path} returned ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

function header(msg: Message, name: string): string | null {
  return (
    msg.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? null
  );
}

export const integration: Integration = {
  async tick(ctx) {
    let token: string;
    try {
      token = await getGoogleAccessToken(ctx, 'GMAIL');
    } catch (err) {
      return { status: 'skipped', message: err instanceof Error ? err.message : String(err) };
    }

    // Filter out Gmail's auto-tabbed promo/social/notification mail, then take
    // recent inbox traffic regardless of read state — Kevin reads most mail on
    // his phone before the daemon ticks, so `is:unread` silently dropped
    // everything personally-relevant. Content-hash dedup in `ingest()` keeps
    // re-ingestion of already-seen messages cheap.
    const exclude = '-category:promotions -category:social -category:updates -category:forums';
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
