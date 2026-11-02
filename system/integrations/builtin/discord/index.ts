import { checkOutbound } from '../../../lib/discretion/policy.ts';
import type { Integration, IntegrationContext } from '../../_runtime/types.ts';

const API = 'https://discord.com/api/v10';
/** Discord rejects any message body over 2000 chars outright. */
const CONTENT_LIMIT = 2000;
/**
 * SUPPRESS_NOTIFICATIONS (1 << 12) — Discord's "silent message". The message
 * lands and shows an unread mark, but fires no push and no sound, so a 4:30am
 * delivery doesn't wake anyone. One of the four flags Create Message accepts.
 */
const SUPPRESS_NOTIFICATIONS = 1 << 12;
/**
 * SUPPRESS_EMBEDS (1 << 2) — no link-preview cards. A brief carries ~28 links
 * (every Gmail row is one), and unsuppressed each would unfurl into its own
 * card, burying the text. Default ON everywhere; the bare URL still renders and
 * is still clickable.
 */
const SUPPRESS_EMBEDS = 1 << 2;

function messageFlags(opts: { silent?: boolean; suppressEmbeds?: boolean }): number {
  return (
    (opts.silent ? SUPPRESS_NOTIFICATIONS : 0) |
    (opts.suppressEmbeds === false ? 0 : SUPPRESS_EMBEDS)
  );
}

export interface DiscordNotifyParams {
  title?: string;
  message: string;
  link?: string;
  /** Prefix the operator's `<@id>` so the message actually pings. Defaults to true. */
  mention?: boolean;
  /** Deliver without a push notification or sound (Discord's silent message). */
  silent?: boolean;
  /** Link-preview cards. Suppressed unless explicitly set to false. */
  suppressEmbeds?: boolean;
  channelId?: string;
}

export interface DiscordResult {
  delivered: boolean;
  reason?: string;
  channelId?: string;
  messageId?: string;
}

interface DiscordDeps {
  fetch?: typeof fetch;
  env?: NodeJS.ProcessEnv;
}

/**
 * DM channels are stable per recipient but cost a round trip to open. Cache for
 * the life of the process — a daemon that pings often shouldn't re-open it
 * every time, and a stale id just 404s into the normal error path.
 */
const dmChannelCache = new Map<string, string>();

function operatorId(env: NodeJS.ProcessEnv): string | null {
  const raw = env.DISCORD_ALLOWED_USER_IDS ?? '';
  const first = raw.split(',')[0]?.trim();
  return first || null;
}

export function formatMessage(params: DiscordNotifyParams, env: NodeJS.ProcessEnv): string {
  const parts: string[] = [];
  if (params.mention !== false) {
    const uid = operatorId(env);
    if (uid) parts.push(`<@${uid}>`);
  }
  if (params.title) parts.push(`**${params.title}**`);
  const head = parts.join(' ');
  const body = [head, params.message].filter(Boolean).join('\n');
  const full = params.link ? `${body}\n${params.link}` : body;
  return full.length > CONTENT_LIMIT ? `${full.slice(0, CONTENT_LIMIT - 1)}…` : full;
}

async function api(
  path: string,
  init: RequestInit,
  deps: DiscordDeps,
): Promise<Record<string, unknown>> {
  const env = deps.env ?? process.env;
  const token = env.DISCORD_BOT_TOKEN;
  if (!token) throw new Error('DISCORD_BOT_TOKEN not set');
  const doFetch = deps.fetch ?? fetch;
  const send = () =>
    doFetch(`${API}${path}`, {
      ...init,
      headers: {
        authorization: `Bot ${token}`,
        'content-type': 'application/json',
        // Discord requires the `DiscordBot ($url, $version)` shape. A generic
        // UA gets bounced by Cloudflare with a bare `error code: 1010` that
        // looks like an auth failure but isn't.
        'user-agent': 'DiscordBot (https://askrobin.io, 1.0)',
        ...(init.headers as Record<string, string> | undefined),
      },
    });

  let res = await send();
  // One retry on a rate limit: Discord tells us exactly how long to wait, and a
  // notification that arrives a second late still beats one that never lands.
  if (res.status === 429) {
    const body = (await res.json().catch(() => ({}))) as { retry_after?: number };
    const waitMs = Math.min((body.retry_after ?? 1) * 1000, 10_000);
    await new Promise((r) => setTimeout(r, waitMs));
    res = await send();
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(
      `discord ${init.method ?? 'GET'} ${path} → ${res.status} ${text.slice(0, 200)}`,
    );
  }
  return (await res.json().catch(() => ({}))) as Record<string, unknown>;
}

async function postMessage(
  channelId: string,
  content: string,
  deps: DiscordDeps,
  opts: { silent?: boolean; suppressEmbeds?: boolean } = {},
): Promise<DiscordResult> {
  // Resolve no mention from the text itself (a quoted email subject could say
  // @everyone or <@&role>); only the operator's own ping may notify.
  const uid = operatorId(deps.env ?? process.env);
  const body: Record<string, unknown> = {
    content,
    allowed_mentions: { parse: [], users: uid ? [uid] : [] },
  };
  const flags = messageFlags(opts);
  if (flags) body.flags = flags;
  const out = await api(
    `/channels/${channelId}/messages`,
    { method: 'POST', body: JSON.stringify(body) },
    deps,
  );
  return { delivered: true, channelId, messageId: typeof out.id === 'string' ? out.id : undefined };
}

/**
 * Split text into Discord-sized messages, preferring blank-line boundaries so a
 * brief's sections never tear mid-paragraph. Falls back to line boundaries, then
 * to a hard slice for a single paragraph or line that is itself over the cap.
 */
export function chunkContent(text: string, limit = CONTENT_LIMIT): string[] {
  const chunks: string[] = [];
  let current = '';

  const flush = () => {
    if (current.trim()) chunks.push(current.trim());
    current = '';
  };
  const push = (piece: string, sep: string) => {
    const candidate = current ? `${current}${sep}${piece}` : piece;
    if (candidate.length <= limit) {
      current = candidate;
      return true;
    }
    return false;
  };

  for (const block of text.split(/\n{2,}/)) {
    if (push(block, '\n\n')) continue;
    flush();
    if (block.length <= limit) {
      current = block;
      continue;
    }
    // Oversized block: fall back to line boundaries, then a hard slice.
    for (const line of block.split('\n')) {
      if (push(line, '\n')) continue;
      flush();
      let rest = line;
      while (rest.length > limit) {
        chunks.push(rest.slice(0, limit));
        rest = rest.slice(limit);
      }
      current = rest;
    }
  }
  flush();
  return chunks;
}

/** A markdown table wider than this stops being scannable on a phone. */
const TABLE_CODE_BLOCK_MAX_WIDTH = 56;
/** Above this a code block risks being torn across a chunk, breaking the fence. */
const TABLE_CODE_BLOCK_MAX_CHARS = 1500;

function splitRow(line: string): string[] {
  return line
    .replace(/^\s*\|/, '')
    .replace(/\|\s*$/, '')
    .split('|')
    .map((c) => c.trim());
}

/** `| --- | ---: |` — the separator that makes the preceding line a header. */
function isSeparator(line: string): boolean {
  return /^\s*\|(\s*:?-{3,}:?\s*\|)+\s*$/.test(line);
}

function renderTable(header: string[], rows: string[][], aligns: string[]): string {
  const hasLinks = [...rows.flat(), ...header].some((c) => c.includes(']('));
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const total = widths.reduce((a, b) => a + b + 2, 0);

  // Monospace keeps number columns aligned, which is the reason for the
  // finance/balance tables — but a code block swallows markdown links and
  // scrolls sideways on a phone, so it only earns its place when the table is
  // link-free and narrow.
  if (!hasLinks && total <= TABLE_CODE_BLOCK_MAX_WIDTH) {
    const pad = (c: string, i: number) =>
      aligns[i] === 'right' ? c.padStart(widths[i]) : c.padEnd(widths[i]);
    const lines = [
      header.map(pad).join('  '),
      widths.map((w) => '-'.repeat(w)).join('  '),
      ...rows.map((r) => header.map((_, i) => pad(r[i] ?? '', i)).join('  ')),
    ];
    const block = `\`\`\`\n${lines.join('\n').trimEnd()}\n\`\`\``;
    if (block.length <= TABLE_CODE_BLOCK_MAX_CHARS) return block;
  }

  // Otherwise one bullet per row: no horizontal scroll, links intact.
  const head = header.filter(Boolean).join(' · ');
  const body = rows.map((r) => `- ${r.filter(Boolean).join(' · ')}`);
  return [head ? `**${head}**` : '', ...body].filter(Boolean).join('\n');
}

/**
 * Discord renders no markdown tables — a `|`-delimited table arrives as raw
 * pipes. Rewrite each table into something legible: an aligned code block when
 * it is narrow and link-free, bullet-per-row otherwise. Non-table text passes
 * through untouched.
 */
export function mdTablesToDiscord(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let inFence = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) inFence = !inFence;

    const isTableStart =
      !inFence && line.trim().startsWith('|') && i + 1 < lines.length && isSeparator(lines[i + 1]);
    if (!isTableStart) {
      out.push(line);
      continue;
    }

    const header = splitRow(line);
    const aligns = splitRow(lines[i + 1]).map((c) => (c.endsWith(':') ? 'right' : 'left'));
    const rows: string[][] = [];
    let j = i + 2;
    for (; j < lines.length && lines[j].trim().startsWith('|'); j++) {
      rows.push(splitRow(lines[j]));
    }
    out.push(renderTable(header, rows, aligns));
    i = j - 1;
  }
  return out.join('\n');
}

async function openDm(userId: string, deps: DiscordDeps): Promise<string> {
  const cached = dmChannelCache.get(userId);
  if (cached) return cached;
  const out = await api(
    '/users/@me/channels',
    { method: 'POST', body: JSON.stringify({ recipient_id: userId }) },
    deps,
  );
  const id = out.id;
  if (typeof id !== 'string') throw new Error('discord DM channel open returned no id');
  dmChannelCache.set(userId, id);
  return id;
}

/**
 * Post a notification to a Discord channel. Never throws — mirrors
 * `notifyMacOSAction` so operational callers can fan out to both transports
 * without either one being able to take down the caller.
 */
export async function notifyDiscordAction(
  params: DiscordNotifyParams,
  deps: DiscordDeps = {},
): Promise<DiscordResult> {
  const env = deps.env ?? process.env;
  try {
    const channelId = params.channelId ?? env.DISCORD_NOTIFY_CHANNEL_ID;
    if (!channelId) return { delivered: false, reason: 'DISCORD_NOTIFY_CHANNEL_ID not set' };
    const content = formatMessage(params, env);
    // Same guard the Discord reply path was always meant to carry: a PII or
    // credential shape must not reach a channel, however it got composed.
    const verdict = checkOutbound({ text: content, destination: `discord:channel:${channelId}` });
    if (!verdict.ok) return { delivered: false, reason: `discretion:${verdict.reason}` };
    return await postMessage(channelId, content, deps, params);
  } catch (err) {
    return { delivered: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/** Direct-message the operator. Never throws; same contract as `notifyDiscordAction`. */
export async function dmDiscordAction(
  params: DiscordNotifyParams,
  deps: DiscordDeps = {},
): Promise<DiscordResult> {
  const env = deps.env ?? process.env;
  try {
    const uid = operatorId(env);
    if (!uid) return { delivered: false, reason: 'DISCORD_ALLOWED_USER_IDS not set' };
    // A DM is already addressed to one person; an @-mention on top is noise.
    const content = formatMessage({ ...params, mention: false }, env);
    const verdict = checkOutbound({ text: content, destination: `discord:dm:${uid}` });
    if (!verdict.ok) return { delivered: false, reason: `discretion:${verdict.reason}` };
    const channelId = await openDm(uid, deps);
    return await postMessage(channelId, content, deps, params);
  } catch (err) {
    return { delivered: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

export interface DiscordDigestParams {
  /** Optional heading, prepended to the first chunk. Omit when the body has its own. */
  title?: string;
  /** The long body. Posted as consecutive chunked messages in the channel. */
  body: string;
  /** Defaults to true — a digest is scheduled, not urgent. */
  silent?: boolean;
  /** Defaults to false — a silent push and an @-mention work against each other. */
  mention?: boolean;
  /** Link-preview cards. Suppressed unless explicitly set to false. */
  suppressEmbeds?: boolean;
  channelId?: string;
}

export interface DiscordDigestResult extends DiscordResult {
  parts?: number;
}

/**
 * Post a long document straight into the channel as consecutive messages,
 * split on paragraph boundaries. Deliberately NOT a thread: a brief is meant to
 * be read inline in the channel, so the content has to be in the channel
 * itself rather than one tap behind a collapsed summary.
 *
 * Never throws — a failure mid-way still leaves the earlier parts delivered,
 * and the caller (the brief job) has already persisted the document to disk.
 */
export async function postDigestAction(
  params: DiscordDigestParams,
  deps: DiscordDeps = {},
): Promise<DiscordDigestResult> {
  const env = deps.env ?? process.env;
  try {
    const channelId = params.channelId ?? env.DISCORD_NOTIFY_CHANNEL_ID;
    if (!channelId) return { delivered: false, reason: 'DISCORD_NOTIFY_CHANNEL_ID not set' };
    const silent = params.silent !== false;

    const heading = params.title
      ? formatMessage({ title: params.title, message: '', mention: params.mention === true }, env)
      : '';
    const full = heading ? `${heading}\n\n${params.body}` : params.body;

    const verdict = checkOutbound({ text: full, destination: `discord:channel:${channelId}` });
    if (!verdict.ok) return { delivered: false, reason: `discretion:${verdict.reason}` };

    const chunks = chunkContent(mdTablesToDiscord(full));
    let first: DiscordResult | undefined;
    for (const chunk of chunks) {
      const sent = await postMessage(channelId, chunk, deps, {
        silent,
        suppressEmbeds: params.suppressEmbeds,
      });
      first ??= sent;
    }
    return { delivered: true, channelId, messageId: first?.messageId, parts: chunks.length };
  } catch (err) {
    return { delivered: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

async function probe(deps: DiscordDeps): Promise<{ ok: boolean; message: string }> {
  const env = deps.env ?? process.env;
  if (!env.DISCORD_BOT_TOKEN) return { ok: false, message: 'DISCORD_BOT_TOKEN not set' };
  const me = await api('/users/@me', { method: 'GET' }, deps);
  const guilds = (await api('/users/@me/guilds', { method: 'GET' }, deps)) as unknown as Array<{
    id: string;
  }>;
  const want = env.DISCORD_ALLOWED_GUILD_ID;
  const inGuild = !want || (Array.isArray(guilds) && guilds.some((g) => g.id === want));
  return {
    ok: inGuild,
    message: inGuild
      ? `${me.username}#${me.discriminator} in ${Array.isArray(guilds) ? guilds.length : 0} guild(s)`
      : `bot is not a member of guild ${want}`,
  };
}

export const integration: Integration = {
  async tick(ctx: IntegrationContext) {
    try {
      const p = await probe({ fetch: ctx.fetch });
      return { status: p.ok ? 'ok' : 'error', message: p.message };
    } catch (err) {
      return { status: 'error', message: err instanceof Error ? err.message : String(err) };
    }
  },

  async health(ctx: IntegrationContext) {
    try {
      return await probe({ fetch: ctx.fetch });
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  },
};

export const actions = {
  async notify(params: DiscordNotifyParams, ctx: IntegrationContext): Promise<DiscordResult> {
    const out = await notifyDiscordAction(params, { fetch: ctx.fetch });
    if (!out.delivered) throw new Error(out.reason ?? 'discord notify failed');
    return out;
  },
  async dm(params: DiscordNotifyParams, ctx: IntegrationContext): Promise<DiscordResult> {
    const out = await dmDiscordAction(params, { fetch: ctx.fetch });
    if (!out.delivered) throw new Error(out.reason ?? 'discord dm failed');
    return out;
  },
  async digest(params: DiscordDigestParams, ctx: IntegrationContext): Promise<DiscordDigestResult> {
    const out = await postDigestAction(params, { fetch: ctx.fetch });
    if (!out.delivered) throw new Error(out.reason ?? 'discord digest failed');
    return out;
  },
};
