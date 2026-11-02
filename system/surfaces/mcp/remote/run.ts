#!/usr/bin/env node
import { buildCoreDeps } from '../core/server.ts';
import { parseRedirectHosts, REDIRECT_HOSTS_ENV } from './oauth/redirect.ts';
import { type RemoteMcpHandle, startRemoteMcpServer } from './server.ts';

export const REMOTE_TOKEN_ENV = 'ROBIN_MCP_REMOTE_TOKEN';
export const REMOTE_PUBLIC_URL_ENV = 'ROBIN_MCP_PUBLIC_URL';
export const REMOTE_REDIRECT_HOSTS_ENV = REDIRECT_HOSTS_ENV;

/**
 * Read the consent-screen access key. Refuses to fall back to a generated or
 * default value: a server that boots without one would let whoever finds the
 * consent page authorize themselves, and the operator would never know.
 */
export function resolveRemoteToken(env: Record<string, string | undefined>): string {
  const token = (env[REMOTE_TOKEN_ENV] ?? '').trim();
  if (!token) {
    throw new Error(
      `${REMOTE_TOKEN_ENV} is not set. Add it to user-data/config/secrets/.env — generate one with:\n` +
        `  ${REMOTE_TOKEN_ENV}=$(openssl rand -base64 48 | tr -d '/+=' | cut -c1-43)`,
    );
  }
  return token;
}

/**
 * The public origin. OAuth metadata has to advertise absolute URLs that match
 * what the client actually reached, so this cannot be inferred from a loopback
 * bind — a wrong value produces a flow that fails only at the last step.
 */
export function resolvePublicUrl(env: Record<string, string | undefined>): string {
  const raw = (env[REMOTE_PUBLIC_URL_ENV] ?? '').trim();
  if (!raw) {
    throw new Error(
      `${REMOTE_PUBLIC_URL_ENV} is not set. It must be the public origin this server is reached at, e.g.\n` +
        `  ${REMOTE_PUBLIC_URL_ENV}=https://mcp.example.com`,
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${REMOTE_PUBLIC_URL_ENV} is not a valid URL: ${raw}`);
  }
  if (parsed.protocol !== 'https:') {
    // OAuth 2.1 requires HTTPS for authorization server endpoints.
    throw new Error(`${REMOTE_PUBLIC_URL_ENV} must be https, got: ${raw}`);
  }
  return `${parsed.protocol}//${parsed.host}`;
}

/**
 * Optional extra redirect hosts, comma-separated, on top of claude.ai and
 * claude.com. Unset is the normal case. A malformed entry (wildcard, scheme,
 * bare TLD) throws rather than quietly widening who can receive a code.
 */
export function resolveRedirectHosts(env: Record<string, string | undefined>): string[] {
  return parseRedirectHosts(env[REMOTE_REDIRECT_HOSTS_ENV]);
}

/** Boots the server and hands the handle back; the caller owns any output. */
export async function runMcpRemote(opts: { port?: number } = {}): Promise<RemoteMcpHandle> {
  // Separate process from the daemon and from the stdio MCP servers: it must
  // load secrets and open its own DB handle. loadEnvFile runs inside buildCoreDeps.
  const deps = buildCoreDeps();
  const accessKey = resolveRemoteToken(process.env);
  const publicUrl = resolvePublicUrl(process.env);
  const redirectHosts = resolveRedirectHosts(process.env);
  return await startRemoteMcpServer({
    ...deps,
    accessKey,
    publicUrl,
    redirectHosts,
    port: opts.port,
    // JSON lines to stdout, which launchd captures. This is the only record of
    // who reached the endpoint, so it stays on by default rather than behind a
    // debug flag — a public surface with no access log can't be audited.
    onRequest: (entry) => {
      process.stdout.write(`${JSON.stringify(entry)}\n`);
    },
  });
}
