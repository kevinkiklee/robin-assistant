export async function stop(ctx, client) {
  if (!client) return;
  try {
    await client.destroy();
  } catch (e) {
    ctx.log?.(`discord stop error: ${e.message}`);
  }
}
