import { validateBotToken } from '../../integrations/_auth/discord-bot.js';
import { writeSecrets } from '../../integrations/_auth/secrets-io.js';
import { input } from '../prompts.js';

export async function authDiscord() {
  const bot_token = await input('Discord bot token: ');
  const me = await validateBotToken({ token: bot_token });
  const application_id = me.id;
  const allowed_user_ids = (await input('Allowed user IDs (comma-sep): '))
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const allowed_guild_ids = (await input('Allowed guild IDs (comma-sep): '))
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  await writeSecrets('discord', {
    bot_token,
    application_id,
    allowed_user_ids,
    allowed_guild_ids,
  });
  console.log(
    `discord authenticated as ${me.username}#${me.discriminator ?? ''}; secrets written.`,
  );
}
