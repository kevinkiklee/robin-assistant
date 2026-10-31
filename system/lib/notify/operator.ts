import {
  type DiscordResult,
  notifyDiscordAction,
} from '../../integrations/builtin/discord/index.ts';
import { notifyMacOSAction } from '../../integrations/builtin/notify/index.ts';

export interface OperatorNotification {
  title: string;
  message: string;
  /** Appended on its own line in Discord; ignored by the macOS banner. */
  link?: string;
  /** Prefix the operator's `<@id>` in Discord. Defaults to true. */
  mention?: boolean;
  /** Discord silent flag: unread mark, no push, no sound. For off-hours sends. */
  silent?: boolean;
}

export interface OperatorResult {
  delivered: boolean;
  reason?: string;
  transports: {
    macos: { delivered: boolean; reason?: string };
    discord: DiscordResult;
  };
}

/**
 * The single operational-notification surface: a macOS banner for when the operator is
 * at the machine, and a Discord ping for when they aren't.
 *
 * Both transports are attempted independently and neither can throw, so one
 * being unconfigured or down never suppresses the other — `delivered` is true
 * if *either* landed. Discord no-ops quietly without `DISCORD_BOT_TOKEN` +
 * `DISCORD_NOTIFY_CHANNEL_ID`, which is the default for a fresh install.
 */
export async function notifyOperator(n: OperatorNotification): Promise<OperatorResult> {
  const [macos, discord] = await Promise.all([
    notifyMacOSAction({ title: n.title, message: n.message }),
    notifyDiscordAction({
      title: n.title,
      message: n.message,
      link: n.link,
      mention: n.mention,
      silent: n.silent,
    }),
  ]);
  const delivered = macos.delivered || discord.delivered;
  const reason = delivered
    ? undefined
    : [macos.reason && `macos:${macos.reason}`, discord.reason && `discord:${discord.reason}`]
        .filter(Boolean)
        .join('; ');
  return { delivered, reason, transports: { macos, discord } };
}
