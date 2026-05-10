const COMMANDS = [
  { name: 'new', description: 'Start a new Robin session' },
  { name: 'cancel', description: 'Cancel current session' },
  { name: 'help', description: 'Show Robin help' },
];

export async function registerSlashCommands({
  applicationId,
  guildId,
  botToken,
  fetchFn = globalThis.fetch,
}) {
  const r = await fetchFn(
    `https://discord.com/api/v10/applications/${applicationId}/guilds/${guildId}/commands`,
    {
      method: 'PUT',
      headers: { Authorization: `Bot ${botToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(COMMANDS),
    },
  );
  if (!r.ok) throw new Error(`discord command registration failed: ${r.status}`);
  return await r.json();
}
