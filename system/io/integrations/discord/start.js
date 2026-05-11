import { Client, GatewayIntentBits, Partials } from 'discord.js';
import { surql } from 'surrealdb';
import { getSecret, requireSecret } from '../../../config/secrets.js';
import { registerSlashCommands } from './commands.js';
import {
  buildEventFromInteraction,
  buildEventFromMessage,
  classifyMessage,
  isAllowed,
} from './dispatcher.js';
import { generateAndSendReply } from './reply.js';

function splitIds(value) {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function start(ctx) {
  const { db, host } = ctx;

  // Discord secrets are pulled directly from dotenv: bot_token is required;
  // application_id and the allow-lists are optional. Using getSecret avoids the
  // strict throw-on-missing behavior of the ctx.secrets getter — discord can
  // boot without slash-command registration or an explicit allowlist.
  const bot_token = requireSecret('DISCORD_BOT_TOKEN');
  const application_id = getSecret('DISCORD_APPLICATION_ID');
  const allowed_user_ids = splitIds(getSecret('DISCORD_ALLOWED_USER_IDS'));
  const allowed_guild_ids = splitIds(getSecret('DISCORD_ALLOWED_GUILD_IDS'));

  const allowlist = {
    user_ids: allowed_user_ids,
    guild_ids: allowed_guild_ids,
    dm_user_ids: allowed_user_ids,
  };

  const [rt] = await db
    .query(surql`SELECT * FROM type::record('runtime', 'integrations')`)
    .collect();
  const registered = rt[0]?.value?.discord?.commands_registered_at;
  if (!registered && application_id) {
    for (const guildId of allowlist.guild_ids) {
      try {
        await registerSlashCommands({
          applicationId: application_id,
          guildId,
          botToken: bot_token,
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

  await client.login(bot_token);
  return client;
}
