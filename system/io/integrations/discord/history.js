import { surql } from 'surrealdb';

// Discord conversations are stored as captured events with
// `source = 'discord'` and `meta.channel_id` set to the thread/DM id.
// `meta.kind` distinguishes the speaker:
//   'dm' | 'mention' | 'thread' — user said this
//   'bot_reply'                  — Robin said this
//   'session_boundary'           — /new marker; history stops here
//   'slash'                      — slash-command invocation; skipped from history

const MAX_TURNS = 20;
const MAX_CHARS = 8000;

function eventToTurn(row) {
  const kind = row.meta?.kind;
  if (kind === 'bot_reply') return { role: 'assistant', content: row.content };
  if (kind === 'dm' || kind === 'mention' || kind === 'thread') {
    return { role: 'user', content: row.content };
  }
  return null;
}

/**
 * Fetch recent Discord conversation turns for one channel/thread, oldest →
 * newest, capped at MAX_TURNS turns and MAX_CHARS total content length. Stops
 * at the most recent `/new` boundary so the user can explicitly reset context.
 *
 * Returns `[]` when there's no usable history (new conversation, only the just-
 * captured user message exists yet, etc).
 */
export async function fetchHistory(
  db,
  channelId,
  { maxTurns = MAX_TURNS, maxChars = MAX_CHARS } = {},
) {
  if (!channelId) return [];
  // Pull a wider window than we need so a few `slash` rows or stray non-turn
  // events don't starve the actual conversation.
  const lookback = maxTurns * 3;
  const [rows] = await db
    .query(
      surql`SELECT content, meta, ts FROM events
            WHERE source = 'discord' AND meta.channel_id = ${channelId}
            ORDER BY ts DESC LIMIT ${lookback}`,
    )
    .collect();

  // rows[] is newest-first. Walk it that way so we can short-circuit on the
  // first session boundary, then reverse to get chronological order.
  const newestFirst = [];
  for (const r of rows) {
    if (r.meta?.kind === 'session_boundary') break;
    const turn = eventToTurn(r);
    if (turn) newestFirst.push(turn);
  }
  const chronological = newestFirst.reverse();

  // Apply caps: keep the most recent maxTurns. Then walk newest→oldest summing
  // chars; drop the oldest as needed so the prompt stays under maxChars.
  const trimmed = chronological.slice(-maxTurns);
  let total = trimmed.reduce((s, t) => s + (t.content?.length ?? 0), 0);
  while (trimmed.length > 1 && total > maxChars) {
    const dropped = trimmed.shift();
    total -= dropped.content?.length ?? 0;
  }
  return trimmed;
}

/**
 * Build the message array for `host.invokeLLM` from the channel history plus
 * the current user prompt. The current prompt is always the LAST user turn —
 * it may also be the most recent thing in `history` if the user message was
 * captured before this call (the common case), in which case we de-dupe.
 */
export function buildMessages(history, currentPrompt) {
  const turns = [...history];
  const last = turns[turns.length - 1];
  // If the last history turn is the same user message we're about to send,
  // don't append a duplicate. (recordEvent captures the user msg before we
  // build messages, so it normally IS the latest history row.)
  if (!(last?.role === 'user' && last.content === currentPrompt)) {
    turns.push({ role: 'user', content: currentPrompt });
  }
  return turns;
}

/**
 * Insert a synthetic boundary marker so future `fetchHistory` calls stop at
 * this point. Called from the /new slash command handler.
 */
export async function insertBoundary(capture, channelId, userId) {
  await capture([
    {
      source: 'discord',
      content: '/new',
      ts: new Date(),
      external_id: `boundary:${channelId}:${Date.now()}`,
      trust: 'untrusted',
      meta: {
        kind: 'session_boundary',
        channel_id: channelId,
        author_id: userId,
      },
    },
  ]);
}

/**
 * Build a bot-reply event so future history queries can include Robin's side
 * of the conversation. Reply text is the post-policy-check, pre-chunking
 * content (the full message Robin sent, before Discord's 2000-char split).
 */
export function buildBotReplyEvent({ channelId, replyText, botUserId, messageId }) {
  return {
    source: 'discord',
    content: replyText,
    ts: new Date(),
    external_id: `reply:${messageId}:${Date.now()}`,
    trust: 'untrusted',
    meta: {
      kind: 'bot_reply',
      channel_id: channelId,
      author_id: botUserId,
      reply_to: messageId,
    },
  };
}
