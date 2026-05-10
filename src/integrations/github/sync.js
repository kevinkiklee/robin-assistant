import {
  getAuthenticatedUser,
  listNotifications,
  listReleases,
  listStarredRepos,
  listUserEvents,
} from '../github_write/client.js';

const RELEASE_WINDOW_DAYS = 30;

function describeEvent(ev) {
  const t = ev.type;
  const r = ev.repo?.name ?? '';
  const p = ev.payload ?? {};
  if (t === 'PushEvent')
    return `pushed ${p.commits?.length ?? 0} commit(s) to ${p.ref?.replace('refs/heads/', '') ?? '?'}`;
  if (t === 'PullRequestEvent')
    return `${p.action} PR #${p.number}: ${p.pull_request?.title ?? ''}`;
  if (t === 'PullRequestReviewEvent') return `reviewed PR #${p.pull_request?.number ?? '?'}`;
  if (t === 'PullRequestReviewCommentEvent') return 'commented on PR review';
  if (t === 'IssuesEvent') return `${p.action} issue #${p.issue?.number}: ${p.issue?.title ?? ''}`;
  if (t === 'IssueCommentEvent') return `commented on #${p.issue?.number}`;
  if (t === 'CreateEvent') return `created ${p.ref_type} ${p.ref ?? ''}`;
  if (t === 'DeleteEvent') return `deleted ${p.ref_type} ${p.ref ?? ''}`;
  if (t === 'WatchEvent') return `starred ${r}`;
  if (t === 'ForkEvent') return `forked ${r}`;
  if (t === 'ReleaseEvent') return `${p.action} release ${p.release?.tag_name ?? ''}`;
  return t;
}

export async function sync(ctx) {
  const { GITHUB_PAT: token } = ctx.secrets;
  const { fetchFn, signal, log, cursor } = ctx;

  // Resolve cursor: on first run use 30 days ago for events/releases cutoff.
  const since = cursor?.last_synced_at ?? null;
  const releaseCutoff = new Date(Date.now() - RELEASE_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  // 1. Identify the authenticated user.
  const me = await getAuthenticatedUser({ token, fetchFn, signal });
  const login = me.login;

  const events = [];

  // 2. User activity events.
  const rawEvents = await listUserEvents({ login, token, fetchFn, signal, since, cap: 300 });
  for (const ev of rawEvents) {
    const repo = ev.repo?.name ?? '';
    events.push({
      source: 'github',
      external_id: `github:event:${ev.id}`,
      content: `${repo}: ${ev.type} — ${describeEvent(ev)}`,
      ts: new Date(ev.created_at),
      meta: {
        kind: 'github_activity',
        repo,
        type: ev.type,
        event_id: ev.id,
      },
    });
  }

  // 3. Notifications (fine-grained PATs may return 403 — handle gracefully).
  const rawNotifs = await listNotifications({ token, fetchFn, signal });
  if (rawNotifs === null) {
    log('/notifications returned 403 — skipping (fine-grained PAT limitation)');
  } else {
    for (const n of rawNotifs) {
      const repo = n.repository?.full_name ?? '';
      const subject = n.subject ?? {};
      events.push({
        source: 'github',
        external_id: `github:notif:${n.id}`,
        content: `${repo}: [${n.reason}] ${subject.type} — ${subject.title}`,
        ts: new Date(n.updated_at),
        meta: {
          kind: 'github_notif',
          repo,
          reason: n.reason,
          subject_type: subject.type,
          subject_title: subject.title,
          unread: n.unread ?? false,
        },
      });
    }
  }

  // 4. Releases from starred repos (max 50 repos, releases newer than 30 days).
  const stars = await listStarredRepos({ token, fetchFn, signal, cap: 50 });
  for (const repo of stars) {
    const [owner, name] = (repo.full_name ?? '').split('/');
    if (!owner || !name) continue;
    let releases;
    try {
      releases = await listReleases({ owner, repo: name, token, fetchFn, signal });
    } catch (err) {
      // Skip renamed/deleted/blocked repos.
      if (!/404/.test(err.message)) log(`skipped releases for ${repo.full_name}: ${err.message}`);
      continue;
    }
    if (!Array.isArray(releases)) continue;
    for (const rel of releases) {
      const published = rel.published_at ?? rel.created_at;
      if (!published || new Date(published) < releaseCutoff) continue;
      events.push({
        source: 'github',
        external_id: `github:release:${repo.full_name}:${rel.tag_name}`,
        content: `${repo.full_name}: release ${rel.tag_name}${rel.name ? ` — ${rel.name}` : ''}`,
        ts: new Date(published),
        meta: {
          kind: 'github_release',
          repo: repo.full_name,
          tag: rel.tag_name,
          name: rel.name ?? '',
        },
      });
    }
  }

  await ctx.capture(events);

  return {
    count: events.length,
    cursor: { last_synced_at: new Date().toISOString() },
  };
}
