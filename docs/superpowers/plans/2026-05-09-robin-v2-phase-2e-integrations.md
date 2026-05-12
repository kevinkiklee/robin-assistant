# Robin v2 Phase 2e — .env Secrets Layer + Calendar/Drive/YouTube + github_write Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Replace Phase 2d's per-integration JSON secrets with a single `${ROBIN_HOME}/secrets/.env`, ship Calendar/Drive/YouTube/github_write integrations on top, and migrate all 2d integrations to read .env keys.

**Architecture:** Three integration kinds — sync (gmail/lunch_money/calendar/drive/youtube), gateway (discord), tool-only (github_write). Shared Google OAuth via `_auth/google-token-cache.js` singleton. github_write captures text writes to events (recall-searchable); non-text actions audited via daemon log only.

**Tech Stack:** Node ≥ 22, ES modules, surrealdb@^2, @huggingface/transformers, @modelcontextprotocol/sdk, discord.js@^14. node --test, Biome.

**Spec:** `/Users/iser/workspace/robin/robin-assistant/docs/superpowers/specs/2026-05-09-robin-v2-phase-2e-design.md` is the source of truth.

---

## File structure

```
robin-assistant-v2/
  src/
    secrets/
      dotenv-io.js                              # NEW — replaces _auth/secrets-io.js
    integrations/
      _auth/
        secrets-io.js                           # DELETE
        oauth2-google.js                        # MODIFY — writeback paths use saveSecret
        google-token-cache.js                   # NEW — singleton
      _framework/
        manifest-loader.js                      # MODIFY — accept secrets.env_keys, detect tool-only kind
        run-sync.js                             # MODIFY — build ctx.secrets via getter, expose ctx.saveSecret
      gmail/
        manifest.js                             # MODIFY — secrets.env_keys
        sync.js                                 # MODIFY — read GOOGLE_OAUTH_*
        tools/gmail-search.js                   # MODIFY — requireSecret
        tools/gmail-get-thread.js               # MODIFY — requireSecret
      lunch_money/
        manifest.js                             # MODIFY — secrets.env_keys
        sync.js                                 # MODIFY — read LUNCH_MONEY_API_KEY
      discord/
        manifest.js                             # MODIFY — secrets.env_keys
        start.js                                # MODIFY — read DISCORD_BOT_TOKEN etc from secrets
      google_calendar/
        manifest.js                             # NEW
        client.js                               # NEW
        sync.js                                 # NEW
        tools/calendar-list-events.js           # NEW
        tools/calendar-get-event.js             # NEW
      google_drive/
        manifest.js                             # NEW
        client.js                               # NEW
        sync.js                                 # NEW
        tools/drive-search.js                   # NEW
        tools/drive-get-file.js                 # NEW
      youtube/
        manifest.js                             # NEW
        client.js                               # NEW
        sync.js                                 # NEW
        tools/youtube-list-subscriptions.js     # NEW
        tools/youtube-list-liked.js             # NEW
      github_write/
        manifest.js                             # NEW
        client.js                               # NEW
        tools/github-write.js                   # NEW
    cli/
      commands/
        auth-gmail.js                           # DELETE
        auth-lunch-money.js                     # DELETE
        auth-discord.js                         # DELETE
        secrets-import.js                       # NEW
        secrets-list.js                         # NEW
        secrets-set.js                          # NEW
        integrations-list.js                    # MODIFY — merge registry + runtime
      index.js                                  # MODIFY — drop `auth`, add `secrets`
    daemon/
      server.js                                 # MODIFY — boot warning, tool-only branch, dotenv calls
    install/
      agents-md.js                              # MODIFY — three-sub-block fence
    mcp/tools/
      integration-run.js                        # MODIFY — new `tool_only_no_sync` reason
  tests/
    unit/
      dotenv-io.test.js                         # NEW
      secrets-cli-import.test.js                # NEW
      secrets-cli-list.test.js                  # NEW
      google-token-cache.test.js                # NEW
      calendar-sync.test.js                     # NEW
      calendar-tools.test.js                    # NEW
      drive-sync.test.js                        # NEW
      drive-tools.test.js                       # NEW
      youtube-sync.test.js                      # NEW
      youtube-tools.test.js                     # NEW
      github-write-tool.test.js                 # NEW
      manifest-tool-only.test.js                # NEW
      agents-md-2e.test.js                      # NEW
      auth-oauth2-google.test.js                # MODIFY — saveSecret instead of writeSecrets
      auth-api-key.test.js                      # MODIFY
      auth-discord-bot.test.js                  # MODIFY
      gmail-tools.test.js                       # MODIFY
      lunch-money-sync.test.js                  # MODIFY
      discord-dispatcher.test.js                # MODIFY
      tool-integration-run.test.js              # MODIFY — new tool_only_no_sync test
    integration/
      secrets-import-roundtrip.test.js          # NEW
      google-shared-oauth.test.js               # NEW
      calendar-rolling-window.test.js           # NEW
      youtube-three-kinds.test.js               # NEW
      github-write-roundtrip.test.js            # NEW
```

---

## Task 0: dotenv-io module + secrets CLI

**Files:**
- Create: `src/secrets/dotenv-io.js`
- Create: `src/cli/commands/secrets-import.js`
- Create: `src/cli/commands/secrets-list.js`
- Create: `src/cli/commands/secrets-set.js`
- Modify: `src/cli/index.js` — add `secrets` branch
- Create: `tests/unit/dotenv-io.test.js`
- Create: `tests/unit/secrets-cli-import.test.js`
- Create: `tests/unit/secrets-cli-list.test.js`

- [ ] **Step 1: Write `src/secrets/dotenv-io.js`**

```js
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

function envPath() {
  return process.env.ROBIN_HOME
    ? join(process.env.ROBIN_HOME, 'secrets', '.env')
    : join(homedir(), '.robin', 'secrets', '.env');
}

function parseEnv(path) {
  const out = new Map();
  if (!existsSync(path)) return out;
  const content = readFileSync(path, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    out.set(trimmed.slice(0, eq).trim(), trimmed.slice(eq + 1).trim());
  }
  return out;
}

export function requireSecret(key) {
  const value = parseEnv(envPath()).get(key);
  if (!value) throw new Error(`missing secret: ${key}. Set it in ${envPath()} or run: robin secrets import --from <v1-user-data>`);
  return value;
}

export function getSecret(key) {
  return parseEnv(envPath()).get(key) ?? null;
}

export function listKeys() {
  return [...parseEnv(envPath()).keys()];
}

export function envFilePath() { return envPath(); }

export function saveSecret(key, value) {
  const path = envPath();
  mkdirSync(dirname(path), { recursive: true });
  let lines = [];
  if (existsSync(path)) {
    lines = readFileSync(path, 'utf-8').split('\n');
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  }
  let replaced = false;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    if (trimmed.slice(0, eq).trim() === key) {
      lines[i] = `${key}=${value}`;
      replaced = true;
      break;
    }
  }
  if (!replaced) lines.push(`${key}=${value}`);
  const content = lines.join('\n') + '\n';
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content, { mode: 0o600 });
  renameSync(tmp, path);
  chmodSync(path, 0o600);
}

export function importFrom(srcPath, { force = false } = {}) {
  const dest = envPath();
  if (existsSync(dest) && !force) {
    throw new Error(`destination ${dest} already exists; rerun with --force to overwrite`);
  }
  if (!existsSync(srcPath)) {
    throw new Error(`source not found: ${srcPath}`);
  }
  // Validate parseable (just parse and discard; non-throwing parser)
  const src = readFileSync(srcPath, 'utf-8');
  mkdirSync(dirname(dest), { recursive: true });
  const tmp = `${dest}.tmp`;
  writeFileSync(tmp, src, { mode: 0o600 });
  renameSync(tmp, dest);
  chmodSync(dest, 0o600);
}
```

- [ ] **Step 2: Write `tests/unit/dotenv-io.test.js`**

```js
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

let tmpHome;
test.beforeEach(() => {
  tmpHome = join(tmpdir(), `robin-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpHome, { recursive: true });
  process.env.ROBIN_HOME = tmpHome;
});
test.afterEach(() => { rmSync(tmpHome, { recursive: true, force: true }); });

test('requireSecret throws on missing', async () => {
  const { requireSecret } = await import('../../src/secrets/dotenv-io.js?cb=' + Date.now());
  assert.throws(() => requireSecret('NOPE'), /missing secret/);
});

test('saveSecret + requireSecret round-trip', async () => {
  const { requireSecret, saveSecret } = await import('../../src/secrets/dotenv-io.js?cb=' + Date.now());
  saveSecret('FOO', 'bar');
  assert.equal(requireSecret('FOO'), 'bar');
});

test('saveSecret preserves siblings', async () => {
  const { requireSecret, saveSecret } = await import('../../src/secrets/dotenv-io.js?cb=' + Date.now());
  saveSecret('A', '1');
  saveSecret('B', '2');
  saveSecret('A', '11');
  assert.equal(requireSecret('A'), '11');
  assert.equal(requireSecret('B'), '2');
});

test('saveSecret produces 0600 file', async () => {
  const { saveSecret, envFilePath } = await import('../../src/secrets/dotenv-io.js?cb=' + Date.now());
  saveSecret('X', 'y');
  const mode = statSync(envFilePath()).mode & 0o777;
  assert.equal(mode, 0o600);
});

test('getSecret returns null on missing', async () => {
  const { getSecret } = await import('../../src/secrets/dotenv-io.js?cb=' + Date.now());
  assert.equal(getSecret('NOPE'), null);
});

test('importFrom copies file with 0600 perms', async () => {
  const { importFrom, requireSecret, envFilePath } = await import('../../src/secrets/dotenv-io.js?cb=' + Date.now());
  const src = join(tmpHome, 'src.env');
  writeFileSync(src, 'KEY=value\n', 'utf-8');
  importFrom(src);
  assert.equal(requireSecret('KEY'), 'value');
  const mode = statSync(envFilePath()).mode & 0o777;
  assert.equal(mode, 0o600);
});

test('importFrom refuses without --force when dest exists', async () => {
  const { importFrom, saveSecret } = await import('../../src/secrets/dotenv-io.js?cb=' + Date.now());
  saveSecret('EXISTING', 'yes');
  const src = join(tmpHome, 'src.env');
  writeFileSync(src, 'NEW=val\n', 'utf-8');
  assert.throws(() => importFrom(src), /already exists/);
});

test('importFrom with force overwrites', async () => {
  const { importFrom, saveSecret, requireSecret, getSecret } = await import('../../src/secrets/dotenv-io.js?cb=' + Date.now());
  saveSecret('OLD', 'v1');
  const src = join(tmpHome, 'src.env');
  writeFileSync(src, 'NEW=v2\n', 'utf-8');
  importFrom(src, { force: true });
  assert.equal(getSecret('OLD'), null);
  assert.equal(requireSecret('NEW'), 'v2');
});

test('parser ignores comments and malformed lines', async () => {
  const { importFrom, getSecret } = await import('../../src/secrets/dotenv-io.js?cb=' + Date.now());
  const src = join(tmpHome, 'src.env');
  writeFileSync(src, '# comment\n\nMALFORMED_NO_EQ\nGOOD=ok\n', 'utf-8');
  importFrom(src);
  assert.equal(getSecret('GOOD'), 'ok');
  assert.equal(getSecret('MALFORMED_NO_EQ'), null);
});

test('listKeys returns names only', async () => {
  const { saveSecret, listKeys } = await import('../../src/secrets/dotenv-io.js?cb=' + Date.now());
  saveSecret('A', '1');
  saveSecret('B', '2');
  const keys = listKeys();
  assert.deepEqual(keys.sort(), ['A', 'B']);
});
```

- [ ] **Step 3: Write `src/cli/commands/secrets-import.js`**

```js
import { importFrom } from '../../secrets/dotenv-io.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export async function secretsImport(argv) {
  const fromIdx = argv.indexOf('--from');
  const force = argv.includes('--force');
  if (fromIdx === -1 || !argv[fromIdx + 1]) {
    console.error('usage: robin secrets import --from <path-to-v1-user-data> [--force]');
    console.error('  Suggestion: --from ~/workspace/robin/robin-assistant/user-data');
    process.exit(1);
  }
  let src = argv[fromIdx + 1];
  if (!src.endsWith('.env')) {
    src = join(src, 'runtime', 'secrets', '.env');
  }
  if (!existsSync(src)) {
    console.error(`source not found: ${src}`);
    process.exit(1);
  }
  try {
    importFrom(src, { force });
    console.log(`imported secrets from ${src}`);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
```

- [ ] **Step 4: Write `src/cli/commands/secrets-list.js`**

```js
import { listKeys, envFilePath } from '../../secrets/dotenv-io.js';
import { existsSync, statSync } from 'node:fs';

export async function secretsList() {
  const path = envFilePath();
  if (!existsSync(path)) {
    console.log(`(no secrets file at ${path})`);
    return;
  }
  const keys = listKeys();
  console.log(`${path} (${statSync(path).size} bytes, modified ${statSync(path).mtime.toISOString()})`);
  if (keys.length === 0) {
    console.log('  (empty)');
    return;
  }
  for (const key of keys.sort()) {
    console.log(`  ${key}`);
  }
}
```

- [ ] **Step 5: Write `src/cli/commands/secrets-set.js`**

```js
import { saveSecret } from '../../secrets/dotenv-io.js';
import readline from 'node:readline/promises';

export async function secretsSet(argv) {
  if (!argv[0]) {
    console.error('usage: robin secrets set <KEY>           # interactive (no echo)');
    console.error('       robin secrets set <KEY>=<value>   # accepted but warns about shell history');
    process.exit(1);
  }
  const arg = argv[0];
  const eq = arg.indexOf('=');
  let key, value;
  if (eq !== -1) {
    key = arg.slice(0, eq);
    value = arg.slice(eq + 1);
    console.warn('warning: value passed via CLI arg lands in shell history; prefer interactive `robin secrets set <KEY>`');
  } else {
    key = arg;
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    // Disable echo on stdin if TTY
    if (process.stdin.isTTY) process.stdin.setRawMode?.(true);
    process.stdout.write(`Value for ${key} (input hidden): `);
    value = await new Promise((resolve) => {
      let buf = '';
      const onData = (data) => {
        const ch = data.toString();
        if (ch === '\r' || ch === '\n') {
          if (process.stdin.isTTY) process.stdin.setRawMode?.(false);
          process.stdin.removeListener('data', onData);
          process.stdout.write('\n');
          resolve(buf);
        } else if (ch === '') {
          process.exit(1);
        } else if (ch === '' || ch === '\b') {
          buf = buf.slice(0, -1);
        } else {
          buf += ch;
        }
      };
      process.stdin.on('data', onData);
    });
    rl.close();
  }
  if (!key) {
    console.error('key required');
    process.exit(1);
  }
  saveSecret(key, value);
  console.log(`saved ${key}`);
}
```

- [ ] **Step 6: Wire into `src/cli/index.js`**

Read first. Add new branch before any existing similar branches:

```js
if (cmd === 'secrets') {
  const sub = argv[1];
  if (sub === 'import') return (await import('./commands/secrets-import.js')).secretsImport(argv.slice(2));
  if (sub === 'list') return (await import('./commands/secrets-list.js')).secretsList();
  if (sub === 'set') return (await import('./commands/secrets-set.js')).secretsSet(argv.slice(2));
  console.error('usage: robin secrets <import --from <path>|list|set <KEY>>');
  process.exit(1);
}
```

- [ ] **Step 7: Write CLI tests**

`tests/unit/secrets-cli-import.test.js`:

```js
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

let tmpHome;
test.beforeEach(() => {
  tmpHome = join(tmpdir(), `robin-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpHome, { recursive: true });
  process.env.ROBIN_HOME = tmpHome;
});
test.afterEach(() => { rmSync(tmpHome, { recursive: true, force: true }); });

test('secrets import --from <path>/runtime/secrets/.env succeeds', async () => {
  const v1 = join(tmpHome, 'v1');
  mkdirSync(join(v1, 'runtime', 'secrets'), { recursive: true });
  writeFileSync(join(v1, 'runtime', 'secrets', '.env'), 'KEY=value\n', 'utf-8');
  const { secretsImport } = await import('../../src/cli/commands/secrets-import.js?cb=' + Date.now());
  await secretsImport(['--from', v1]);
  const dest = join(tmpHome, 'secrets', '.env');
  assert.ok(existsSync(dest));
  assert.match(readFileSync(dest, 'utf-8'), /KEY=value/);
});

test('secrets import accepts direct .env path', async () => {
  const src = join(tmpHome, 'custom.env');
  writeFileSync(src, 'KEY=value\n', 'utf-8');
  const { secretsImport } = await import('../../src/cli/commands/secrets-import.js?cb=' + Date.now());
  await secretsImport(['--from', src]);
  const dest = join(tmpHome, 'secrets', '.env');
  assert.ok(existsSync(dest));
});
```

`tests/unit/secrets-cli-list.test.js`:

```js
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

let tmpHome;
test.beforeEach(() => {
  tmpHome = join(tmpdir(), `robin-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpHome, { recursive: true });
  process.env.ROBIN_HOME = tmpHome;
});
test.afterEach(() => { rmSync(tmpHome, { recursive: true, force: true }); });

test('secrets list prints keys, never values', async () => {
  const { saveSecret } = await import('../../src/secrets/dotenv-io.js?cb=' + Date.now());
  saveSecret('SECRET_KEY', 'super-secret-value-do-not-print');
  const { secretsList } = await import('../../src/cli/commands/secrets-list.js?cb=' + Date.now());
  const lines = [];
  const orig = console.log;
  console.log = (s) => lines.push(s);
  try { await secretsList(); } finally { console.log = orig; }
  const all = lines.join('\n');
  assert.match(all, /SECRET_KEY/);
  assert.doesNotMatch(all, /super-secret-value/);
});
```

- [ ] **Step 8: Run + lint + commit**

```bash
cd /Users/iser/workspace/robin/robin-assistant-v2
npm test -- tests/unit/dotenv-io.test.js tests/unit/secrets-cli-import.test.js tests/unit/secrets-cli-list.test.js
npm run lint
git add src/secrets/ src/cli/commands/secrets-*.js src/cli/index.js tests/unit/dotenv-io.test.js tests/unit/secrets-cli-*.test.js
git commit -m "feat(secrets): dotenv-io module + secrets import/list/set CLIs"
```

---

## Task 1: Migrate Phase 2d integrations from secrets-io.js to dotenv-io

**Files:**
- Modify: `src/integrations/_auth/oauth2-google.js` — `ensureFreshToken` writeback path
- Modify: `src/integrations/gmail/sync.js` — pass secrets via getter ctx
- Modify: `src/integrations/gmail/tools/gmail-search.js`
- Modify: `src/integrations/gmail/tools/gmail-get-thread.js`
- Modify: `src/integrations/lunch_money/sync.js`
- Modify: `src/integrations/discord/start.js`
- Modify: `src/integrations/_framework/run-sync.js` — build ctx.secrets via getter
- Delete: `src/integrations/_auth/secrets-io.js`
- Modify: `src/integrations/_framework/manifest-loader.js` — accept `secrets.env_keys`
- Delete: `src/cli/commands/auth-gmail.js`, `auth-lunch-money.js`, `auth-discord.js`
- Modify: `src/cli/index.js` — drop `auth` branch
- Modify: tests — use `requireSecret`/`saveSecret`

- [ ] **Step 1: Update `src/integrations/_framework/manifest-loader.js`**

Read first. Add `secrets: m.secrets ?? { env_keys: [] }` to validateManifest's return.

```js
return {
  name: m.name,
  cadence_ms,
  embed: m.embed ?? true,
  capture_mode,
  auth: m.auth ?? null,            // legacy, may be removed in 2f
  secrets: { env_keys: m.secrets?.env_keys ?? [] },
  tools: m.tools ?? [],
  sync: m.sync,
  start: m.start,
  stop: m.stop,
  config: m.config ?? {},
};
```

- [ ] **Step 2: Update `src/integrations/_framework/run-sync.js`**

Read first. Replace ctx-construction so `ctx.secrets` is built via Object.defineProperty getters that call `requireSecret(key)`. Also expose `ctx.saveSecret = saveSecret`.

```js
import { requireSecret, saveSecret } from '../../secrets/dotenv-io.js';

// Inside runIntegrationSync, where ctx is built:
const secrets = {};
for (const key of integration.secrets?.env_keys ?? []) {
  Object.defineProperty(secrets, key, { get: () => requireSecret(key), enumerable: true });
}
const ctx = {
  secrets,
  saveSecret,
  log: (...args) => console.log(`[integrations:${name}]`, ...args),
  cursor: cur.cursor ?? null,
  capture: integration.capture,
  signal: ctrl.signal,
  fetchFn: integration.fetchFn ?? globalThis.fetch,
};
```

Note: the daemon's existing call passes `secrets` to `registry.set(name, { ...m, secrets, capture })` from `readSecrets`. After this change, daemon stops calling `readSecrets`; instead pass the manifest's `secrets.env_keys` through. See Task 8 (daemon).

- [ ] **Step 3: Update `src/integrations/_auth/oauth2-google.js`**

Read first. Find `ensureFreshToken` — currently writes back via `writeSecrets(name, fresh)`. Change to:

```js
import { saveSecret } from '../../secrets/dotenv-io.js';

export async function ensureFreshToken(secrets, deps = {}) {
  // secrets is now an object with GOOGLE_OAUTH_REFRESH_TOKEN, GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET getters.
  // Returns { access_token, expires_at } only — no longer mutates secrets.
  // Refresh token rotation (rare for Google): caller responsible for `ctx.saveSecret('GOOGLE_OAUTH_REFRESH_TOKEN', new)` after detecting rotation.
  // ...
}
```

Strip the second `name` arg; signature becomes `ensureFreshToken(secrets, deps)`. Remove writeSecrets call. Drop the access_token caching (handled by google-token-cache.js in Task 2).

Drop `runLoopbackAuth`'s writeSecrets references at the end — that path is no longer wired into a CLI in 2e, but the helper stays (returns `{ access_token, refresh_token, expires_at }` for caller to handle). Update its signature to drop the writeback.

- [ ] **Step 4: Update gmail integration**

`src/integrations/gmail/sync.js`:

```js
// Replace 'gmail' name argument; pass through new ensureFreshToken signature
import { ensureFreshToken } from '../_auth/oauth2-google.js';
// ... in sync(ctx):
const fresh = await ensureFreshToken(ctx.secrets, { fetchFn: ctx.fetchFn });
const accessToken = fresh.access_token;
// rest unchanged
```

`src/integrations/gmail/tools/gmail-search.js`:

```js
import { ensureFreshToken } from '../../_auth/oauth2-google.js';
import { requireSecret } from '../../../secrets/dotenv-io.js';
import { listMessages } from '../client.js';

export function createGmailSearchTool() {
  return {
    name: 'gmail_search',
    description: 'Search Gmail using Gmail query syntax. Returns message stubs (id, threadId).',
    inputSchema: { /* unchanged */ },
    handler: async (args) => {
      try {
        const secrets = {
          GOOGLE_OAUTH_REFRESH_TOKEN: requireSecret('GOOGLE_OAUTH_REFRESH_TOKEN'),
          GOOGLE_OAUTH_CLIENT_ID: requireSecret('GOOGLE_OAUTH_CLIENT_ID'),
          GOOGLE_OAUTH_CLIENT_SECRET: requireSecret('GOOGLE_OAUTH_CLIENT_SECRET'),
        };
        const fresh = await ensureFreshToken(secrets);
        const page = await listMessages({ accessToken: fresh.access_token, q: args.query });
        return { messages: (page.messages ?? []).slice(0, args.max ?? 20) };
      } catch (e) {
        if (/missing secret/.test(e.message)) {
          throw new Error('gmail not authenticated; run: robin secrets import --from <v1-user-data>');
        }
        throw e;
      }
    },
  };
}
```

Same pattern for `gmail-get-thread.js`.

- [ ] **Step 5: Update lunch_money + discord**

`src/integrations/lunch_money/sync.js` — read `ctx.secrets.LUNCH_MONEY_API_KEY` (replaces `ctx.secrets.api_key`).

`src/integrations/discord/start.js` — read `ctx.secrets.DISCORD_BOT_TOKEN`, `ctx.secrets.DISCORD_APPLICATION_ID`, `ctx.secrets.DISCORD_ALLOWED_USER_IDS`, `ctx.secrets.DISCORD_ALLOWED_GUILD_IDS`. The IDs are comma-separated strings; split inline:

```js
const allowlist = {
  user_ids: (ctx.secrets.DISCORD_ALLOWED_USER_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  guild_ids: (ctx.secrets.DISCORD_ALLOWED_GUILD_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  dm_user_ids: (ctx.secrets.DISCORD_ALLOWED_USER_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
};
```

Note: `ctx.secrets.X` getter throws if X is missing. For optional discord vars, wrap in try-catch or use `getSecret` directly.

Update manifests to declare `secrets.env_keys`:

```js
// gmail/manifest.js
secrets: { env_keys: ['GOOGLE_OAUTH_REFRESH_TOKEN', 'GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET'] },

// lunch_money/manifest.js
secrets: { env_keys: ['LUNCH_MONEY_API_KEY'] },

// discord/manifest.js
secrets: { env_keys: ['DISCORD_BOT_TOKEN', 'DISCORD_APPLICATION_ID', 'DISCORD_ALLOWED_USER_IDS', 'DISCORD_ALLOWED_GUILD_IDS'] },
```

- [ ] **Step 6: Delete obsolete files**

```bash
rm src/integrations/_auth/secrets-io.js
rm src/cli/commands/auth-gmail.js
rm src/cli/commands/auth-lunch-money.js
rm src/cli/commands/auth-discord.js
```

Remove the `auth` branch from `src/cli/index.js`.

- [ ] **Step 7: Update unit tests**

For each test file that imported from `_auth/secrets-io.js` or asserted `writeSecrets` calls: rewire to use `dotenv-io.js` and `requireSecret`/`saveSecret`. Files:

- `tests/unit/auth-oauth2-google.test.js` — drop `writeSecrets`-related assertions (this module no longer writes back)
- `tests/unit/auth-api-key.test.js` — unchanged structure; just verify still passes
- `tests/unit/auth-discord-bot.test.js` — unchanged
- `tests/unit/gmail-tools.test.js` — set `process.env.ROBIN_HOME = '/tmp/...'` and `saveSecret('GOOGLE_OAUTH_*', 'value')` before each test; drop the "process.env.ROBIN_HOME = no-auth" pattern
- `tests/unit/lunch-money-sync.test.js` — pass `ctx.secrets.LUNCH_MONEY_API_KEY` instead of `api_key`
- `tests/unit/discord-dispatcher.test.js` — unchanged (dispatcher doesn't read secrets)

- [ ] **Step 8: Run + lint + commit**

```bash
npm test
npm run lint
git add -A
git commit -m "refactor(integrations): migrate gmail/lunch_money/discord/oauth helper to dotenv-io"
```

---

## Task 2: Google token cache singleton

**Files:**
- Create: `src/integrations/_auth/google-token-cache.js`
- Create: `tests/unit/google-token-cache.test.js`
- Modify: `src/integrations/gmail/sync.js` — use cache instead of direct ensureFreshToken
- Modify: `src/integrations/gmail/tools/gmail-search.js` — same
- Modify: `src/integrations/gmail/tools/gmail-get-thread.js` — same

- [ ] **Step 1: Write `src/integrations/_auth/google-token-cache.js`**

```js
import { ensureFreshToken } from './oauth2-google.js';

let cached = null;
let refreshPromise = null;

export async function getGoogleAccessToken({ secrets, fetchFn }) {
  const now = Date.now();
  if (cached && cached.expires_at - now > 60_000) return cached.access_token;
  if (refreshPromise) return refreshPromise.then((c) => c.access_token);
  refreshPromise = ensureFreshToken(secrets, { fetchFn })
    .finally(() => { refreshPromise = null; });
  cached = await refreshPromise;
  return cached.access_token;
}

// For tests
export function _resetCache() { cached = null; refreshPromise = null; }
```

- [ ] **Step 2: Write tests at `tests/unit/google-token-cache.test.js`**

```js
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { _resetCache, getGoogleAccessToken } from '../../src/integrations/_auth/google-token-cache.js';

function fakeSecrets() {
  return { GOOGLE_OAUTH_REFRESH_TOKEN: 'r', GOOGLE_OAUTH_CLIENT_ID: 'c', GOOGLE_OAUTH_CLIENT_SECRET: 's' };
}

test('cache returns same token within TTL', async () => {
  _resetCache();
  let calls = 0;
  const fetchFn = mock.fn(async () => {
    calls += 1;
    return { ok: true, json: async () => ({ access_token: 'a1', expires_in: 3600 }) };
  });
  const t1 = await getGoogleAccessToken({ secrets: fakeSecrets(), fetchFn });
  const t2 = await getGoogleAccessToken({ secrets: fakeSecrets(), fetchFn });
  assert.equal(t1, 'a1');
  assert.equal(t2, 'a1');
  assert.equal(calls, 1);
});

test('cache dedupes concurrent refresh', async () => {
  _resetCache();
  let calls = 0;
  const fetchFn = mock.fn(async () => {
    calls += 1;
    await new Promise((r) => setTimeout(r, 10));
    return { ok: true, json: async () => ({ access_token: 'a1', expires_in: 3600 }) };
  });
  const [t1, t2, t3] = await Promise.all([
    getGoogleAccessToken({ secrets: fakeSecrets(), fetchFn }),
    getGoogleAccessToken({ secrets: fakeSecrets(), fetchFn }),
    getGoogleAccessToken({ secrets: fakeSecrets(), fetchFn }),
  ]);
  assert.equal(t1, 'a1');
  assert.equal(t2, 'a1');
  assert.equal(t3, 'a1');
  assert.equal(calls, 1);
});
```

- [ ] **Step 3: Update gmail to use the cache**

In `gmail/sync.js`, `gmail/tools/gmail-search.js`, `gmail/tools/gmail-get-thread.js`: replace `ensureFreshToken(...)` calls with `getGoogleAccessToken({ secrets, fetchFn })`. The returned value is just the access_token string.

- [ ] **Step 4: Run + lint + commit**

```bash
npm test
npm run lint
git add src/integrations/_auth/google-token-cache.js src/integrations/gmail/ tests/unit/google-token-cache.test.js
git commit -m "feat(integrations): google-token-cache singleton + gmail uses cache"
```

---

## Task 3: google_calendar integration

**Files:**
- Create: `src/integrations/google_calendar/manifest.js`
- Create: `src/integrations/google_calendar/client.js`
- Create: `src/integrations/google_calendar/sync.js`
- Create: `src/integrations/google_calendar/tools/calendar-list-events.js`
- Create: `src/integrations/google_calendar/tools/calendar-get-event.js`
- Create: `tests/unit/calendar-sync.test.js`
- Create: `tests/unit/calendar-tools.test.js`

- [ ] **Step 1: Write `src/integrations/google_calendar/client.js`**

```js
async function calendarFetch(path, { accessToken, fetchFn = globalThis.fetch, signal }) {
  const r = await fetchFn(`https://www.googleapis.com/calendar/v3${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal,
  });
  if (!r.ok) throw new Error(`calendar ${path} ${r.status}`);
  return await r.json();
}

export async function listEvents({ accessToken, timeMin, timeMax, updatedMin, pageToken, fetchFn, signal }) {
  const params = new URLSearchParams({ timeMin, timeMax, singleEvents: 'true', maxResults: '250' });
  if (updatedMin) params.set('updatedMin', updatedMin);
  if (pageToken) params.set('pageToken', pageToken);
  return await calendarFetch(`/calendars/primary/events?${params}`, { accessToken, fetchFn, signal });
}

export async function getEvent({ accessToken, eventId, fetchFn, signal }) {
  return await calendarFetch(`/calendars/primary/events/${encodeURIComponent(eventId)}`, { accessToken, fetchFn, signal });
}

export function buildEventFromCalendarItem(item) {
  const startIso = item.start?.dateTime ?? item.start?.date ?? '';
  const endIso = item.end?.dateTime ?? item.end?.date ?? '';
  const attendeeCount = (item.attendees ?? []).length;
  const summary = item.summary ?? '(no title)';
  const cancelled = item.status === 'cancelled';
  const content = cancelled
    ? `[CANCELLED] ${summary} · ${startIso} – ${endIso} · ${attendeeCount} attendees`
    : `${summary} · ${startIso} – ${endIso} · ${attendeeCount} attendees`;
  return {
    source: 'google_calendar',
    content,
    ts: new Date(startIso || item.updated || Date.now()),
    external_id: item.id,
    meta: {
      event_id: item.id,
      calendar_id: 'primary',
      status: item.status,
      organizer_email: item.organizer?.email,
      attendees: (item.attendees ?? []).map((a) => a.email),
      location: item.location,
      html_link: item.htmlLink,
      etag: item.etag,
    },
  };
}
```

- [ ] **Step 2: Write `src/integrations/google_calendar/sync.js`**

```js
import { getGoogleAccessToken } from '../_auth/google-token-cache.js';
import { buildEventFromCalendarItem, listEvents } from './client.js';

const WINDOW_DAYS = 14;

export async function sync(ctx) {
  const accessToken = await getGoogleAccessToken({ secrets: ctx.secrets, fetchFn: ctx.fetchFn });
  const now = new Date();
  const timeMin = new Date(now.getTime() - WINDOW_DAYS * 86400_000).toISOString();
  const timeMax = new Date(now.getTime() + WINDOW_DAYS * 86400_000).toISOString();
  const updatedMin = ctx.cursor?.updated_min;

  const events = [];
  let pageToken = null;
  let latestUpdated = updatedMin ?? new Date(0).toISOString();
  do {
    const page = await listEvents({ accessToken, timeMin, timeMax, updatedMin, pageToken, fetchFn: ctx.fetchFn, signal: ctx.signal });
    pageToken = page.nextPageToken;
    for (const item of page.items ?? []) {
      events.push(buildEventFromCalendarItem(item));
      if (item.updated && item.updated > latestUpdated) latestUpdated = item.updated;
    }
  } while (pageToken);

  await ctx.capture(events);
  return { count: events.length, cursor: { updated_min: new Date().toISOString() } };
}
```

- [ ] **Step 3: Write `src/integrations/google_calendar/manifest.js`**

```js
import { sync } from './sync.js';
import { createCalendarGetEventTool } from './tools/calendar-get-event.js';
import { createCalendarListEventsTool } from './tools/calendar-list-events.js';

export const manifest = {
  name: 'google_calendar',
  cadence: '30m',
  embed: true,
  capture_mode: 'upsert',
  secrets: { env_keys: ['GOOGLE_OAUTH_REFRESH_TOKEN', 'GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET'] },
  sync,
  tools: [createCalendarListEventsTool, createCalendarGetEventTool],
};
```

- [ ] **Step 4: Write the two MCP tools**

`src/integrations/google_calendar/tools/calendar-list-events.js`:

```js
import { surql, BoundQuery } from 'surrealdb';

export function createCalendarListEventsTool({ db }) {
  return {
    name: 'calendar_list_events',
    description: 'List captured Google Calendar events from the events table.',
    inputSchema: {
      type: 'object',
      properties: {
        since: { type: 'string', format: 'date-time' },
        until: { type: 'string', format: 'date-time' },
        limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
      },
    },
    handler: async (args) => {
      const filters = ["source = 'google_calendar'"];
      const bindings = {};
      if (args.since) { filters.push('ts >= $since'); bindings.since = new Date(args.since); }
      if (args.until) { filters.push('ts <= $until'); bindings.until = new Date(args.until); }
      const limit = Math.min(args.limit ?? 50, 200);
      const sql = `SELECT id, content, ts, meta FROM events WHERE ${filters.join(' AND ')} ORDER BY ts ASC LIMIT ${limit}`;
      const [rows] = await db.query(new BoundQuery(sql, bindings)).collect();
      return { events: rows.map((r) => ({ ...r, id: String(r.id) })) };
    },
  };
}
```

`src/integrations/google_calendar/tools/calendar-get-event.js`:

```js
import { getGoogleAccessToken } from '../../_auth/google-token-cache.js';
import { requireSecret } from '../../../secrets/dotenv-io.js';
import { getEvent } from '../client.js';

export function createCalendarGetEventTool() {
  return {
    name: 'calendar_get_event',
    description: 'Fetch a Google Calendar event live (current state, not stale snapshot).',
    inputSchema: {
      type: 'object',
      properties: { event_id: { type: 'string' } },
      required: ['event_id'],
    },
    handler: async (args) => {
      try {
        const secrets = {
          GOOGLE_OAUTH_REFRESH_TOKEN: requireSecret('GOOGLE_OAUTH_REFRESH_TOKEN'),
          GOOGLE_OAUTH_CLIENT_ID: requireSecret('GOOGLE_OAUTH_CLIENT_ID'),
          GOOGLE_OAUTH_CLIENT_SECRET: requireSecret('GOOGLE_OAUTH_CLIENT_SECRET'),
        };
        const accessToken = await getGoogleAccessToken({ secrets });
        const event = await getEvent({ accessToken, eventId: args.event_id });
        return { event };
      } catch (e) {
        if (/missing secret/.test(e.message)) {
          throw new Error('Google not authenticated; run: robin secrets import --from <v1-user-data>');
        }
        throw e;
      }
    },
  };
}
```

- [ ] **Step 5: Write tests**

`tests/unit/calendar-sync.test.js`:

```js
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { _resetCache } from '../../src/integrations/_auth/google-token-cache.js';
import { sync } from '../../src/integrations/google_calendar/sync.js';

function fakeEvent(id, opts = {}) {
  return {
    id,
    summary: opts.summary ?? `Event ${id}`,
    status: opts.status ?? 'confirmed',
    start: { dateTime: '2026-05-09T10:00:00Z' },
    end: { dateTime: '2026-05-09T11:00:00Z' },
    attendees: opts.attendees ?? [],
    organizer: { email: 'me@me.com' },
    htmlLink: `https://calendar.google.com/${id}`,
    etag: 'abc',
    updated: opts.updated ?? '2026-05-09T09:00:00Z',
  };
}

test('first sync captures events and saves cursor', async () => {
  _resetCache();
  const fetchFn = mock.fn(async (url) => {
    if (url.includes('/token')) return { ok: true, json: async () => ({ access_token: 'a', expires_in: 3600 }) };
    if (url.includes('/calendars')) return { ok: true, json: async () => ({ items: [fakeEvent('e1'), fakeEvent('e2')] }) };
    throw new Error('unexpected: ' + url);
  });
  const captured = [];
  const ctx = {
    secrets: { GOOGLE_OAUTH_REFRESH_TOKEN: 'r', GOOGLE_OAUTH_CLIENT_ID: 'c', GOOGLE_OAUTH_CLIENT_SECRET: 's' },
    log: () => {},
    cursor: null,
    capture: async (rows) => { captured.push(...rows); return {}; },
    fetchFn,
  };
  const r = await sync(ctx);
  assert.equal(r.count, 2);
  assert.ok(r.cursor.updated_min);
  assert.equal(captured[0].external_id, 'e1');
});

test('cancelled events get [CANCELLED] prefix', async () => {
  _resetCache();
  const fetchFn = mock.fn(async (url) => {
    if (url.includes('/token')) return { ok: true, json: async () => ({ access_token: 'a', expires_in: 3600 }) };
    if (url.includes('/calendars')) return { ok: true, json: async () => ({ items: [fakeEvent('e1', { status: 'cancelled', summary: 'Old Meeting' })] }) };
    throw new Error('unexpected: ' + url);
  });
  const captured = [];
  const ctx = {
    secrets: { GOOGLE_OAUTH_REFRESH_TOKEN: 'r', GOOGLE_OAUTH_CLIENT_ID: 'c', GOOGLE_OAUTH_CLIENT_SECRET: 's' },
    log: () => {},
    cursor: null,
    capture: async (rows) => { captured.push(...rows); return {}; },
    fetchFn,
  };
  await sync(ctx);
  assert.match(captured[0].content, /\[CANCELLED\]/);
});
```

`tests/unit/calendar-tools.test.js`:

```js
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createCalendarListEventsTool } from '../../src/integrations/google_calendar/tools/calendar-list-events.js';

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  return db;
}

test('calendar_list_events filters by source', async () => {
  const db = await fresh();
  await db.query(surql`CREATE events CONTENT ${{
    source: 'google_calendar', content: 'Meeting · 2026-05-09', ts: new Date('2026-05-09T10:00:00Z'),
    external_id: 'e1', meta: { event_id: 'e1' },
  }}`).collect();
  await db.query(surql`CREATE events CONTENT ${{
    source: 'gmail', content: 'unrelated', ts: new Date(), external_id: 'm1', meta: {},
  }}`).collect();
  const t = createCalendarListEventsTool({ db });
  const r = await t.handler({});
  assert.equal(r.events.length, 1);
  assert.match(r.events[0].content, /Meeting/);
  await close(db);
});
```

- [ ] **Step 6: Run + lint + commit**

```bash
npm test -- tests/unit/calendar-sync.test.js tests/unit/calendar-tools.test.js
npm run lint
git add src/integrations/google_calendar/ tests/unit/calendar-*.test.js
git commit -m "feat(integrations): google_calendar — manifest + sync + 2 MCP tools"
```

---

## Task 4: google_drive integration

**Files:**
- Create: `src/integrations/google_drive/manifest.js`
- Create: `src/integrations/google_drive/client.js`
- Create: `src/integrations/google_drive/sync.js`
- Create: `src/integrations/google_drive/tools/drive-search.js`
- Create: `src/integrations/google_drive/tools/drive-get-file.js`
- Create: `tests/unit/drive-sync.test.js`
- Create: `tests/unit/drive-tools.test.js`

- [ ] **Step 1: Write `src/integrations/google_drive/client.js`**

```js
const FIRST_SYNC_CAP = 200;
const FIRST_SYNC_DAYS = 30;
const BODY_FETCH_CAP_BYTES = 100_000;
const TEXT_MIMES = ['text/plain', 'text/markdown', 'text/csv', 'application/json'];
const WORKSPACE_DOC = 'application/vnd.google-apps.document';

const FIELDS = 'id,name,mimeType,modifiedTime,owners,webViewLink,parents,shared,size';

async function driveFetch(path, { accessToken, fetchFn = globalThis.fetch, signal }) {
  const r = await fetchFn(`https://www.googleapis.com/drive/v3${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal,
  });
  if (!r.ok) throw new Error(`drive ${path} ${r.status}`);
  return await r.json();
}

export async function getStartPageToken({ accessToken, fetchFn, signal }) {
  return await driveFetch('/changes/startPageToken', { accessToken, fetchFn, signal });
}

export async function listFiles({ accessToken, q, pageToken, fetchFn, signal }) {
  const params = new URLSearchParams({ fields: `nextPageToken,files(${FIELDS})`, pageSize: '100', orderBy: 'modifiedTime desc' });
  if (q) params.set('q', q);
  if (pageToken) params.set('pageToken', pageToken);
  return await driveFetch(`/files?${params}`, { accessToken, fetchFn, signal });
}

export async function listChanges({ accessToken, pageToken, fetchFn, signal }) {
  const params = new URLSearchParams({ fields: `newStartPageToken,nextPageToken,changes(file(${FIELDS}),removed,fileId)`, pageToken });
  return await driveFetch(`/changes?${params}`, { accessToken, fetchFn, signal });
}

export async function getFileMetadata({ accessToken, fileId, fetchFn, signal }) {
  return await driveFetch(`/files/${fileId}?fields=${FIELDS}`, { accessToken, fetchFn, signal });
}

export async function getFileBody({ accessToken, fileId, mimeType, fetchFn, signal }) {
  if (mimeType === WORKSPACE_DOC) {
    const r = await fetchFn(`https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=text/plain`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal,
    });
    if (!r.ok) throw new Error(`drive export ${fileId} ${r.status}`);
    const text = await r.text();
    if (text.length > BODY_FETCH_CAP_BYTES) {
      return { truncated: true, body: text.slice(0, BODY_FETCH_CAP_BYTES) };
    }
    return { truncated: false, body: text };
  }
  if (!TEXT_MIMES.some((m) => mimeType?.startsWith(m))) {
    return null;
  }
  const r = await fetchFn(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal,
  });
  if (!r.ok) throw new Error(`drive download ${fileId} ${r.status}`);
  const text = await r.text();
  if (text.length > BODY_FETCH_CAP_BYTES) {
    return { truncated: true, body: text.slice(0, BODY_FETCH_CAP_BYTES) };
  }
  return { truncated: false, body: text };
}

export function buildEventFromFile(file) {
  const owner = file.owners?.[0]?.emailAddress ?? '(unknown)';
  return {
    source: 'google_drive',
    content: `${file.name} · ${file.mimeType} · modified ${file.modifiedTime} · owner ${owner}`,
    ts: new Date(file.modifiedTime),
    external_id: file.id,
    meta: {
      file_id: file.id,
      mime_type: file.mimeType,
      web_view_link: file.webViewLink,
      owners: (file.owners ?? []).map((o) => o.emailAddress),
      modified_time: file.modifiedTime,
      parents: file.parents,
      shared: file.shared,
      size: file.size,
    },
  };
}

export { BODY_FETCH_CAP_BYTES, FIRST_SYNC_CAP, FIRST_SYNC_DAYS, TEXT_MIMES, WORKSPACE_DOC };
```

- [ ] **Step 2: Write `src/integrations/google_drive/sync.js`**

```js
import { getGoogleAccessToken } from '../_auth/google-token-cache.js';
import { buildEventFromFile, FIRST_SYNC_CAP, FIRST_SYNC_DAYS, getStartPageToken, listChanges, listFiles } from './client.js';

async function firstSync(ctx, accessToken) {
  const cutoff = new Date(Date.now() - FIRST_SYNC_DAYS * 86400_000).toISOString();
  const events = [];
  let pageToken = null;
  let total = 0;
  do {
    const page = await listFiles({ accessToken, q: `modifiedTime > '${cutoff}'`, pageToken, fetchFn: ctx.fetchFn, signal: ctx.signal });
    pageToken = page.nextPageToken;
    for (const file of page.files ?? []) {
      if (total >= FIRST_SYNC_CAP) break;
      events.push(buildEventFromFile(file));
      total += 1;
    }
  } while (pageToken && total < FIRST_SYNC_CAP);
  await ctx.capture(events);
  const { startPageToken } = await getStartPageToken({ accessToken, fetchFn: ctx.fetchFn, signal: ctx.signal });
  return { count: events.length, cursor: { start_page_token: startPageToken } };
}

async function deltaSync(ctx, accessToken, startPageToken) {
  const events = [];
  let pageToken = startPageToken;
  let newStartPageToken = startPageToken;
  do {
    const page = await listChanges({ accessToken, pageToken, fetchFn: ctx.fetchFn, signal: ctx.signal });
    if (page.newStartPageToken) newStartPageToken = page.newStartPageToken;
    pageToken = page.nextPageToken;
    for (const change of page.changes ?? []) {
      if (change.removed || !change.file) continue;
      events.push(buildEventFromFile(change.file));
    }
  } while (pageToken);
  await ctx.capture(events);
  return { count: events.length, cursor: { start_page_token: newStartPageToken } };
}

export async function sync(ctx) {
  const accessToken = await getGoogleAccessToken({ secrets: ctx.secrets, fetchFn: ctx.fetchFn });
  if (ctx.cursor?.start_page_token) {
    return await deltaSync(ctx, accessToken, ctx.cursor.start_page_token);
  }
  return await firstSync(ctx, accessToken);
}
```

- [ ] **Step 3: Write manifest + tools**

`src/integrations/google_drive/manifest.js`:

```js
import { sync } from './sync.js';
import { createDriveGetFileTool } from './tools/drive-get-file.js';
import { createDriveSearchTool } from './tools/drive-search.js';

export const manifest = {
  name: 'google_drive',
  cadence: '4h',
  embed: true,
  capture_mode: 'upsert',
  secrets: { env_keys: ['GOOGLE_OAUTH_REFRESH_TOKEN', 'GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET'] },
  sync,
  tools: [createDriveSearchTool, createDriveGetFileTool],
};
```

`src/integrations/google_drive/tools/drive-search.js`:

```js
import { getGoogleAccessToken } from '../../_auth/google-token-cache.js';
import { requireSecret } from '../../../secrets/dotenv-io.js';
import { listFiles } from '../client.js';

function buildSecrets() {
  return {
    GOOGLE_OAUTH_REFRESH_TOKEN: requireSecret('GOOGLE_OAUTH_REFRESH_TOKEN'),
    GOOGLE_OAUTH_CLIENT_ID: requireSecret('GOOGLE_OAUTH_CLIENT_ID'),
    GOOGLE_OAUTH_CLIENT_SECRET: requireSecret('GOOGLE_OAUTH_CLIENT_SECRET'),
  };
}

export function createDriveSearchTool() {
  return {
    name: 'drive_search',
    description: 'Search Google Drive files by name (live API).',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 } },
      required: ['query'],
    },
    handler: async (args) => {
      const accessToken = await getGoogleAccessToken({ secrets: buildSecrets() });
      const q = `name contains '${args.query.replace(/'/g, "\\'")}'`;
      const page = await listFiles({ accessToken, q });
      return { files: (page.files ?? []).slice(0, args.limit ?? 20) };
    },
  };
}
```

`src/integrations/google_drive/tools/drive-get-file.js`:

```js
import { getGoogleAccessToken } from '../../_auth/google-token-cache.js';
import { requireSecret } from '../../../secrets/dotenv-io.js';
import { getFileBody, getFileMetadata, WORKSPACE_DOC } from '../client.js';

function buildSecrets() {
  return {
    GOOGLE_OAUTH_REFRESH_TOKEN: requireSecret('GOOGLE_OAUTH_REFRESH_TOKEN'),
    GOOGLE_OAUTH_CLIENT_ID: requireSecret('GOOGLE_OAUTH_CLIENT_ID'),
    GOOGLE_OAUTH_CLIENT_SECRET: requireSecret('GOOGLE_OAUTH_CLIENT_SECRET'),
  };
}

export function createDriveGetFileTool() {
  return {
    name: 'drive_get_file',
    description: 'Fetch Google Drive file metadata; body for text/Docs only, ≤100KB. Sheets/Slides return metadata + browser link.',
    inputSchema: {
      type: 'object',
      properties: { file_id: { type: 'string' } },
      required: ['file_id'],
    },
    handler: async (args) => {
      const accessToken = await getGoogleAccessToken({ secrets: buildSecrets() });
      const metadata = await getFileMetadata({ accessToken, fileId: args.file_id });
      let body = null;
      if (metadata.mimeType?.startsWith('application/vnd.google-apps.') && metadata.mimeType !== WORKSPACE_DOC) {
        return { metadata, body: null, body_status: 'workspace_format_not_supported' };
      }
      try {
        const result = await getFileBody({ accessToken, fileId: args.file_id, mimeType: metadata.mimeType });
        if (result === null) return { metadata, body: null, body_status: 'mime_not_text' };
        body = result.body;
        return { metadata, body, body_status: result.truncated ? 'truncated_at_100KB' : 'full' };
      } catch (e) {
        return { metadata, body: null, body_status: `error: ${e.message}` };
      }
    },
  };
}
```

- [ ] **Step 4: Write tests**

`tests/unit/drive-sync.test.js`:

```js
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { _resetCache } from '../../src/integrations/_auth/google-token-cache.js';
import { sync } from '../../src/integrations/google_drive/sync.js';

function fakeFile(id) {
  return {
    id, name: `File${id}.txt`, mimeType: 'text/plain',
    modifiedTime: '2026-05-09T10:00:00Z',
    owners: [{ emailAddress: 'me@me.com' }],
    webViewLink: `https://drive.google.com/${id}`,
    parents: ['root'], shared: false, size: '100',
  };
}

test('first sync caps at 200 and saves start_page_token', async () => {
  _resetCache();
  const fetchFn = mock.fn(async (url) => {
    if (url.includes('/token')) return { ok: true, json: async () => ({ access_token: 'a', expires_in: 3600 }) };
    if (url.includes('/files?')) return { ok: true, json: async () => ({ files: [fakeFile('f1'), fakeFile('f2')] }) };
    if (url.includes('/changes/startPageToken')) return { ok: true, json: async () => ({ startPageToken: '999' }) };
    throw new Error('unexpected: ' + url);
  });
  const captured = [];
  const r = await sync({
    secrets: { GOOGLE_OAUTH_REFRESH_TOKEN: 'r', GOOGLE_OAUTH_CLIENT_ID: 'c', GOOGLE_OAUTH_CLIENT_SECRET: 's' },
    log: () => {},
    cursor: null,
    capture: async (rows) => { captured.push(...rows); return {}; },
    fetchFn,
  });
  assert.equal(r.count, 2);
  assert.equal(r.cursor.start_page_token, '999');
});

test('delta sync uses changes.list', async () => {
  _resetCache();
  const fetchFn = mock.fn(async (url) => {
    if (url.includes('/token')) return { ok: true, json: async () => ({ access_token: 'a', expires_in: 3600 }) };
    if (url.includes('/changes?')) return { ok: true, json: async () => ({
      newStartPageToken: '1000',
      changes: [{ file: fakeFile('f10') }],
    }) };
    throw new Error('unexpected: ' + url);
  });
  const captured = [];
  const r = await sync({
    secrets: { GOOGLE_OAUTH_REFRESH_TOKEN: 'r', GOOGLE_OAUTH_CLIENT_ID: 'c', GOOGLE_OAUTH_CLIENT_SECRET: 's' },
    log: () => {},
    cursor: { start_page_token: '500' },
    capture: async (rows) => { captured.push(...rows); return {}; },
    fetchFn,
  });
  assert.equal(r.count, 1);
  assert.equal(r.cursor.start_page_token, '1000');
});
```

`tests/unit/drive-tools.test.js`:

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDriveGetFileTool } from '../../src/integrations/google_drive/tools/drive-get-file.js';
import { createDriveSearchTool } from '../../src/integrations/google_drive/tools/drive-search.js';

test('drive_search has correct schema', () => {
  const t = createDriveSearchTool();
  assert.equal(t.name, 'drive_search');
  assert.ok(t.inputSchema.required.includes('query'));
});

test('drive_get_file has correct schema', () => {
  const t = createDriveGetFileTool();
  assert.equal(t.name, 'drive_get_file');
  assert.ok(t.inputSchema.required.includes('file_id'));
});
```

- [ ] **Step 5: Run + lint + commit**

```bash
npm test -- tests/unit/drive-sync.test.js tests/unit/drive-tools.test.js
npm run lint
git add src/integrations/google_drive/ tests/unit/drive-*.test.js
git commit -m "feat(integrations): google_drive — manifest + sync + 2 MCP tools"
```

---

## Task 5: youtube integration

**Files:**
- Create: `src/integrations/youtube/manifest.js`
- Create: `src/integrations/youtube/client.js`
- Create: `src/integrations/youtube/sync.js`
- Create: `src/integrations/youtube/tools/youtube-list-subscriptions.js`
- Create: `src/integrations/youtube/tools/youtube-list-liked.js`
- Create: `tests/unit/youtube-sync.test.js`
- Create: `tests/unit/youtube-tools.test.js`

- [ ] **Step 1: Write `src/integrations/youtube/client.js`**

```js
async function ytFetch(path, { accessToken, fetchFn = globalThis.fetch, signal }) {
  const r = await fetchFn(`https://www.googleapis.com/youtube/v3${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal,
  });
  if (!r.ok) throw new Error(`youtube ${path} ${r.status}`);
  return await r.json();
}

export async function listSubscriptions({ accessToken, pageToken, fetchFn, signal }) {
  const params = new URLSearchParams({ part: 'snippet', mine: 'true', maxResults: '50' });
  if (pageToken) params.set('pageToken', pageToken);
  return await ytFetch(`/subscriptions?${params}`, { accessToken, fetchFn, signal });
}

export async function listMyPlaylists({ accessToken, pageToken, fetchFn, signal }) {
  const params = new URLSearchParams({ part: 'snippet,contentDetails', mine: 'true', maxResults: '50' });
  if (pageToken) params.set('pageToken', pageToken);
  return await ytFetch(`/playlists?${params}`, { accessToken, fetchFn, signal });
}

export async function listLikedVideos({ accessToken, pageToken, fetchFn, signal }) {
  const params = new URLSearchParams({ part: 'snippet', myRating: 'like', maxResults: '50' });
  if (pageToken) params.set('pageToken', pageToken);
  return await ytFetch(`/videos?${params}`, { accessToken, fetchFn, signal });
}

export function buildEventFromSubscription(item) {
  const channelId = item.snippet?.resourceId?.channelId ?? item.id;
  const channelTitle = item.snippet?.title ?? '(unknown)';
  return {
    source: 'youtube',
    content: `sub: ${channelTitle}`,
    ts: new Date(item.snippet?.publishedAt ?? Date.now()),
    external_id: `sub:${channelId}`,
    meta: { kind: 'subscription', channel_id: channelId, channel_title: channelTitle },
  };
}

export function buildEventFromPlaylist(item) {
  const playlistId = item.id;
  const title = item.snippet?.title ?? '(untitled)';
  const itemCount = item.contentDetails?.itemCount ?? 0;
  return {
    source: 'youtube',
    content: `playlist: ${title} (${itemCount} videos)`,
    ts: new Date(item.snippet?.publishedAt ?? Date.now()),
    external_id: `playlist:${playlistId}`,
    meta: { kind: 'playlist', playlist_id: playlistId, title, item_count: itemCount },
  };
}

export function buildEventFromLikedVideo(item) {
  const videoId = item.id;
  const title = item.snippet?.title ?? '(untitled)';
  const channelTitle = item.snippet?.channelTitle ?? '(unknown)';
  return {
    source: 'youtube',
    content: `liked: ${title} · ${channelTitle}`,
    ts: new Date(item.snippet?.publishedAt ?? Date.now()),
    external_id: `liked:${videoId}`,
    meta: { kind: 'liked_video', video_id: videoId, channel_id: item.snippet?.channelId, channel_title: channelTitle, title },
  };
}
```

- [ ] **Step 2: Write `src/integrations/youtube/sync.js`**

```js
import { getGoogleAccessToken } from '../_auth/google-token-cache.js';
import {
  buildEventFromLikedVideo, buildEventFromPlaylist, buildEventFromSubscription,
  listLikedVideos, listMyPlaylists, listSubscriptions,
} from './client.js';

async function paginateAll(fetcher, accessToken, ctx, builder) {
  const events = [];
  let pageToken = null;
  do {
    const page = await fetcher({ accessToken, pageToken, fetchFn: ctx.fetchFn, signal: ctx.signal });
    pageToken = page.nextPageToken;
    for (const item of page.items ?? []) {
      events.push(builder(item));
    }
  } while (pageToken);
  return events;
}

export async function sync(ctx) {
  const accessToken = await getGoogleAccessToken({ secrets: ctx.secrets, fetchFn: ctx.fetchFn });
  const [subs, playlists, liked] = await Promise.all([
    paginateAll(listSubscriptions, accessToken, ctx, buildEventFromSubscription),
    paginateAll(listMyPlaylists, accessToken, ctx, buildEventFromPlaylist),
    paginateAll(listLikedVideos, accessToken, ctx, buildEventFromLikedVideo),
  ]);
  const events = [...subs, ...playlists, ...liked];
  await ctx.capture(events);
  return { count: events.length, cursor: { last_run_at: new Date().toISOString() } };
}
```

- [ ] **Step 3: Write manifest + tools**

`src/integrations/youtube/manifest.js`:

```js
import { sync } from './sync.js';
import { createYouTubeListLikedTool } from './tools/youtube-list-liked.js';
import { createYouTubeListSubscriptionsTool } from './tools/youtube-list-subscriptions.js';

export const manifest = {
  name: 'youtube',
  cadence: '1d',
  embed: true,
  capture_mode: 'insert-or-skip',
  secrets: { env_keys: ['GOOGLE_OAUTH_REFRESH_TOKEN', 'GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET'] },
  sync,
  tools: [createYouTubeListSubscriptionsTool, createYouTubeListLikedTool],
};
```

`src/integrations/youtube/tools/youtube-list-subscriptions.js`:

```js
import { BoundQuery } from 'surrealdb';

export function createYouTubeListSubscriptionsTool({ db }) {
  return {
    name: 'youtube_list_subscriptions',
    description: 'List captured YouTube subscriptions from the events table.',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 } },
    },
    handler: async (args) => {
      const limit = Math.min(args.limit ?? 50, 200);
      const sql = `SELECT id, content, ts, meta FROM events WHERE source = 'youtube' AND meta.kind = 'subscription' ORDER BY ts DESC LIMIT ${limit}`;
      const [rows] = await db.query(new BoundQuery(sql, {})).collect();
      return { subscriptions: rows.map((r) => ({ ...r, id: String(r.id) })) };
    },
  };
}
```

`src/integrations/youtube/tools/youtube-list-liked.js`:

```js
import { BoundQuery } from 'surrealdb';

export function createYouTubeListLikedTool({ db }) {
  return {
    name: 'youtube_list_liked',
    description: 'List captured YouTube liked videos from the events table.',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 } },
    },
    handler: async (args) => {
      const limit = Math.min(args.limit ?? 50, 200);
      const sql = `SELECT id, content, ts, meta FROM events WHERE source = 'youtube' AND meta.kind = 'liked_video' ORDER BY ts DESC LIMIT ${limit}`;
      const [rows] = await db.query(new BoundQuery(sql, {})).collect();
      return { liked: rows.map((r) => ({ ...r, id: String(r.id) })) };
    },
  };
}
```

- [ ] **Step 4: Write tests**

`tests/unit/youtube-sync.test.js`:

```js
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { _resetCache } from '../../src/integrations/_auth/google-token-cache.js';
import { sync } from '../../src/integrations/youtube/sync.js';

test('sync produces all three event kinds with correct external_id prefixes', async () => {
  _resetCache();
  const fetchFn = mock.fn(async (url) => {
    if (url.includes('/token')) return { ok: true, json: async () => ({ access_token: 'a', expires_in: 3600 }) };
    if (url.includes('/subscriptions')) return { ok: true, json: async () => ({
      items: [{ id: 'sub1', snippet: { resourceId: { channelId: 'c1' }, title: 'Channel One', publishedAt: '2026-01-01T00:00:00Z' } }],
    }) };
    if (url.includes('/playlists')) return { ok: true, json: async () => ({
      items: [{ id: 'p1', snippet: { title: 'My Playlist', publishedAt: '2026-01-01T00:00:00Z' }, contentDetails: { itemCount: 5 } }],
    }) };
    if (url.includes('/videos')) return { ok: true, json: async () => ({
      items: [{ id: 'v1', snippet: { title: 'Liked Vid', channelTitle: 'Channel One', channelId: 'c1', publishedAt: '2026-01-01T00:00:00Z' } }],
    }) };
    throw new Error('unexpected: ' + url);
  });
  const captured = [];
  const r = await sync({
    secrets: { GOOGLE_OAUTH_REFRESH_TOKEN: 'r', GOOGLE_OAUTH_CLIENT_ID: 'c', GOOGLE_OAUTH_CLIENT_SECRET: 's' },
    log: () => {},
    cursor: null,
    capture: async (rows) => { captured.push(...rows); return {}; },
    fetchFn,
  });
  assert.equal(r.count, 3);
  const ids = captured.map((e) => e.external_id).sort();
  assert.deepEqual(ids, ['liked:v1', 'playlist:p1', 'sub:c1']);
});
```

`tests/unit/youtube-tools.test.js`:

```js
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createYouTubeListLikedTool } from '../../src/integrations/youtube/tools/youtube-list-liked.js';
import { createYouTubeListSubscriptionsTool } from '../../src/integrations/youtube/tools/youtube-list-subscriptions.js';

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  return db;
}

test('youtube_list_subscriptions filters by kind', async () => {
  const db = await fresh();
  await db.query(surql`CREATE events CONTENT ${{
    source: 'youtube', content: 'sub: A', ts: new Date('2026-05-09'),
    external_id: 'sub:c1', meta: { kind: 'subscription' },
  }}`).collect();
  await db.query(surql`CREATE events CONTENT ${{
    source: 'youtube', content: 'liked: V', ts: new Date('2026-05-09'),
    external_id: 'liked:v1', meta: { kind: 'liked_video' },
  }}`).collect();
  const t = createYouTubeListSubscriptionsTool({ db });
  const r = await t.handler({});
  assert.equal(r.subscriptions.length, 1);
  await close(db);
});

test('youtube_list_liked filters by kind', async () => {
  const db = await fresh();
  await db.query(surql`CREATE events CONTENT ${{
    source: 'youtube', content: 'liked: V', ts: new Date('2026-05-09'),
    external_id: 'liked:v1', meta: { kind: 'liked_video' },
  }}`).collect();
  const t = createYouTubeListLikedTool({ db });
  const r = await t.handler({});
  assert.equal(r.liked.length, 1);
  await close(db);
});
```

- [ ] **Step 5: Run + lint + commit**

```bash
npm test -- tests/unit/youtube-sync.test.js tests/unit/youtube-tools.test.js
npm run lint
git add src/integrations/youtube/ tests/unit/youtube-*.test.js
git commit -m "feat(integrations): youtube — manifest + sync + 2 MCP tools"
```

---

## Task 6: github_write integration (tool-only kind)

**Files:**
- Modify: `src/integrations/_framework/manifest-loader.js` — detect tool-only kind
- Modify: `src/mcp/tools/integration-run.js` — new `tool_only_no_sync` reason
- Create: `src/integrations/github_write/manifest.js`
- Create: `src/integrations/github_write/client.js`
- Create: `src/integrations/github_write/tools/github-write.js`
- Create: `tests/unit/github-write-tool.test.js`
- Create: `tests/unit/manifest-tool-only.test.js`
- Modify: `tests/unit/tool-integration-run.test.js` — add tool_only_no_sync test

- [ ] **Step 1: Update `src/integrations/_framework/manifest-loader.js`**

Read first. Add a `kind` derivation:

```js
function deriveKind(m) {
  if (m.cadence_ms !== null && m.sync) return 'sync';
  if (m.cadence_ms === null && m.start) return 'gateway';
  if (m.cadence_ms === null && !m.start && (m.tools?.length ?? 0) > 0) return 'tool-only';
  return 'invalid';
}
// Inside validateManifest, add:
const kind = deriveKind({ ...m, cadence_ms });
if (kind === 'invalid') throw new Error(`manifest ${m.name}: cannot determine integration kind (need sync OR start OR tools[])`);
```

Return `kind` as part of the validated manifest.

- [ ] **Step 2: Write `src/integrations/github_write/client.js`**

```js
import { requireSecret } from '../../secrets/dotenv-io.js';

async function githubFetch(path, { method = 'GET', body, fetchFn = globalThis.fetch, signal }) {
  const r = await fetchFn(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${requireSecret('GITHUB_PAT')}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });
  if (!r.ok) {
    const errText = await r.text().catch(() => '');
    throw new Error(`github ${path} ${r.status}: ${errText}`);
  }
  return r.status === 204 ? null : await r.json();
}

export async function createIssue({ repo, title, body, labels, fetchFn, signal }) {
  return await githubFetch(`/repos/${repo}/issues`, {
    method: 'POST',
    body: { title, body, labels: labels ?? [] },
    fetchFn, signal,
  });
}

export async function addComment({ repo, issue_id, body, fetchFn, signal }) {
  return await githubFetch(`/repos/${repo}/issues/${issue_id}/comments`, {
    method: 'POST',
    body: { body },
    fetchFn, signal,
  });
}

export async function applyLabels({ repo, issue_id, add = [], remove = [], fetchFn, signal }) {
  if (add.length > 0) {
    await githubFetch(`/repos/${repo}/issues/${issue_id}/labels`, {
      method: 'POST',
      body: { labels: add },
      fetchFn, signal,
    });
  }
  for (const label of remove) {
    await githubFetch(`/repos/${repo}/issues/${issue_id}/labels/${encodeURIComponent(label)}`, {
      method: 'DELETE',
      fetchFn, signal,
    });
  }
  return { added: add, removed: remove };
}

export async function markNotificationRead({ notification_id, fetchFn, signal }) {
  return await githubFetch(`/notifications/threads/${notification_id}`, {
    method: 'PATCH',
    fetchFn, signal,
  });
}
```

- [ ] **Step 3: Write `src/integrations/github_write/tools/github-write.js`**

```js
import { checkOutbound } from '../../../outbound/policy.js';
import { addComment, applyLabels, createIssue, markNotificationRead } from '../client.js';

export function createGitHubWriteTool({ db, capture }) {
  return {
    name: 'github_write',
    description: 'Write to GitHub: create-issue, comment, label, or mark-read. Text actions pass through outbound-policy.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create-issue', 'comment', 'label', 'mark-read'] },
        args: { type: 'object' },
      },
      required: ['action', 'args'],
    },
    handler: async (input) => {
      const { action, args } = input;
      switch (action) {
        case 'create-issue': {
          const text = `${args.title ?? ''}\n${args.body ?? ''}\n${(args.labels ?? []).join(',')}`;
          const policy = await checkOutbound(db, { destination: 'github_write', text });
          if (!policy.ok) return { ok: false, reason: 'outbound_blocked', blocked_by: policy.reason };
          const r = await createIssue(args);
          await capture([{
            source: 'github_write',
            content: text,
            external_id: `${args.repo}:${r.number}`,
            meta: { action: 'create-issue', repo: args.repo, number: r.number, url: r.html_url },
          }]);
          return { ok: true, url: r.html_url, id: r.number };
        }
        case 'comment': {
          const text = args.body ?? '';
          const policy = await checkOutbound(db, { destination: 'github_write', text });
          if (!policy.ok) return { ok: false, reason: 'outbound_blocked', blocked_by: policy.reason };
          const r = await addComment(args);
          await capture([{
            source: 'github_write',
            content: text,
            external_id: `${args.repo}:${args.issue_id}:${r.id}`,
            meta: { action: 'comment', repo: args.repo, issue_id: args.issue_id, comment_id: r.id, url: r.html_url },
          }]);
          return { ok: true, url: r.html_url, id: r.id };
        }
        case 'label': {
          const r = await applyLabels(args);
          console.log(`[github_write] applied labels on ${args.repo}#${args.issue_id}: +${(r.added ?? []).join(',')} -${(r.removed ?? []).join(',')}`);
          return { ok: true, ...r };
        }
        case 'mark-read': {
          await markNotificationRead(args);
          console.log(`[github_write] marked notification ${args.notification_id} read`);
          return { ok: true };
        }
        default:
          return { ok: false, reason: 'unknown_action', action };
      }
    },
  };
}
```

- [ ] **Step 4: Write `src/integrations/github_write/manifest.js`**

```js
import { createGitHubWriteTool } from './tools/github-write.js';

export const manifest = {
  name: 'github_write',
  cadence: null,
  embed: true,
  capture_mode: 'insert-or-skip',
  secrets: { env_keys: ['GITHUB_PAT'] },
  tools: [createGitHubWriteTool],
};
```

- [ ] **Step 5: Update `src/mcp/tools/integration-run.js`**

Add `tool_only_no_sync` reason. Find the gateway-refusal block and add:

```js
const integration = registry.get(args.name);
if (!integration) return { ok: false, reason: 'unknown_integration', name: args.name };
if (integration.cadence_ms === null && !integration.sync) return { ok: false, reason: 'tool_only_no_sync' };
if (integration.cadence_ms === null) return { ok: false, reason: 'gateway_no_sync' };
```

- [ ] **Step 6: Write tests**

`tests/unit/manifest-tool-only.test.js`:

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateManifest } from '../../src/integrations/_framework/manifest-loader.js';

test('tool-only manifest validates with kind=tool-only', () => {
  const m = validateManifest({
    name: 'github_write',
    cadence: null,
    tools: [() => ({ name: 'x', description: 'y', inputSchema: {}, handler: async () => ({}) })],
  });
  assert.equal(m.kind ?? 'tool-only', 'tool-only'); // depending on implementation; adjust
});

test('rejects manifest with no sync, no start, no tools', () => {
  assert.throws(() => validateManifest({ name: 'broken', cadence: null }));
});
```

`tests/unit/github-write-tool.test.js`:

```js
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { mock, test } from 'node:test';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createStubEmbedder } from '../../src/embed/embedder.js';
import { createCapture } from '../../src/integrations/_framework/capture.js';
import { createGitHubWriteTool } from '../../src/integrations/github_write/tools/github-write.js';

async function fresh() {
  process.env.ROBIN_HOME = `/tmp/robin-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const { saveSecret } = await import('../../src/secrets/dotenv-io.js?cb=' + Date.now());
  saveSecret('GITHUB_PAT', 'ghp_test');
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  return db;
}

test('create-issue passes policy and captures event', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 384 });
  const capture = createCapture({ db, embedder: e, source: 'github_write', embed: true, mode: 'insert-or-skip' });
  const fakeFetch = mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    status: 201,
    json: async () => ({ number: 42, html_url: 'https://github.com/x/y/issues/42' }),
    text: async () => '',
  }));
  try {
    const t = createGitHubWriteTool({ db, capture });
    const r = await t.handler({
      action: 'create-issue',
      args: { repo: 'x/y', title: 'Bug', body: 'Details', labels: ['bug'] },
    });
    assert.equal(r.ok, true);
    assert.equal(r.id, 42);
  } finally { fakeFetch.mock.restore(); await close(db); }
});

test('create-issue blocked by PII', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 384 });
  const capture = createCapture({ db, embedder: e, source: 'github_write', embed: true, mode: 'insert-or-skip' });
  const t = createGitHubWriteTool({ db, capture });
  const r = await t.handler({
    action: 'create-issue',
    args: { repo: 'x/y', title: 'My SSN is 123-45-6789', body: 'oops' },
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'outbound_blocked');
  await close(db);
});

test('label action skips outbound-policy', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 384 });
  const capture = createCapture({ db, embedder: e, source: 'github_write', embed: true, mode: 'insert-or-skip' });
  const fakeFetch = mock.method(globalThis, 'fetch', async () => ({ ok: true, status: 200, json: async () => ([]), text: async () => '' }));
  try {
    const t = createGitHubWriteTool({ db, capture });
    const r = await t.handler({
      action: 'label',
      args: { repo: 'x/y', issue_id: 42, add: ['bug'] },
    });
    assert.equal(r.ok, true);
  } finally { fakeFetch.mock.restore(); await close(db); }
});

test('unknown action returns unknown_action', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 384 });
  const capture = createCapture({ db, embedder: e, source: 'github_write', embed: true, mode: 'insert-or-skip' });
  const t = createGitHubWriteTool({ db, capture });
  const r = await t.handler({ action: 'zoom', args: {} });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'unknown_action');
  await close(db);
});
```

Update `tests/unit/tool-integration-run.test.js` — add a test for tool-only:

```js
test('integration_run rejects tool-only integration', async () => {
  const db = await fresh();
  const registry = new Map([['github_write', { cadence_ms: null, tools: [() => ({})] }]]);
  const t = createIntegrationRunTool({ db, registry, runIntegrationSync: async () => {} });
  const r = await t.handler({ name: 'github_write' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'tool_only_no_sync');
  await close(db);
});
```

- [ ] **Step 7: Run + lint + commit**

```bash
npm test -- tests/unit/github-write-tool.test.js tests/unit/manifest-tool-only.test.js tests/unit/tool-integration-run.test.js
npm run lint
git add src/integrations/github_write/ src/integrations/_framework/manifest-loader.js src/mcp/tools/integration-run.js tests/unit/github-write-tool.test.js tests/unit/manifest-tool-only.test.js tests/unit/tool-integration-run.test.js
git commit -m "feat(integrations): github_write tool-only integration with 4 actions"
```

---

## Task 7: Daemon wiring + integrations list update

**Files:**
- Modify: `src/daemon/server.js` — boot warning, tool-only branch, register github_write tools, dotenv-aware
- Modify: `src/cli/commands/integrations-list.js` — merge registry + runtime row

- [ ] **Step 1: Update `src/daemon/server.js`**

Read first. Three changes:

(a) **Add boot warning if .env missing.** Near the top of the daemon's boot sequence:

```js
import { existsSync } from 'node:fs';
import { envFilePath } from '../secrets/dotenv-io.js';

if (!existsSync(envFilePath())) {
  console.warn(`[daemon] no secrets file at ${envFilePath()} — integrations will fail.`);
  console.warn(`         Run: robin secrets import --from <v1-user-data>  (or: robin secrets set <KEY>)`);
}
```

(b) **Tool-only branch in the manifest-loop.** When iterating manifests:

```js
for (const m of manifests) {
  const capture = createCapture({ db: dbHandle, embedder: embedderWrap, source: m.name, embed: m.embed, mode: m.capture_mode });
  registry.set(m.name, { ...m, capture });

  if (m.cadence_ms !== null && m.sync) {
    // sync integration: seed scheduler row
    const [rows] = await dbHandle.query(surql`SELECT * FROM type::record('runtime', 'scheduler')`).collect();
    const value = rows[0]?.value ?? {};
    const integrations = value.integrations ?? {};
    if (!integrations[m.name]) {
      integrations[m.name] = { cadence_ms: m.cadence_ms, next_run_at: new Date(), consecutive_failures: 0 };
      await dbHandle.query(surql`UPSERT type::record('runtime', 'scheduler') SET value = ${{ ...value, integrations }}`).collect();
    }
  } else if (m.cadence_ms === null && m.start) {
    // gateway: build secrets ctx + start
    const secrets = {};
    for (const key of m.secrets?.env_keys ?? []) {
      Object.defineProperty(secrets, key, { get: () => requireSecret(key), enumerable: true });
    }
    try {
      const ctx = {
        db: dbHandle, host: hostInstance, secrets, capture,
        log: (...a) => console.log(`[${m.name}]`, ...a),
        saveSecret,
      };
      const client = await m.start(ctx);
      gatewayClients.set(m.name, client);
      console.log(`integration ${m.name}: gateway started`);
    } catch (e) {
      console.warn(`integration ${m.name}: gateway start failed: ${e.message}`);
    }
  } else if (m.cadence_ms === null && !m.start && (m.tools?.length ?? 0) > 0) {
    // tool-only: just register tools
    console.log(`integration ${m.name}: tool-only (no sync, no gateway)`);
  } else {
    console.warn(`integration ${m.name}: invalid kind`);
  }
}
```

(c) **Add registry-based access to `m.sync` in run-sync.** Drop the old `secrets: ...` key passed to registry — `runIntegrationSync` builds its own ctx.secrets via getter from `integration.secrets.env_keys`.

(d) **Pass capture into github_write tool factory.** When iterating manifest tools:

```js
for (const m of manifests) {
  for (const factory of m.tools ?? []) {
    try {
      // github_write needs capture; calendar/drive get db; gmail tools need none
      const capture = registry.get(m.name)?.capture;
      const tool = factory({ db: dbHandle, embedder: embedderWrap, capture });
      tools.push(tool);
    } catch (e) {
      console.warn(`integration ${m.name}: tool factory failed: ${e.message}`);
    }
  }
}
```

- [ ] **Step 2: Update `src/cli/commands/integrations-list.js`**

Read first. Modify to merge from BOTH manifest registry (read manifests at runtime) AND scheduler row:

```js
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { surql } from 'surrealdb';
import { close, connect } from '../../db/client.js';
import { isPidAlive, readDaemonState } from '../../daemon/lock.js';
import { loadManifests } from '../../integrations/_framework/manifest-loader.js';
import { ensureHome, paths } from '../../runtime/home.js';

function formatCadence(m) {
  if (m.cadence_ms === null && m.start) return 'gateway';
  if (m.cadence_ms === null) return 'tool-only';
  if (m.cadence_ms >= 86_400_000 && m.cadence_ms % 86_400_000 === 0) return `${m.cadence_ms / 86_400_000}d`;
  if (m.cadence_ms >= 3_600_000 && m.cadence_ms % 3_600_000 === 0) return `${m.cadence_ms / 3_600_000}h`;
  return `${m.cadence_ms / 60_000}m`;
}

export async function integrationsList() {
  await ensureHome();
  const p = paths();
  const integrationsDir = new URL('../../integrations/', import.meta.url).pathname;
  const manifests = await loadManifests(integrationsDir);

  const db = await connect({ engine: `rocksdb://${p.db}` });
  let rtIntegrations = {};
  try {
    const [rows] = await db.query(surql`SELECT * FROM type::record('runtime', 'scheduler')`).collect();
    rtIntegrations = rows[0]?.value?.integrations ?? {};
  } finally { await close(db); }

  if (manifests.length === 0) { console.log('(no integrations registered)'); return; }
  for (const m of manifests) {
    const cadence = formatCadence(m);
    const rt = rtIntegrations[m.name];
    const last = rt?.last_sync_at ? new Date(rt.last_sync_at).toISOString() : (m.cadence_ms === null ? '─' : 'never');
    const ok = rt?.last_sync_ok === true ? 'OK' : (rt?.last_sync_ok === false ? 'FAIL' : '─');
    console.log(`${m.name.padEnd(15)}  ${cadence.padEnd(10)}  last=${last.padEnd(25)}  ${ok}`);
  }
}
```

- [ ] **Step 3: Smoke test daemon boot**

```bash
ROBIN_HOME=/tmp/robin-task7-$$ ROBIN_HOST=claude_code node bin/robin migrate
ROBIN_HOME=/tmp/robin-task7-$$ ROBIN_HOST=claude_code node src/daemon/server.js &
DAEMON_PID=$!
sleep 5
cat /tmp/robin-task7-*/.daemon.state
kill $DAEMON_PID
sleep 2
```

Expected: daemon starts; logs `no secrets file at .../secrets/.env` warning; logs `integration github_write: tool-only (no sync, no gateway)` for github_write; tool count climbs to 31.

- [ ] **Step 4: Run + lint + commit**

```bash
npm test
npm run lint
git add src/daemon/server.js src/cli/commands/integrations-list.js
git commit -m "feat(daemon): tool-only branch + boot secrets warning + integrations list registry merge"
```

---

## Task 8: AGENTS.md three-sub-block + outbound-writes caveat

**Files:**
- Modify: `src/install/agents-md.js` — three-sub-block structure
- Create: `tests/unit/agents-md-2e.test.js`
- Modify: `tests/unit/agents-md-integrations.test.js` — expect new structure

- [ ] **Step 1: Update `src/install/agents-md.js`**

Read first. Restructure `integrationsSection(integrations)` to render three blocks inside one fence. The `Available integrations` rendering keeps the same per-integration row format (cadence + tool list).

```js
function renderIntegrationsList(integrations) {
  const lines = [];
  for (const i of integrations) {
    const cadence = formatCadence(i.cadence_ms, i.kind);
    const tools = i.tool_names?.length > 0 ? i.tool_names.join(', ') : '(no agent-callable tools)';
    if (i.kind === 'gateway') {
      lines.push(`- ${i.name} (gateway): bot listens on allowlist; ${tools === '(no agent-callable tools)' ? 'no agent-callable tools' : tools}`);
    } else if (i.kind === 'tool-only') {
      lines.push(`- ${i.name} (tool-only): ${tools}`);
    } else {
      lines.push(`- ${i.name} (${cadence}): ${tools}`);
    }
  }
  if (lines.length === 0) lines.push('- (none registered)');
  return lines.join('\n');
}

function formatCadence(ms, kind) {
  if (kind === 'gateway') return 'gateway';
  if (kind === 'tool-only') return 'tool-only';
  if (ms === null) return 'gateway';
  if (ms >= 86_400_000 && ms % 86_400_000 === 0) return `${ms / 86_400_000}d`;
  if (ms >= 3_600_000 && ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  return `${ms / 60_000}m`;
}

export function integrationsSection(integrations = []) {
  return `<!-- robin-integrations:start (auto-generated, do not hand-edit) -->
## Integration data freshness

Before quoting integration data as "today's" / "current" / "latest", call
integration_status({name}) and verify last_sync_at is within 2× the cadence.
If stale, either label the quote as "data from <last_sync_at>" OR call
integration_run({name}) to refresh.

After integration_run, the result IS immediate when no concurrent sync is
running — the tool awaits and returns count/cursor/duration_ms. If it returns
{ ok: false, reason: 'in_flight' }, poll integration_status({name}) every 2s
(don't poll faster); when in_flight flips to false, check last_sync_at and
last_sync_ok. Don't loop more than ~30 polls (~60s).

Don't fabricate fresh data. Don't loop on integration_run — the 30s
min-interval will refuse, and repeated polling burns API quota.

## Outbound writes (github_write)

Use \`github_write\` for create-issue, comment, label, mark-read. Text content
(create-issue body, comment body) passes through outbound-policy — PII /
secret / verbatim-untrusted-quote checks. If blocked, the tool returns
{ ok: false, reason: 'outbound_blocked', blocked_by: '<policy reason>' };
DON'T retry by paraphrasing to bypass the guard — surface the block to the
user and ask for guidance.

create-issue and comment writes are captured to events (recall searchable);
label and mark-read are NOT captured (no text content). Don't expect
recall('issue I labeled X') to find anything.

## Available integrations

${renderIntegrationsList(integrations)}
<!-- robin-integrations:end -->`;
}
```

The function signature `agentsMdContent({ integrations = [] } = {})` stays. Each integration in the array now has shape `{ name, cadence_ms, kind, tool_names }`.

- [ ] **Step 2: Write tests**

`tests/unit/agents-md-2e.test.js`:

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentsMdContent } from '../../src/install/agents-md.js';

test('agentsMdContent renders three sub-blocks inside one fence', () => {
  const md = agentsMdContent({ integrations: [
    { name: 'gmail', cadence_ms: 900_000, kind: 'sync', tool_names: ['gmail_search'] },
    { name: 'discord', cadence_ms: null, kind: 'gateway', tool_names: [] },
    { name: 'github_write', cadence_ms: null, kind: 'tool-only', tool_names: ['github_write'] },
  ] });
  assert.match(md, /<!-- robin-integrations:start/);
  assert.match(md, /<!-- robin-integrations:end -->/);
  assert.match(md, /## Integration data freshness/);
  assert.match(md, /## Outbound writes \(github_write\)/);
  assert.match(md, /## Available integrations/);
  assert.match(md, /gmail \(15m\): gmail_search/);
  assert.match(md, /discord \(gateway\)/);
  assert.match(md, /github_write \(tool-only\): github_write/);
});

test('outbound-writes section warns against bypass', () => {
  const md = agentsMdContent({ integrations: [] });
  assert.match(md, /DON'T retry by paraphrasing/);
  assert.match(md, /outbound_blocked/);
});
```

Update `tests/unit/agents-md-integrations.test.js` (from 2d) — change `integrations` array elements to include `kind` field:

```js
{ name: 'gmail', cadence_ms: 900_000, kind: 'sync', tool_names: ['gmail_search'] },
```

- [ ] **Step 3: Run + lint + commit**

```bash
npm test -- tests/unit/agents-md-2e.test.js tests/unit/agents-md-integrations.test.js
npm run lint
git add src/install/agents-md.js tests/unit/agents-md-*.test.js
git commit -m "feat(install): AGENTS.md three-sub-block structure with outbound-writes caveat"
```

---

## Task 9: Integration tests

**Files:**
- Create: `tests/integration/secrets-import-roundtrip.test.js`
- Create: `tests/integration/google-shared-oauth.test.js`
- Create: `tests/integration/calendar-rolling-window.test.js`
- Create: `tests/integration/youtube-three-kinds.test.js`
- Create: `tests/integration/github-write-roundtrip.test.js`

- [ ] **Step 1: secrets-import-roundtrip**

```js
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

let tmpHome;
test.beforeEach(() => {
  tmpHome = join(tmpdir(), `robin-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpHome, { recursive: true });
  process.env.ROBIN_HOME = tmpHome;
});
test.afterEach(() => { rmSync(tmpHome, { recursive: true, force: true }); });

test('write fake v1 .env, run import, requireSecret reads keys', async () => {
  const v1 = join(tmpHome, 'v1');
  mkdirSync(join(v1, 'runtime', 'secrets'), { recursive: true });
  writeFileSync(join(v1, 'runtime', 'secrets', '.env'), 'GMAIL_TOKEN=abc\nGITHUB_PAT=ghp_xyz\n', 'utf-8');
  const { secretsImport } = await import('../../src/cli/commands/secrets-import.js?cb=' + Date.now());
  await secretsImport(['--from', v1]);
  const { requireSecret } = await import('../../src/secrets/dotenv-io.js?cb=' + Date.now());
  assert.equal(requireSecret('GMAIL_TOKEN'), 'abc');
  assert.equal(requireSecret('GITHUB_PAT'), 'ghp_xyz');
});
```

- [ ] **Step 2-5: Other integration tests**

Each follows the Phase 2d integration test pattern (mem:// + mocked fetch). Detail:

`google-shared-oauth.test.js` — three sync calls (gmail, calendar, drive) hit one mocked Google token endpoint; assert single token-fetch via `_resetCache()` then verify the cache singleton dedupes.

`calendar-rolling-window.test.js` — first sync without cursor; second sync with cursor; assert delta picks up only updated events.

`youtube-three-kinds.test.js` — single sync produces sub/playlist/liked event kinds with correct external_id prefixes.

`github-write-roundtrip.test.js` — create-issue policy passes → events row written; comment with PII blocked → outbound_refusals row; label → no event captured.

- [ ] **Step 3: Run + lint + commit**

```bash
npm test
npm run lint
git add tests/integration/
git commit -m "test(2e): integration coverage for secrets, oauth cache, calendar, youtube, github-write"
```

---

## Task 10: CHANGELOG + tag v6.0.0-alpha.6

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Prepend entry**

```markdown
## [6.0.0-alpha.6] — 2026-05-09

Phase 2e: .env secrets layer + Calendar/Drive/YouTube + github_write.

- **Secrets layer rework:** Phase 2d's per-integration JSON files at `~/.robin/secrets/<name>.json` replaced with a single `${ROBIN_HOME}/secrets/.env`. Lazy `requireSecret(key)` reads, atomic write-temp-then-rename for `saveSecret` and `importFrom`. No `process.env` pollution. Each manifest declares `secrets.env_keys: [...]`.
- **`robin secrets import --from <path>`** copies v1's `user-data/runtime/secrets/.env` into v2's location with 0600 perms. **Required upgrade step from 2d.** Plus `robin secrets list` (key names only, never values) and `robin secrets set <KEY>` (interactive, no echo).
- **3 new sync integrations** all reusing `GOOGLE_OAUTH_*` env keys via a `google-token-cache.js` singleton (refresh-promise dedup):
  - `google_calendar` (30m, ±14d window, upsert)
  - `google_drive` (4h, 30d/200-cap first sync, upsert)
  - `youtube` (24h, three-kind capture: sub/playlist/liked, insert-or-skip)
- **`github_write` tool-only integration** — third manifest kind alongside sync and gateway. 4 actions (create-issue, comment, label, mark-read). Text actions through outbound-policy; non-text skip. create-issue and comment captures audit events to the events table; label and mark-read are daemon-log only.
- **7 new MCP tools** (31 total daemon surface): `calendar_list_events`, `calendar_get_event`, `drive_search`, `drive_get_file`, `youtube_list_subscriptions`, `youtube_list_liked`, `github_write`. `integration_run` gains `tool_only_no_sync` refusal reason.
- **Removed:** `auth gmail/lunch_money/discord` CLIs and `_auth/secrets-io.js`. OAuth loopback helper retained for 2f's headless flow.
- **AGENTS.md** restructured into three regenerable sub-blocks: Integration data freshness, Outbound writes (github_write), Available integrations.
- **Daemon boot warning** if `${ROBIN_HOME}/secrets/.env` is missing.

Phase 2f candidates: spotify-write, headless OAuth `--code` flag, rate limiter, remaining v1 integrations (weather, ebird, chrome, whoop, lrc, linear, nhl, photos, ga).
```

- [ ] **Step 2: Commit + tag**

```bash
git add CHANGELOG.md
git commit -m "chore(2e): CHANGELOG for v6.0.0-alpha.6"
git tag v6.0.0-alpha.6
git tag -l 'v6.0.0-alpha*'
```

Expected: tag landed.

---

## Spec coverage cross-check

| Spec section | Tasks |
|---|---|
| 1. Scope | All tasks |
| 2. Secrets layer | Tasks 0, 1 |
| 3. Calendar / Drive / YouTube | Tasks 2, 3, 4, 5 |
| 4. github_write + tool-only kind | Task 6 |
| 5. CLI + MCP + AGENTS.md | Tasks 0, 7, 8 |
| 6. Testing | All tasks (TDD) + Task 9 |
| Daemon wiring | Task 7 |
| CHANGELOG + tag | Task 10 |

11 tasks total (0-10). Plan covers all spec requirements.
