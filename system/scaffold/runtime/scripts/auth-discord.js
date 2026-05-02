#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile, access, chmod, constants } from 'node:fs/promises';
import { PermissionsBitField } from 'discord.js';
import { requireSecret, getSecret } from '../../../system/scripts/sync/lib/secrets.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROBIN_ROOT = resolve(__dirname, '../../../');
const ENV_PATH = resolve(ROBIN_ROOT, 'user-data/runtime/secrets/.env');
// Cycle-2a: do NOT call dotenv.config — secrets stay out of process.env.
// Read each value via requireSecret/getSecret which read .env directly.

async function main() {
  const errors = [];
  for (const k of ['DISCORD_BOT_TOKEN', 'DISCORD_APP_ID', 'DISCORD_ALLOWED_USER_IDS', 'DISCORD_ALLOWED_GUILD_ID']) {
    if (!getSecret(ROBIN_ROOT, k)) errors.push(`missing ${k}`);
  }
  if (errors.length) {
    console.error('Setup blockers:'); errors.forEach(e => console.error(' -', e));
    process.exit(1);
  }

  // 1) Validate token
  const res = await fetch('https://discord.com/api/v10/users/@me', {
    headers: { Authorization: `Bot ${requireSecret(ROBIN_ROOT, 'DISCORD_BOT_TOKEN').trim()}` },
  });
  if (!res.ok) {
    console.error(`[auth-discord] token validation failed: ${res.status} ${res.statusText}`);
    process.exit(1);
  }
  const me = await res.json();
  console.log(`[auth-discord] token OK: ${me.username}#${me.discriminator || '0'} (id=${me.id})`);

  // 2) Resolve claude binary
  const which = spawnSync('which', ['claude'], { encoding: 'utf-8' });
  if (which.status !== 0 || !which.stdout.trim()) {
    console.error('[auth-discord] could not find `claude` on PATH. Install Claude Code first.');
    process.exit(1);
  }
  const claudePath = which.stdout.trim();
  await access(claudePath, constants.X_OK);
  console.log(`[auth-discord] claude found at ${claudePath}`);

  // 3) Persist DISCORD_BOT_CLAUDE_PATH to .env
  let envText = '';
  try { envText = await readFile(ENV_PATH, 'utf-8'); } catch {}
  const updated = upsertEnvKey(envText, 'DISCORD_BOT_CLAUDE_PATH', claudePath);
  await writeFile(ENV_PATH, updated);
  await chmod(ENV_PATH, 0o600);
  console.log(`[auth-discord] wrote DISCORD_BOT_CLAUDE_PATH to ${ENV_PATH} (mode 0600)`);

  // 4) Print invite URL
  const perms = new PermissionsBitField([
    PermissionsBitField.Flags.ViewChannel,
    PermissionsBitField.Flags.SendMessages,
    PermissionsBitField.Flags.SendMessagesInThreads,
    PermissionsBitField.Flags.CreatePublicThreads,
    PermissionsBitField.Flags.ReadMessageHistory,
  ]);
  const url = `https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(requireSecret(ROBIN_ROOT, 'DISCORD_APP_ID'))}&scope=bot&permissions=${perms.bitfield}`;
  console.log('\nInvite URL (open in browser, choose your server):');
  console.log(url);
}

function upsertEnvKey(envText, key, value) {
  const lines = envText.split('\n');
  let found = false;
  const out = lines.map(line => {
    if (line.startsWith(`${key}=`)) { found = true; return `${key}=${value}`; }
    return line;
  });
  if (!found) out.push(`${key}=${value}`);
  return out.join('\n');
}

main().catch(err => { console.error('[auth-discord] fatal:', err); process.exit(1); });
