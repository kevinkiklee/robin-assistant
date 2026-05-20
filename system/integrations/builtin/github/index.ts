import type { Integration, IntegrationContext } from '../../_runtime/types.ts';
import { ingest } from '../../../brain/memory/ingest.ts';

const API_BASE = 'https://api.github.com';

interface GhNotification {
  id: string;
  subject: { title: string; type: string };
  repository: { full_name: string };
  unread: boolean;
  reason: string;
  updated_at: string;
}

interface GhEvent {
  id: string;
  type: string;
  repo: { name: string };
  payload: Record<string, unknown>;
  created_at: string;
}

interface GhUser {
  login: string;
  name: string | null;
}

async function gh<T>(ctx: IntegrationContext, path: string, token: string): Promise<T> {
  const res = await ctx.fetch(`${API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'robin-assistant',
    },
  });
  if (!res.ok) throw new Error(`github ${path} returned ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

async function resolveUsername(ctx: IntegrationContext, token: string): Promise<string> {
  const cached = ctx.state.get('username');
  if (cached) return cached;
  const user = await gh<GhUser>(ctx, '/user', token);
  ctx.state.set('username', user.login);
  return user.login;
}

function requireToken(): string {
  // We rely on the caller (daemon's secrets loader) to populate GITHUB_TOKEN into process.env.
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN not set in environment');
  return token;
}

export const integration: Integration = {
  async tick(ctx) {
    let token: string;
    try { token = requireToken(); } catch (err) { return { status: 'skipped', message: err instanceof Error ? err.message : String(err) }; }

    const notifications = await gh<GhNotification[]>(ctx, '/notifications?all=false&per_page=20', token);
    let ingested = 0;
    const seen = new Set(JSON.parse(ctx.state.get('seen_notification_ids') ?? '[]'));
    for (const n of notifications) {
      if (seen.has(n.id)) continue;
      seen.add(n.id);
      await ingest(ctx.db, ctx.llm, {
        kind: 'integration.github.notification',
        source: 'github',
        content: `[${n.repository.full_name}] ${n.subject.title} (${n.subject.type}, reason: ${n.reason})`,
        payload: { id: n.id, repo: n.repository.full_name, reason: n.reason, type: n.subject.type, updated_at: n.updated_at },
      });
      ingested++;
    }
    // Truncate seen-set to 200 most recent to keep state KV small
    const seenArr = Array.from(seen).slice(-200);
    ctx.state.set('seen_notification_ids', JSON.stringify(seenArr));
    ctx.state.set('last_sync', ctx.now().toISOString());
    return { status: 'ok', ingested };
  },

  async health(ctx) {
    const last = ctx.state.get('last_sync');
    if (!process.env.GITHUB_TOKEN) return { ok: false, message: 'GITHUB_TOKEN not set' };
    return { ok: true, message: last ? `last sync: ${last}` : 'never synced' };
  },
};

// MCP action handlers (called from robin-extension when implemented)
export const actions = {
  async notifications(params: { limit?: number }, ctx: IntegrationContext): Promise<GhNotification[]> {
    const token = requireToken();
    const limit = params.limit ?? 20;
    return gh<GhNotification[]>(ctx, `/notifications?all=false&per_page=${limit}`, token);
  },
  async recent_activity(params: { limit?: number }, ctx: IntegrationContext): Promise<GhEvent[]> {
    const token = requireToken();
    const username = await resolveUsername(ctx, token);
    const limit = params.limit ?? 20;
    return gh<GhEvent[]>(ctx, `/users/${username}/events?per_page=${limit}`, token);
  },
};
