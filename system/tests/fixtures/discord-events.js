export function makeMessage({
  id = 'm1',
  content = 'hello',
  author_id = 'u1',
  guild_id = 'g1',
  channel_id = 'c1',
  mentions_bot = false,
  dm = false,
} = {}) {
  return {
    id,
    content,
    author: { id: author_id, bot: false },
    guildId: dm ? null : guild_id,
    channelId: channel_id,
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
