const DISCORD_MAX = 2000;

function readAllowedUserIds() {
  return (process.env.DISCORD_ALLOWED_USER_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function truncateForDiscord(text) {
  // Spread to code points: `String.slice` cuts surrogate pairs mid-pair when an
  // emoji or non-BMP character straddles the boundary, and Discord's API can
  // reject the resulting invalid UTF-16. Discord's 2000 limit is by code unit,
  // but emitting valid UTF-16 is what matters here.
  const codePoints = [...text];
  if (codePoints.length <= DISCORD_MAX) return text;
  return `${codePoints.slice(0, DISCORD_MAX - 1).join('')}…`;
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
