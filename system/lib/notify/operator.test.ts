import assert from 'node:assert/strict';
import { test } from 'node:test';
import { notifyOperator } from './operator.ts';

// No DISCORD_BOT_TOKEN / channel in the test env: Discord must decline quietly
// while the macOS banner still goes out (or declines on non-darwin) — the point
// is that neither transport can throw or suppress the other.
test('notifyOperator reports both transports and never throws', async () => {
  const out = await notifyOperator({ title: 'T', message: 'm' });
  assert.ok('macos' in out.transports && 'discord' in out.transports);
  assert.equal(typeof out.delivered, 'boolean');
  if (!out.transports.discord.delivered) assert.ok(out.transports.discord.reason);
});
