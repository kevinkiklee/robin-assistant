export function isAllowed({ allowlist, message, interaction }) {
  if (message) {
    const dm = !message.guildId;
    if (dm && allowlist.dm_user_ids?.includes(message.author.id)) return true;
    if (
      !dm &&
      allowlist.guild_ids?.includes(message.guildId) &&
      allowlist.user_ids?.includes(message.author.id)
    ) {
      return true;
    }
    return false;
  }
  if (interaction) {
    return (
      allowlist.guild_ids?.includes(interaction.guildId) &&
      allowlist.user_ids?.includes(interaction.user.id)
    );
  }
  return false;
}

// Possible kinds:
//   'dm'      — direct message; reply unconditionally if user is allowlisted
//   'thread'  — message in a thread Robin created (ownerId === bot); the
//               thread itself is the session, so any user message continues it
//   'mention' — @-mention in a non-thread guild channel; start a new thread
//   'other'   — drop (plain channel chatter, mention inside an unrelated thread)
export function classifyMessage(message, botUserId) {
  if (!message.guildId) return 'dm';
  const channel = message.channel;
  const inThread = typeof channel?.isThread === 'function' && channel.isThread();
  if (inThread) {
    // Only follow up in threads Robin owns. Threads created by other users
    // would let unrelated chatter trigger the bot.
    if (channel.ownerId === botUserId) return 'thread';
    if (message.mentions.has(botUserId)) return 'thread';
    return 'other';
  }
  if (message.mentions.has(botUserId)) return 'mention';
  return 'other';
}

export function buildEventFromMessage(message, kind) {
  return {
    source: 'discord',
    content: message.content,
    ts: new Date(),
    external_id: message.id,
    trust: 'untrusted',
    meta: {
      discord_message_id: message.id,
      channel_id: message.channelId,
      guild_id: message.guildId,
      author_id: message.author.id,
      kind,
    },
  };
}

export function buildEventFromInteraction(interaction) {
  return {
    source: 'discord',
    content: interaction.commandName,
    ts: new Date(),
    external_id: interaction.id,
    trust: 'untrusted',
    meta: {
      discord_message_id: interaction.id,
      channel_id: null,
      guild_id: interaction.guildId,
      author_id: interaction.user.id,
      kind: 'slash',
    },
  };
}
