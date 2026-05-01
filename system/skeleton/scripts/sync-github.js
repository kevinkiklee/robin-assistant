#!/usr/bin/env node
// Template — auto-copied to user-data/scripts/ by skeleton-sync.
// Imports resolve only after copy; not runnable in place.
//
// GitHub sync — pulls the authed user's last-30-days public events, current
// notifications, and recent releases from starred repos. Writes scannable
// activity.md / notifications.md / releases.md to user-data/memory/knowledge/github/.
//
// Usage:
//   node user-data/scripts/sync-github.js
//   node user-data/scripts/sync-github.js --bootstrap
//   node user-data/scripts/sync-github.js --dry-run

import { join } from 'node:path';
import { hostname } from 'node:os';
import { fileURLToPath } from 'node:url';
import { loadSecrets, requireSecret } from '../../system/scripts/lib/sync/secrets.js';
import { loadCursor, saveCursor } from '../../system/scripts/lib/sync/cursor.js';
import { atomicWrite, writeTable } from '../../system/scripts/lib/sync/markdown.js';
import { updateIndex } from '../../system/scripts/lib/sync/index-updater.js';
import { acquireLock, releaseLock } from '../../system/scripts/lib/jobs/atomic.js';
import { GitHubClient } from './lib/github/client.js';

const SOURCE = 'sync-github';
const ACTIVITY_DAYS = 30;

function nowISO() { return new Date().toISOString(); }

function describeEvent(ev) {
  const t = ev.type;
  const r = ev.repo?.name ?? '';
  const p = ev.payload ?? {};
  if (t === 'PushEvent') return `pushed ${p.commits?.length ?? 0} commit(s) to ${p.ref?.replace('refs/heads/', '') ?? '?'}`;
  if (t === 'PullRequestEvent') return `${p.action} PR #${p.number}: ${p.pull_request?.title ?? ''}`;
  if (t === 'PullRequestReviewEvent') return `reviewed PR #${p.pull_request?.number ?? '?'}`;
  if (t === 'PullRequestReviewCommentEvent') return `commented on PR review`;
  if (t === 'IssuesEvent') return `${p.action} issue #${p.issue?.number}: ${p.issue?.title ?? ''}`;
  if (t === 'IssueCommentEvent') return `commented on #${p.issue?.number}`;
  if (t === 'CreateEvent') return `created ${p.ref_type} ${p.ref ?? ''}`;
  if (t === 'DeleteEvent') return `deleted ${p.ref_type} ${p.ref ?? ''}`;
  if (t === 'WatchEvent') return `starred ${r}`;
  if (t === 'ForkEvent') return `forked ${r}`;
  if (t === 'ReleaseEvent') return `${p.action} release ${p.release?.tag_name ?? ''}`;
  return t;
}

export async function syncGitHub({ workspaceDir, dryRun = false, bootstrap = false }) {
  loadSecrets(workspaceDir);
  const pat = requireSecret('GITHUB_PAT');
  const client = new GitHubClient(pat);

  const me = await client.user();
  console.log(`[sync-github] user: ${me.login}`);

  const since = new Date(Date.now() - ACTIVITY_DAYS * 24 * 60 * 60 * 1000);

  // 1. Activity events
  const events = await client.listUserEvents(me.login, { cap: 300 });
  const recent = events.filter((e) => new Date(e.created_at) >= since);

  // 2. Notifications (fine-grained PATs cannot access /notifications — fall through on 403)
  let notifs = [];
  let notifsSkipped = false;
  try {
    notifs = await client.listNotifications({ all: true });
  } catch (err) {
    if (err?.status === 403) {
      console.warn('[sync-github] /notifications returned 403 — skipping (fine-grained PATs do not support this endpoint).');
      notifsSkipped = true;
    } else {
      throw err;
    }
  }

  // 3. Releases from starred repos (capped — full sweep can be slow)
  let releases = [];
  if (bootstrap || true) {
    // We always check; the underlying GitHub call is one request per repo.
    // For a casual user with <50 starred repos this is fine. For a power user,
    // skip during incremental.
    const stars = await client.listStarredRepos({ cap: 50 });
    console.log(`[sync-github] checking releases on ${stars.length} starred repos…`);
    for (const repo of stars) {
      try {
        const rs = await client.listReleases(repo.owner.login, repo.name);
        for (const r of rs) {
          if (new Date(r.published_at ?? r.created_at) >= since) {
            releases.push({ repo: repo.full_name, tag: r.tag_name, name: r.name ?? '', published: r.published_at ?? r.created_at });
          }
        }
      } catch (err) {
        // Skip repos that have been renamed/deleted/blocked.
        if (err?.status !== 404) console.warn(`[sync-github]   skipped ${repo.full_name}: ${err.message}`);
      }
    }
    releases.sort((a, b) => b.published.localeCompare(a.published));
  }

  console.log(`[sync-github] ${recent.length} events, ${notifs.length} notifications, ${releases.length} releases`);

  if (dryRun) {
    console.log('[sync-github] dry-run: skipping writes');
    return { events: recent.length, notifications: notifs.length, releases: releases.length };
  }

  // Write activity table
  const activityRows = recent.map((e) => ({
    date: (e.created_at ?? '').slice(0, 16).replace('T', ' '),
    repo: e.repo?.name ?? '',
    type: e.type,
    summary: describeEvent(e),
  }));
  await atomicWrite(workspaceDir, 'user-data/memory/knowledge/github/activity.md',
    `---\ndescription: GitHub activity — last ${ACTIVITY_DAYS} days for ${me.login} (auto-pulled)\n---\n\n` +
    `# GitHub Activity — ${me.login}\n\nPulled ${nowISO()}. ${recent.length} events.\n\n` +
    writeTable({ columns: ['date', 'repo', 'type', 'summary'], rows: activityRows }),
    { trust: 'untrusted', trustSource: 'sync-github' }
  );

  // Notifications
  const notifRows = notifs.map((n) => ({
    updated: (n.updated_at ?? '').slice(0, 16).replace('T', ' '),
    repo: n.repository?.full_name ?? '',
    reason: n.reason ?? '',
    type: n.subject?.type ?? '',
    title: n.subject?.title ?? '',
    unread: n.unread ? 'yes' : '',
  }));
  const notifsHeader = notifsSkipped
    ? `Skipped — fine-grained PAT cannot access \`/notifications\`. Add classic PAT with \`notifications\` scope, or check via the GitHub UI.\n\n`
    : `Pulled ${nowISO()}. ${notifs.length} threads.\n\n`;
  await atomicWrite(workspaceDir, 'user-data/memory/knowledge/github/notifications.md',
    `---\ndescription: GitHub notifications — current unread + recent (auto-pulled)\n---\n\n` +
    `# GitHub Notifications — ${me.login}\n\n${notifsHeader}` +
    writeTable({ columns: ['updated', 'repo', 'reason', 'type', 'title', 'unread'], rows: notifRows }),
    { trust: 'untrusted', trustSource: 'sync-github' }
  );

  // Releases
  await atomicWrite(workspaceDir, 'user-data/memory/knowledge/github/releases.md',
    `---\ndescription: GitHub releases — last ${ACTIVITY_DAYS} days from starred repos (auto-pulled)\n---\n\n` +
    `# GitHub Releases — last ${ACTIVITY_DAYS} days\n\nPulled ${nowISO()}.\n\n` +
    writeTable({ columns: ['published', 'repo', 'tag', 'name'], rows: releases }),
    { trust: 'untrusted', trustSource: 'sync-github' }
  );

  saveCursor(workspaceDir, SOURCE, {
    last_attempt_at: nowISO(),
    last_success_at: nowISO(),
    error_count: 0,
    last_error: null,
    auth_status: 'ok',
    cursor: { events_seen: recent.length, notifications_seen: notifs.length, releases_seen: releases.length },
  });

  await updateIndex(workspaceDir, { skipIfLocked: true });
  console.log(`[sync-github] wrote activity (${recent.length}) + notifications (${notifs.length}) + releases (${releases.length})`);
  return { events: recent.length, notifications: notifs.length, releases: releases.length };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const workspaceDir = fileURLToPath(new URL('../..', import.meta.url));
  const dryRun = process.argv.includes('--dry-run');
  const bootstrap = process.argv.includes('--bootstrap');

  const underRunner = !!process.env.ROBIN_WORKSPACE;
  const lockPath = join(workspaceDir, `user-data/state/jobs/locks/${SOURCE}.lock`);
  let acquired = false;

  async function run() {
    if (!underRunner) {
      const r = acquireLock(lockPath, { host: hostname() });
      if (r === 'held') {
        console.log(`[${SOURCE}] another instance is running (lock held); exiting.`);
        return;
      }
      acquired = true;
    }
    try {
      await syncGitHub({ workspaceDir, dryRun, bootstrap });
    } finally {
      if (acquired) releaseLock(lockPath);
    }
  }

  run().catch((err) => {
    try {
      saveCursor(workspaceDir, SOURCE, {
        last_attempt_at: nowISO(),
        last_error: err.message,
        error_count: (loadCursor(workspaceDir, SOURCE).error_count ?? 0) + 1,
        auth_status: err.name === 'AuthError' ? 'needs_reauth' : 'unknown',
      });
    } catch { /* ignore */ }
    if (acquired) {
      try { releaseLock(lockPath); } catch { /* ignore */ }
    }
    console.error(`[${SOURCE}] failed: ${err.message}`);
    process.exit(1);
  });
}
