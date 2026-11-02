import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { closeDb, openDb, type RobinDb } from '../../../brain/memory/db.ts';
import { allMigrations, applyMigrations } from '../../../brain/memory/migrations/index.ts';
import { READ_ONLY_TOOLS, REMOTE_WRITE_TOOLS } from '../core/server.ts';
import { registerClient } from './oauth/store.ts';
import { decisionForm, submitForm } from './oauth/test-helpers.ts';
import {
  MIN_TOKEN_LENGTH,
  type RemoteMcpHandle,
  type RemoteRequestLog,
  startRemoteMcpServer,
} from './server.ts';

const ACCESS_KEY = 'k'.repeat(MIN_TOKEN_LENGTH);
const PUBLIC_URL = 'https://mcp.example.test';
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

function freshDb(): RobinDb {
  const dir = mkdtempSync(join(tmpdir(), 'robin-mcp-remote-'));
  mkdirSync(join(dir, 'state', 'db'), { recursive: true });
  const db = openDb(join(dir, 'state', 'db', 'robin.sqlite'));
  applyMigrations(db, allMigrations);
  return db;
}

/**
 * Teardown is registered with the test context, not called at the end of the
 * body: a failed assertion returns early, and a still-listening server keeps the
 * event loop alive, which turns any failure into a hang that reports nothing.
 */
async function boot(
  t: TestContext,
  opts: { onRequest?: (entry: RemoteRequestLog) => void; redirectHosts?: string[] } = {},
): Promise<{ db: RobinDb; handle: RemoteMcpHandle; base: string }> {
  const db = freshDb();
  const handle = await startRemoteMcpServer({
    db,
    llm: null,
    accessKey: ACCESS_KEY,
    publicUrl: PUBLIC_URL,
    port: 0,
    onRequest: opts.onRequest,
    redirectHosts: opts.redirectHosts,
  });
  t.after(async () => {
    await handle.close();
    closeDb(db);
  });
  return { db, handle, base: `http://127.0.0.1:${handle.port}` };
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

async function register(
  base: string,
  body: Record<string, unknown>,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${base}/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

function consentUrl(base: string, clientId: string, redirectUri = REDIRECT): string {
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: pkce().challenge,
    code_challenge_method: 'S256',
    state: 'xyz',
    resource: `${PUBLIC_URL}/mcp`,
  });
  return `${base}/oauth/authorize?${query}`;
}

/** Drives the whole OAuth dance the way claude.ai does, returning a bearer token. */
async function obtainToken(
  base: string,
  opts: { key?: string; write?: boolean } = {},
): Promise<string> {
  const key = opts.key ?? ACCESS_KEY;
  const registration = await fetch(`${base}/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'claude', redirect_uris: [REDIRECT] }),
  });
  const { client_id } = (await registration.json()) as { client_id: string };

  const { verifier, challenge } = pkce();
  const form = new URLSearchParams({
    response_type: 'code',
    client_id,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'xyz',
    resource: `${PUBLIC_URL}/mcp`,
    access_key: key,
    ...(opts.write ? { grant_write: '1' } : {}),
  });
  const approved = await fetch(`${base}/oauth/authorize`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
    redirect: 'manual',
  });
  const location = approved.headers.get('location');
  if (!location) throw new Error(`no redirect issued (status ${approved.status})`);
  const code = new URL(location).searchParams.get('code');
  if (!code) throw new Error(`no code in redirect: ${location}`);

  const tokenRes = await fetch(`${base}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id,
      redirect_uri: REDIRECT,
      code_verifier: verifier,
      resource: `${PUBLIC_URL}/mcp`,
    }).toString(),
  });
  const tokens = (await tokenRes.json()) as { access_token: string };
  return tokens.access_token;
}

async function connect(t: TestContext, base: string, token: string): Promise<Client> {
  const client = new Client({ name: 'robin-remote-test', version: '0.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
  t.after(() => client.close());
  return client;
}

test('remote mcp: refuses to start on an access key too short to resist guessing', async (t) => {
  const db = freshDb();
  t.after(() => closeDb(db));
  await assert.rejects(
    () =>
      startRemoteMcpServer({
        db,
        llm: null,
        accessKey: 'short',
        publicUrl: PUBLIC_URL,
        port: 0,
      }),
    /access key/i,
  );
});

test('remote mcp: binds loopback only, so exposure is always a deliberate tunnel', async (t) => {
  const { handle } = await boot(t);
  assert.equal(handle.host, '127.0.0.1');
});

test('remote mcp: an unauthenticated call is a 401 that points at the metadata', async (t) => {
  const { base } = await boot(t);
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  assert.equal(res.status, 401);
  // Claude only follows the pointer on a 401; it ignores WWW-Authenticate on a 200.
  const challenge = res.headers.get('www-authenticate') ?? '';
  assert.match(challenge, /^Bearer /);
  assert.match(
    challenge,
    new RegExp(`resource_metadata="${PUBLIC_URL}/\\.well-known/oauth-protected-resource"`),
  );
});

test('remote mcp: protected-resource metadata names this server and its auth server', async (t) => {
  const { base } = await boot(t);
  for (const path of [
    '/.well-known/oauth-protected-resource',
    // Claude probes the path-suffixed form first when the MCP URL has a path.
    '/.well-known/oauth-protected-resource/mcp',
  ]) {
    const res = await fetch(`${base}${path}`);
    assert.equal(res.status, 200, `${path} must serve metadata`);
    const body = (await res.json()) as { resource: string; authorization_servers: string[] };
    // Must match the URL the user types into Claude, exactly.
    assert.equal(body.resource, `${PUBLIC_URL}/mcp`);
    assert.deepEqual(body.authorization_servers, [PUBLIC_URL]);
  }
});

test('remote mcp: authorization-server metadata advertises DCR and S256 PKCE', async (t) => {
  const { base } = await boot(t);
  const res = await fetch(`${base}/.well-known/oauth-authorization-server`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body.issuer, PUBLIC_URL);
  assert.equal(body.registration_endpoint, `${PUBLIC_URL}/oauth/register`);
  assert.equal(body.authorization_endpoint, `${PUBLIC_URL}/oauth/authorize`);
  assert.equal(body.token_endpoint, `${PUBLIC_URL}/oauth/token`);
  // Claude verifies S256 support from metadata before starting the flow, and
  // authenticates as a public client at the token endpoint.
  assert.deepEqual(body.code_challenge_methods_supported, ['S256']);
  assert.deepEqual(body.token_endpoint_auth_methods_supported, ['none']);
});

test('remote mcp: the consent screen is served for a browser to fill in', async (t) => {
  const { base } = await boot(t);
  const { json } = await register(base, { client_name: 'Claude', redirect_uris: [REDIRECT] });
  const res = await fetch(consentUrl(base, json.client_id as string));
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/html/);
  const html = await res.text();
  assert.match(html, /access_key/, 'the form must collect the access key');
  assert.ok(!html.includes(ACCESS_KEY), 'the page must never echo the key back');
  // The registered name and where the code will go, so the operator can tell
  // a phishing client from Claude before typing the key.
  assert.match(html, /<strong class="client">Claude<\/strong>/);
  assert.match(html, /<strong class="host">claude\.ai<\/strong>/);
});

test('remote mcp: registration refuses a redirect URI off the allowlist', async (t) => {
  const { base } = await boot(t);
  for (const uris of [
    ['https://evil.example/cb'],
    // One bad URI poisons the registration; it must not be dropped silently.
    [REDIRECT, 'https://evil.example/cb'],
    [REDIRECT, 42],
  ]) {
    const { status, json } = await register(base, { client_name: 'x', redirect_uris: uris });
    assert.equal(status, 400, JSON.stringify(uris));
    assert.equal(json.error, 'invalid_redirect_uri');
  }
});

test('remote mcp: registration accepts claude.com and loopback callbacks', async (t) => {
  const { base } = await boot(t);
  for (const uri of ['https://claude.com/api/mcp/auth_callback', 'http://localhost:6274/cb']) {
    const { status, json } = await register(base, { redirect_uris: [uri] });
    assert.equal(status, 201, uri);
    assert.deepEqual(json.redirect_uris, [uri]);
  }
});

test('remote mcp: configured extra redirect hosts are accepted', async (t) => {
  const { base } = await boot(t, { redirectHosts: ['connector.example.com'] });
  const ok = await register(base, { redirect_uris: ['https://connector.example.com/cb'] });
  assert.equal(ok.status, 201);
  const still = await register(base, { redirect_uris: ['https://evil.example/cb'] });
  assert.equal(still.status, 400);
});

test('remote mcp: a non-string client name is dropped, not a 500', async (t) => {
  const { base } = await boot(t);
  const { status, json } = await register(base, {
    client_name: { nested: true },
    redirect_uris: [REDIRECT],
  });
  assert.equal(status, 201);
  assert.equal(json.client_name, undefined);
});

test('remote mcp: the consent screen is refused for an unknown client or redirect', async (t) => {
  const { base } = await boot(t);
  const { json } = await register(base, { client_name: 'Claude', redirect_uris: [REDIRECT] });
  for (const url of [
    consentUrl(base, 'not-a-client'),
    consentUrl(base, json.client_id as string, 'https://claude.ai/some/other/path'),
  ]) {
    const res = await fetch(url, { redirect: 'manual' });
    // RFC 6749 §4.1.2.1: never redirect to an unverified target; tell the human.
    assert.equal(res.status, 400, url);
    assert.equal(res.headers.get('location'), null);
    const html = await res.text();
    assert.ok(!html.includes('access_key'), 'no key prompt for a flow that cannot succeed');
  }
});

test('remote mcp: approval re-checks the allowlist, even for an already-registered client', async (t) => {
  const { db, base } = await boot(t);
  // Registered before the allowlist existed (or straight into the store).
  const evil = 'https://evil.example/cb';
  const { client_id } = registerClient(db, { clientName: 'Claude', redirectUris: [evil] });

  const page = await fetch(consentUrl(base, client_id, evil));
  assert.equal(page.status, 400, 'the consent screen must not render for it');

  const approved = await fetch(`${base}/oauth/authorize`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    redirect: 'manual',
    body: new URLSearchParams({
      response_type: 'code',
      client_id,
      redirect_uri: evil,
      code_challenge: pkce().challenge,
      code_challenge_method: 'S256',
      access_key: ACCESS_KEY,
    }).toString(),
  });
  assert.equal(approved.status, 400);
  assert.equal(approved.headers.get('location'), null, 'no code may reach the attacker');
  const codes = db.prepare('SELECT COUNT(*) AS c FROM oauth_codes').get() as { c: number };
  assert.equal(codes.c, 0);
});

test('remote mcp: a browser ticking the write box on the real page grants write', async (t) => {
  const { db, base } = await boot(t);
  const { json } = await register(base, { client_name: 'Claude', redirect_uris: [REDIRECT] });
  const html = await (await fetch(consentUrl(base, json.client_id as string))).text();
  const form = decisionForm(html);

  const scopeAfter = async (checked: string[]): Promise<string | undefined> => {
    const res = await fetch(`${base}${form.action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      redirect: 'manual',
      body: submitForm(form, { filled: { access_key: ACCESS_KEY }, checked }).toString(),
    });
    assert.equal(res.status, 302);
    const row = db.prepare('SELECT scope FROM oauth_codes ORDER BY rowid DESC LIMIT 1').get() as
      | { scope: string }
      | undefined;
    return row?.scope;
  };

  assert.equal(await scopeAfter(['grant_write']), 'robin:read robin:write');
  assert.equal(await scopeAfter([]), 'robin:read');
});

test('remote mcp: an empty resource parameter binds the code to this server', async (t) => {
  const { db, base } = await boot(t);
  const { json } = await register(base, { redirect_uris: [REDIRECT] });
  const approved = await fetch(`${base}/oauth/authorize`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    redirect: 'manual',
    body: new URLSearchParams({
      response_type: 'code',
      client_id: json.client_id as string,
      redirect_uri: REDIRECT,
      code_challenge: pkce().challenge,
      code_challenge_method: 'S256',
      resource: '',
      access_key: ACCESS_KEY,
    }).toString(),
  });
  assert.equal(approved.status, 302);
  const row = db.prepare('SELECT resource FROM oauth_codes').get() as { resource: string | null };
  // Empty means absent, and absent means this server's MCP URL — never ''.
  assert.equal(row.resource, `${PUBLIC_URL}/mcp`);
});

test('remote mcp: approving without the access key issues no code', async (t) => {
  const { base } = await boot(t);
  await assert.rejects(
    () => obtainToken(base, { key: 'w'.repeat(MIN_TOKEN_LENGTH) }),
    /no redirect|no code/,
    'a wrong key must not yield an authorization code',
  );
});

test('remote mcp: the full OAuth flow yields a token that opens the MCP endpoint', async (t) => {
  const { base } = await boot(t);
  const token = await obtainToken(base);
  const client = await connect(t, base, token);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((x) => x.name).sort(), [...READ_ONLY_TOOLS].sort());
  for (const write of REMOTE_WRITE_TOOLS) {
    assert.ok(!tools.some((x) => x.name === write), `${write} needs the write scope`);
  }
});

test('remote mcp: a write tool is unreachable even with a valid token', async (t) => {
  const { db, base } = await boot(t);
  const client = await connect(t, base, await obtainToken(base));
  const denied = (await client.callTool({
    name: 'remember',
    arguments: { content: 'injected from the web' },
  })) as { isError?: boolean; content: Array<{ text: string }> };
  assert.equal(denied.isError, true, 'the write path must be absent, not merely unadvertised');
  const events = db.prepare('SELECT COUNT(*) AS c FROM events').get() as { c: number };
  assert.equal(events.c, 0);
});

test('remote mcp: the bearer scheme is matched case-insensitively', async (t) => {
  const { base } = await boot(t);
  const token = await obtainToken(base);
  // RFC 7235 §2.1: the auth scheme is case-insensitive. Matching only "Bearer "
  // rejects a spec-compliant client for a reason that looks like a bad token.
  for (const scheme of ['Bearer', 'bearer', 'BEARER']) {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `${scheme} ${token}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    assert.equal(res.status, 200, `"${scheme}" must be accepted`);
  }
});

test('remote mcp: a read tool actually answers over HTTP', async (t) => {
  const { base } = await boot(t);
  const client = await connect(t, base, await obtainToken(base));
  const result = (await client.callTool({ name: 'list', arguments: { type: 'entities' } })) as {
    content: Array<{ type: string; text: string }>;
  };
  assert.equal(result.content[0]?.type, 'text');
  assert.doesNotThrow(() => JSON.parse(result.content[0]?.text ?? ''));
});

test('remote mcp: responses stream as SSE and are not length-delimited', async (t) => {
  const { base } = await boot(t);
  const token = await obtainToken(base);
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'x', version: '1' },
      },
    }),
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
  assert.equal(res.headers.get('content-length'), null, 'SSE must not be length-delimited');
  assert.match(res.headers.get('cache-control') ?? '', /no-transform/);
});

test('remote mcp: requests are logged with path and method, never the access key', async (t) => {
  const seen: RemoteRequestLog[] = [];
  const { base } = await boot(t, { onRequest: (entry) => seen.push(entry) });
  await fetch(`${base}/nope`, { method: 'POST' });
  await obtainToken(base);

  for (let i = 0; i < 50 && seen.length < 2; i++) {
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(seen[0]?.path, '/nope');
  assert.equal(seen[0]?.status, 404);
  // The key travels in a POST body during consent; it must not reach the log.
  const dump = JSON.stringify(seen);
  assert.ok(!dump.includes(ACCESS_KEY), 'the access key must never be logged');
});

test('remote mcp: without the write grant, memory cannot be written', async (t) => {
  const { db, base } = await boot(t);
  const client = await connect(t, base, await obtainToken(base));
  const denied = (await client.callTool({
    name: 'remember',
    arguments: { content: 'from the web' },
  })) as { isError?: boolean };
  assert.equal(denied.isError, true, 'remember must be absent without robin:write');
  const events = db.prepare('SELECT COUNT(*) AS c FROM events').get() as { c: number };
  assert.equal(events.c, 0, 'nothing may reach the event log');
});

test('remote mcp: the write grant unlocks memory writes and nothing else', async (t) => {
  const { db, base } = await boot(t);
  const client = await connect(t, base, await obtainToken(base, { write: true }));

  const { tools } = await client.listTools();
  const names = tools.map((x) => x.name).sort();
  assert.deepEqual(names, [...READ_ONLY_TOOLS, ...REMOTE_WRITE_TOOLS].sort());

  const wrote = (await client.callTool({
    name: 'remember',
    arguments: { content: 'captured from the browser' },
  })) as { isError?: boolean };
  assert.notEqual(wrote.isError, true, 'remember must work with the write scope');
  const events = db.prepare('SELECT COUNT(*) AS c FROM events').get() as { c: number };
  assert.equal(events.c, 1);

  // The write scope is about the memory ledger, not daemon control: the mixed
  // tools stay disarmed even here.
  const power = (await client.callTool({ name: 'power', arguments: { action: 'pause' } })) as {
    content: Array<{ text: string }>;
  };
  assert.match(power.content[0]?.text ?? '', /only action='status'/);
});

test('remote mcp: the granted scope comes from the checkbox, not the client request', async (t) => {
  const { db, base } = await boot(t);
  // A client asking for robin:write without the human ticking the box gets read.
  const registration = await fetch(`${base}/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'greedy', redirect_uris: [REDIRECT] }),
  });
  const { client_id } = (await registration.json()) as { client_id: string };
  const approved = await fetch(`${base}/oauth/authorize`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    redirect: 'manual',
    body: new URLSearchParams({
      response_type: 'code',
      client_id,
      redirect_uri: REDIRECT,
      code_challenge: 'irrelevant',
      code_challenge_method: 'S256',
      scope: 'robin:read robin:write',
      access_key: ACCESS_KEY,
    }).toString(),
  });
  assert.equal(approved.status, 302);
  const scope = db
    .prepare('SELECT scope FROM oauth_codes ORDER BY expires_at DESC LIMIT 1')
    .get() as { scope: string } | undefined;
  assert.equal(scope?.scope, 'robin:read', 'a client-requested write scope must not be honoured');
});
