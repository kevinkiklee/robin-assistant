# Secrets

API keys, tokens, and other credentials for Robin's integrations.

## Convention

- One `.env` file per workspace at `user-data/secrets/.env`.
- One key per line, `KEY=value` format.
- Comments with `#`.
- No quotes around values unless the value contains spaces.
- Reference example keys in `.env.example`.

## Loading

Scripts that need a secret read it via `process.env.KEY` after loading the env file. Use the helper at `system/scripts/lib/load-secrets.js` (loads `user-data/secrets/.env` into `process.env`).

## Safety

- This folder is gitignored at the repo root (`/user-data/`) and again locally (`user-data/secrets/.gitignore`).
- Never commit a real `.env`. Only `.env.example` (with placeholder values) is tracked.
- Run `npm run gitleaks` (if configured) before pushing.

## Adding a new secret

1. Add `KEY=` to `.env.example` with a comment describing what it's for.
2. Add `KEY=actual-value` to `.env`.
3. Read it in scripts via `process.env.KEY`.
