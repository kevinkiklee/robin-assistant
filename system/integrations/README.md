# Integration setup playbooks

Step-by-step provider-side setup for each integration that ships with Robin.
These docs cover the parts that happen *outside* your shell (developer
consoles, OAuth consent screens, scope decisions) and the gotchas worth
knowing before you start.

The corresponding **scripts** live in `system/scaffold/scripts/` and are
copied to `user-data/ops/scripts/` on first run:

- `auth-google.js`, `auth-github.js`, `auth-spotify.js` — one-shot setup
- `sync-calendar.js`, `sync-gmail.js`, `sync-github.js`, `sync-spotify.js`,
  `sync-lunch-money.js` — periodic data pulls

The OAuth library used by all OAuth providers lives in
`system/scripts/sync/lib/oauth.js`.

## Per-provider playbooks

| Provider | Doc | What you get |
|---|---|---|
| Google (Calendar + Gmail) | [google-setup.md](google-setup.md) | events sync, inbox metadata, top senders |
| GitHub | [github-setup.md](github-setup.md) | activity events, releases from starred repos, notifications* |
| Spotify | [spotify-setup.md](spotify-setup.md) | recently-played, top tracks/artists, playlist metadata* |
| Lunch Money | [lunch-money-setup.md](lunch-money-setup.md) | transactions, accounts, budgets |
| Discord | [discord-setup.md](discord-setup.md) | personal Discord bot front-end (chat with Robin from Discord) |

\* Some endpoints are gated for newer apps — see provider-specific docs.

## Standard flow for OAuth providers

1. Create app/client in the provider's developer console.
2. Add credentials to `user-data/ops/secrets/.env` (placeholders ship in
   `system/scaffold/secrets/.env.example`).
3. Run `node user-data/ops/scripts/auth-<provider>.js` — opens a browser, runs
   the OAuth code flow against `127.0.0.1:<port>/oauth-callback`, writes
   the refresh token back to `.env`, caches the access token in
   `user-data/ops/state/sync/<provider>.json`.
4. Bootstrap once: `node user-data/ops/scripts/sync-<name>.js --bootstrap`.
5. Enable the recurring job: `node bin/robin.js jobs enable sync-<name>`.

## Where data lands

All sync output is written under `user-data/memory/knowledge/<topic>/` as
markdown. That keeps it readable, greppable, and git-diffable. Auth tokens
live in `user-data/ops/secrets/.env` (gitignored). Per-provider cursor state
(access token cache, last-sync timestamps) lives in
`user-data/ops/state/sync/<provider>.json`.
