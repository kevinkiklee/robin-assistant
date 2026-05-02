#!/usr/bin/env node
import { Client, GatewayIntentBits, Events, ChannelType, Partials } from 'discord.js';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { access, constants, stat, writeFile, mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { homedir, userInfo } from 'node:os';
import { existsSync } from 'node:fs';
import dotenv from 'dotenv';
import { createSessionStore } from './lib/discord/session-store.js';
import { createEventLog } from './lib/discord/event-log.js';
import { createRunner } from './lib/discord/claude-runner.js';
import { isAllowedContext } from './lib/discord/auth.js';
import { stripMention, splitMessage } from './lib/discord/formatter.js';
import { assertOutboundContentAllowed, OutboundPolicyError, buildRefusalEntry } from '../../system/scripts/lib/outbound-policy.js';
import { appendPolicyRefusal } from '../../system/scripts/lib/policy-refusals-log.js';
import { requireSecret } from '../../system/scripts/lib/sync/secrets.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROBIN_ROOT = resolve(__dirname, '../../');
const STATE_DIR = resolve(ROBIN_ROOT, 'user-data/state');
const LOG_DIR = resolve(STATE_DIR, 'logs');
const SESSIONS_PATH = resolve(STATE_DIR, 'discord-sessions.json');
const EVENTS_PATH = resolve(LOG_DIR, 'discord-bot.events.jsonl');
const STATUS_PATH = resolve(STATE_DIR, 'discord-bot.status.json');
const SECRETS_ENV = resolve(ROBIN_ROOT, 'user-data/secrets/.env');

// Cycle-2a: dotenv.config still loads non-secret config from .env (the bot
// needs DISCORD_BOT_CLAUDE_PATH, TIMEOUT_MS, etc. as env so they show up in
// claude-runner's whitelist semantics). After load, we explicitly delete
// secret keys so they cannot leak via subprocess inheritance.
dotenv.config({ path: SECRETS_ENV });
const SECRET_KEYS = [
  'DISCORD_BOT_TOKEN',
  'DISCORD_APP_ID',
  'DISCORD_ALLOWED_USER_IDS',
  'DISCORD_ALLOWED_GUILD_ID',
  'GITHUB_PAT',
  'LUNCH_MONEY_API_KEY',
  'GOOGLE_OAUTH_CLIENT_ID',
  'GOOGLE_OAUTH_CLIENT_SECRET',
  'GOOGLE_OAUTH_REFRESH_TOKEN',
  'SPOTIFY_CLIENT_ID',
  'SPOTIFY_CLIENT_SECRET',
  'SPOTIFY_REFRESH_TOKEN',
];
for (const k of SECRET_KEYS) {
  delete process.env[k];
}

const ENV_WHITELIST = ['HOME', 'PATH', 'LANG', 'USER', 'SHELL'];
const TTL = { dm: 4 * 3600 * 1000, thread: 24 * 3600 * 1000 };

// Required CONFIG keys (non-secrets). Secrets are validated below via
// requireSecret() and throw clear errors if missing.
const REQUIRED_CONFIG_KEYS = [
  'DISCORD_BOT_CLAUDE_PATH',
];

async function main() {
  // 1. Validate config + secrets
  for (const k of REQUIRED_CONFIG_KEYS) {
    if (!process.env[k] || !process.env[k].trim()) {
      console.error(`[discord-bot] missing required config: ${k}`);
      process.exit(1);
    }
  }

  // Cycle-2a: read secrets via requireSecret() — they are NOT in process.env.
  let allowedUserIdsRaw, allowedGuildIdRaw;
  try {
    allowedUserIdsRaw = requireSecret(ROBIN_ROOT, 'DISCORD_ALLOWED_USER_IDS');
    allowedGuildIdRaw = requireSecret(ROBIN_ROOT, 'DISCORD_ALLOWED_GUILD_ID');
    requireSecret(ROBIN_ROOT, 'DISCORD_BOT_TOKEN');  // existence check; actual value read at login
    requireSecret(ROBIN_ROOT, 'DISCORD_APP_ID');     // existence check
  } catch (err) {
    console.error(`[discord-bot] ${err.message}`);
    process.exit(1);
  }

  const allow = {
    allowedUserIds: allowedUserIdsRaw.split(',').map(s => s.trim()).filter(Boolean),
    allowedGuildId: allowedGuildIdRaw.trim(),
  };
  const binPath = process.env.DISCORD_BOT_CLAUDE_PATH.trim();
  const timeoutMs = Number(process.env.DISCORD_BOT_TIMEOUT_MS || 600_000);
  const maxTurns = Number(process.env.DISCORD_BOT_MAX_TURNS || 30);
  const maxConcurrent = Number(process.env.DISCORD_BOT_MAX_CONCURRENT_RUNS || 4);

  // 2. Verify binary exists at startup
  try {
    await access(binPath, constants.X_OK);
  } catch {
    console.error(`[discord-bot] DISCORD_BOT_CLAUDE_PATH is not executable: ${binPath}`);
    process.exit(1);
  }

  // 3. .env perms warning
  try {
    const s = await stat(SECRETS_ENV);
    if ((s.mode & 0o077) !== 0) {
      console.warn(`[discord-bot] WARNING: ${SECRETS_ENV} is mode ${(s.mode & 0o777).toString(8)}, expected 0600`);
    }
  } catch { /* ignore */ }

  // 4. Cross-recovery: ensure the watchdog launchd job is installed and loaded.
  // If the bot is starting up but the watchdog isn't watching, install it.
  // Failure here is non-fatal — bot keeps running; watchdog can be installed
  // manually later.
  try {
    const watchdogLabel = 'com.robin.discord-bot-watchdog';
    const watchdogPlist = resolve(homedir(), 'Library/LaunchAgents', `${watchdogLabel}.plist`);
    const watchdogScript = resolve(__dirname, 'discord-bot-watchdog.js');
    const printR = spawnSync('launchctl', ['print', `gui/${userInfo().uid}/${watchdogLabel}`]);
    if (!existsSync(watchdogPlist) || printR.status !== 0) {
      const r = spawnSync(process.execPath, [watchdogScript, '--install'], { encoding: 'utf-8' });
      if (r.status === 0) console.log('[discord-bot] re-installed watchdog (was missing)');
      else console.error(`[discord-bot] watchdog re-install failed: ${(r.stderr || r.stdout).trim()}`);
    }
  } catch (err) {
    console.error(`[discord-bot] watchdog ensure error (non-fatal): ${err.message}`);
  }

  // 5. Init state
  await mkdir(LOG_DIR, { recursive: true });
  const sessionStore = await createSessionStore({ path: SESSIONS_PATH });
  const eventLog = createEventLog({ path: EVENTS_PATH });
  const runner = createRunner({
    binPath,
    cwd: ROBIN_ROOT,
    envWhitelist: ENV_WHITELIST,
    maxTurns,
    timeoutMs,
    maxConcurrent,
  });

  // 6. Discord client
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
    partials: [Partials.Channel, Partials.Message], // needed for DM delivery to uncached channels
  });

  let hasConnected = false;

  async function writeStatus(state) {
    try {
      await writeFile(STATUS_PATH, JSON.stringify({ state, ts: new Date().toISOString() }, null, 2));
    } catch { /* best-effort */ }
  }

  client.on(Events.ClientReady, async () => {
    console.log(`[discord-bot] logged in as ${client.user.tag}`);
    await writeStatus('ready');
    if (!hasConnected) {
      hasConnected = true;
      await eventLog.append({ event: 'startup', status: 'ok' });
    } else {
      await eventLog.append({ event: 'reconnect', status: 'ok' });
    }
  });

  client.on(Events.ShardReconnecting, () => writeStatus('reconnecting'));
  client.on(Events.ShardResume, async () => {
    await writeStatus('ready');
    await eventLog.append({ event: 'resume', status: 'ok' });
  });
  client.on(Events.ShardDisconnect, async (closeEvent, shardId) => {
    await writeStatus('disconnected');
    await eventLog.append({
      event: 'disconnect',
      status: 'ok',
      shardId,
      code: closeEvent?.code ?? null,
      reason: closeEvent?.reason ? String(closeEvent.reason) : null,
      wasClean: closeEvent?.wasClean ?? null,
    });
  });
  client.on(Events.ShardError, async (error, shardId) => {
    await eventLog.append({
      event: 'shard_error',
      status: 'error',
      shardId,
      message: error?.message ?? String(error),
    });
  });

  client.on(Events.MessageCreate, async (message) => {
    if (message.author.bot) return;
    // DIAG (DM debug, 2026-04-30): log every received human message pre-auth.
    // Revert by deleting this line once DM delivery is confirmed working.
    console.log(`[discord-bot] msg type=${message.channel.type} guild=${message.guildId ?? 'DM'} user=${message.author.id} content_len=${message.content?.length ?? 0} allowed=${isAllowedContext(message, allow)}`);
    if (!isAllowedContext(message, allow)) return;

    const expiredKeys = await sessionStore.expireIdle(TTL);

    const isDm = message.channel.type === ChannelType.DM;
    const isThread = message.channel.isThread?.() === true;
    const botUserId = client.user.id;
    const mentioned = message.mentions.users.has(botUserId);

    // Trigger check.
    let key;
    if (isDm) {
      key = `dm-${message.author.id}`;
    } else if (isThread) {
      const existing = sessionStore.getSession(`thread-${message.channel.id}`);
      if (!existing && !mentioned) return; // thread but no session and no @ → ignore
      key = `thread-${message.channel.id}`;
    } else if (mentioned) {
      // Channel @-mention: open a thread
      const cleanedFirst = stripMention(message.content, botUserId).trim() || 'Robin';
      const threadName = cleanedFirst.slice(0, 50);
      try {
        const thread = await message.startThread({ name: threadName, autoArchiveDuration: 1440 });
        key = `thread-${thread.id}`;
        message._discordBotThread = thread; // pass-through for reply target
      } catch (err) {
        console.error('[discord-bot] startThread failed:', err.message);
        return;
      }
    } else {
      return; // no trigger
    }

    let cleanText = stripMention(message.content, botUserId).trim();

    // Text triggers
    if (cleanText === '/help') {
      await safeReply(message, helpText(), key);
      await eventLog.append({ event: 'help', status: 'ok', userId: message.author.id, conversationKey: key });
      return;
    }
    if (cleanText === '/new') {
      await sessionStore.drop(key);
      await safeReply(message, 'Started fresh.', key);
      await eventLog.append({ event: 'new', status: 'ok', userId: message.author.id, conversationKey: key });
      return;
    }
    if (cleanText === '/cancel') {
      const cancelled = runner.cancel(key);
      await safeReply(message, cancelled ? 'Stopped.' : 'Nothing to stop.', key);
      await eventLog.append({ event: 'cancel', status: cancelled ? 'ok' : 'noop', userId: message.author.id, conversationKey: key });
      return;
    }

    if (!cleanText) cleanText = 'Hi';

    const ctxHeader = isDm
      ? `[Discord — DM | user: ${message.author.username}]`
      : `[Discord — channel: #${(message.channel.parent?.name ?? message.channel.name) ?? '?'} | user: ${message.author.username}]`;
    const prompt = `${ctxHeader}\n${cleanText}`;

    // "Fresh after idle" means we just dropped this key in expireIdle above.
    // A genuinely-new conversation gets no prefix.
    const wasIdleExpired = expiredKeys.has(key);
    const priorSessionId = sessionStore.getSession(key)?.claudeSessionId ?? null;

    // Typing indicator
    const typingTarget = message._discordBotThread ?? message.channel;
    let typingTimer;
    try {
      await typingTarget.sendTyping();
      typingTimer = setInterval(() => typingTarget.sendTyping().catch(() => {}), 8000);
    } catch { /* ignore */ }

    const start = Date.now();
    let runResult;
    try {
      runResult = await runner.run({ key, prompt, priorSessionId });
    } catch (err) {
      clearInterval(typingTimer);
      const userMsg = err.code === 'TIMEOUT'
        ? 'Robin took too long and was stopped.'
        : err.code === 'CANCELLED'
        ? null
        : err.code === 'PARSE_FAILED' || err.code === 'NONZERO_EXIT'
        ? 'Robin had an error. (logged)'
        : `Robin: unexpected error (${err.code || 'UNKNOWN'}).`;
      if (userMsg) await safeReply(message, userMsg, key);
      await eventLog.append({
        event: 'run', status: 'error', userId: message.author.id, conversationKey: key,
        latencyMs: Date.now() - start, error: (err.stderrTail || err.message || '').slice(-2048),
      });
      return;
    }
    clearInterval(typingTimer);

    if (runResult.sessionId) {
      await sessionStore.setSession(key, runResult.sessionId);
    }

    let body = runResult.result;
    const emptyResult = !body || !body.trim();
    if (emptyResult) {
      // Claude exited cleanly but produced no final text. Almost always means
      // the --max-turns ceiling was hit while Claude was still in tool-use mode.
      const note = runResult.isError
        ? `Robin couldn't finish (${runResult.subtype || 'is_error'}). Try a simpler question or raise DISCORD_BOT_MAX_TURNS.`
        : `Robin returned no text — likely hit the turn limit (currently ${maxTurns}) mid-tool-use. Try a simpler question, or bump DISCORD_BOT_MAX_TURNS in .env and restart.`;
      await safeReply(message, note, key);
      await eventLog.append({
        event: 'run', status: 'empty_result', userId: message.author.id, conversationKey: key,
        latencyMs: Date.now() - start, claudeSessionId: runResult.sessionId, totalCostUsd: runResult.costUsd,
      });
      return;
    }
    if (wasIdleExpired) body = `(new session) ${body}`;
    const chunks = splitMessage(body);
    if (chunks.length === 0) {
      await safeReply(message, '(no response)', key);
    } else {
      await safeReply(message, chunks[0], key);
      for (let i = 1; i < chunks.length; i++) {
        await safeChannelSend(typingTarget, chunks[i], key);
      }
    }

    await eventLog.append({
      event: 'run', status: 'ok', userId: message.author.id, conversationKey: key,
      latencyMs: Date.now() - start, claudeSessionId: runResult.sessionId, totalCostUsd: runResult.costUsd,
    });
  });

  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[discord-bot] shutdown (${signal})`);
    await writeStatus('shutdown');
    try { client.destroy(); } catch {}
    process.exit(0);
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  await client.login(requireSecret(ROBIN_ROOT, 'DISCORD_BOT_TOKEN'));

  // Outbound policy gate: applied to every reply or channel send. Wraps the
  // proposed content; on OutboundPolicyError replaces with a refusal note and
  // logs to policy-refusals.log. The bot must not exit on a policy error
  // (long-lived process) — we substitute the content and continue.
  function gateContent({ content, targetStr, inboundOriginStr }) {
    try {
      assertOutboundContentAllowed({
        content,
        target: targetStr,
        workspaceDir: ROBIN_ROOT,
        ctx: { inboundOrigin: inboundOriginStr },
      });
      return content;
    } catch (e) {
      if (e instanceof OutboundPolicyError) {
        appendPolicyRefusal(ROBIN_ROOT, buildRefusalEntry({ target: targetStr, error: e, content }));
        return `(declined to send full reply: outbound policy layer ${e.layer} — ${e.reason})`;
      }
      throw e;
    }
  }

  function inboundOriginFromMessage(msg) {
    if (msg.channel?.isDMBased?.()) return `discord:dm:${msg.author.id}`;
    if (msg._discordBotThread) {
      const t = msg._discordBotThread;
      return `discord:guild:${t.guildId}:channel:${t.parentId}:thread:${t.id}`;
    }
    if (msg.channel?.guildId) return `discord:guild:${msg.channel.guildId}:channel:${msg.channel.id}`;
    return 'discord:unknown';
  }

  async function safeReply(msg, content, key) {
    const inboundOrigin = inboundOriginFromMessage(msg);
    const targetStr = inboundOrigin;  // by construction reply goes back to inbound
    const safe = gateContent({ content, targetStr, inboundOriginStr: inboundOrigin });
    try {
      const target = msg._discordBotThread;
      if (target) {
        await target.send({ content: safe, allowedMentions: { parse: [], repliedUser: false } });
      } else {
        await msg.reply({ content: safe, allowedMentions: { parse: [], repliedUser: false } });
      }
    } catch (err) {
      if (err.code === 10003 /* Unknown Channel */ || err.code === 50001 /* Missing Access */) {
        await sessionStore.drop(key);
        await eventLog.append({ event: 'reply', status: 'channel_gone', conversationKey: key });
      } else {
        console.error('[discord-bot] reply failed:', err.message);
      }
    }
  }

  async function safeChannelSend(channel, content, key) {
    // For channel sends we don't have the original message; use the channel-
    // derived target. For DMs we don't track the recipient here, so fall back
    // to the channel id only.
    let targetStr;
    if (channel.isDMBased?.()) targetStr = `discord:dm:${channel.recipient?.id ?? 'unknown'}`;
    else if (channel.guildId) targetStr = `discord:guild:${channel.guildId}:channel:${channel.id}`;
    else targetStr = `discord:channel:${channel.id}`;
    const safe = gateContent({ content, targetStr, inboundOriginStr: targetStr });
    try {
      await channel.send({ content: safe, allowedMentions: { parse: [], repliedUser: false } });
    } catch (err) {
      if (err.code === 10003 || err.code === 50001) {
        await sessionStore.drop(key);
      }
    }
  }

  function helpText() {
    return [
      '**Robin**',
      '- DM me, or `@`-mention me in an allowed channel.',
      '- I auto-create a thread on `@`-mention; reply in that thread to continue.',
      '- `/new` — drop session, start fresh.',
      '- `/cancel` — stop the current in-flight reply.',
      '- `/help` — this message.',
      '_Idle: 24h thread, 4h DM. After idle, the next reply is prefixed `(new session)`._',
    ].join('\n');
  }
}

main().catch(err => {
  console.error('[discord-bot] fatal:', err);
  process.exit(1);
});
