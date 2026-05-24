import { ingest } from '../../../brain/memory/ingest.ts';
import type { Integration, IntegrationContext } from '../../_runtime/types.ts';

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
  // Accept either GITHUB_TOKEN (the canonical name per integration.yaml + the
  // gh CLI convention) or GITHUB_PAT (the name many users assign for personal
  // access tokens). Allowing both means the user's .env doesn't have to choose
  // between Robin and whatever other tooling already reads GITHUB_PAT.
  const token = process.env.GITHUB_TOKEN ?? process.env.GITHUB_PAT;
  if (!token) throw new Error('GITHUB_TOKEN (or GITHUB_PAT) not set in environment');
  return token;
}

export const integration: Integration = {
  async tick(ctx) {
    let token: string;
    try {
      token = requireToken();
    } catch (err) {
      return { status: 'skipped', message: err instanceof Error ? err.message : String(err) };
    }

    let ingested = 0;

    // --- Notifications (may 403 if PAT lacks the notifications scope) ---
    const seenNotifs = new Set(JSON.parse(ctx.state.get('seen_notification_ids') ?? '[]'));
    try {
      const notifications = await gh<GhNotification[]>(
        ctx,
        '/notifications?all=false&per_page=20',
        token,
      );
      for (const n of notifications) {
        if (seenNotifs.has(n.id)) continue;
        seenNotifs.add(n.id);
        await ingest(ctx.db, ctx.llm, {
          kind: 'integration.github.notification',
          source: 'github',
          content: `[${n.repository.full_name}] ${n.subject.title} (${n.subject.type}, reason: ${n.reason})`,
          payload: {
            id: n.id,
            repo: n.repository.full_name,
            reason: n.reason,
            type: n.subject.type,
            updated_at: n.updated_at,
          },
        });
        ingested++;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('403')) {
        ctx.log.warn(
          { err: msg },
          'GitHub /notifications returned 403 — PAT likely missing notifications scope; skipping',
        );
      } else {
        throw err;
      }
    }
    const seenNotifsArr = Array.from(seenNotifs).slice(-200);
    ctx.state.set('seen_notification_ids', JSON.stringify(seenNotifsArr));

    // --- Recent activity (user events — always works with basic PAT scopes) ---
    const seenEvents = new Set(JSON.parse(ctx.state.get('seen_event_ids') ?? '[]'));
    try {
      const username = await resolveUsername(ctx, token);
      const events = await gh<GhEvent[]>(ctx, `/users/${username}/events?per_page=20`, token);
      for (const e of events) {
        if (seenEvents.has(e.id)) continue;
        seenEvents.add(e.id);
        await ingest(ctx.db, ctx.llm, {
          kind: 'integration.github.event',
          source: 'github',
          content: `[${e.repo.name}] ${e.type} at ${e.created_at}`,
          payload: {
            id: e.id,
            type: e.type,
            repo: e.repo.name,
            created_at: e.created_at,
          },
        });
        ingested++;
      }
    } catch (err) {
      // Events are best-effort; don't fail the tick if this secondary source errors
      ctx.log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'GitHub /events failed (non-fatal)',
      );
    }
    const seenEventsArr = Array.from(seenEvents).slice(-200);
    ctx.state.set('seen_event_ids', JSON.stringify(seenEventsArr));

    ctx.state.set('last_sync', ctx.now().toISOString());
    return { status: 'ok', ingested };
  },

  async health(ctx) {
    const last = ctx.state.get('last_sync');
    if (!process.env.GITHUB_TOKEN && !process.env.GITHUB_PAT) {
      return { ok: false, message: 'GITHUB_TOKEN (or GITHUB_PAT) not set' };
    }
    return { ok: true, message: last ? `last sync: ${last}` : 'never synced' };
  },
};

// MCP action handlers (called from robin-extension when implemented)
export const actions = {
  async notifications(
    params: { limit?: number },
    ctx: IntegrationContext,
  ): Promise<GhNotification[]> {
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
