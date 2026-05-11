import { spawn } from 'node:child_process';
import readline from 'node:readline/promises';
import { runHeadlessAuth, runLoopbackAuth } from '../../../io/integrations/_auth/oauth2.js';
import { loadManifests } from '../../../io/integrations/_framework/manifest-loader.js';
import { requireSecret, saveSecret } from '../../../config/secrets.js';

// Default scope unions per provider. Manifests do not yet declare oauth scopes
// (Phase 2f introduces them via `secrets.oauth.scopes` in a later task); until
// they do, the auth CLIs request the union of scopes the bundled integrations
// actually use. unionScopes() prefers manifest-declared scopes when present so
// this default becomes a fallback once manifests are annotated.
const DEFAULT_SCOPES = {
  google: [
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/calendar.readonly',
    'https://www.googleapis.com/auth/drive.readonly',
    'https://www.googleapis.com/auth/youtube.readonly',
  ],
  spotify: [
    'user-read-private',
    'user-read-recently-played',
    'user-top-read',
    'user-library-read',
    'playlist-read-private',
  ],
  whoop: ['read:recovery', 'read:cycles', 'read:sleep', 'read:workout', 'read:profile', 'offline'],
};

function openUrl(url) {
  return new Promise((resolve, reject) => {
    const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
    const p = spawn(cmd, [url], { stdio: 'ignore', detached: true });
    p.on('error', reject);
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
  });
}

export function parseCodeArg(argv) {
  const i = argv.indexOf('--code');
  if (i === -1) {
    // Also support `--code=<VALUE>` even if `--code` alone isn't present.
    const inline = argv.find((a) => a.startsWith('--code='));
    if (inline) return { mode: 'headless-inline', code: inline.slice('--code='.length) };
    return { mode: 'loopback' };
  }
  const arg = argv[i];
  if (arg === '--code') {
    if (argv[i + 1] && !argv[i + 1].startsWith('--')) {
      console.error(
        'error: use `--code=<VALUE>` or `--code` alone for interactive prompt; space-separated form is ambiguous',
      );
      process.exit(1);
    }
    return { mode: 'headless-interactive' };
  }
  if (arg.startsWith('--code=')) {
    return { mode: 'headless-inline', code: arg.slice('--code='.length) };
  }
  return { mode: 'loopback' };
}

async function unionScopes(provider) {
  const dir = new URL('../../integrations/', import.meta.url).pathname;
  const { loaded: manifests } = await loadManifests(dir);
  const all = new Set();
  for (const m of manifests) {
    // Forward-compat: pick up scopes if manifests declare `secrets.oauth.{provider, scopes}`.
    if (m.secrets?.oauth?.provider === provider) {
      for (const s of m.secrets.oauth.scopes ?? []) all.add(s);
    }
  }
  if (all.size > 0) return [...all];
  return DEFAULT_SCOPES[provider] ?? [];
}

function buildSecretsFor(envKeys) {
  const out = {};
  for (const k of envKeys) {
    try {
      out[k] = requireSecret(k);
    } catch {
      // Missing client_id/secret will surface from the provider's token endpoint
      // with a clearer error than re-throwing here would.
    }
  }
  return out;
}

async function runAuthFlow({ provider, refreshTokenEnv, clientEnvKeys, argv }) {
  const scopes = await unionScopes(provider);
  if (scopes.length === 0) {
    console.error(`no integrations declare oauth scopes for provider ${provider}`);
    process.exit(1);
  }
  const secrets = buildSecretsFor(clientEnvKeys);
  const parse = parseCodeArg(argv);
  let tokens;
  if (parse.mode === 'loopback') {
    tokens = await runLoopbackAuth({ provider, scopes, openFn: openUrl, secrets });
  } else if (parse.mode === 'headless-interactive') {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      tokens = await runHeadlessAuth({
        provider,
        scopes,
        secrets,
        readCode: async () => (await rl.question('Paste the code= parameter: ')).trim(),
      });
    } finally {
      rl.close();
    }
  } else {
    tokens = await runHeadlessAuth({
      provider,
      scopes,
      secrets,
      readCode: async () => parse.code,
    });
  }
  if (!tokens.refresh_token) {
    console.error(
      `${provider} authentication did not return a refresh_token; ensure the consent flow includes offline access`,
    );
    process.exit(1);
  }
  saveSecret(refreshTokenEnv, tokens.refresh_token);
  console.log(`${provider} authenticated; refresh token saved.`);
}

export async function authGoogle(argv) {
  return await runAuthFlow({
    provider: 'google',
    refreshTokenEnv: 'GOOGLE_OAUTH_REFRESH_TOKEN',
    clientEnvKeys: ['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET'],
    argv,
  });
}

export { runAuthFlow };
