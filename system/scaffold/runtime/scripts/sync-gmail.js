#!/usr/bin/env node
// Template — auto-copied to user-data/runtime/scripts/ by scaffold-sync.
// Imports resolve only after copy; not runnable in place.
//
// Gmail sync — fetches the last 30 days of inbox messages (metadata only:
// sender, subject, date, labels) and writes a scannable inbox-snapshot.md +
// a derived senders.md table. Bodies are NOT pulled — those are lazy via the
// MCP or a dedicated read script.
//
// Usage:
//   node user-data/runtime/scripts/sync-gmail.js              # incremental
//   node user-data/runtime/scripts/sync-gmail.js --bootstrap  # full window
//   node user-data/runtime/scripts/sync-gmail.js --dry-run

import { join } from 'node:path';
import { hostname } from 'node:os';
import { fileURLToPath } from 'node:url';
import { getAccessToken } from '../../../system/scripts/sync/lib/oauth.js';
import { loadCursor, saveCursor } from '../../../system/scripts/sync/lib/cursor.js';
import { atomicWrite, writeTable } from '../../../system/scripts/sync/lib/markdown.js';
import { updateIndex } from '../../../system/scripts/sync/lib/index-updater.js';
import { acquireLock, releaseLock } from '../../../system/scripts/jobs/lib/atomic.js';
import { buildEntityRegistry } from '../../../system/scripts/wiki-graph/lib/build-entity-registry.js';
import { applyEntityLinks } from '../../../system/scripts/wiki-graph/lib/apply-entity-links.js';
import { GmailClient, header } from './lib/google/gmail-client.js';

const SOURCE = 'sync-gmail';
const PROVIDER = 'google';
const WINDOW_DAYS = 30;
const MAX_MESSAGES = 2000;

function nowISO() { return new Date().toISOString(); }

// Insert wiki-graph entity links into a memory file we just wrote.
// Best-effort; never throw to the caller.
async function linkAfterWrite(workspaceDir, registry, wsRelPath) {
  if (!registry || !wsRelPath.startsWith('user-data/memory/')) return;
  const memRelPath = wsRelPath.slice('user-data/memory/'.length);
  try {
    await applyEntityLinks(workspaceDir, memRelPath, registry);
  } catch (err) {
    console.warn(`sync-gmail: applyEntityLinks(${memRelPath}) failed: ${err.message}`);
  }
}

function parseSender(from) {
  if (!from) return { name: '', email: '' };
  const m = from.match(/^(.*?)\s*<(.+)>$/);
  if (m) return { name: m[1].replace(/^"|"$/g, '').trim(), email: m[2].trim() };
  return { name: '', email: from.trim() };
}

function snippet(msg) {
  return (msg.snippet ?? '').replace(/\s+/g, ' ').trim();
}

function isUnread(msg) {
  return Array.isArray(msg.labelIds) && msg.labelIds.includes('UNREAD');
}

function hasAttachments(msg) {
  return Array.isArray(msg.labelIds) && msg.labelIds.includes('HAS_ATTACHMENT');
}

function topLabels(msg) {
  const ids = msg.labelIds ?? [];
  // Prefer user-meaningful labels: CATEGORY_*, IMPORTANT, STARRED.
  const interesting = ids.filter((id) => /^(CATEGORY_|IMPORTANT|STARRED)/.test(id));
  return interesting.join(',');
}

export async function syncGmail({ workspaceDir, dryRun = false, bootstrap = false }) {
  let registry = null;
  try {
    registry = await buildEntityRegistry(workspaceDir);
  } catch (err) {
    console.warn(`sync-gmail: registry unavailable, skipping link insertion (${err.message})`);
  }

  const accessToken = await getAccessToken(workspaceDir, PROVIDER);
  const client = new GmailClient(accessToken);

  const profile = await client.getProfile();
  console.log(`[sync-gmail] account: ${profile.emailAddress}, ~${profile.messagesTotal} total`);

  const query = `newer_than:${WINDOW_DAYS}d in:inbox`;
  console.log(`[sync-gmail] query: ${query}`);
  const ids = await client.listMessageIds(query, { cap: MAX_MESSAGES });
  console.log(`[sync-gmail] ${ids.length} messages to fetch metadata for`);

  if (dryRun) {
    console.log('[sync-gmail] dry-run: skipping fetch + writes');
    return { messages: ids.length };
  }

  // Fetch metadata in chunks to avoid hammering the API too hard.
  // Gmail's per-user quota is generous; small chunks keep memory bounded.
  const messages = [];
  const CHUNK = 25;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    const batch = await Promise.all(slice.map(({ id }) => client.getMessageMetadata(id)));
    messages.push(...batch);
    if (i % 250 === 0 && i > 0) console.log(`[sync-gmail]   ${i}/${ids.length}…`);
  }

  // Build inbox snapshot rows.
  const rows = [];
  const senderCounts = new Map();
  for (const msg of messages) {
    const from = header(msg, 'From');
    const subject = header(msg, 'Subject');
    const date = header(msg, 'Date');
    const sender = parseSender(from);
    rows.push({
      date: msg.internalDate ? new Date(parseInt(msg.internalDate, 10)).toISOString().slice(0, 16).replace('T', ' ') : (date ?? ''),
      sender: sender.email || sender.name,
      subject: subject ?? '',
      snippet: snippet(msg).slice(0, 120),
      labels: topLabels(msg),
      unread: isUnread(msg) ? 'yes' : '',
      attach: hasAttachments(msg) ? 'yes' : '',
    });
    if (sender.email) {
      const prev = senderCounts.get(sender.email) ?? { count: 0, last: '', unread: 0, name: sender.name };
      prev.count += 1;
      prev.last = (msg.internalDate && (!prev.last || parseInt(msg.internalDate, 10) > prev.lastMs))
        ? new Date(parseInt(msg.internalDate, 10)).toISOString().slice(0, 10)
        : prev.last;
      prev.lastMs = Math.max(prev.lastMs ?? 0, parseInt(msg.internalDate, 10) || 0);
      if (isUnread(msg)) prev.unread += 1;
      senderCounts.set(sender.email, prev);
    }
  }

  // Sort rows newest first
  rows.sort((a, b) => b.date.localeCompare(a.date));

  const inboxCols = ['date', 'sender', 'subject', 'snippet', 'labels', 'unread', 'attach'];
  await atomicWrite(workspaceDir, 'user-data/memory/knowledge/email/inbox-snapshot.md',
    `---\ndescription: Gmail inbox — last ${WINDOW_DAYS} days metadata snapshot (auto-pulled)\n---\n\n` +
    `# Inbox Snapshot — ${profile.emailAddress}\n\nPulled ${nowISO()}. ${rows.length} messages.\n\n` +
    writeTable({ columns: inboxCols, rows }),
    { trust: 'untrusted', trustSource: 'sync-gmail' }
  );
  await linkAfterWrite(workspaceDir, registry, 'user-data/memory/knowledge/email/inbox-snapshot.md');

  // Derive top senders.
  const senders = [...senderCounts.entries()]
    .map(([email, v]) => ({
      email,
      name: v.name,
      count: String(v.count),
      unread: String(v.unread),
      last_seen: v.last,
    }))
    .sort((a, b) => parseInt(b.count, 10) - parseInt(a.count, 10))
    .slice(0, 50);

  await atomicWrite(workspaceDir, 'user-data/memory/knowledge/email/senders.md',
    `---\ndescription: Gmail — top 50 senders last ${WINDOW_DAYS} days (auto-pulled)\n---\n\n` +
    `# Top Senders — ${profile.emailAddress}\n\nPulled ${nowISO()}.\n\n` +
    writeTable({ columns: ['email', 'name', 'count', 'unread', 'last_seen'], rows: senders }),
    { trust: 'untrusted', trustSource: 'sync-gmail' }
  );
  await linkAfterWrite(workspaceDir, registry, 'user-data/memory/knowledge/email/senders.md');

  saveCursor(workspaceDir, SOURCE, {
    last_attempt_at: nowISO(),
    last_success_at: nowISO(),
    error_count: 0,
    last_error: null,
    auth_status: 'ok',
    cursor: { messages_seen: messages.length, top_senders: senders.length },
  });

  await updateIndex(workspaceDir, { skipIfLocked: true });
  console.log(`[sync-gmail] wrote inbox-snapshot (${rows.length}) + senders (${senders.length})`);
  return { messages: messages.length, senders: senders.length };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const workspaceDir = fileURLToPath(new URL('../..', import.meta.url));
  const dryRun = process.argv.includes('--dry-run');
  const bootstrap = process.argv.includes('--bootstrap');

  const underRunner = !!process.env.ROBIN_WORKSPACE;
  const lockPath = join(workspaceDir, `user-data/runtime/state/jobs/locks/${SOURCE}.lock`);
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
      await syncGmail({ workspaceDir, dryRun, bootstrap });
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
