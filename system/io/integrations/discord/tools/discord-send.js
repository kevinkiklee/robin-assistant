import { checkOutbound } from '../../../../cognition/discretion/outbound-policy.js';
import { checkActionTrust, recordOutcome } from '../../../../cognition/jobs/action-trust.js';
import { getSecret } from '../../../../config/secrets.js';
import { checkRateLimit } from '../../../outbound/rate-limit.js';
import { DISCORD_MESSAGE_MAX } from '../constants.js';
import { formatForDiscord } from '../formatter.js';

function splitIds(value) {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function readAllowlist() {
  return {
    user_ids: new Set(splitIds(getSecret('DISCORD_ALLOWED_USER_IDS'))),
    guild_ids: new Set(splitIds(getSecret('DISCORD_ALLOWED_GUILD_IDS'))),
  };
}

function mapDiscordError(e) {
  const code = e?.code;
  const status = e?.status ?? e?.httpStatus;
  if (code === 50007) return { ok: false, reason: 'dms_closed' };
  if (status === 404 || code === 10003 || code === 10013) {
    return { ok: false, reason: 'channel_not_found' };
  }
  if (code === 50001) return { ok: false, reason: 'no_access', detail: e?.message };
  return { ok: false, reason: 'discord_error', detail: e?.message };
}

export function createDiscordSendTool({ db, capture, getGatewayClient }) {
  return {
    name: 'discord_send',
    description:
      "Send a Discord DM or channel message through robin's gateway. Allowlist-gated. 2000-char cap.",
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['send_dm', 'send_channel'] },
        args: { type: 'object' },
      },
      required: ['action', 'args'],
    },
    handler: async (input) => {
      const { action, args } = input;

      const rate = await checkRateLimit(db, 'discord_send');
      if (!rate.ok) return rate;

      if (action !== 'send_dm' && action !== 'send_channel') {
        return { ok: false, reason: 'unknown_action', action };
      }

      const cls = `discord_send:${action}`;
      const trust = await checkActionTrust(db, 'discord_send', action);
      if (trust.state === 'NEVER') {
        return { ok: false, reason: 'action_not_allowed', class: cls };
      }
      if (trust.state === 'ASK' && args?.force !== true) {
        return {
          ok: false,
          reason: 'requires_permission',
          class: cls,
          last_state_change_at: trust.last_state_change_at,
        };
      }

      const rawContent = args?.content;
      if (typeof rawContent !== 'string' || rawContent.length === 0) {
        return { ok: false, reason: 'missing_arg', arg: 'content' };
      }
      // Convert GFM tables → fenced code blocks. Length check uses the
      // post-transform string since that's what actually goes to Discord.
      const content = formatForDiscord(rawContent);
      if (content.length > DISCORD_MESSAGE_MAX) {
        return {
          ok: false,
          reason: 'content_too_long',
          max: DISCORD_MESSAGE_MAX,
          given: content.length,
        };
      }

      const client = getGatewayClient?.('discord') ?? null;
      if (!client) return { ok: false, reason: 'discord_not_running' };

      const allowlist = readAllowlist();

      try {
        if (action === 'send_dm') {
          const user_id = args?.user_id;
          if (typeof user_id !== 'string' || user_id.length === 0) {
            return { ok: false, reason: 'missing_arg', arg: 'user_id' };
          }
          if (!allowlist.user_ids.has(user_id)) {
            return { ok: false, reason: 'not_allowed' };
          }

          const policy = await checkOutbound(db, { destination: 'discord_send', text: content });
          if (!policy.ok)
            return { ok: false, reason: 'outbound_blocked', blocked_by: policy.reason };

          const user = await client.users.fetch(user_id);
          const message = await user.send(content);
          console.log(`[discord_send] sent dm to ${user_id} · ${content.length} chars`);
          await capture([
            {
              source: 'discord_send',
              content: content.slice(0, 200),
              external_id: message.id,
              meta: { action, target: { user_id }, length: content.length },
            },
          ]);
          await recordOutcome(db, cls, 'success');
          return { ok: true, message_id: message.id, channel_id: message.channelId ?? null };
        }

        // send_channel
        const channel_id = args?.channel_id;
        if (typeof channel_id !== 'string' || channel_id.length === 0) {
          return { ok: false, reason: 'missing_arg', arg: 'channel_id' };
        }

        const channel = await client.channels.fetch(channel_id);
        if (!channel) return { ok: false, reason: 'channel_not_found' };
        const guild_id = channel.guildId ?? null;
        if (!guild_id || !allowlist.guild_ids.has(guild_id)) {
          return { ok: false, reason: 'not_allowed' };
        }

        const policy = await checkOutbound(db, { destination: 'discord_send', text: content });
        if (!policy.ok) return { ok: false, reason: 'outbound_blocked', blocked_by: policy.reason };

        const message = await channel.send(content);
        console.log(`[discord_send] sent channel ${channel_id} · ${content.length} chars`);
        await capture([
          {
            source: 'discord_send',
            content: content.slice(0, 200),
            external_id: message.id,
            meta: { action, target: { channel_id, guild_id }, length: content.length },
          },
        ]);
        await recordOutcome(db, cls, 'success');
        return { ok: true, message_id: message.id, channel_id };
      } catch (e) {
        return mapDiscordError(e);
      }
    },
  };
}
