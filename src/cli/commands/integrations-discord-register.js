import { readSecrets } from '../../integrations/_auth/secrets-io.js';
import { registerSlashCommands } from '../../integrations/discord/commands.js';

export async function integrationsDiscordRegister() {
  const secrets = await readSecrets('discord');
  if (!secrets?.bot_token || !secrets?.application_id) {
    console.error('discord not authenticated; run: robin auth discord');
    process.exit(1);
  }
  const guildIds = secrets.allowed_guild_ids ?? [];
  if (guildIds.length === 0) {
    console.error('no allowed_guild_ids in discord secrets; re-run: robin auth discord');
    process.exit(1);
  }
  let failures = 0;
  for (const guildId of guildIds) {
    try {
      await registerSlashCommands({
        applicationId: secrets.application_id,
        guildId,
        botToken: secrets.bot_token,
      });
      console.log(`registered slash commands for guild ${guildId}`);
    } catch (e) {
      failures += 1;
      console.error(`failed for guild ${guildId}: ${e.message}`);
    }
  }
  if (failures > 0) process.exit(1);
}
