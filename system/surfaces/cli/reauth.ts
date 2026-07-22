import { execFile } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { closeDb, openDb, type RobinDb } from '../../brain/memory/db.ts';
import { isProcessAlive, readPidfile } from '../../kernel/runtime/pidfile.ts';
import { dbFilePath, pidFilePath, resolveUserDataDir } from '../../lib/paths.ts';
import { loadEnvFile } from '../../lib/secrets/load-env.ts';

const execFileAsync = promisify(execFile);
const LAUNCHD_LABEL = 'io.robin-assistant.daemon';

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const WHOOP_AUTH_URL = 'https://api.prod.whoop.com/oauth/oauth2/auth';
const WHOOP_TOKEN_URL = 'https://api.prod.whoop.com/oauth/oauth2/token';

const DEFAULT_PORT = 8089;

// `access_type=offline` + `prompt=consent` together are what guarantee Google
// returns a *new* refresh_token. Without `prompt=consent` Google returns the old
// one (or nothing if the cached consent is fresh) — silently leaving us with the
// same revoked token we started with. Whoop needs neither; its `offline` scope
// is what triggers refresh-token issuance.
const GOOGLE_CONSENT_PARAMS = { access_type: 'offline', prompt: 'consent' };

interface OAuthPreset {
  /** Env-var prefix for CLIENT_ID / CLIENT_SECRET / REFRESH_TOKEN. */
  envPrefix: string;
  scopes: string[];
  label: string;
  authUrl: string;
  tokenUrl: string;
  /** Local redirect path; MUST match a Redirect URI registered with the provider. */
  callbackPath: string;
  /** Extra authorize-URL query params (provider-specific consent flags). */
  extraAuthParams: Record<string, string>;
  /**
   * When set, delete the integration's cached token rows from
   * `integration_state` after writing the new refresh token. Required for
   * providers whose integration reads
   *   ctx.state.get('<x>_refresh_token') ?? process.env.<X>_REFRESH_TOKEN
   * (Whoop rotates single-use refresh tokens and caches the latest in state) —
   * the stale cached row would otherwise SHADOW the fresh .env value and the
   * daemon would keep failing with the dead token. Google integrations read the
   * refresh token from env only, so they leave this unset.
   */
  clearStateFor?: string;
}

/**
 * Per-integration OAuth presets. Each entry names the env-var prefix the
 * integration already uses and the provider endpoints / scopes to request.
 *
 * Add a new integration here when you need a CLI reauth path for it. Keep
 * scopes minimal — broader scopes flip Google into "sensitive" review even
 * though we're not publishing.
 */
const PRESETS: Record<string, OAuthPreset> = {
  gmail: {
    envPrefix: 'GMAIL',
    scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
    label: 'Gmail (read-only)',
    authUrl: GOOGLE_AUTH_URL,
    tokenUrl: GOOGLE_TOKEN_URL,
    callbackPath: '/oauth/callback',
    extraAuthParams: GOOGLE_CONSENT_PARAMS,
  },
  google_calendar: {
    envPrefix: 'GOOGLE_CALENDAR',
    // calendar.events grants read + write on event data without ACL/calendar-
    // list management. To also create/delete calendars (rare), upgrade to
    // the broader `calendar` scope.
    scopes: ['https://www.googleapis.com/auth/calendar.events'],
    label: 'Google Calendar (read + write)',
    authUrl: GOOGLE_AUTH_URL,
    tokenUrl: GOOGLE_TOKEN_URL,
    callbackPath: '/oauth/callback',
    extraAuthParams: GOOGLE_CONSENT_PARAMS,
  },
  whoop: {
    envPrefix: 'WHOOP',
    // `offline` is what makes Whoop return a refresh_token; the read:* scopes
    // cover the four streams the integration syncs (recovery/sleep/workout/cycle).
    scopes: [
      'offline',
      'read:recovery',
      'read:cycles',
      'read:sleep',
      'read:workout',
      'read:profile',
      'read:body_measurement',
    ],
    label: 'Whoop (recovery, sleep, workouts)',
    authUrl: WHOOP_AUTH_URL,
    tokenUrl: WHOOP_TOKEN_URL,
    // Whoop's registered redirect is http://localhost:8089/callback — matching
    // the pre-existing standalone flow in user-data/scripts/whoop-reauth.mjs so
    // the same Whoop developer-app registration works for both.
    callbackPath: '/callback',
    extraAuthParams: {},
    clearStateFor: 'whoop',
  },
};

export interface ReauthOptions {
  integration: string;
  port?: number;
}

/**
 * Resolve the redirect URI plus the local port/path to listen on. An explicit
 * `<PREFIX>_REDIRECT_URI` override wins and is honored verbatim (its port and
 * path drive the local capture server), so a user can match whatever their
 * provider app has registered — a different port OR a different path — without
 * editing code. Absent an override, we build `http://localhost:<port><path>`
 * from the `--port` flag (or DEFAULT_PORT) and the preset's callback path.
 */
export function resolveRedirect(
  override: string | undefined,
  portOpt: number | undefined,
  preset: Pick<OAuthPreset, 'callbackPath'>,
): { redirectUri: string; port: number; callbackPath: string } {
  if (override) {
    const u = new URL(override);
    const port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
    return { redirectUri: override, port, callbackPath: u.pathname };
  }
  const port = portOpt ?? DEFAULT_PORT;
  return {
    redirectUri: `http://localhost:${port}${preset.callbackPath}`,
    port,
    callbackPath: preset.callbackPath,
  };
}

export async function runReauth(opts: ReauthOptions): Promise<void> {
  const preset = PRESETS[opts.integration];
  if (!preset) {
    const known = Object.keys(PRESETS).join(', ');
    throw new Error(`unknown integration '${opts.integration}'. known: ${known}`);
  }

  const userData = resolveUserDataDir();
  loadEnvFile(userData);

  const clientId = process.env[`${preset.envPrefix}_CLIENT_ID`];
  const clientSecret = process.env[`${preset.envPrefix}_CLIENT_SECRET`];
  if (!clientId || !clientSecret) {
    throw new Error(
      `${preset.envPrefix}_CLIENT_ID / _CLIENT_SECRET must be set in user-data/config/secrets/.env before reauth.`,
    );
  }

  // The redirect URI must match one the provider has pre-registered EXACTLY.
  // A `<PREFIX>_REDIRECT_URI` env override wins so the user can point at
  // whatever is registered (different port OR path) without a code change;
  // otherwise fall back to localhost + the preset's default path.
  const { redirectUri, port, callbackPath } = resolveRedirect(
    process.env[`${preset.envPrefix}_REDIRECT_URI`],
    opts.port,
    preset,
  );
  const state = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

  const consentUrl = new URL(preset.authUrl);
  consentUrl.searchParams.set('client_id', clientId);
  consentUrl.searchParams.set('redirect_uri', redirectUri);
  consentUrl.searchParams.set('response_type', 'code');
  consentUrl.searchParams.set('scope', preset.scopes.join(' '));
  consentUrl.searchParams.set('state', state);
  for (const [key, value] of Object.entries(preset.extraAuthParams)) {
    consentUrl.searchParams.set(key, value);
  }

  console.log(`\nReauthorizing ${preset.label}.`);
  console.log(
    `Listening on ${redirectUri} (this redirect URI must be registered with the provider)\n`,
  );
  console.log("If the browser doesn't open, paste this URL manually:\n");
  console.log(`  ${consentUrl.toString()}\n`);

  const code = await captureCodeViaLocalServer({
    port,
    callbackPath,
    expectedState: state,
    openUrl: consentUrl.toString(),
  });
  console.log('\nGot consent code. Exchanging for refresh token...');

  const tokens = await exchangeCodeForTokens({
    code,
    clientId,
    clientSecret,
    redirectUri,
    tokenUrl: preset.tokenUrl,
  });
  if (!tokens.refresh_token) {
    throw new Error(
      'Provider returned no refresh_token. Google: usually a stale consent — retry and confirm the consent screen showed all requested permissions. Whoop: ensure the `offline` scope was granted.',
    );
  }

  const envPath = join(userData, 'config', 'secrets', '.env');
  upsertEnvKey(envPath, `${preset.envPrefix}_REFRESH_TOKEN`, tokens.refresh_token);

  console.log(`\n✓ Wrote new ${preset.envPrefix}_REFRESH_TOKEN to ${envPath}`);

  // Some integrations cache their (rotated) refresh token in integration_state
  // and read it BEFORE the env value — so a stale cached row would shadow the
  // token we just wrote. Delete the cached token rows so the fresh .env value
  // wins on the next tick. (Google reads the refresh token from env only.)
  if (preset.clearStateFor) {
    const db = openDb(dbFilePath(userData));
    try {
      const cleared = clearShadowingTokenRows(db, preset.clearStateFor);
      console.log(
        `✓ Cleared ${cleared} stale cached token row(s) from integration_state (so the new token isn't shadowed)`,
      );
    } finally {
      closeDb(db);
    }
  }

  // Try to nudge the daemon so the new token is picked up. The daemon reads
  // process.env at start, so we have to bounce it. If launchd is supervising
  // it'll respawn automatically; otherwise the user needs to restart by hand.
  const restarted = await bounceDaemonIfRunning(userData);
  console.log(
    restarted
      ? 'Sent SIGTERM to running daemon (launchd should respawn it). Verify with `robin status`.'
      : 'No running daemon detected. Restart the daemon manually (`robin daemon --foreground` or via launchd) to pick up the new token.',
  );
}

interface CaptureOpts {
  port: number;
  callbackPath: string;
  expectedState: string;
  openUrl: string;
}

function captureCodeViaLocalServer(opts: CaptureOpts): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      if (!req.url) {
        res.statusCode = 400;
        res.end('missing url');
        return;
      }
      const url = new URL(req.url, `http://localhost:${opts.port}`);
      if (url.pathname !== opts.callbackPath) {
        res.statusCode = 404;
        res.end('not found');
        return;
      }
      const error = url.searchParams.get('error');
      if (error) {
        res.statusCode = 400;
        res.end(`Google returned an OAuth error: ${error}. You can close this tab.`);
        server.close();
        reject(new Error(`google oauth consent returned error: ${error}`));
        return;
      }
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      if (!code) {
        res.statusCode = 400;
        res.end('missing code');
        server.close();
        reject(new Error('callback missing code parameter'));
        return;
      }
      // State check guards against the (unlikely but cheap) case where a
      // different process triggered a parallel consent flow on the same port.
      if (state !== opts.expectedState) {
        res.statusCode = 400;
        res.end('state mismatch');
        server.close();
        reject(new Error('oauth state mismatch — possible cross-flow callback'));
        return;
      }
      res.statusCode = 200;
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(
        '<!doctype html><meta charset=utf-8><title>robin reauth</title>' +
          '<style>body{font:14px/1.5 -apple-system,system-ui,sans-serif;color:#1a1a1a;background:#f5f4ee;padding:48px;max-width:520px;margin:auto}h1{font-size:18px;color:#d44715}</style>' +
          '<h1>Robin: reauth complete</h1>' +
          '<p>You can close this tab and return to the terminal.</p>',
      );
      server.close();
      resolve(code);
    });
    server.on('error', (err) => reject(err));
    server.listen(opts.port, '127.0.0.1', () => {
      // Best-effort browser launch (macOS only here; the URL is already printed
      // for non-macOS or when `open` is missing).
      execFile('open', [opts.openUrl], () => {
        // ignore errors — we already told the user how to paste the URL
      });
    });
  });
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope: string;
  token_type: string;
}

async function exchangeCodeForTokens(args: {
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  tokenUrl: string;
}): Promise<TokenResponse> {
  const body = new URLSearchParams({
    code: args.code,
    client_id: args.clientId,
    client_secret: args.clientSecret,
    redirect_uri: args.redirectUri,
    grant_type: 'authorization_code',
  });
  const res = await fetch(args.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) {
    throw new Error(`token exchange returned ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as TokenResponse;
}

/**
 * Delete an integration's cached OAuth token rows (`*_refresh_token`,
 * `*_access_token`, `*_access_token_expiry`) from `integration_state`, leaving
 * cursors, `last_sync`, and everything else intact. Returns the number of rows
 * deleted. Used after a reauth for providers whose integration prefers the
 * state-cached refresh token over the .env value (see `clearStateFor`).
 */
export function clearShadowingTokenRows(db: RobinDb, integrationName: string): number {
  const res = db
    .prepare(
      `DELETE FROM integration_state
       WHERE integration_name = ?
         AND (key LIKE '%\\_refresh\\_token' ESCAPE '\\'
           OR key LIKE '%\\_access\\_token' ESCAPE '\\'
           OR key LIKE '%\\_access\\_token\\_expiry' ESCAPE '\\')`,
    )
    .run(integrationName);
  return res.changes;
}

/**
 * Atomically replace (or append) a `KEY=value` line in a .env file.
 * Preserves all other lines, including comments and blank lines. The value
 * is double-quoted only if it contains whitespace or `=`; OAuth refresh
 * tokens never need quoting in practice but the check is defensive.
 */
export function upsertEnvKey(path: string, key: string, value: string): void {
  const original = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const needsQuote = /\s|=|"/.test(value);
  const literal = needsQuote ? `"${value.replace(/"/g, '\\"')}"` : value;
  const line = `${key}=${literal}`;
  const re = new RegExp(`^(?:export\\s+)?${key}=.*$`, 'm');
  const next = re.test(original) ? original.replace(re, line) : `${original.trimEnd()}\n${line}\n`;
  writeFileSync(path, next, 'utf8');
}

async function bounceDaemonIfRunning(userData: string): Promise<boolean> {
  // Prefer `launchctl kickstart -k` when the daemon is supervised — it
  // guarantees a clean process recycle (TERM the old one, start a fresh one)
  // even when the old process is wedged in shutdown. SIGTERM alone has bitten
  // us when the daemon's shutdown handler hung past process.exit.
  if (await isLaunchdManaged()) {
    try {
      await execFileAsync('launchctl', [
        'kickstart',
        '-k',
        `gui/${process.getuid?.() ?? 501}/${LAUNCHD_LABEL}`,
      ]);
      return true;
    } catch {
      // Fall through to SIGTERM as a best-effort backup.
    }
  }
  const pidPath = pidFilePath(userData);
  const pid = readPidfile(pidPath);
  if (!pid || !isProcessAlive(pid)) return false;
  try {
    process.kill(pid, 'SIGTERM');
    return true;
  } catch {
    return false;
  }
}

async function isLaunchdManaged(): Promise<boolean> {
  try {
    const uid = process.getuid?.() ?? 501;
    const { stdout } = await execFileAsync('launchctl', ['print', `gui/${uid}/${LAUNCHD_LABEL}`]);
    return /state\s*=\s*(running|active|waiting)/i.test(stdout);
  } catch {
    return false;
  }
}
