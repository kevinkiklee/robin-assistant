// `channel_kind` controls how `message.channel.isThread()` and `.ownerId`
// behave so tests can exercise the dispatcher's thread-vs-channel logic
// without spinning up real discord.js types.
//   'channel'       — regular guild text channel
//   'bot_thread'    — thread Robin owns (ownerId === botUserId, default 'bot')
//   'other_thread'  — thread owned by some other user
export function makeMessage({
  id = 'm1',
  content = 'hello',
  author_id = 'u1',
  guild_id = 'g1',
  channel_id = 'c1',
  mentions_bot = false,
  dm = false,
  channel_kind = 'channel',
  bot_user_id = 'bot',
} = {}) {
  const channel = {
    id: channel_id,
    isThread: () => channel_kind === 'bot_thread' || channel_kind === 'other_thread',
    ownerId:
      channel_kind === 'bot_thread'
        ? bot_user_id
        : channel_kind === 'other_thread'
          ? 'someone-else'
          : null,
    send: async (text) => ({ id: `send-${id}`, content: text }),
    sendTyping: async () => true,
  };
  return {
    id,
    content,
    author: { id: author_id, bot: false },
    guildId: dm ? null : guild_id,
    channelId: channel_id,
    channel,
    // `has` is uid-agnostic on purpose: classifyMessage passes the bot's id,
    // but tests describe intent via the `mentions_bot` boolean rather than
    // matching exact ids.
    mentions: { has: () => mentions_bot },
    reply: async (text) => ({ id: `reply-${id}`, content: text }),
  };
}

export function makeInteraction({
  id = 'i1',
  commandName = '/help',
  user_id = 'u1',
  guild_id = 'g1',
} = {}) {
  return {
    id,
    isChatInputCommand: () => true,
    commandName,
    user: { id: user_id },
    guildId: guild_id,
    reply: async () => ({}),
  };
}
