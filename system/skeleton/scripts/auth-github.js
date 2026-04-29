#!/usr/bin/env node
// Template — auto-copied to user-data/scripts/ by skeleton-sync.
// Imports resolve only after copy; not runnable in place.
//
// GitHub PAT validator. Confirms the token in .env actually authenticates,
// reports the user it's tied to, and lists granted scopes.
//
// Usage:
//   node user-data/scripts/auth-github.js
//
// Prerequisite: in user-data/secrets/.env, set:
//   GITHUB_PAT=<fine-grained personal access token>
// Generate at: https://github.com/settings/tokens?type=beta
// Recommended scopes: read:user, repo (or public_repo), notifications.

import { fileURLToPath } from 'node:url';
import { fetchJson } from '../../system/scripts/lib/sync/http.js';
import { loadSecrets, requireSecret } from '../../system/scripts/lib/sync/secrets.js';

async function main() {
  const workspaceDir = fileURLToPath(new URL('../..', import.meta.url));
  loadSecrets(workspaceDir);

  let pat;
  try {
    pat = requireSecret('GITHUB_PAT');
  } catch (err) {
    console.error(`\n[auth-github] ${err.message}\n`);
    console.error(
      'Generate a fine-grained PAT at\n' +
      '  https://github.com/settings/tokens?type=beta\n' +
      'with these scopes (or repo equivalents):\n' +
      '  - read:user\n  - repo (or public_repo for read-only public)\n  - notifications\n' +
      'Then add this line to user-data/secrets/.env:\n' +
      '  GITHUB_PAT=<your-token>\n'
    );
    process.exit(1);
  }

  // Use raw fetch here so we can read response headers (X-OAuth-Scopes etc.)
  // — fetchJson returns parsed JSON only.
  const res = await fetch('https://api.github.com/user', {
    headers: {
      Authorization: `Bearer ${pat}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });

  if (res.status === 401) {
    console.error(`\n[auth-github] PAT rejected (401). Check the value in .env.\n`);
    process.exit(1);
  }
  if (!res.ok) {
    console.error(`\n[auth-github] HTTP ${res.status}: ${await res.text()}\n`);
    process.exit(1);
  }

  const user = await res.json();
  const scopes = res.headers.get('x-oauth-scopes') ?? '(fine-grained — scopes not exposed)';
  const ratelimit = res.headers.get('x-ratelimit-limit') ?? '?';
  const remaining = res.headers.get('x-ratelimit-remaining') ?? '?';

  console.log(`[auth-github] OK`);
  console.log(`  user:       ${user.login} (${user.name ?? '(no name)'})`);
  console.log(`  scopes:     ${scopes}`);
  console.log(`  rate limit: ${remaining}/${ratelimit} remaining`);
  console.log('');
  console.log('  Enable the sync job with:');
  console.log('    node bin/robin.js jobs enable sync-github');
  console.log('    node user-data/scripts/sync-github.js --bootstrap');
}

main().catch((err) => {
  console.error(`\n[auth-github] failed: ${err.message}`);
  process.exit(1);
});
