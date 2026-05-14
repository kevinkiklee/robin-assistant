import { ChannelType, Client, GatewayIntentBits, Partials } from 'discord.js';
import { surql } from 'surrealdb';
import { getSecret, requireSecret } from '../../../config/secrets.js';
import { registerSlashCommands } from './commands.js';
import {
  buildEventFromInteraction,
  buildEventFromMessage,
  classifyMessage,
  isAllowed,
} from './dispatcher.js';
import { originForTarget, stripMention, threadTitleFrom } from './formatter.js';
import { buildBotReplyEvent, insertBoundary } from './history.js';
import { generateAndSendReply } from './reply.js';

const THREAD_AUTO_ARCHIVE_MINUTES = 1440; // 24h
const HELP_TEXT = [
  '**Robin commands**',
  '`/new` — drop the conversation history in this channel/thread/DM',
  '`/cancel` — interrupt the reply currently being generated here',
  '`/help` — show this help',
  '',
  '**Trigger Robin without slash commands**',
  '- DM Robin directly.',
  '- In a guild channel, `@`-mention Robin — I will open a thread for the conversation.',
  '- Inside a thread I created, every message you send continues the conversation.',
  '',
  '**Memory**',
  'Robin remembers the last ~20 turns of conversation per thread / DM.',
  '`/new` clears that history; future replies start fresh.',
].join('\n');

function splitIds(value) {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// Try public thread → private thread → fall back to the parent channel.
// Discord requires CreatePublicThreads / CreatePrivateThreads at the role or
// channel-override level; we attempt the better UX first and degrade gracefully.
async function openThreadOrFallback(message, botUserId) {
  const name = threadTitleFrom(message.content, botUserId);
  const opts = { name, autoArchiveDuration: THREAD_AUTO_ARCHIVE_MINUTES };
  try {
    return await message.startThread(opts);
  } catch (e) {
    if (e.code !== 50013 /* Missing Permissions */) {
      console.warn(`[discord] public-thread start failed: ${e.message}`);
    }
  }
  try {
    return await message.channel.threads.create({
      ...opts,
      type: ChannelType.PrivateThread,
      startMessage: message.id,
    });
  } catch (e) {
    console.warn(`[discord] private-thread start failed: ${e.message}`);
  }
  return null; // caller falls back to message.channel
}

export async function start(ctx) {
  const { db } = ctx;

  const bot_token = requireSecret('DISCORD_BOT_TOKEN');
  const application_id = getSecret('DISCORD_APPLICATION_ID');
  const allowed_user_ids = splitIds(getSecret('DISCORD_ALLOWED_USER_IDS'));
  const allowed_guild_ids = splitIds(getSecret('DISCORD_ALLOWED_GUILD_IDS'));

  const allowlist = {
    user_ids: allowed_user_ids,
    guild_ids: allowed_guild_ids,
    dm_user_ids: allowed_user_ids,
  };

  // Operators who forget to populate the allowlist see "Robin is online but
  // ignores everything" — the silent-deny is the safe behavior, but it's
  // invisible without this line. Log what we'll accept on startup so the
  // misconfiguration is obvious.
  if (allowed_user_ids.length === 0 && allowed_guild_ids.length === 0) {
    ctx.log(
      'discord: WARNING — DISCORD_ALLOWED_USER_IDS and DISCORD_ALLOWED_GUILD_IDS are both empty; bot will ignore every message',
    );
  } else {
    ctx.log(
      `discord: allowlist — ${allowed_user_ids.length} user(s), ${allowed_guild_ids.length} guild(s)`,
    );
  }

  // Trusted destinations for the outbound Layer-1 (untrusted-quote) bypass.
  // If `DISCORD_TRUSTED_ORIGINS` is set, parse it explicitly; otherwise default
  // to "your allowed guilds + your allowed users' DMs" since you've already
  // told us those are trusted on the *inbound* side. PII + secret guards
  // still apply at trusted origins.
  const explicitTrusted = splitIds(getSecret('DISCORD_TRUSTED_ORIGINS'));
  const trustedOrigins =
    explicitTrusted.length > 0
      ? explicitTrusted
      : [
          ...allowed_guild_ids.map((g) => `discord:guild:${g}`),
          ...allowed_user_ids.map((u) => `discord:dm:${u}`),
        ];

  // Track in-flight agent runs per channel/thread/DM so `/cancel` can abort
  // them. Keyed by channelId. Cleared in the finally block of each
  // messageCreate handler (only when the entry still points at our own
  // controller — a newer message replaces and gets its own lifecycle).
  const inFlight = new Map();

  // Per-channel Claude-agent session ids so multi-turn conversations resume
  // (`claude --resume <id>`) instead of starting fresh each message. Lives in
  // process memory only — a daemon restart drops the map and the next reply
  // begins a fresh agent session. `/new` and `/cancel` also clear the entry.
  const sessionByChannel = new Map();

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
    let channelId = null;
    let controller = null;
    try {
      if (message.author.bot) return;
      if (!isAllowed({ allowlist, message })) return;
      const botUserId = client.user?.id;
      const kind = classifyMessage(message, botUserId);
      if (kind === 'other') return;

      // Capture the inbound user message so future history queries see it.
      const event = buildEventFromMessage(message, kind);
      await ctx.capture([event]);

      // Pick the reply target. Mentions in a non-thread channel get a fresh
      // thread; DMs and existing threads reply where the user spoke.
      let target = message.channel;
      if (kind === 'mention') {
        const thread = await openThreadOrFallback(message, botUserId);
        if (thread) target = thread;
      }
      channelId = target.id;

      // Register an AbortController so /cancel can interrupt the agent run.
      // Replace any pre-existing controller — only one reply runs per channel
      // at a time; the new message implies the old one is stale.
      const prev = inFlight.get(channelId);
      if (prev) prev.abort();
      controller = new AbortController();
      inFlight.set(channelId, controller);

      const prompt = stripMention(message.content, botUserId).trim() || message.content;
      const origin = originForTarget(target, message.author.id);
      const priorSessionId = sessionByChannel.get(channelId) ?? null;
      const result = await generateAndSendReply({
        db,
        target,
        prompt,
        sessionId: priorSessionId,
        signal: controller.signal,
        origin,
        trustedOrigins,
      });

      // Update the per-channel session id so the next message resumes.
      if (result.sessionId) {
        sessionByChannel.set(channelId, result.sessionId);
      }

      if (result.sent && result.replyText) {
        // Capture Robin's reply so recall + biographer can see it later. (The
        // bot itself uses --resume for context; this capture is for the rest
        // of Robin's memory layer.)
        await ctx.capture([
          buildBotReplyEvent({
            channelId,
            replyText: result.replyText,
            botUserId,
            messageId: message.id,
          }),
        ]);
      }
    } catch (e) {
      ctx.log(`messageCreate handler error: ${e.message}`);
    } finally {
      // Only clear the map entry if it still points at OUR controller
      // (a fresh message could have replaced it mid-run).
      if (channelId && controller && inFlight.get(channelId) === controller) {
        inFlight.delete(channelId);
      }
    }
  });

  client.on('interactionCreate', async (interaction) => {
    try {
      if (!interaction.isChatInputCommand()) return;
      if (!isAllowed({ allowlist, interaction })) return;
      const event = buildEventFromInteraction(interaction);
      await ctx.capture([event]);

      switch (interaction.commandName) {
        case 'help':
          await interaction.reply({ content: HELP_TEXT, ephemeral: true });
          return;
        case 'new': {
          // Drop both the agent session-id (so --resume isn't used next turn)
          // and the history-boundary marker (so recall sees a clean break).
          sessionByChannel.delete(interaction.channelId);
          await insertBoundary(ctx.capture, interaction.channelId, interaction.user.id);
          await interaction.reply({
            content:
              'Fresh start. Robin has forgotten this conversation; the next message begins a new agent session.',
            ephemeral: true,
          });
          return;
        }
        case 'cancel': {
          const c = inFlight.get(interaction.channelId);
          // Drop the session-id too: a killed agent may have written partial
          // state; resuming from it risks confused replies.
          sessionByChannel.delete(interaction.channelId);
          if (c) {
            c.abort();
            inFlight.delete(interaction.channelId);
            await interaction.reply({
              content: 'Cancelled the reply in progress.',
              ephemeral: true,
            });
          } else {
            await interaction.reply({ content: 'Nothing to cancel.', ephemeral: true });
          }
          return;
        }
        default:
          await interaction.reply({
            content: `(robin: unknown command \`${interaction.commandName}\`)`,
            ephemeral: true,
          });
      }
    } catch (e) {
      ctx.log(`interactionCreate handler error: ${e.message}`);
    }
  });

  await client.login(bot_token);
  return client;
}
