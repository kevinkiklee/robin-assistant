import { checkOutbound } from '../../outbound/policy.js';

export async function generateAndSendReply({ db, host, message, prompt }) {
  if (!host) {
    await message.reply('(robin: LLM host unavailable)');
    return { sent: false, reason: 'no_host' };
  }
  const llm = await host.invokeLLM([{ role: 'user', content: prompt }], { tier: 'fast' });
  const replyText = (llm.content ?? '').slice(0, 2000);
  const policy = await checkOutbound(db, { destination: 'discord', text: replyText });
  if (!policy.ok) {
    await message.reply(`(robin: reply blocked by outbound policy: ${policy.reason})`);
    return { sent: false, reason: policy.reason };
  }
  await message.reply(replyText);
  return { sent: true };
}
