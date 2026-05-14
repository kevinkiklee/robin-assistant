import { checkOutbound } from '../../../cognition/discretion/outbound-policy.js';
import { runDiscordAgent } from './agent.js';
import { formatForDiscord, splitMessage } from './formatter.js';

// Discord's typing indicator expires ~10s after the last sendTyping. Refresh
// every 7s while the agent is working so the user sees a continuous "Robin is
// typing…" until the reply lands.
const TYPING_REFRESH_MS = 7000;

function startTyping(target) {
  if (typeof target?.sendTyping !== 'function') return () => {};
  target.sendTyping().catch(() => {});
  const id = setInterval(() => {
    target.sendTyping().catch(() => {});
  }, TYPING_REFRESH_MS);
  return () => clearInterval(id);
}

async function deliverChunked(target, text) {
  const chunks = splitMessage(text);
  for (const chunk of chunks) {
    await target.send(chunk);
  }
  return chunks.length;
}

/**
 * Generate Robin's reply via the Claude Code agent running in the Robin
 * package root (so it has full MCP access: recall, get_knowledge, integrations,
 * etc.) and deliver it to the Discord target.
 *
 * Returns `{ sent, sessionId, reason?, replyText?, chunks? }`. `sessionId` is
 * the agent's new/continuing session id — caller should persist it per
 * channel so the next message can resume the conversation.
 *
 * @param {object} args
 * @param {object} args.db
 * @param {object} args.target            Discord channel/thread/DMChannel
 * @param {string} args.prompt            Current user message (post-strip)
 * @param {string|null} [args.sessionId]  Prior agent session id to resume
 * @param {AbortSignal} [args.signal]     Aborted by /cancel
 * @param {string} [args.origin]
 * @param {string[]} [args.trustedOrigins]
 * @param {Function} [args.agentRunner]   Test seam — defaults to runDiscordAgent
 */
export async function generateAndSendReply({
  db,
  target,
  prompt,
  sessionId = null,
  signal,
  origin,
  trustedOrigins,
  agentRunner = runDiscordAgent,
}) {
  if (!target || typeof target.send !== 'function') {
    return { sent: false, reason: 'no_target' };
  }

  const stopTyping = startTyping(target);
  let result;
  try {
    result = await agentRunner({ prompt, sessionId, signal });
  } finally {
    stopTyping();
  }

  if (result.code === 'CANCELLED') {
    // /cancel acknowledged via the interaction reply; stay silent here.
    return { sent: false, reason: 'cancelled', sessionId: null };
  }

  const rawReply = String(result.text ?? '').trim();
  if (!rawReply) {
    await target.send('(robin: no reply produced)').catch(() => {});
    return { sent: false, reason: 'empty_reply', sessionId: result.sessionId };
  }

  // Convert GFM tables → fenced code blocks before policy check so the policy
  // sees what actually goes to Discord (kept consistent with discord_send).
  const formatted = formatForDiscord(rawReply);

  const policy = await checkOutbound(db, {
    destination: 'discord',
    text: formatted,
    origin,
    trustedOrigins,
  });
  if (!policy.ok) {
    await target.send(`(robin: reply blocked by outbound policy: ${policy.reason})`).catch(() => {});
    return { sent: false, reason: policy.reason, sessionId: result.sessionId };
  }

  const chunks = await deliverChunked(target, formatted);
  return {
    sent: true,
    replyText: formatted,
    chunks,
    sessionId: result.sessionId,
    costUsd: result.costUsd,
  };
}
