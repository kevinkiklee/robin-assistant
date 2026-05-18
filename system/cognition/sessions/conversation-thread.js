// Cross-channel conversation thread management (M2).
//
// Threads bound to (channel, peer_id). Within the inactivity window the
// same peer on the same channel resumes; outside the window a new thread
// starts. Thread ID embeds a time-bucket so resumed threads stay stable
// even after a daemon restart.

import { surql } from 'surrealdb';

const DEFAULT_WINDOW_MS = 30 * 60_000; // 30 min idle
const DEFAULT_MAX_MESSAGES = 15;
const DEFAULT_MAX_TOKENS = 4_000;

// Pure: derive a stable thread ID from inputs.
//
// We bucket by `now` floored to the window so two messages within the
// window land in the same bucket; the next-window message rolls to a new
// bucket. This means the ID is computed at write time, not lookup time —
// callers should resolve their thread ID via `resolveThreadId` which checks
// the most-recent thread for (channel, peer_id) first before allocating a
// new bucket.
export function computeThreadId({ channel, peer_id, bucketStartMs }) {
  if (!channel || !peer_id || !Number.isFinite(bucketStartMs)) {
    throw new Error('computeThreadId: channel, peer_id, bucketStartMs required');
  }
  const safe = (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  return `${safe(channel)}__${safe(peer_id)}__${bucketStartMs}`;
}

// Look up the active thread for (channel, peer_id). Returns the existing
// thread if its `last_msg_at` is within `windowMs`, otherwise allocates a
// new bucket (writes nothing — caller writes on append).
export async function resolveThreadId(
  db,
  { channel, peer_id },
  { windowMs = DEFAULT_WINDOW_MS, now = Date.now } = {},
) {
  const cutoff = new Date(now() - windowMs);
  const [rows] = await db
    .query(
      surql`SELECT thread_id, last_msg_at FROM conversation_threads
            WHERE channel = ${channel} AND peer_id = ${peer_id} AND last_msg_at >= ${cutoff}
            ORDER BY last_msg_at DESC LIMIT 1`,
    )
    .collect();
  const existing = rows?.[0];
  if (existing) return { thread_id: existing.thread_id, resumed: true };
  return {
    thread_id: computeThreadId({ channel, peer_id, bucketStartMs: now() }),
    resumed: false,
  };
}

// Append a message to the thread. Creates the thread if it doesn't exist.
// Maintains rolling caps via tail-pruning when either max is exceeded.
export async function appendToThread(
  db,
  { thread_id, channel, peer_id, role, content, timestamp = new Date() },
  { maxMessages = DEFAULT_MAX_MESSAGES, maxTokens = DEFAULT_MAX_TOKENS } = {},
) {
  if (!thread_id || !channel || !peer_id || !role || typeof content !== 'string') {
    throw new Error('appendToThread: thread_id, channel, peer_id, role, content required');
  }
  const [rows] = await db
    .query(
      surql`SELECT channel_history, token_count FROM conversation_threads WHERE thread_id = ${thread_id} LIMIT 1`,
    )
    .collect();
  const existing = rows?.[0];
  const history = Array.isArray(existing?.channel_history) ? [...existing.channel_history] : [];
  const newMsg = { role, content, ts: timestamp instanceof Date ? timestamp : new Date(timestamp) };
  history.push(newMsg);

  // Rough token estimate: 1 token ~= 4 chars. Prune oldest until both caps hold.
  let tokenCount = history.reduce((n, m) => n + Math.ceil((m.content?.length ?? 0) / 4), 0);
  while ((history.length > maxMessages || tokenCount > maxTokens) && history.length > 1) {
    const dropped = history.shift();
    tokenCount -= Math.ceil((dropped.content?.length ?? 0) / 4);
  }

  if (existing) {
    await db
      .query(
        surql`UPDATE conversation_threads SET channel_history = ${history}, token_count = ${tokenCount}, last_msg_at = ${newMsg.ts} WHERE thread_id = ${thread_id}`,
      )
      .collect();
  } else {
    await db
      .query(
        surql`CREATE conversation_threads SET thread_id = ${thread_id}, channel = ${channel}, peer_id = ${peer_id}, channel_history = ${history}, token_count = ${tokenCount}, last_msg_at = ${newMsg.ts}`,
      )
      .collect();
  }
  return { thread_id, message_count: history.length, token_count: tokenCount };
}

// Read the most recent context messages for injection into agent prompt.
export async function readThreadContext(db, thread_id) {
  if (!thread_id) return { messages: [], token_count: 0 };
  const [rows] = await db
    .query(
      surql`SELECT channel_history, token_count FROM conversation_threads WHERE thread_id = ${thread_id} LIMIT 1`,
    )
    .collect();
  const row = rows?.[0];
  if (!row) return { messages: [], token_count: 0 };
  return {
    messages: Array.isArray(row.channel_history) ? row.channel_history : [],
    token_count: row.token_count ?? 0,
  };
}

// Drop threads not touched within `maxAgeMs`. Called from a daily prune job.
export async function pruneStaleThreads(db, { maxAgeMs = 24 * 60 * 60_000, now = Date.now } = {}) {
  const cutoff = new Date(now() - maxAgeMs);
  const [rows] = await db
    .query(
      surql`SELECT count() AS n FROM conversation_threads WHERE last_msg_at < ${cutoff} GROUP ALL`,
    )
    .collect();
  const deleteCount = rows?.[0]?.n ?? 0;
  await db
    .query(surql`DELETE conversation_threads WHERE last_msg_at < ${cutoff}`)
    .collect();
  return { deleted: deleteCount };
}
