export async function validateBotToken({ token, fetchFn = globalThis.fetch }) {
  const r = await fetchFn('https://discord.com/api/v10/users/@me', {
    headers: { Authorization: `Bot ${token}` },
  });
  if (!r.ok) throw new Error(`discord bot token invalid: ${r.status}`);
  return await r.json();
}
