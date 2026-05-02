# Secrets

API keys, tokens, and other credentials for Robin's integrations.

For provider-side setup walkthroughs (creating OAuth clients, choosing
scopes, known gotchas), see `system/integrations/`.

## Convention

- One `.env` file per workspace at `user-data/runtime/secrets/.env`.
- One key per line, `KEY=value` format.
- Comments with `#`.
- No quotes around values unless the value contains spaces.
- Reference example keys in `.env.example`.

## Loading

Scripts that need a secret read it via `process.env.KEY` after loading the env file. Use the helper at `system/scripts/sync/lib/secrets.js`:

```js
import { loadSecrets, requireSecret } from '../../system/scripts/sync/lib/secrets.js';
loadSecrets(workspaceDir);
const apiKey = requireSecret('MY_API_KEY');
```

For OAuth integrations whose refresh tokens may rotate, use `saveSecret(workspaceDir, key, value)` from the same module — it does an atomic write that preserves comments and existing keys.

## Safety

- This folder is gitignored at the repo root (`/user-data/`) and again locally (`user-data/runtime/secrets/.gitignore`).
- Never commit a real `.env`. Only `.env.example` (with placeholder values) is tracked.
- Run `npm run gitleaks` (if configured) before pushing.

## Adding a new secret

1. Add `KEY=` to `.env.example` with a comment describing what it's for.
2. Add `KEY=actual-value` to `.env`.
3. Read it in scripts via `process.env.KEY`.
