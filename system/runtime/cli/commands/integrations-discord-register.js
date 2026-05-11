import { getSecret, requireSecret } from '../../../config/secrets.js';
import { registerSlashCommands } from '../../../io/integrations/discord/commands.js';

export async function integrationsDiscordRegister() {
  let bot_token;
  let application_id;
  try {
    bot_token = requireSecret('DISCORD_BOT_TOKEN');
    application_id = requireSecret('DISCORD_APPLICATION_ID');
  } catch (e) {
    if (/missing secret/.test(e.message)) {
      console.error(
        'discord not authenticated; set DISCORD_BOT_TOKEN and DISCORD_APPLICATION_ID via: robin secrets set <KEY>',
      );
      process.exit(1);
    }
    throw e;
  }
  const guildIds = (getSecret('DISCORD_ALLOWED_GUILD_IDS') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (guildIds.length === 0) {
    console.error(
      'no DISCORD_ALLOWED_GUILD_IDS set; set it via: robin secrets set DISCORD_ALLOWED_GUILD_IDS',
    );
    process.exit(1);
  }
  let failures = 0;
  for (const guildId of guildIds) {
    try {
      await registerSlashCommands({
        applicationId: application_id,
        guildId,
        botToken: bot_token,
      });
      console.log(`registered slash commands for guild ${guildId}`);
    } catch (e) {
      failures += 1;
      console.error(`failed for guild ${guildId}: ${e.message}`);
    }
  }
  if (failures > 0) process.exit(1);
}
