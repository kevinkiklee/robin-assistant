# Discord setup — chat with Robin via Discord

A Discord bot front-end for Robin. When you `@`-mention the bot in your
allowlisted server (or DM it), the bot spawns `claude -p` with `cwd` set
to your Robin workspace. Per-conversation continuity uses Claude Code
session resume. Personal-only by default — allowlisted to a single user
and a single guild.

**Requirements:** macOS (uses launchd); Claude Code CLI installed and
authenticated for your account; Node ≥18.

## 1. Create the Discord application

1. Open https://discord.com/developers/applications → **New Application**.
2. Pick a name (the bot will appear under this name in your server).
3. **Bot** tab:
   - Click **Reset Token** → copy the token (you'll only see it once).
   - **Privileged Gateway Intents** → enable **Message Content Intent**
     only. Leave Presence and Server Members **off** (you don't need
     them, and turning them off avoids the 100-server verification gate).
   - **Public Bot** → uncheck (only you should be able to add it).
4. **OAuth2 → General** tab: copy the **Client ID** (== App ID) and the
   **Client Secret** (Reset Secret first if you've shared it).

## 2. Find your Discord IDs

Enable Developer Mode in Discord: Settings → Advanced → Developer Mode.

- **User ID:** right-click your own name → "Copy User ID."
- **Server (guild) ID:** right-click your server icon → "Copy Server ID."

## 3. Add to `.env`

```env
DISCORD_BOT_TOKEN=<bot token from step 1>
DISCORD_APP_ID=<client id>
DISCORD_ALLOWED_USER_IDS=<your user id>      # comma-separated if you ever add others
DISCORD_ALLOWED_GUILD_ID=<your server id>
```

`chmod 600 user-data/runtime/secrets/.env` if you haven't already. The setup
script (`auth-discord.js`) will fill in `DISCORD_BOT_CLAUDE_PATH`
automatically.

## 4. Validate token and get the invite URL

```sh
node user-data/runtime/scripts/auth-discord.js
```

This:
- hits Discord's `/users/@me` to validate the bot token,
- runs `which claude` and writes the resolved path to `.env`,
- prints an OAuth invite URL with the minimum permissions: View
  Channels, Send Messages, Send Messages in Threads, Create Public
  Threads, Read Message History.

Open the printed URL in your browser, pick your server, and authorize.

## 5. Install the launchd service

```sh
node user-data/runtime/scripts/discord-bot-install.js
```

This writes `~/Library/LaunchAgents/com.robin.discord-bot.plist` and
loads it via `launchctl bootstrap`. The service auto-starts at login,
auto-restarts on crash (with a 30s throttle), and logs to
`user-data/runtime/state/services/discord-bot.log`.

## 6. Smoke test

DM your bot:
- "hi" → should reply within ~10–15s on the first turn.
- a follow-up like "what did I just say?" → should resume context.
- `/help` → trigger list.
- `/new` → reset session.
- `/cancel` → stop an in-flight reply.

`@`-mention the bot in any channel of your allowlisted server → the bot
auto-creates a thread and replies inside it.

## Triggers

| Trigger | Behavior |
|---|---|
| `/new` | Drop the conversation's session, start fresh. |
| `/cancel` | SIGTERM the in-flight subprocess for this conversation. |
| `/help` | Print the trigger list. |

## Idle rules

- **Threads:** 24h since last message → next message starts a fresh
  Claude session. The first reply of the new session is prefixed
  `(new session) `.
- **DMs:** 4h.

## Lifecycle

```sh
# Stop / start
launchctl bootout    gui/$(id -u)/com.robin.discord-bot
launchctl bootstrap  gui/$(id -u) ~/Library/LaunchAgents/com.robin.discord-bot.plist

# Restart after editing .env
launchctl kickstart -k gui/$(id -u)/com.robin.discord-bot

# Status
node user-data/runtime/scripts/discord-bot-status.js

# Uninstall
node user-data/runtime/scripts/discord-bot-install.js --uninstall
```

## Optional: weekly health summary

```sh
node user-data/runtime/scripts/discord-bot-health.js --install
```

Schedules a launchd job (Sundays 09:00 local) that scans
`discord-bot.events.jsonl` for the last 7 days and writes a verdict
report (GREEN/YELLOW/RED + error breakdown + 7-day cost) to
`user-data/runtime/state/services/discord-bot-health.md`. Manual run:
`node user-data/runtime/scripts/discord-bot-health.js`.

## Privacy

The events log under `user-data/runtime/state/services/discord-bot.events.jsonl`
records **metadata only** — timestamp, user ID, conversation key,
latency, status, error tail, Claude session ID, cost. **No prompt or
reply text.** Discord itself stores message content (server property,
not bot property).

The bot subprocess only inherits an allowlist of env vars (HOME, PATH,
LANG, USER, SHELL) plus `ROBIN_SESSION_PLATFORM=discord`, NOT the full
`process.env`.

## Cost note

First turns are expensive — they reload Robin's full session-startup
files. A short DM session can run $0.30–0.50; a long thread can run
several dollars. Resume turns within an active conversation are much
cheaper.

## Security

- Bot token + client secret should be in `user-data/runtime/secrets/.env` only,
  with mode `0600`. Never commit them.
- Allowlist enforces both user ID **and** guild ID for non-DM messages.
  If you ever invite the bot to another server, it will silently ignore
  all activity there.
- The Claude Code subprocess respects the project's
  `.claude/settings.json` for tool permissions — same as your terminal.
  Do not add `--permission-mode bypassPermissions` to the subprocess args.

## Rotating credentials

```sh
# 1. Reset Token (and/or Reset Secret) in the Discord Developer Portal.
# 2. Update the values in user-data/runtime/secrets/.env.
# 3. Restart the bot:
launchctl kickstart -k gui/$(id -u)/com.robin.discord-bot
```

## Troubleshooting

- **Bot offline / not replying:** `node user-data/runtime/scripts/discord-bot-status.js`.
  If `launchd: NOT loaded`, re-run the installer.
- **"missing required env" exit:** the bot validates env at startup.
  Check the message for which key is missing or blank.
- **DMs don't work:** verify Message Content Intent is enabled in the
  dev portal Bot tab.
- **Manual run conflicts with launchd:** stop launchd first
  (`launchctl bootout gui/$(id -u)/com.robin.discord-bot`) before running
  `node user-data/runtime/scripts/discord-bot.js` directly.
