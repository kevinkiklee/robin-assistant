import { checkOutbound } from '../../../cognition/discretion/outbound-policy.js';
import { DISCORD_MESSAGE_MAX } from './constants.js';

export async function generateAndSendReply({ db, host, message, prompt }) {
  if (!host) {
    await message.reply('(robin: LLM host unavailable)');
    return { sent: false, reason: 'no_host' };
  }
  const llm = await host.invokeLLM([{ role: 'user', content: prompt }], { tier: 'fast' });
  // Slice by code points so emoji / non-BMP characters don't get cut mid-surrogate.
  const rawReply = String(llm.content ?? '');
  const codePoints = [...rawReply];
  const replyText =
    codePoints.length <= DISCORD_MESSAGE_MAX
      ? rawReply
      : codePoints.slice(0, DISCORD_MESSAGE_MAX).join('');
  const policy = await checkOutbound(db, { destination: 'discord', text: replyText });
  if (!policy.ok) {
    await message.reply(`(robin: reply blocked by outbound policy: ${policy.reason})`);
    return { sent: false, reason: policy.reason };
  }
  await message.reply(replyText);
  return { sent: true };
}
