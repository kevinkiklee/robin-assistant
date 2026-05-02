# Integrations

Platform: claude-code

## Available

- email: gmail
  - live: mcp__claude_ai_Gmail__         (Claude Code only)
  - sync: knowledge/email/                (every 15m, when sync-gmail job is enabled)
- calendar: google
  - live: mcp__claude_ai_Google_Calendar__
  - sync: knowledge/calendar/             (every 30m, when sync-calendar job is enabled)
- storage: google-drive
  - live: mcp__claude_ai_Google_Drive__
- finance: lunch-money
  - sync: knowledge/finance/lunch-money/  (daily, via sync-lunch-money job)
- github: github
  - sync: knowledge/github/               (hourly, when sync-github job is enabled)
  - write: user-data/scripts/github-write.js (--action create-issue|comment|label|mark-read)
- music: spotify
  - sync: knowledge/spotify/              (every 4h, when sync-spotify job is enabled)
  - write: user-data/scripts/spotify-write.js (--action queue|skip|playlist-add)
- weather: user-provided (paste or summarize)
- browser: user-provided (paste or summarize)
- discord: discord
  - bot: user-data/scripts/discord-bot.js (launchd-supervised on macOS)
  - control: user-data/scripts/discord-bot-{install,status,health}.js
  - triggers: @mention, DM, /new /cancel /help
  - allowlisted: DISCORD_ALLOWED_USER_IDS + DISCORD_ALLOWED_GUILD_ID

## Setup status

The Calendar / Gmail / GitHub / Spotify sync jobs ship `enabled: false` and
do not run until you complete the per-provider auth setup. Each setup is a
one-shot script:

  node user-data/scripts/auth-google.js     # Calendar + Gmail (shared OAuth client)
  node user-data/scripts/auth-github.js     # validate fine-grained PAT
  node user-data/scripts/auth-spotify.js    # OAuth, port 8765 callback

After auth succeeds, run a `--bootstrap` once and enable the job:

  node user-data/scripts/sync-<name>.js --bootstrap
  node bin/robin.js jobs enable sync-<name>

See system/scaffold/secrets/README.md for the .env keys each provider needs.

## Not configured

- maps, health

## Fallback behavior

For any integration not listed above, protocols ask the user to provide the
information directly (paste, summarize, or screenshot).
