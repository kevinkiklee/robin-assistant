import { execFile } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { isProcessAlive, readPidfile } from '../../kernel/runtime/pidfile.ts';
import { loadEnvFile } from '../../lib/secrets/load-env.ts';
import { pidFilePath, resolveUserDataDir } from '../../lib/paths.ts';

const execFileAsync = promisify(execFile);
const LAUNCHD_LABEL = 'io.robin-assistant.daemon';

/**
 * Per-integration OAuth presets. Each entry names the env-var prefix the
 * integration already uses for client_id / client_secret / refresh_token and
 * the scopes to request on consent.
 *
 * Add a new integration here when you need a CLI reauth path for it. Keep
 * scopes minimal — broader scopes flip Google into "sensitive" review even
 * though we're not publishing.
 */
const PRESETS: Record<
  string,
  { envPrefix: string; scopes: string[]; label: string }
> = {
  gmail: {
    envPrefix: 'GMAIL',
    scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
    label: 'Gmail (read-only)',
  },
  google_calendar: {
    envPrefix: 'GOOGLE_CALENDAR',
    // calendar.events grants read + write on event data without ACL/calendar-
    // list management. If Kevin ever needs to create calendars themselves
    // (rare), upgrade to `calendar`.
    scopes: ['https://www.googleapis.com/auth/calendar.events'],
    label: 'Google Calendar (read + write)',
  },
};

const DEFAULT_PORT = 8089;
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';

export interface ReauthOptions {
  integration: string;
  port?: number;
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

  const port = opts.port ?? DEFAULT_PORT;
  const redirectUri = `http://localhost:${port}/oauth/callback`;
  const state = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

  const consentUrl = new URL(AUTH_URL);
  consentUrl.searchParams.set('client_id', clientId);
  consentUrl.searchParams.set('redirect_uri', redirectUri);
  consentUrl.searchParams.set('response_type', 'code');
  consentUrl.searchParams.set('scope', preset.scopes.join(' '));
  // `access_type=offline` + `prompt=consent` together are what guarantee a
  // *new* refresh_token. Without `prompt=consent` Google returns the old one
  // (or nothing if the cached consent is fresh) — which silently leaves us
  // with the same revoked token we started with.
  consentUrl.searchParams.set('access_type', 'offline');
  consentUrl.searchParams.set('prompt', 'consent');
  consentUrl.searchParams.set('state', state);

  // biome-ignore lint/suspicious/noConsole: CLI output
  console.log(`\nReauthorizing ${preset.label}.`);
  // biome-ignore lint/suspicious/noConsole: CLI output
  console.log(`Listening on ${redirectUri}\n`);
  // biome-ignore lint/suspicious/noConsole: CLI output
  console.log('If the browser doesn\'t open, paste this URL manually:\n');
  // biome-ignore lint/suspicious/noConsole: CLI output
  console.log(`  ${consentUrl.toString()}\n`);

  const code = await captureCodeViaLocalServer({
    port,
    expectedState: state,
    openUrl: consentUrl.toString(),
  });
  // biome-ignore lint/suspicious/noConsole: CLI output
  console.log('\nGot consent code. Exchanging for refresh token...');

  const tokens = await exchangeCodeForTokens({
    code,
    clientId,
    clientSecret,
    redirectUri,
  });
  if (!tokens.refresh_token) {
    throw new Error(
      'Google returned no refresh_token. This usually means a stale consent — try again, and confirm the consent screen showed all requested permissions.',
    );
  }

  const envPath = join(userData, 'config', 'secrets', '.env');
  upsertEnvKey(envPath, `${preset.envPrefix}_REFRESH_TOKEN`, tokens.refresh_token);

  // biome-ignore lint/suspicious/noConsole: CLI output
  console.log(`\n✓ Wrote new ${preset.envPrefix}_REFRESH_TOKEN to ${envPath}`);

  // Try to nudge the daemon so the new token is picked up. The daemon reads
  // process.env at start, so we have to bounce it. If launchd is supervising
  // it'll respawn automatically; otherwise the user needs to restart by hand.
  const restarted = await bounceDaemonIfRunning(userData);
  // biome-ignore lint/suspicious/noConsole: CLI output
  console.log(
    restarted
      ? 'Sent SIGTERM to running daemon (launchd should respawn it). Verify with `robin status`.'
      : 'No running daemon detected. Restart the daemon manually (`robin daemon --foreground` or via launchd) to pick up the new token.',
  );
}

interface CaptureOpts {
  port: number;
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
      if (url.pathname !== '/oauth/callback') {
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
}): Promise<TokenResponse> {
  const body = new URLSearchParams({
    code: args.code,
    client_id: args.clientId,
    client_secret: args.clientSecret,
    redirect_uri: args.redirectUri,
    grant_type: 'authorization_code',
  });
  const res = await fetch(TOKEN_URL, {
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
  const next = re.test(original)
    ? original.replace(re, line)
    : `${original.trimEnd()}\n${line}\n`;
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
    const { stdout } = await execFileAsync('launchctl', [
      'print',
      `gui/${uid}/${LAUNCHD_LABEL}`,
    ]);
    return /state\s*=\s*(running|active|waiting)/i.test(stdout);
  } catch {
    return false;
  }
}
