const DISCORD_MAX = 2000;

function readAllowedUserIds() {
  return (process.env.DISCORD_ALLOWED_USER_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function truncateForDiscord(text) {
  if (text.length <= DISCORD_MAX) return text;
  return `${text.slice(0, DISCORD_MAX - 1)}…`;
}

export async function dispatchNotify({ capture, name, notify, output, tools, kind }) {
  const externalIdPrefix = `${name}:${new Date().toISOString()}`;
  const sendDiscord = notify === 'discord_dm' || notify === 'both';
  const sendCapture = notify === 'capture' || notify === 'both';

  if (sendDiscord) {
    const users = readAllowedUserIds();
    if (users.length === 0) {
      throw new Error('no discord notify target (DISCORD_ALLOWED_USER_IDS empty)');
    }
    const tool = tools.find((t) => t?.name === 'discord_send');
    if (!tool) throw new Error('discord_send tool not registered');
    const result = await tool.handler({
      action: 'send_dm',
      args: { user_id: users[0], content: truncateForDiscord(output) },
    });
    if (!result?.ok) {
      throw new Error(`discord_send refused: ${result?.reason ?? 'unknown'}`);
    }
  }

  if (sendCapture) {
    await capture([
      {
        source: kind === 'failure' ? 'job_notification' : 'job_output',
        content: output.slice(0, 4000),
        external_id: externalIdPrefix,
        meta: { job_name: name, kind },
      },
    ]);
  }
}
