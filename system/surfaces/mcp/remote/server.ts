import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { LLMDispatcher } from '../../../brain/llm/dispatcher.ts';
import type { RobinDb } from '../../../brain/memory/db.ts';
import { buildCoreServer, READ_ONLY_TOOLS, REMOTE_WRITE_TOOLS } from '../core/server.ts';
import { consentErrorPage, consentPage } from './oauth/consent.ts';
import { isAllowedRedirectUri } from './oauth/redirect.ts';
import {
  getClient,
  issueCode,
  issueTokens,
  type RegisteredClient,
  redeemCode,
  redeemRefreshToken,
  registerClient,
  verifyAccessToken,
} from './oauth/store.ts';

/**
 * The access key gates the consent screen — it is what stops anyone who finds
 * the endpoint from authorizing themselves. 32 chars of base64url is ~192 bits.
 */
export const MIN_TOKEN_LENGTH = 32;

/** The MCP endpoint. Deliberately short and boring: claude.ai's connector
 * validator rejects a URL whose path carries a long high-entropy secret
 * (verified 2026-08-08 — the same server connected at `/mcp` and failed at
 * `/t/<43-char-token>/mcp`), so the credential lives in a header, not the path. */
const MCP_PATH = '/mcp';
/**
 * Two scopes, chosen on the consent screen. Read is always granted; write is
 * opt-in per connection, so a token that only ever needs to search memory can't
 * be used to modify it if it leaks.
 */
const READ_SCOPE = 'robin:read';
const WRITE_SCOPE = 'robin:write';

/** Tools a token may reach, from the scope recorded on it at consent time. */
function toolsForScope(scope: string | undefined): ReadonlySet<string> {
  const granted = new Set((scope ?? '').split(/\s+/).filter(Boolean));
  const allow = new Set<string>(READ_ONLY_TOOLS);
  if (granted.has(WRITE_SCOPE)) for (const tool of REMOTE_WRITE_TOOLS) allow.add(tool);
  return allow;
}

export interface RemoteRequestLog {
  ts: string;
  method: string;
  path: string;
  status: number;
  /** JSON-RPC method, for accepted MCP POSTs. */
  rpc?: string;
  ip?: string;
  userAgent?: string;
}

export interface RemoteMcpDeps {
  db: RobinDb;
  /** Dispatcher for recall's vector layer. Null → lexical recall only. */
  llm: LLMDispatcher | null;
  /** Secret entered on the consent screen to approve a connection. */
  accessKey: string;
  /** Public origin this server is reached at, e.g. https://mcp.example.com. */
  publicUrl: string;
  /**
   * Extra https redirect hosts allowed at registration, beyond claude.ai and
   * claude.com (and their subdomains). From ROBIN_MCP_REDIRECT_HOSTS.
   */
  redirectHosts?: readonly string[];
  /** 0 picks an ephemeral port (tests). Defaults to 41274 — the daemon owns 41273. */
  port?: number;
  host?: string;
  onRequest?: (entry: RemoteRequestLog) => void;
}

export interface RemoteMcpHandle {
  server: Server;
  port: number;
  host: string;
  /** Path of the MCP endpoint, for building the URL to paste into a client. */
  path: string;
  close: () => Promise<void>;
}

const MAX_BODY_BYTES = 4 * 1024 * 1024;

async function readBody(req: IncomingMessage): Promise<string> {
  let body = '';
  let bytes = 0;
  for await (const chunk of req) {
    const str = typeof chunk === 'string' ? chunk : (chunk as Buffer).toString();
    bytes += Buffer.byteLength(str);
    if (bytes > MAX_BODY_BYTES) throw new Error('request body too large');
    body += str;
  }
  return body;
}

function rpcMethodOf(payload: unknown): string | undefined {
  const one = Array.isArray(payload) ? payload[0] : payload;
  const method = (one as { method?: unknown } | undefined)?.method;
  if (typeof method !== 'string') return undefined;
  return Array.isArray(payload) ? `${method} (+${payload.length - 1} batched)` : method;
}

/** Constant-time compare for values an attacker can probe repeatedly. */
function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(payload);
}

/**
 * Read-only MCP over Streamable HTTP with an OAuth 2.1 authorization server in
 * front, for clients Robin does not run — today that means claude.ai connectors.
 *
 * Binds loopback. Reaching it from the internet requires a deliberate tunnel,
 * which keeps "exposed" from ever being the default state of a process that
 * reads the operator's memory.
 */
export async function startRemoteMcpServer(deps: RemoteMcpDeps): Promise<RemoteMcpHandle> {
  if (deps.accessKey.length < MIN_TOKEN_LENGTH) {
    throw new Error(
      `remote MCP access key must be at least ${MIN_TOKEN_LENGTH} characters (got ${deps.accessKey.length}) — it is the only thing standing between the public internet and memory reads`,
    );
  }
  const base = deps.publicUrl.replace(/\/+$/, '');
  const resourceUrl = `${base}${MCP_PATH}`;
  const metadataUrl = `${base}/.well-known/oauth-protected-resource`;
  const host = deps.host ?? '127.0.0.1';
  const redirectHosts = deps.redirectHosts ?? [];

  /**
   * The client, if `redirectUri` is one it registered AND still on the
   * allowlist. Re-checking the allowlist here (not only at registration) covers
   * clients registered before it existed or before it was narrowed.
   */
  const clientFor = (clientId: string, redirectUri: string): RegisteredClient | null => {
    const client = getClient(deps.db, clientId);
    if (!client?.redirect_uris.includes(redirectUri)) return null;
    if (!isAllowedRedirectUri(redirectUri, redirectHosts)) return null;
    return client;
  };

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('x-frame-options', 'DENY');
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    let rpc: string | undefined;
    if (deps.onRequest) {
      // Logged at close so the status is the real one, and so a held-open SSE
      // stream still produces exactly one entry, on disconnect.
      res.on('close', () => {
        deps.onRequest?.({
          ts: new Date().toISOString(),
          method: req.method ?? '',
          path: pathname,
          status: res.statusCode,
          rpc,
          ip:
            typeof req.headers['cf-connecting-ip'] === 'string'
              ? req.headers['cf-connecting-ip']
              : undefined,
          userAgent: req.headers['user-agent'],
        });
      });
    }

    (async () => {
      // ---- RFC 9728: protected resource metadata -----------------------------
      // Claude probes the path-suffixed form first, then the bare one.
      if (
        req.method === 'GET' &&
        (pathname === '/.well-known/oauth-protected-resource' ||
          pathname === `/.well-known/oauth-protected-resource${MCP_PATH}`)
      ) {
        sendJson(res, 200, {
          resource: resourceUrl,
          authorization_servers: [base],
          scopes_supported: [READ_SCOPE, WRITE_SCOPE],
          bearer_methods_supported: ['header'],
        });
        return;
      }

      // ---- RFC 8414: authorization server metadata ---------------------------
      if (req.method === 'GET' && pathname === '/.well-known/oauth-authorization-server') {
        sendJson(res, 200, {
          issuer: base,
          authorization_endpoint: `${base}/oauth/authorize`,
          token_endpoint: `${base}/oauth/token`,
          registration_endpoint: `${base}/oauth/register`,
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          // Claude checks S256 support here before starting the flow, and
          // authenticates as a public client (no secret) at the token endpoint.
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['none'],
          scopes_supported: [READ_SCOPE, WRITE_SCOPE],
        });
        return;
      }

      // ---- RFC 7591: dynamic client registration -----------------------------
      if (req.method === 'POST' && pathname === '/oauth/register') {
        const body = await readBody(req);
        let parsed: { client_name?: unknown; redirect_uris?: unknown };
        try {
          parsed = JSON.parse(body) as typeof parsed;
        } catch {
          sendJson(res, 400, { error: 'invalid_client_metadata' });
          return;
        }
        if (!parsed || typeof parsed !== 'object') {
          sendJson(res, 400, { error: 'invalid_client_metadata' });
          return;
        }
        // Every URI must be a string on the allowlist. One bad entry fails the
        // whole registration (RFC 7591 §3.2.2) rather than being dropped, so a
        // client never ends up registered with fewer callbacks than it asked for.
        const redirectUris: unknown[] = Array.isArray(parsed.redirect_uris)
          ? parsed.redirect_uris
          : [];
        const rejected = redirectUris.find(
          (u) => typeof u !== 'string' || !isAllowedRedirectUri(u, redirectHosts),
        );
        if (redirectUris.length === 0 || rejected !== undefined) {
          sendJson(res, 400, {
            error: 'invalid_redirect_uri',
            error_description:
              redirectUris.length === 0
                ? 'redirect_uris is required'
                : 'redirect URIs must be https on claude.ai or claude.com, or http on localhost/127.0.0.1',
          });
          return;
        }
        const client = registerClient(deps.db, {
          // Self-reported and shown on the consent screen; anything but a
          // string is dropped rather than stored.
          clientName: typeof parsed.client_name === 'string' ? parsed.client_name : undefined,
          redirectUris: redirectUris as string[],
        });
        sendJson(res, 201, client);
        return;
      }

      // ---- Consent screen ----------------------------------------------------
      if (pathname === '/oauth/authorize') {
        const params =
          req.method === 'POST'
            ? new URLSearchParams(await readBody(req))
            : new URL(req.url ?? '/', 'http://localhost').searchParams;

        const clientId = params.get('client_id') ?? '';
        const redirectUri = params.get('redirect_uri') ?? '';
        const codeChallenge = params.get('code_challenge') ?? '';
        const state = params.get('state') ?? '';
        // Empty means absent (RFC 8707), and absent means this server's MCP URL.
        // `??` would let `resource=` through as '', an audience that binds nothing.
        const resource = params.get('resource') || resourceUrl;
        const scope = params.get('scope') ?? READ_SCOPE;

        // Validate the client and its redirect URI before anything else: an
        // unregistered or off-allowlist target must never receive a code, and
        // the operator must never be asked for the key on its behalf.
        const client = clientFor(clientId, redirectUri);

        if (req.method === 'GET') {
          res.setHeader('content-type', 'text/html; charset=utf-8');
          if (!client) {
            res.statusCode = 400;
            res.end(
              consentErrorPage(
                'This authorization request names an unknown client, or a redirect address that is not registered and allowed. No access was granted.',
              ),
            );
            return;
          }
          res.statusCode = 200;
          res.end(
            consentPage({
              clientId,
              clientName: client.client_name,
              redirectUri,
              codeChallenge,
              codeChallengeMethod: params.get('code_challenge_method') ?? 'S256',
              state,
              resource,
              scope,
            }),
          );
          return;
        }

        if (req.method === 'POST') {
          if (!client) {
            sendJson(res, 400, { error: 'invalid_request' });
            return;
          }
          if (params.get('code_challenge_method') !== 'S256' || !codeChallenge) {
            sendJson(res, 400, { error: 'invalid_request' });
            return;
          }
          if (!sameSecret(params.get('access_key') ?? '', deps.accessKey)) {
            // Re-render rather than redirect: a wrong key is a human typo, and
            // redirecting an error to the client would leak that the endpoint is
            // real to whoever is driving the flow.
            res.statusCode = 401;
            res.setHeader('content-type', 'text/html; charset=utf-8');
            res.end(
              consentPage({
                clientId,
                clientName: client.client_name,
                redirectUri,
                codeChallenge,
                codeChallengeMethod: 'S256',
                state,
                resource,
                scope,
                error: 'That access key is not correct.',
              }),
            );
            return;
          }

          // The granted scope is decided here, by the human, not taken from
          // what the client requested — a client can ask for anything.
          const granted =
            params.get('grant_write') === '1' ? `${READ_SCOPE} ${WRITE_SCOPE}` : READ_SCOPE;
          const code = issueCode(deps.db, {
            clientId,
            redirectUri,
            codeChallenge,
            resource,
            scope: granted,
          });
          const target = new URL(redirectUri);
          target.searchParams.set('code', code);
          if (state) target.searchParams.set('state', state);
          res.statusCode = 302;
          res.setHeader('location', target.toString());
          res.end();
          return;
        }
      }

      // ---- Token endpoint ----------------------------------------------------
      if (req.method === 'POST' && pathname === '/oauth/token') {
        // RFC 6749 requires form encoding here; Claude sends both the initial
        // exchange and refreshes this way.
        const params = new URLSearchParams(await readBody(req));
        const grantType = params.get('grant_type');
        const clientId = params.get('client_id') ?? '';

        if (grantType === 'authorization_code') {
          const result = redeemCode(deps.db, {
            code: params.get('code') ?? '',
            clientId,
            redirectUri: params.get('redirect_uri') ?? '',
            codeVerifier: params.get('code_verifier') ?? undefined,
          });
          if ('error' in result) {
            sendJson(res, 400, { error: result.error });
            return;
          }
          sendJson(
            res,
            200,
            issueTokens(deps.db, {
              clientId,
              resource: result.resource,
              scope: result.scope,
            }),
          );
          return;
        }

        if (grantType === 'refresh_token') {
          const rotated = redeemRefreshToken(deps.db, {
            refreshToken: params.get('refresh_token') ?? '',
            clientId,
          });
          if (!rotated) {
            // RFC 6749 code, so Claude re-runs the flow instead of retrying.
            sendJson(res, 400, { error: 'invalid_grant' });
            return;
          }
          sendJson(res, 200, rotated);
          return;
        }

        sendJson(res, 400, { error: 'unsupported_grant_type' });
        return;
      }

      // ---- MCP endpoint ------------------------------------------------------
      if (pathname === MCP_PATH) {
        // RFC 7235 §2.1: the auth scheme is case-insensitive. Matching only the
        // exact string "Bearer " rejects a compliant client with `invalid_token`,
        // which reads as a bad credential rather than a parsing bug.
        const header = req.headers.authorization ?? '';
        const bearer = /^bearer\s+(.+)$/i.exec(header.trim());
        const token = bearer?.[1]?.trim() ?? '';
        const auth = token ? verifyAccessToken(deps.db, token, resourceUrl) : null;
        if (!auth) {
          // The 401 is what starts discovery; Claude ignores this header on a 200.
          res.statusCode = 401;
          res.setHeader('www-authenticate', `Bearer resource_metadata="${metadataUrl}"`);
          sendJson(res, 401, { error: 'invalid_token' });
          return;
        }

        // readOnly stays true even with the write scope: it disarms the write
        // branches of mixed tools (`get` upserting, `alerts` ack, `power`
        // mutations), which are never appropriate remotely. The write scope adds
        // memory-ledger tools, it does not unlock daemon control.
        //
        // reloadable: false — this builds a server PER REQUEST against
        // `deps.db`, a single handle shared across every concurrent request on
        // this process, not owned by this call. Hot-reload's job on a
        // successful swap is to `closeDb` the previous generation's handle;
        // doing that here would close the shared handle out from under every
        // other in-flight request (task-4 review finding 1). Staleness on this
        // surface is fixed by restarting the remote process, same as before
        // the hot-reload feature existed.
        const mcp = buildCoreServer(
          { db: deps.db, llm: deps.llm },
          { allow: toolsForScope(auth.scope), readOnly: true, reloadable: false },
        );
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

        // Make the response look like a stream on the wire. The transport sets a
        // Content-Length, which turns text/event-stream into a length-delimited
        // payload — something no working server sends. Dropping it here leaves
        // Node to use chunked encoding; setting Transfer-Encoding directly is
        // rejected, since the two headers may not coexist. `no-transform` tells
        // Cloudflare to leave the body alone (it strips x-accel-buffering).
        const writeHead = res.writeHead.bind(res);
        res.writeHead = ((status: number, ...rest: unknown[]) => {
          const headers = rest.find((arg) => arg && typeof arg === 'object') as
            | Record<string, unknown>
            | undefined;
          const contentType = String(
            headers?.['Content-Type'] ??
              headers?.['content-type'] ??
              res.getHeader('content-type') ??
              '',
          );
          if (contentType.includes('text/event-stream')) {
            for (const key of Object.keys(headers ?? {})) {
              if (key.toLowerCase() === 'content-length') delete headers?.[key];
            }
            res.removeHeader('content-length');
            const cacheKey =
              Object.keys(headers ?? {}).find((k) => k.toLowerCase() === 'cache-control') ??
              'Cache-Control';
            if (headers) headers[cacheKey] = 'no-cache, no-transform';
            else res.setHeader('cache-control', 'no-cache, no-transform');
          }
          return writeHead(status, ...(rest as []));
        }) as typeof res.writeHead;

        res.on('close', () => {
          void transport.close();
          void mcp.close();
        });
        await mcp.connect(transport);

        // Read the body here rather than letting the transport pull it off the
        // stream, so the JSON-RPC method lands in the access log. Once consumed
        // it can't be re-read, so an unparseable body is forwarded as-is for the
        // transport to reject — never silently dropped.
        let parsedBody: unknown;
        if (req.method === 'POST') {
          const raw = await readBody(req);
          if (raw) {
            try {
              parsedBody = JSON.parse(raw);
              rpc = rpcMethodOf(parsedBody);
            } catch {
              parsedBody = raw;
            }
          }
        }
        await transport.handleRequest(req, res, parsedBody);
        return;
      }

      res.statusCode = 404;
      res.end();
    })().catch(() => {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32603, message: 'internal server error' },
            id: null,
          }),
        );
      }
    });
  });

  return await new Promise<RemoteMcpHandle>((resolve, reject) => {
    server.once('error', reject);
    server.listen(deps.port ?? 41274, host, () => {
      const address = server.address();
      if (typeof address === 'string' || !address) {
        reject(new Error('remote MCP server address unavailable'));
        return;
      }
      resolve({
        server,
        port: address.port,
        host,
        path: MCP_PATH,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
            // `server.close` waits for every open socket, and both of this
            // server's normal clients hold one open: HTTP keep-alive, and the
            // SSE stream a Streamable HTTP client parks on the endpoint.
            server.closeAllConnections();
          }),
      });
    });
  });
}
