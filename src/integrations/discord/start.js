import { Client, GatewayIntentBits, Partials } from 'discord.js';
import { surql } from 'surrealdb';
import { registerSlashCommands } from './commands.js';
import {
  buildEventFromInteraction,
  buildEventFromMessage,
  classifyMessage,
  isAllowed,
} from './dispatcher.js';
import { generateAndSendReply } from './reply.js';

export async function start(ctx) {
  const { db, host, secrets } = ctx;
  if (!secrets?.bot_token) throw new Error('discord secrets missing bot_token');
  const allowlist = {
    user_ids: secrets.allowed_user_ids ?? [],
    guild_ids: secrets.allowed_guild_ids ?? [],
    dm_user_ids: secrets.allowed_user_ids ?? [],
  };

  const [rt] = await db
    .query(surql`SELECT * FROM type::record('runtime', 'integrations')`)
    .collect();
  const registered = rt[0]?.value?.discord?.commands_registered_at;
  if (!registered && secrets.application_id) {
    for (const guildId of allowlist.guild_ids) {
      try {
        await registerSlashCommands({
          applicationId: secrets.application_id,
          guildId,
          botToken: secrets.bot_token,
        });
      } catch (e) {
        ctx.log(`slash registration failed for guild ${guildId}: ${e.message}`);
      }
    }
    const cur = rt[0]?.value ?? {};
    const merged = {
      ...cur,
      discord: { ...(cur.discord ?? {}), commands_registered_at: new Date() },
    };
    await db
      .query(surql`UPSERT type::record('runtime', 'integrations') SET value = ${merged}`)
      .collect();
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
    partials: [Partials.Channel],
  });

  client.on('messageCreate', async (message) => {
    try {
      if (message.author.bot) return;
      if (!isAllowed({ allowlist, message })) return;
      const kind = classifyMessage(message, client.user?.id);
      if (kind === 'other') return;
      const event = buildEventFromMessage(message, kind);
      await ctx.capture([event]);
      await generateAndSendReply({ db, host, message, prompt: message.content });
    } catch (e) {
      ctx.log(`messageCreate handler error: ${e.message}`);
    }
  });

  client.on('interactionCreate', async (interaction) => {
    try {
      if (!interaction.isChatInputCommand()) return;
      if (!isAllowed({ allowlist, interaction })) return;
      const event = buildEventFromInteraction(interaction);
      await ctx.capture([event]);
      await interaction.reply(`(robin: ${interaction.commandName} received)`);
    } catch (e) {
      ctx.log(`interactionCreate handler error: ${e.message}`);
    }
  });

  await client.login(secrets.bot_token);
  return client;
}
