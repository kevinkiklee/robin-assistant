# Robin v2 Phase 2d — Integrations Framework + Gmail + Lunch Money + Discord Bot

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Build the integrations framework (manifest + sync + capture + outbound policy + auth helpers), three reference integrations (Gmail, Lunch Money, Discord bot), 5 new MCP tools, 4 CLI commands, and migration 0006.

**Architecture:** Each integration is a directory under `src/integrations/<name>/` exporting a `manifest.js`, a `sync.js` (or `start.js`/`stop.js` for gateway), and tool factories. Daemon discovers manifests at boot, registers cursors in `runtime:scheduler.integrations.<name>`, and the Phase 2c heartbeat tick fires past-due syncs through a shared `runIntegrationSync(name, { manual })` helper. Bot lives in-process inside the daemon. Outbound writes (Discord replies) flow through a ported `outbound-policy.js` (PII / secrets / untrusted-quote guard).

**Tech Stack:** Node ≥ 22, ES modules, surrealdb@^2, @surrealdb/node@^3, @huggingface/transformers, @modelcontextprotocol/sdk, discord.js@^14 (new dep), claude/gemini subprocess for LLM. node --test, Biome.

**Spec:** `/Users/iser/workspace/robin/robin-assistant/docs/superpowers/specs/2026-05-09-robin-v2-phase-2d-design.md` is the source of truth.

---

## File structure

```
robin-assistant-v2/
  src/
    schema/migrations/
      0006-integrations.surql                 # NEW
    outbound/
      policy.js                               # NEW (PII/secret/untrusted-quote guard)
      patterns.js                             # NEW (regex constants)
    integrations/
      _framework/
        manifest-loader.js                    # NEW
        cadence.js                            # NEW (parser)
        capture.js                            # NEW (ctx.capture helper)
        run-sync.js                           # NEW (runIntegrationSync shared helper)
        boot-cleanup.js                       # NEW (in_flight reset on boot)
      _auth/
        oauth2-google.js                      # NEW
        api-key.js                            # NEW
        discord-bot.js                        # NEW
        secrets-io.js                         # NEW (read/write ~/.robin/secrets/<name>.json with 0600)
      gmail/
        manifest.js                           # NEW
        sync.js                               # NEW
        client.js                             # NEW (Gmail REST helpers)
        tools/
          gmail-search.js                     # NEW
          gmail-get-thread.js                 # NEW
      lunch_money/
        manifest.js                           # NEW
        sync.js                               # NEW
        client.js                             # NEW
        tools/
          lunch-money-query.js                # NEW
      discord/
        manifest.js                           # NEW
        start.js                              # NEW (gateway lifecycle)
        stop.js                               # NEW
        dispatcher.js                         # NEW (allowlist + routing)
        reply.js                              # NEW (LLM call + outbound-policy)
        commands.js                           # NEW (slash command registration)
    daemon/
      scheduler.js                            # MODIFY (per-integration cursors)
      server.js                               # MODIFY (load integrations, wire bot, integration tools)
    mcp/tools/
      integration-status.js                   # NEW
      integration-run.js                      # NEW
    cli/commands/
      auth-gmail.js                           # NEW
      auth-lunch-money.js                     # NEW
      auth-discord.js                         # NEW
      integrations-list.js                    # NEW
      integrations-status.js                  # NEW
      integrations-run.js                     # NEW
      integrations-discord-register.js        # NEW
    cli/index.js                              # MODIFY
    install/agents-md.js                      # MODIFY (regen-fence for integrations)
  tests/
    unit/
      cadence-parser.test.js                  # NEW
      manifest-loader.test.js                 # NEW
      outbound-policy.test.js                 # NEW
      capture-helper.test.js                  # NEW
      run-sync-helper.test.js                 # NEW
      boot-cleanup.test.js                    # NEW
      auth-oauth2-google.test.js              # NEW
      auth-api-key.test.js                    # NEW
      auth-discord-bot.test.js                # NEW
      gmail-sync.test.js                      # NEW
      gmail-tools.test.js                     # NEW
      lunch-money-sync.test.js                # NEW
      lunch-money-tool.test.js                # NEW
      discord-dispatcher.test.js              # NEW
      discord-reply.test.js                   # NEW
      tool-integration-status.test.js         # NEW
      tool-integration-run.test.js            # NEW
      agents-md-integrations.test.js          # NEW
    integration/
      gmail-full-sync.test.js                 # NEW
      lunch-money-rolling-window.test.js      # NEW
      discord-allowlist.test.js               # NEW
      scheduler-multi-integration.test.js     # NEW
      integration-run-roundtrip.test.js       # NEW
      backoff-isolation.test.js               # NEW
    fixtures/
      discord-events.js                       # NEW (fake Message/Interaction shapes)
```

---

## Task 0: Schema migration 0006

**Files:**
- Create: `src/schema/migrations/0006-integrations.surql`
- Modify: `tests/integration/bootstrap-empty-db.test.js`

- [ ] **Step 1: Write migration file**

Content for `src/schema/migrations/0006-integrations.surql`:

```surql
-- Phase 2d: integrations framework + outbound policy

DEFINE FIELD external_id ON events TYPE option<string>;
DEFINE INDEX events_source_external ON events FIELDS source, external_id UNIQUE;

DEFINE FIELD trust ON events TYPE string DEFAULT 'trusted'
  ASSERT $value IN ['trusted', 'untrusted', 'untrusted-mixed'];

REMOVE FIELD embedding ON events;
DEFINE FIELD embedding ON events TYPE option<array<float>>
  ASSERT $value IS NONE OR array::len($value) = 384;

DEFINE TABLE outbound_refusals SCHEMAFULL TYPE NORMAL;
DEFINE FIELD destination ON outbound_refusals TYPE string;
DEFINE FIELD reason      ON outbound_refusals TYPE string;
DEFINE FIELD payload_hash ON outbound_refusals TYPE string;
DEFINE FIELD created_at  ON outbound_refusals TYPE datetime DEFAULT time::now() READONLY;
DEFINE INDEX outbound_refusals_created ON outbound_refusals FIELDS created_at;
```

- [ ] **Step 2: Verify all 6 migrations parse sequentially**

```bash
cd /Users/iser/workspace/robin/robin-assistant-v2
node -e "
import('./src/db/client.js').then(async ({connect, close}) => {
  const { readdir, readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const dir = 'src/schema/migrations';
  const files = (await readdir(dir)).filter(f => f.endsWith('.surql')).sort();
  const db = await connect({ engine: 'mem://' });
  for (const f of files) {
    await db.query(await readFile(join(dir, f), 'utf8')).collect();
    console.log('OK', f);
  }
  await close(db);
  process.exit(0);
});
"
```

Expected: prints OK for all 6 migrations.

- [ ] **Step 3: Update bootstrap test**

In `tests/integration/bootstrap-empty-db.test.js`, change `applied 5 migrations` → `applied 6 migrations`.

- [ ] **Step 4: Run full suite to verify the embedding relaxation didn't break Phase 2c tests**

```bash
npm test
```

Expected: 251 tests still pass.

- [ ] **Step 5: Commit**

```bash
git add src/schema/migrations/0006-integrations.surql tests/integration/bootstrap-empty-db.test.js
git commit -m "feat(schema): 0006-integrations — events.external_id UNIQUE, trust marker, relaxed embedding, outbound_refusals"
```

---

## Task 1: Cadence parser + manifest loader

**Files:**
- Create: `src/integrations/_framework/cadence.js`
- Create: `src/integrations/_framework/manifest-loader.js`
- Create: `tests/unit/cadence-parser.test.js`
- Create: `tests/unit/manifest-loader.test.js`

- [ ] **Step 1: Write cadence parser tests**

`tests/unit/cadence-parser.test.js`:

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCadence } from '../../src/integrations/_framework/cadence.js';

test('parseCadence "15m" → 900_000', () => assert.equal(parseCadence('15m'), 900_000));
test('parseCadence "1h" → 3_600_000', () => assert.equal(parseCadence('1h'), 3_600_000));
test('parseCadence "1d" → 86_400_000', () => assert.equal(parseCadence('1d'), 86_400_000));
test('parseCadence raw integer ms', () => assert.equal(parseCadence(60_000), 60_000));
test('parseCadence rejects compound forms', () => assert.throws(() => parseCadence('15m30s')));
test('parseCadence rejects negative', () => assert.throws(() => parseCadence('-5m')));
test('parseCadence rejects zero', () => assert.throws(() => parseCadence(0)));
test('parseCadence rejects null/undefined', () => {
  assert.throws(() => parseCadence(null));
  assert.throws(() => parseCadence(undefined));
});
test('parseCadence rejects non-numeric strings', () => assert.throws(() => parseCadence('abc')));
```

- [ ] **Step 2: Write `src/integrations/_framework/cadence.js`**

```js
const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000 };

export function parseCadence(input) {
  if (input === null || input === undefined) {
    throw new Error('cadence required');
  }
  if (typeof input === 'number') {
    if (!Number.isInteger(input) || input <= 0) {
      throw new Error(`cadence must be a positive integer in ms; got ${input}`);
    }
    return input;
  }
  if (typeof input !== 'string') {
    throw new Error(`cadence must be string or integer ms; got ${typeof input}`);
  }
  const match = /^(\d+)([mhd])$/.exec(input);
  if (!match) {
    throw new Error(`invalid cadence: ${input} (accepted: <n>m, <n>h, <n>d, or integer ms)`);
  }
  const n = Number.parseInt(match[1], 10);
  if (n <= 0) throw new Error(`cadence must be positive; got ${input}`);
  return n * UNIT_MS[match[2]];
}
```

- [ ] **Step 3: Run cadence tests**

```bash
npm test -- tests/unit/cadence-parser.test.js
```

Expected: 9 pass.

- [ ] **Step 4: Write manifest-loader tests**

`tests/unit/manifest-loader.test.js`:

```js
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { loadManifests, validateManifest } from '../../src/integrations/_framework/manifest-loader.js';

test('validateManifest accepts valid scheduled manifest', () => {
  const m = {
    name: 'gmail',
    cadence: '15m',
    embed: true,
    capture_mode: 'insert-or-skip',
    auth: { kind: 'oauth2-google', scopes: [] },
    tools: [],
  };
  const r = validateManifest(m);
  assert.equal(r.name, 'gmail');
  assert.equal(r.cadence_ms, 900_000);
});

test('validateManifest accepts gateway manifest with cadence: null', () => {
  const m = {
    name: 'discord',
    cadence: null,
    embed: false,
    auth: { kind: 'discord-bot' },
    tools: [],
  };
  const r = validateManifest(m);
  assert.equal(r.cadence_ms, null);
});

test('validateManifest rejects missing name', () => {
  assert.throws(() => validateManifest({ cadence: '15m', auth: {}, tools: [] }));
});

test('validateManifest rejects unknown auth.kind', () => {
  assert.throws(() => validateManifest({
    name: 'x', cadence: '15m', auth: { kind: 'magic' }, tools: [],
  }));
});

test('validateManifest defaults capture_mode to insert-or-skip', () => {
  const m = { name: 'x', cadence: '1h', embed: true, auth: { kind: 'api-key' }, tools: [] };
  const r = validateManifest(m);
  assert.equal(r.capture_mode, 'insert-or-skip');
});

test('loadManifests skips broken manifest, loads good ones', async () => {
  // Use real integrations dir; create a tmp dir with one bad + one good manifest
  // Real test would mock the file system or use a fixtures dir
  // For now, just call against the real integrations dir and assert no throw
  const integrationsDir = resolve(import.meta.dirname, '../../src/integrations');
  const manifests = await loadManifests(integrationsDir);
  assert.ok(Array.isArray(manifests));
});
```

- [ ] **Step 5: Write `src/integrations/_framework/manifest-loader.js`**

```js
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parseCadence } from './cadence.js';

const VALID_AUTH_KINDS = new Set(['oauth2-google', 'api-key', 'discord-bot']);
const VALID_CAPTURE_MODES = new Set(['insert-or-skip', 'upsert']);

export function validateManifest(m) {
  if (!m || typeof m !== 'object') throw new Error('manifest must be an object');
  if (!m.name || typeof m.name !== 'string') throw new Error('manifest.name required (string)');
  if (m.cadence !== null && m.cadence !== undefined) {
    var cadence_ms = parseCadence(m.cadence);
  } else {
    var cadence_ms = null;
  }
  if (!m.auth || !VALID_AUTH_KINDS.has(m.auth.kind)) {
    throw new Error(`manifest.auth.kind must be one of: ${[...VALID_AUTH_KINDS].join(', ')}`);
  }
  const capture_mode = m.capture_mode ?? 'insert-or-skip';
  if (!VALID_CAPTURE_MODES.has(capture_mode)) {
    throw new Error(`manifest.capture_mode must be one of: ${[...VALID_CAPTURE_MODES].join(', ')}`);
  }
  return {
    name: m.name,
    cadence_ms,
    embed: m.embed ?? true,
    capture_mode,
    auth: m.auth,
    tools: m.tools ?? [],
    config: m.config ?? {},
  };
}

export async function loadManifests(integrationsDir) {
  let entries;
  try {
    entries = await readdir(integrationsDir, { withFileTypes: true });
  } catch { return []; }
  const out = [];
  for (const ent of entries) {
    if (!ent.isDirectory() || ent.name.startsWith('_')) continue;
    const manifestPath = join(integrationsDir, ent.name, 'manifest.js');
    try {
      const mod = await import(manifestPath);
      const validated = validateManifest(mod.manifest ?? mod.default);
      out.push(validated);
    } catch (e) {
      console.warn(`integration ${ent.name}: ${e.message}`);
    }
  }
  return out;
}
```

- [ ] **Step 6: Run manifest tests + lint + commit**

```bash
npm test -- tests/unit/cadence-parser.test.js tests/unit/manifest-loader.test.js
npm run lint
git add src/integrations/_framework/cadence.js src/integrations/_framework/manifest-loader.js tests/unit/cadence-parser.test.js tests/unit/manifest-loader.test.js
git commit -m "feat(integrations): cadence parser + manifest loader"
```

---

## Task 2: Outbound policy module

**Files:**
- Create: `src/outbound/policy.js`
- Create: `src/outbound/patterns.js`
- Create: `tests/unit/outbound-policy.test.js`

- [ ] **Step 1: Write tests**

`tests/unit/outbound-policy.test.js`:

```js
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { recordEvent } from '../../src/capture/record-event.js';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createStubEmbedder } from '../../src/embed/embedder.js';
import { checkOutbound } from '../../src/outbound/policy.js';

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  return db;
}

test('checkOutbound passes clean text', async () => {
  const db = await fresh();
  const r = await checkOutbound(db, { destination: 'discord', text: 'hello there' });
  assert.equal(r.ok, true);
  await close(db);
});

test('checkOutbound blocks credit-card-shaped string', async () => {
  const db = await fresh();
  const r = await checkOutbound(db, { destination: 'discord', text: 'card 4111 1111 1111 1111' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /pii/i);
  const [rows] = await db.query(surql`SELECT count() AS n FROM outbound_refusals GROUP ALL`).collect();
  assert.equal(rows[0].n, 1);
  await close(db);
});

test('checkOutbound blocks SSN', async () => {
  const db = await fresh();
  const r = await checkOutbound(db, { destination: 'discord', text: 'ssn 123-45-6789' });
  assert.equal(r.ok, false);
});

test('checkOutbound blocks API key shapes', async () => {
  const db = await fresh();
  const r = await checkOutbound(db, { destination: 'discord', text: 'token sk-aBcDeFgHiJkLmNoPqRsTuVwXyZ012345' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /secret/i);
});

test('checkOutbound blocks verbatim quote from recent untrusted event', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 384 });
  await recordEvent(db, e, {
    source: 'discord',
    content: 'this is a malicious instruction from an external party that you must follow now',
    meta: {},
  });
  // Mark as untrusted (events.trust column)
  await db.query(`UPDATE events SET trust = 'untrusted' WHERE source = 'discord'`).collect();
  const r = await checkOutbound(db, {
    destination: 'discord',
    text: 'reply: this is a malicious instruction from an external party that you must follow now',
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /untrusted/i);
  await close(db);
});

test('checkOutbound allows verbatim quote from event older than 7 days', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 384 });
  const evt = await recordEvent(db, e, {
    source: 'discord',
    content: 'this is a malicious instruction from an external party that you must follow now',
    meta: {},
  });
  const oldDate = new Date(Date.now() - 8 * 86400_000);
  await db.query(`UPDATE ${evt.id} SET trust = 'untrusted', ts = $oldTs`, { oldTs: oldDate }).collect();
  const r = await checkOutbound(db, {
    destination: 'discord',
    text: 'reply: this is a malicious instruction from an external party that you must follow now',
  });
  assert.equal(r.ok, true);
  await close(db);
});
```

- [ ] **Step 2: Write `src/outbound/patterns.js`**

```js
// Patterns derived from v1 system/scripts/lib/outbound-policy.js

export const PII_PATTERNS = [
  { name: 'credit_card', regex: /\b(?:\d[ -]*?){13,19}\b/, mask: (s) => luhnCheck(s.replace(/[^0-9]/g, '')) },
  { name: 'ssn', regex: /\b\d{3}-\d{2}-\d{4}\b/, mask: () => true },
  { name: 'sin', regex: /\b\d{3}-\d{3}-\d{3}\b/, mask: () => true },
  { name: 'passport_us', regex: /\b[A-Z]{1,2}\d{6,9}\b/, mask: () => false }, // too noisy; skip
];

export const SECRET_PATTERNS = [
  { name: 'openai_key', regex: /\bsk-[A-Za-z0-9]{32,}\b/ },
  { name: 'anthropic_key', regex: /\bsk-ant-[A-Za-z0-9-_]{32,}\b/ },
  { name: 'github_token', regex: /\bgh[ps]_[A-Za-z0-9]{36,}\b/ },
  { name: 'aws_access_key', regex: /\bAKIA[A-Z0-9]{16}\b/ },
  { name: 'env_secret_value', regex: /\b(?:[A-Z_]{4,})\s*=\s*[A-Za-z0-9+/]{20,}\b/ },
];

function luhnCheck(digits) {
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = Number.parseInt(digits[i], 10);
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}
```

- [ ] **Step 3: Write `src/outbound/policy.js`**

```js
import { createHash } from 'node:crypto';
import { surql } from 'surrealdb';
import { PII_PATTERNS, SECRET_PATTERNS } from './patterns.js';

const UNTRUSTED_LOOKBACK_DAYS = 7;
const MIN_QUOTE_WORDS = 10;

function tokenize(text) {
  return text.toLowerCase().split(/\s+/).filter(Boolean);
}

function containsVerbatim(replyText, sourceText, minWords = MIN_QUOTE_WORDS) {
  const reply = tokenize(replyText);
  const source = tokenize(sourceText);
  if (source.length < minWords) return false;
  for (let i = 0; i + minWords <= source.length; i++) {
    const window = source.slice(i, i + minWords).join(' ');
    if (reply.join(' ').includes(window)) return true;
  }
  return false;
}

async function logRefusal(db, destination, reason, payload) {
  const payload_hash = createHash('sha256').update(payload).digest('hex').slice(0, 16);
  await db.query(surql`CREATE outbound_refusals CONTENT ${{ destination, reason, payload_hash }}`).collect();
}

export async function checkOutbound(db, { destination, text }) {
  for (const p of PII_PATTERNS) {
    const m = p.regex.exec(text);
    if (m && (!p.mask || p.mask(m[0]))) {
      await logRefusal(db, destination, `pii:${p.name}`, text);
      return { ok: false, reason: `pii:${p.name}` };
    }
  }
  for (const p of SECRET_PATTERNS) {
    if (p.regex.test(text)) {
      await logRefusal(db, destination, `secret:${p.name}`, text);
      return { ok: false, reason: `secret:${p.name}` };
    }
  }
  const cutoff = new Date(Date.now() - UNTRUSTED_LOOKBACK_DAYS * 86400_000);
  const [rows] = await db
    .query(surql`SELECT content FROM events WHERE trust IN ['untrusted', 'untrusted-mixed'] AND ts >= ${cutoff}`)
    .collect();
  for (const r of rows) {
    if (containsVerbatim(text, r.content)) {
      await logRefusal(db, destination, 'untrusted_quote', text);
      return { ok: false, reason: 'untrusted_quote' };
    }
  }
  return { ok: true };
}
```

- [ ] **Step 4: Run tests + lint + commit**

```bash
npm test -- tests/unit/outbound-policy.test.js
npm run lint
git add src/outbound/ tests/unit/outbound-policy.test.js
git commit -m "feat(outbound): policy module — PII + secret + untrusted-quote guards"
```

---

## Task 3: Capture API helper + boot cleanup

**Files:**
- Create: `src/integrations/_framework/capture.js`
- Create: `src/integrations/_framework/boot-cleanup.js`
- Create: `tests/unit/capture-helper.test.js`
- Create: `tests/unit/boot-cleanup.test.js`

- [ ] **Step 1: Write `src/integrations/_framework/capture.js`**

```js
import { surql } from 'surrealdb';

function sanitizeIdPart(s) {
  return /^[a-zA-Z0-9_-]+$/.test(s)
    ? s
    : `h_${Buffer.from(s).toString('hex').slice(0, 16)}`;
}

function deterministicId(source, external_id) {
  return `${source}__${sanitizeIdPart(external_id)}`;
}

export function createCapture({ db, embedder, source, embed, mode }) {
  return async function capture(rows) {
    const result = { inserted: 0, skipped: 0, updated: 0, errors: [] };
    for (const row of rows) {
      try {
        const idKey = deterministicId(row.source ?? source, row.external_id);
        let embedding = null;
        if (embed) {
          try {
            embedding = Array.from(await embedder.embed(row.content));
          } catch (e) {
            console.warn(`capture: embedding failed for ${idKey}, writing NULL: ${e.message}`);
          }
        }
        const fields = {
          source: row.source ?? source,
          content: row.content,
          ts: row.ts ?? new Date(),
          external_id: row.external_id,
          trust: row.trust ?? 'trusted',
          meta: row.meta ?? {},
          ...(embedding ? { embedding } : {}),
        };
        if (mode === 'upsert') {
          await db.query(surql`UPSERT type::record('events', ${idKey}) MERGE ${fields}`).collect();
          result.updated += 1;
        } else {
          const [exists] = await db
            .query(surql`SELECT id FROM type::record('events', ${idKey})`)
            .collect();
          if (exists.length > 0) {
            result.skipped += 1;
            continue;
          }
          await db.query(surql`CREATE type::record('events', ${idKey}) CONTENT ${fields}`).collect();
          result.inserted += 1;
        }
      } catch (e) {
        result.errors.push({ external_id: row.external_id, error: e.message });
      }
    }
    return result;
  };
}
```

- [ ] **Step 2: Write `src/integrations/_framework/boot-cleanup.js`**

```js
import { surql } from 'surrealdb';

export async function resetInFlightFlags(db) {
  await db
    .query(surql`UPSERT type::record('runtime', 'scheduler')
      MERGE { value: { _boot_cleanup_at: time::now() } }`)
    .collect();
  const [rows] = await db
    .query(surql`SELECT * FROM type::record('runtime', 'scheduler')`)
    .collect();
  if (!rows[0]) return { reset: 0 };
  const value = rows[0].value ?? {};
  const integrations = value.integrations ?? {};
  let reset = 0;
  for (const name of Object.keys(integrations)) {
    if (integrations[name].in_flight) {
      integrations[name].in_flight = false;
      integrations[name].last_sync_error = (integrations[name].last_sync_error ?? '')
        + ' [boot-reset: in_flight cleared]';
      reset += 1;
    }
  }
  if (reset > 0) {
    await db
      .query(surql`UPDATE type::record('runtime', 'scheduler') SET value.integrations = ${integrations}`)
      .collect();
  }
  return { reset };
}
```

- [ ] **Step 3: Write tests + run + commit**

`tests/unit/capture-helper.test.js`:

```js
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createStubEmbedder } from '../../src/embed/embedder.js';
import { createCapture } from '../../src/integrations/_framework/capture.js';

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  return db;
}

test('capture inserts new rows with deterministic IDs', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 384 });
  const capture = createCapture({ db, embedder: e, source: 'gmail', embed: true, mode: 'insert-or-skip' });
  const r = await capture([
    { source: 'gmail', content: 'Subject: hi', external_id: 'abc123', meta: { thread_id: 't1' } },
  ]);
  assert.equal(r.inserted, 1);
  const [rows] = await db.query(surql`SELECT id, external_id FROM events`).collect();
  assert.equal(rows.length, 1);
  assert.equal(String(rows[0].id), 'events:gmail__abc123');
  assert.equal(rows[0].external_id, 'abc123');
  await close(db);
});

test('capture insert-or-skip dedupes on second call', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 384 });
  const capture = createCapture({ db, embedder: e, source: 'gmail', embed: true, mode: 'insert-or-skip' });
  await capture([{ source: 'gmail', content: 'a', external_id: 'x' }]);
  const r = await capture([{ source: 'gmail', content: 'a', external_id: 'x' }]);
  assert.equal(r.skipped, 1);
  assert.equal(r.inserted, 0);
  await close(db);
});

test('capture upsert updates existing row', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 384 });
  const capture = createCapture({ db, embedder: e, source: 'lunch_money', embed: true, mode: 'upsert' });
  await capture([{ source: 'lunch_money', content: 'orig', external_id: 'lm1' }]);
  await capture([{ source: 'lunch_money', content: 'edited', external_id: 'lm1' }]);
  const [rows] = await db.query(surql`SELECT content FROM events WHERE external_id = 'lm1'`).collect();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].content, 'edited');
  await close(db);
});

test('capture with embed:false writes NULL embedding', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 384 });
  const capture = createCapture({ db, embedder: e, source: 'discord', embed: false, mode: 'insert-or-skip' });
  await capture([{ source: 'discord', content: 'msg', external_id: 'd1' }]);
  const [rows] = await db.query(surql`SELECT embedding FROM events WHERE external_id = 'd1'`).collect();
  assert.equal(rows[0].embedding, null);
  await close(db);
});

test('capture sanitizes special-char external_id', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 384 });
  const capture = createCapture({ db, embedder: e, source: 'x', embed: true, mode: 'insert-or-skip' });
  const r = await capture([{ source: 'x', content: 'c', external_id: 'foo/bar:baz' }]);
  assert.equal(r.inserted, 1);
  await close(db);
});
```

`tests/unit/boot-cleanup.test.js`:

```js
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { resetInFlightFlags } from '../../src/integrations/_framework/boot-cleanup.js';

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  return db;
}

test('resetInFlightFlags clears stale in_flight: true rows', async () => {
  const db = await fresh();
  await db.query(surql`UPSERT type::record('runtime', 'scheduler') SET value = ${{
    integrations: {
      gmail: { in_flight: true, last_sync_at: new Date() },
      lunch_money: { in_flight: false },
    },
  }}`).collect();
  const r = await resetInFlightFlags(db);
  assert.equal(r.reset, 1);
  const [rows] = await db.query(surql`SELECT value FROM type::record('runtime', 'scheduler')`).collect();
  assert.equal(rows[0].value.integrations.gmail.in_flight, false);
  await close(db);
});

test('resetInFlightFlags is no-op on empty integrations', async () => {
  const db = await fresh();
  const r = await resetInFlightFlags(db);
  assert.equal(r.reset, 0);
  await close(db);
});
```

- [ ] **Step 4: Run + lint + commit**

```bash
npm test -- tests/unit/capture-helper.test.js tests/unit/boot-cleanup.test.js
npm run lint
git add src/integrations/_framework/capture.js src/integrations/_framework/boot-cleanup.js tests/unit/capture-helper.test.js tests/unit/boot-cleanup.test.js
git commit -m "feat(integrations): capture helper + boot in_flight cleanup"
```

---

## Task 4: Shared sync helper + scheduler extension

**Files:**
- Create: `src/integrations/_framework/run-sync.js`
- Modify: `src/daemon/scheduler.js` (per-integration cursors)
- Create: `tests/unit/run-sync-helper.test.js`
- Modify: `tests/unit/scheduler-heartbeat.test.js` (back-compat)

- [ ] **Step 1: Write `src/integrations/_framework/run-sync.js`**

```js
import { surql } from 'surrealdb';

const BACKOFF_THRESHOLD = 3;
const BACKOFF_MAX_MS = 24 * 3_600_000;

async function readIntegrationRow(db, name) {
  const [rows] = await db.query(surql`SELECT value FROM type::record('runtime', 'scheduler')`).collect();
  return (rows[0]?.value?.integrations ?? {})[name] ?? null;
}

async function writeIntegrationRow(db, name, fields) {
  const cur = await readIntegrationRow(db, name) ?? {};
  const next = { ...cur, ...fields };
  await db
    .query(surql`UPSERT type::record('runtime', 'scheduler')
      MERGE { value: { integrations: { ${name}: ${next} } } }`)
    .collect();
}

function effectiveCadenceMs(row) {
  const base = row.cadence_ms;
  const failures = row.consecutive_failures ?? 0;
  if (failures < BACKOFF_THRESHOLD) return base;
  const multiplier = Math.pow(2, failures - BACKOFF_THRESHOLD + 1);
  return Math.min(base * multiplier, BACKOFF_MAX_MS);
}

export async function runIntegrationSync(db, registry, name, { manual = false } = {}) {
  const cur = await readIntegrationRow(db, name);
  if (!cur) throw new Error(`integration not registered: ${name}`);
  if (cur.in_flight) {
    return { ok: false, reason: 'in_flight', started_at: cur.in_flight_started_at };
  }
  const integration = registry.get(name);
  if (!integration) throw new Error(`integration manifest not loaded: ${name}`);
  if (integration.cadence_ms === null) {
    return { ok: false, reason: 'gateway_no_sync' };
  }

  await writeIntegrationRow(db, name, {
    in_flight: true,
    in_flight_started_at: new Date(),
  });

  const trigger = manual ? 'manual sync started by tool' : 'scheduled tick fired sync';
  console.log(`[integrations:${name}] ${trigger}`);

  const ctrl = new AbortController();
  const startMs = Date.now();
  try {
    const ctx = {
      secrets: integration.secrets,
      log: (...args) => console.log(`[integrations:${name}]`, ...args),
      cursor: cur.cursor ?? null,
      capture: integration.capture,
      signal: ctrl.signal,
    };
    const result = await integration.sync(ctx);
    const durationMs = Date.now() - startMs;
    await writeIntegrationRow(db, name, {
      in_flight: false,
      in_flight_started_at: null,
      last_sync_at: new Date(),
      last_sync_ok: true,
      last_sync_error: null,
      last_sync_count: result?.count ?? 0,
      consecutive_failures: 0,
      cursor: result?.cursor ?? null,
      next_run_at: new Date(Date.now() + cur.cadence_ms),
    });
    return { ok: true, count: result?.count ?? 0, cursor: result?.cursor ?? null, duration_ms: durationMs };
  } catch (e) {
    const failures = manual ? (cur.consecutive_failures ?? 0) : (cur.consecutive_failures ?? 0) + 1;
    const cadence = effectiveCadenceMs({ cadence_ms: cur.cadence_ms, consecutive_failures: failures });
    await writeIntegrationRow(db, name, {
      in_flight: false,
      in_flight_started_at: null,
      last_sync_at: new Date(),
      last_sync_ok: false,
      last_sync_error: e.message,
      consecutive_failures: failures,
      next_run_at: manual ? cur.next_run_at : new Date(Date.now() + cadence),
    });
    return { ok: false, reason: 'sync_error', error: e.message };
  }
}
```

- [ ] **Step 2: Modify `src/daemon/scheduler.js` to support per-integration cursors**

Replace its single-`inFlight` model with delegation: the scheduler now accepts a `runIntegration(name)` callback and a `listDueIntegrations()` callback. The dream wiring stays as a special "integration" with name `__dream__`. New shape:

```js
export function createScheduler({
  listDue,                  // async () => [{ name, kind: 'integration' | 'dream' }]
  runOne,                   // async (name) => void
  isOverflow,
  heartbeatMs = 60_000,
}) {
  let timer = null;
  const inFlight = new Set();

  async function tick() {
    const due = await listDue();
    for (const item of due) {
      if (inFlight.has(item.name)) continue;
      inFlight.add(item.name);
      runOne(item.name).catch(() => {}).finally(() => inFlight.delete(item.name));
    }
    if (inFlight.size === 0 && (await isOverflow())) {
      inFlight.add('__dream__');
      runOne('__dream__').catch(() => {}).finally(() => inFlight.delete('__dream__'));
    }
  }

  function start() {
    if (timer) clearInterval(timer);
    timer = setInterval(() => { tick().catch(() => {}); }, heartbeatMs);
    timer.unref();
    tick().catch(() => {});
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { start, stop };
}
```

- [ ] **Step 3: Update `tests/unit/scheduler-heartbeat.test.js` to the new API**

Read it first. Adapt the 3 tests to use the new `listDue`/`runOne` API. Goal: same assertions, new shape. Patterns:
- "fires runDream when next_run_at past-due" → `listDue` returns `[{ name: '__dream__' }]`; `runOne` increments call count
- "fires on overflow" → `listDue` returns `[]`; `isOverflow` returns true once
- "in-flight doesn't double-run" → tracks per-name; assert single call

- [ ] **Step 4: Write `tests/unit/run-sync-helper.test.js`**

```js
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { runIntegrationSync } from '../../src/integrations/_framework/run-sync.js';

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  return db;
}

async function seedIntegration(db, name, fields = {}) {
  await db.query(surql`UPSERT type::record('runtime', 'scheduler') MERGE { value: {
    integrations: { ${name}: ${{ cadence_ms: 60_000, consecutive_failures: 0, ...fields }} }
  } }`).collect();
}

test('runIntegrationSync success path stamps cursor and clears failures', async () => {
  const db = await fresh();
  await seedIntegration(db, 'gmail', { consecutive_failures: 2 });
  const registry = new Map([['gmail', {
    cadence_ms: 60_000,
    sync: async () => ({ count: 3, cursor: { history_id: 'h1' } }),
  }]]);
  const r = await runIntegrationSync(db, registry, 'gmail');
  assert.equal(r.ok, true);
  assert.equal(r.count, 3);
  const [rows] = await db.query(surql`SELECT value FROM type::record('runtime', 'scheduler')`).collect();
  const row = rows[0].value.integrations.gmail;
  assert.equal(row.consecutive_failures, 0);
  assert.deepEqual(row.cursor, { history_id: 'h1' });
  await close(db);
});

test('runIntegrationSync scheduled failure increments consecutive_failures', async () => {
  const db = await fresh();
  await seedIntegration(db, 'gmail');
  const registry = new Map([['gmail', { cadence_ms: 60_000, sync: async () => { throw new Error('boom'); } }]]);
  await runIntegrationSync(db, registry, 'gmail');
  const [rows] = await db.query(surql`SELECT value FROM type::record('runtime', 'scheduler')`).collect();
  assert.equal(rows[0].value.integrations.gmail.consecutive_failures, 1);
  await close(db);
});

test('runIntegrationSync manual failure does NOT increment consecutive_failures', async () => {
  const db = await fresh();
  await seedIntegration(db, 'gmail', { consecutive_failures: 2 });
  const registry = new Map([['gmail', { cadence_ms: 60_000, sync: async () => { throw new Error('boom'); } }]]);
  await runIntegrationSync(db, registry, 'gmail', { manual: true });
  const [rows] = await db.query(surql`SELECT value FROM type::record('runtime', 'scheduler')`).collect();
  const row = rows[0].value.integrations.gmail;
  assert.equal(row.consecutive_failures, 2);
  assert.equal(row.last_sync_ok, false);
  assert.match(row.last_sync_error, /boom/);
  await close(db);
});

test('runIntegrationSync returns in_flight when concurrent', async () => {
  const db = await fresh();
  await seedIntegration(db, 'gmail', { in_flight: true, in_flight_started_at: new Date() });
  const registry = new Map([['gmail', { cadence_ms: 60_000, sync: async () => ({}) }]]);
  const r = await runIntegrationSync(db, registry, 'gmail');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'in_flight');
  await close(db);
});

test('runIntegrationSync rejects gateway integration', async () => {
  const db = await fresh();
  await seedIntegration(db, 'discord', { cadence_ms: null });
  const registry = new Map([['discord', { cadence_ms: null }]]);
  const r = await runIntegrationSync(db, registry, 'discord');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'gateway_no_sync');
  await close(db);
});
```

- [ ] **Step 5: Run + lint + commit**

```bash
npm test -- tests/unit/run-sync-helper.test.js tests/unit/scheduler-heartbeat.test.js
npm run lint
git add src/integrations/_framework/run-sync.js src/daemon/scheduler.js tests/unit/run-sync-helper.test.js tests/unit/scheduler-heartbeat.test.js
git commit -m "feat(integrations): runIntegrationSync helper + per-integration scheduler"
```

---

## Task 5: Auth helpers (oauth2-google, api-key, discord-bot, secrets-io)

**Files:**
- Create: `src/integrations/_auth/secrets-io.js`
- Create: `src/integrations/_auth/oauth2-google.js`
- Create: `src/integrations/_auth/api-key.js`
- Create: `src/integrations/_auth/discord-bot.js`
- Create: `tests/unit/auth-oauth2-google.test.js`
- Create: `tests/unit/auth-api-key.test.js`
- Create: `tests/unit/auth-discord-bot.test.js`

- [ ] **Step 1: Write `src/integrations/_auth/secrets-io.js`**

```js
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export function secretsDir() {
  return process.env.ROBIN_HOME
    ? join(process.env.ROBIN_HOME, 'secrets')
    : join(homedir(), '.robin', 'secrets');
}

export function secretsPath(name) {
  return join(secretsDir(), `${name}.json`);
}

export async function readSecrets(name) {
  try {
    const text = await readFile(secretsPath(name), 'utf8');
    return JSON.parse(text);
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

export async function writeSecrets(name, data) {
  const path = secretsPath(name);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(data, null, 2), 'utf8');
  await chmod(path, 0o600);
}
```

- [ ] **Step 2: Write `src/integrations/_auth/oauth2-google.js`**

```js
import { createServer } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { writeSecrets } from './secrets-io.js';

const REDIRECT_PORT = 53682;
const REDIRECT_URI = `http://127.0.0.1:${REDIRECT_PORT}/callback`;

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function generatePKCE() {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

export function buildAuthUrl({ client_id, scopes, challenge, state }) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id,
    redirect_uri: REDIRECT_URI,
    scope: scopes.join(' '),
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    access_type: 'offline',
    prompt: 'consent',
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

export async function exchangeCode({ client_id, client_secret, code, verifier, fetchFn = globalThis.fetch }) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id,
    client_secret,
    redirect_uri: REDIRECT_URI,
    code_verifier: verifier,
  });
  const r = await fetchFn('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!r.ok) throw new Error(`token exchange failed: ${r.status} ${await r.text()}`);
  const json = await r.json();
  return {
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    expires_at: Date.now() + (json.expires_in * 1000),
    token_type: json.token_type,
    scope: json.scope,
  };
}

export async function refreshAccessToken({ client_id, client_secret, refresh_token, fetchFn = globalThis.fetch }) {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token,
    client_id,
    client_secret,
  });
  const r = await fetchFn('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!r.ok) throw new Error(`token refresh failed: ${r.status} ${await r.text()}`);
  const json = await r.json();
  return {
    access_token: json.access_token,
    expires_at: Date.now() + (json.expires_in * 1000),
  };
}

export async function ensureFreshToken(name, secrets, deps = {}) {
  if (!secrets.expires_at || secrets.expires_at - Date.now() < 60_000) {
    const fresh = await refreshAccessToken({
      client_id: secrets.client_id,
      client_secret: secrets.client_secret,
      refresh_token: secrets.refresh_token,
      fetchFn: deps.fetchFn,
    });
    const next = { ...secrets, ...fresh };
    await writeSecrets(name, next);
    return next;
  }
  return secrets;
}

export async function runLoopbackAuth({ client_id, client_secret, scopes, openFn, fetchFn }) {
  const { verifier, challenge } = generatePKCE();
  const state = base64url(randomBytes(16));
  const url = buildAuthUrl({ client_id, scopes, challenge, state });

  return await new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const u = new URL(req.url, REDIRECT_URI);
      if (!u.pathname.startsWith('/callback')) {
        res.writeHead(404).end();
        return;
      }
      const code = u.searchParams.get('code');
      const returnedState = u.searchParams.get('state');
      const err = u.searchParams.get('error');
      if (err) {
        res.writeHead(400).end(`Error: ${err}`);
        server.close();
        reject(new Error(err));
        return;
      }
      if (returnedState !== state) {
        res.writeHead(400).end('State mismatch');
        server.close();
        reject(new Error('state mismatch'));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html' }).end('<h1>Auth complete. You can close this tab.</h1>');
      exchangeCode({ client_id, client_secret, code, verifier, fetchFn })
        .then((tokens) => { server.close(); resolve(tokens); })
        .catch((e) => { server.close(); reject(e); });
    });
    server.listen(REDIRECT_PORT, '127.0.0.1', () => {
      console.log(`Open this URL in your browser:\n  ${url}`);
      if (openFn) openFn(url).catch(() => {});
    });
    server.on('error', reject);
  });
}
```

- [ ] **Step 3: Write `src/integrations/_auth/api-key.js`**

```js
export async function validateApiKey({ baseUrl, key, headerName = 'Authorization', headerPrefix = 'Bearer ', testPath, fetchFn = globalThis.fetch }) {
  const r = await fetchFn(`${baseUrl}${testPath}`, {
    headers: { [headerName]: `${headerPrefix}${key}` },
  });
  if (!r.ok) throw new Error(`api-key validation failed: ${r.status}`);
  return await r.json();
}
```

- [ ] **Step 4: Write `src/integrations/_auth/discord-bot.js`**

```js
export async function validateBotToken({ token, fetchFn = globalThis.fetch }) {
  const r = await fetchFn('https://discord.com/api/v10/users/@me', {
    headers: { Authorization: `Bot ${token}` },
  });
  if (!r.ok) throw new Error(`discord bot token invalid: ${r.status}`);
  return await r.json();
}
```

- [ ] **Step 5: Write tests**

`tests/unit/auth-oauth2-google.test.js`:

```js
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { buildAuthUrl, ensureFreshToken, exchangeCode, generatePKCE, refreshAccessToken } from '../../src/integrations/_auth/oauth2-google.js';

test('generatePKCE produces base64url verifier+challenge', () => {
  const { verifier, challenge } = generatePKCE();
  assert.match(verifier, /^[A-Za-z0-9_-]+$/);
  assert.match(challenge, /^[A-Za-z0-9_-]+$/);
});

test('buildAuthUrl includes PKCE + offline access', () => {
  const url = buildAuthUrl({ client_id: 'c', scopes: ['s1', 's2'], challenge: 'chal', state: 'st' });
  assert.match(url, /code_challenge=chal/);
  assert.match(url, /code_challenge_method=S256/);
  assert.match(url, /access_type=offline/);
  assert.match(url, /prompt=consent/);
});

test('exchangeCode posts to token endpoint and parses response', async () => {
  const fakeFetch = mock.fn(async () => ({
    ok: true,
    json: async () => ({ access_token: 'a', refresh_token: 'r', expires_in: 3600, token_type: 'Bearer', scope: 's' }),
  }));
  const r = await exchangeCode({ client_id: 'c', client_secret: 's', code: 'cd', verifier: 'v', fetchFn: fakeFetch });
  assert.equal(r.access_token, 'a');
  assert.equal(r.refresh_token, 'r');
  assert.ok(r.expires_at > Date.now());
});

test('refreshAccessToken returns new access_token + expires_at', async () => {
  const fakeFetch = mock.fn(async () => ({
    ok: true,
    json: async () => ({ access_token: 'a2', expires_in: 3600 }),
  }));
  const r = await refreshAccessToken({ client_id: 'c', client_secret: 's', refresh_token: 'r', fetchFn: fakeFetch });
  assert.equal(r.access_token, 'a2');
});
```

`tests/unit/auth-api-key.test.js`:

```js
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { validateApiKey } from '../../src/integrations/_auth/api-key.js';

test('validateApiKey hits test endpoint with header', async () => {
  const calls = [];
  const fakeFetch = mock.fn(async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, json: async () => ({ user: 'me' }) };
  });
  const r = await validateApiKey({
    baseUrl: 'https://api.example.com',
    key: 'k',
    testPath: '/me',
    fetchFn: fakeFetch,
  });
  assert.equal(r.user, 'me');
  assert.equal(calls[0].url, 'https://api.example.com/me');
  assert.equal(calls[0].opts.headers.Authorization, 'Bearer k');
});

test('validateApiKey throws on non-OK', async () => {
  const fakeFetch = mock.fn(async () => ({ ok: false, status: 401 }));
  await assert.rejects(() => validateApiKey({ baseUrl: 'x', key: 'k', testPath: '/y', fetchFn: fakeFetch }));
});
```

`tests/unit/auth-discord-bot.test.js`:

```js
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { validateBotToken } from '../../src/integrations/_auth/discord-bot.js';

test('validateBotToken hits /users/@me with Bot prefix', async () => {
  const calls = [];
  const fakeFetch = mock.fn(async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, json: async () => ({ id: 'bot1', username: 'robot' }) };
  });
  const r = await validateBotToken({ token: 't', fetchFn: fakeFetch });
  assert.equal(r.username, 'robot');
  assert.equal(calls[0].opts.headers.Authorization, 'Bot t');
});

test('validateBotToken throws on invalid token', async () => {
  const fakeFetch = mock.fn(async () => ({ ok: false, status: 401 }));
  await assert.rejects(() => validateBotToken({ token: 'x', fetchFn: fakeFetch }));
});
```

- [ ] **Step 6: Run + lint + commit**

```bash
npm test -- tests/unit/auth-oauth2-google.test.js tests/unit/auth-api-key.test.js tests/unit/auth-discord-bot.test.js
npm run lint
git add src/integrations/_auth/ tests/unit/auth-*.test.js
git commit -m "feat(integrations): auth helpers — oauth2-google PKCE + api-key + discord-bot validation"
```

---

## Task 6: Gmail integration

**Files:**
- Create: `src/integrations/gmail/manifest.js`
- Create: `src/integrations/gmail/client.js`
- Create: `src/integrations/gmail/sync.js`
- Create: `src/integrations/gmail/tools/gmail-search.js`
- Create: `src/integrations/gmail/tools/gmail-get-thread.js`
- Create: `tests/unit/gmail-sync.test.js`
- Create: `tests/unit/gmail-tools.test.js`

- [ ] **Step 1: Write `src/integrations/gmail/client.js`**

```js
const SKIP_LABELS_DEFAULT = ['TRASH', 'SPAM', 'CATEGORY_PROMOTIONS'];
const FIRST_SYNC_CAP = 500;
const PAGE_SIZE = 100;

async function gmailFetch(path, { accessToken, fetchFn = globalThis.fetch, signal }) {
  const r = await fetchFn(`https://gmail.googleapis.com/gmail/v1/users/me${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal,
  });
  if (r.status === 401) {
    const err = new Error('gmail 401');
    err.code = 'auth_expired';
    throw err;
  }
  if (r.status === 404 || r.status === 410) {
    const err = new Error(`gmail history expired: ${r.status}`);
    err.code = 'history_expired';
    throw err;
  }
  if (!r.ok) throw new Error(`gmail ${path} failed: ${r.status}`);
  return await r.json();
}

export async function listMessages({ accessToken, q = '', pageToken, fetchFn, signal }) {
  const params = new URLSearchParams({ maxResults: String(PAGE_SIZE), q });
  if (pageToken) params.set('pageToken', pageToken);
  return await gmailFetch(`/messages?${params}`, { accessToken, fetchFn, signal });
}

export async function getMessage({ accessToken, id, fetchFn, signal }) {
  return await gmailFetch(`/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`, { accessToken, fetchFn, signal });
}

export async function listHistory({ accessToken, startHistoryId, fetchFn, signal }) {
  const params = new URLSearchParams({ startHistoryId, historyTypes: 'messageAdded' });
  return await gmailFetch(`/history?${params}`, { accessToken, fetchFn, signal });
}

export async function getProfile({ accessToken, fetchFn, signal }) {
  return await gmailFetch('/profile', { accessToken, fetchFn, signal });
}

export async function getThread({ accessToken, threadId, fetchFn, signal }) {
  return await gmailFetch(`/threads/${threadId}`, { accessToken, fetchFn, signal });
}

export function buildEventFromMessage(msg, profile) {
  const headers = msg.payload?.headers ?? [];
  const get = (name) => headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';
  const subject = get('Subject');
  const from = get('From');
  const snippet = msg.snippet ?? '';
  const labels = msg.labelIds ?? [];
  return {
    source: 'gmail',
    content: `Subject: ${subject} | From: ${from}\n${snippet}`,
    ts: new Date(Number.parseInt(msg.internalDate, 10)),
    external_id: msg.id,
    meta: {
      gmail_id: msg.id,
      thread_id: msg.threadId,
      labels,
      internal_date: msg.internalDate,
    },
  };
}

export function shouldSkipMessage(msg, skipLabels = SKIP_LABELS_DEFAULT) {
  const labels = msg.labelIds ?? [];
  return labels.some((l) => skipLabels.includes(l));
}

export { FIRST_SYNC_CAP, PAGE_SIZE, SKIP_LABELS_DEFAULT };
```

- [ ] **Step 2: Write `src/integrations/gmail/sync.js`**

```js
import { ensureFreshToken } from '../_auth/oauth2-google.js';
import { buildEventFromMessage, FIRST_SYNC_CAP, getMessage, getProfile, listHistory, listMessages, shouldSkipMessage } from './client.js';

async function firstSync(ctx, accessToken) {
  const profile = await getProfile({ accessToken, fetchFn: ctx.fetchFn, signal: ctx.signal });
  let pageToken = null;
  let total = 0;
  const events = [];
  do {
    const page = await listMessages({ accessToken, q: 'newer_than:7d', pageToken, fetchFn: ctx.fetchFn, signal: ctx.signal });
    pageToken = page.nextPageToken;
    for (const stub of page.messages ?? []) {
      if (total >= FIRST_SYNC_CAP) break;
      const msg = await getMessage({ accessToken, id: stub.id, fetchFn: ctx.fetchFn, signal: ctx.signal });
      if (shouldSkipMessage(msg)) continue;
      events.push(buildEventFromMessage(msg, profile));
      total += 1;
    }
  } while (pageToken && total < FIRST_SYNC_CAP);
  await ctx.capture(events);
  return { count: events.length, cursor: { history_id: profile.historyId } };
}

async function deltaSync(ctx, accessToken, startHistoryId) {
  const events = [];
  let pageToken = null;
  let latestHistoryId = startHistoryId;
  try {
    do {
      const page = await listHistory({ accessToken, startHistoryId, fetchFn: ctx.fetchFn, signal: ctx.signal });
      latestHistoryId = page.historyId ?? latestHistoryId;
      for (const h of page.history ?? []) {
        for (const added of h.messagesAdded ?? []) {
          const stub = added.message;
          const msg = await getMessage({ accessToken, id: stub.id, fetchFn: ctx.fetchFn, signal: ctx.signal });
          if (shouldSkipMessage(msg)) continue;
          events.push(buildEventFromMessage(msg));
        }
      }
      pageToken = page.nextPageToken;
    } while (pageToken);
  } catch (e) {
    if (e.code === 'history_expired') {
      ctx.log('history_id expired, falling back to first-sync');
      return await firstSync(ctx, accessToken);
    }
    throw e;
  }
  await ctx.capture(events);
  return { count: events.length, cursor: { history_id: latestHistoryId } };
}

export async function sync(ctx) {
  const fresh = await ensureFreshToken('gmail', ctx.secrets, { fetchFn: ctx.fetchFn });
  ctx.secrets = fresh;
  const accessToken = fresh.access_token;
  if (ctx.cursor?.history_id) {
    return await deltaSync(ctx, accessToken, ctx.cursor.history_id);
  }
  return await firstSync(ctx, accessToken);
}
```

- [ ] **Step 3: Write `src/integrations/gmail/manifest.js`**

```js
import { createGmailGetThreadTool } from './tools/gmail-get-thread.js';
import { createGmailSearchTool } from './tools/gmail-search.js';
import { sync } from './sync.js';

export const manifest = {
  name: 'gmail',
  cadence: '15m',
  embed: true,
  capture_mode: 'insert-or-skip',
  auth: {
    kind: 'oauth2-google',
    scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
  },
  sync,
  tools: [createGmailSearchTool, createGmailGetThreadTool],
};
```

- [ ] **Step 4: Write the two MCP tools**

`src/integrations/gmail/tools/gmail-search.js`:

```js
import { ensureFreshToken } from '../../_auth/oauth2-google.js';
import { readSecrets } from '../../_auth/secrets-io.js';
import { listMessages } from '../client.js';

export function createGmailSearchTool() {
  return {
    name: 'gmail_search',
    description: 'Search Gmail using Gmail query syntax. Returns message stubs (id, threadId).',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' }, max: { type: 'integer', minimum: 1, maximum: 50, default: 20 } },
      required: ['query'],
    },
    handler: async (args) => {
      const secrets = await readSecrets('gmail');
      if (!secrets) throw new Error('gmail not authenticated; run: robin auth gmail');
      const fresh = await ensureFreshToken('gmail', secrets);
      const page = await listMessages({ accessToken: fresh.access_token, q: args.query });
      return { messages: (page.messages ?? []).slice(0, args.max ?? 20) };
    },
  };
}
```

`src/integrations/gmail/tools/gmail-get-thread.js`:

```js
import { ensureFreshToken } from '../../_auth/oauth2-google.js';
import { readSecrets } from '../../_auth/secrets-io.js';
import { getThread } from '../client.js';

export function createGmailGetThreadTool() {
  return {
    name: 'gmail_get_thread',
    description: 'Fetch a Gmail thread by ID; returns full message bodies.',
    inputSchema: {
      type: 'object',
      properties: { thread_id: { type: 'string' } },
      required: ['thread_id'],
    },
    handler: async (args) => {
      const secrets = await readSecrets('gmail');
      if (!secrets) throw new Error('gmail not authenticated; run: robin auth gmail');
      const fresh = await ensureFreshToken('gmail', secrets);
      const thread = await getThread({ accessToken: fresh.access_token, threadId: args.thread_id });
      return { thread };
    },
  };
}
```

- [ ] **Step 5: Write tests**

`tests/unit/gmail-sync.test.js`:

```js
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { sync } from '../../src/integrations/gmail/sync.js';

function fakeProfile() {
  return { historyId: 'h-100', emailAddress: 'me@example.com' };
}
function fakeMsg(id, snippet = 'snippet', labels = ['INBOX']) {
  return {
    id, threadId: `t-${id}`, snippet,
    labelIds: labels,
    internalDate: String(Date.now()),
    payload: { headers: [{ name: 'Subject', value: `Subj ${id}` }, { name: 'From', value: 'a@b.c' }] },
  };
}

function makeFetch(handler) {
  return mock.fn(async (url) => handler(url));
}

test('first-sync paginates messages.list and skips TRASH/SPAM/PROMOTIONS', async () => {
  const captured = [];
  const fetchFn = makeFetch(async (url) => {
    if (url.includes('/profile')) return { ok: true, json: async () => fakeProfile() };
    if (url.includes('/messages?')) return { ok: true, json: async () => ({
      messages: [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }],
    }) };
    if (url.includes('/messages/m1')) return { ok: true, json: async () => fakeMsg('m1') };
    if (url.includes('/messages/m2')) return { ok: true, json: async () => fakeMsg('m2', 's', ['SPAM']) };
    if (url.includes('/messages/m3')) return { ok: true, json: async () => fakeMsg('m3') };
    throw new Error('unexpected: ' + url);
  });
  const ctx = {
    secrets: { client_id: 'c', client_secret: 's', refresh_token: 'r', access_token: 'a', expires_at: Date.now() + 3_600_000 },
    log: () => {},
    cursor: null,
    capture: async (rows) => { captured.push(...rows); return { inserted: rows.length, skipped: 0, updated: 0, errors: [] }; },
    fetchFn,
  };
  const r = await sync(ctx);
  assert.equal(r.count, 2);
  assert.equal(r.cursor.history_id, 'h-100');
  assert.equal(captured.length, 2);
  assert.equal(captured[0].external_id, 'm1');
});

test('delta sync uses history.list when cursor present', async () => {
  const captured = [];
  const fetchFn = makeFetch(async (url) => {
    if (url.includes('/history?')) return { ok: true, json: async () => ({
      historyId: 'h-200',
      history: [{ messagesAdded: [{ message: { id: 'm10' } }] }],
    }) };
    if (url.includes('/messages/m10')) return { ok: true, json: async () => fakeMsg('m10') };
    throw new Error('unexpected: ' + url);
  });
  const ctx = {
    secrets: { client_id: 'c', client_secret: 's', refresh_token: 'r', access_token: 'a', expires_at: Date.now() + 3_600_000 },
    log: () => {},
    cursor: { history_id: 'h-100' },
    capture: async (rows) => { captured.push(...rows); return { inserted: rows.length, skipped: 0, updated: 0, errors: [] }; },
    fetchFn,
  };
  const r = await sync(ctx);
  assert.equal(r.count, 1);
  assert.equal(r.cursor.history_id, 'h-200');
});

test('delta sync falls back to first-sync on history_id 404', async () => {
  let firstSyncCalled = false;
  const fetchFn = makeFetch(async (url) => {
    if (url.includes('/history?')) return { ok: false, status: 404 };
    if (url.includes('/profile')) { firstSyncCalled = true; return { ok: true, json: async () => fakeProfile() }; }
    if (url.includes('/messages?')) return { ok: true, json: async () => ({ messages: [] }) };
    throw new Error('unexpected: ' + url);
  });
  const ctx = {
    secrets: { client_id: 'c', client_secret: 's', refresh_token: 'r', access_token: 'a', expires_at: Date.now() + 3_600_000 },
    log: () => {},
    cursor: { history_id: 'h-stale' },
    capture: async () => ({ inserted: 0, skipped: 0, updated: 0, errors: [] }),
    fetchFn,
  };
  const r = await sync(ctx);
  assert.equal(firstSyncCalled, true);
  assert.equal(r.cursor.history_id, 'h-100');
});
```

`tests/unit/gmail-tools.test.js`:

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGmailGetThreadTool } from '../../src/integrations/gmail/tools/gmail-get-thread.js';
import { createGmailSearchTool } from '../../src/integrations/gmail/tools/gmail-search.js';

test('gmail_search has correct shape', () => {
  const t = createGmailSearchTool();
  assert.equal(t.name, 'gmail_search');
  assert.ok(t.inputSchema.required.includes('query'));
  assert.ok(typeof t.handler === 'function');
});

test('gmail_get_thread has correct shape', () => {
  const t = createGmailGetThreadTool();
  assert.equal(t.name, 'gmail_get_thread');
  assert.ok(t.inputSchema.required.includes('thread_id'));
});

test('gmail_search throws when not authenticated', async () => {
  process.env.ROBIN_HOME = '/tmp/robin-no-auth-' + Date.now();
  const t = createGmailSearchTool();
  await assert.rejects(() => t.handler({ query: 'x' }), /not authenticated/);
});
```

- [ ] **Step 6: Run + lint + commit**

```bash
npm test -- tests/unit/gmail-sync.test.js tests/unit/gmail-tools.test.js
npm run lint
git add src/integrations/gmail/ tests/unit/gmail-*.test.js
git commit -m "feat(integrations): gmail sync + 2 MCP tools"
```

---

## Task 7: Lunch Money integration

**Files:**
- Create: `src/integrations/lunch_money/manifest.js`
- Create: `src/integrations/lunch_money/client.js`
- Create: `src/integrations/lunch_money/sync.js`
- Create: `src/integrations/lunch_money/tools/lunch-money-query.js`
- Create: `tests/unit/lunch-money-sync.test.js`
- Create: `tests/unit/lunch-money-tool.test.js`

- [ ] **Step 1: Write `src/integrations/lunch_money/client.js`**

```js
const ROLLING_DAYS = 14;

async function lmFetch(path, { apiKey, fetchFn = globalThis.fetch, signal }) {
  const r = await fetchFn(`https://dev.lunchmoney.app${path}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal,
  });
  if (!r.ok) throw new Error(`lunch_money ${path} failed: ${r.status}`);
  return await r.json();
}

export async function listTransactions({ apiKey, startDate, endDate, fetchFn, signal }) {
  const params = new URLSearchParams({ start_date: startDate, end_date: endDate });
  return await lmFetch(`/v1/transactions?${params}`, { apiKey, fetchFn, signal });
}

export async function getMe({ apiKey, fetchFn, signal }) {
  return await lmFetch('/v1/me', { apiKey, fetchFn, signal });
}

export function transactionToEvent(t) {
  const amount = Number.parseFloat(t.amount);
  const sign = t.is_income ? '+' : '-';
  return {
    source: 'lunch_money',
    content: `${t.payee ?? '(no payee)'} · ${sign}$${amount.toFixed(2)} · ${t.category_name ?? 'uncategorized'}`,
    ts: new Date(t.date),
    external_id: String(t.id),
    meta: {
      lm_id: t.id,
      account_id: t.asset_id ?? t.plaid_account_id ?? null,
      payee: t.payee,
      amount,
      currency: t.currency,
      category: t.category_name,
      date: t.date,
      status: t.status,
      plaid_account_id: t.plaid_account_id,
    },
  };
}

export function rollingStartDate(savedCursorDate, today = new Date()) {
  const todayStr = today.toISOString().slice(0, 10);
  const minus14 = new Date(today.getTime() - ROLLING_DAYS * 86400_000).toISOString().slice(0, 10);
  if (!savedCursorDate) return minus14;
  return savedCursorDate < minus14 ? minus14 : savedCursorDate;
}

export { ROLLING_DAYS };
```

- [ ] **Step 2: Write `src/integrations/lunch_money/sync.js`**

```js
import { listTransactions, rollingStartDate, transactionToEvent } from './client.js';

export async function sync(ctx) {
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  const startDate = rollingStartDate(ctx.cursor?.start_date ?? null, today);
  const data = await listTransactions({
    apiKey: ctx.secrets.api_key,
    startDate,
    endDate: todayStr,
    fetchFn: ctx.fetchFn,
    signal: ctx.signal,
  });
  const events = (data.transactions ?? []).map(transactionToEvent);
  await ctx.capture(events);
  return { count: events.length, cursor: { start_date: todayStr } };
}
```

- [ ] **Step 3: Write `src/integrations/lunch_money/manifest.js`**

```js
import { sync } from './sync.js';
import { createLunchMoneyQueryTool } from './tools/lunch-money-query.js';

export const manifest = {
  name: 'lunch_money',
  cadence: '1d',
  embed: true,
  capture_mode: 'upsert',
  auth: { kind: 'api-key' },
  sync,
  tools: [createLunchMoneyQueryTool],
};
```

- [ ] **Step 4: Write the MCP tool**

`src/integrations/lunch_money/tools/lunch-money-query.js`:

```js
import { surql } from 'surrealdb';

export function createLunchMoneyQueryTool({ db }) {
  return {
    name: 'lunch_money_query',
    description: 'Query captured Lunch Money transactions. Filters: since, until, payee_contains, min_amount, category.',
    inputSchema: {
      type: 'object',
      properties: {
        since: { type: 'string', format: 'date' },
        until: { type: 'string', format: 'date' },
        payee_contains: { type: 'string' },
        min_amount: { type: 'number' },
        category: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
      },
    },
    handler: async (args) => {
      const filters = ["source = 'lunch_money'"];
      const bindings = {};
      if (args.since) { filters.push('meta.date >= $since'); bindings.since = args.since; }
      if (args.until) { filters.push('meta.date <= $until'); bindings.until = args.until; }
      if (args.payee_contains) { filters.push('string::contains(string::lowercase(meta.payee), string::lowercase($pq))'); bindings.pq = args.payee_contains; }
      if (typeof args.min_amount === 'number') { filters.push('meta.amount >= $minAmt'); bindings.minAmt = args.min_amount; }
      if (args.category) { filters.push('meta.category = $cat'); bindings.cat = args.category; }
      const limit = Math.min(args.limit ?? 50, 200);
      const sql = `SELECT id, content, ts, meta FROM events WHERE ${filters.join(' AND ')} ORDER BY ts DESC LIMIT ${limit}`;
      const [rows] = await db.query(sql, bindings).collect();
      return { transactions: rows.map((r) => ({ ...r, id: String(r.id) })) };
    },
  };
}
```

- [ ] **Step 5: Write tests**

`tests/unit/lunch-money-sync.test.js`:

```js
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { rollingStartDate, transactionToEvent } from '../../src/integrations/lunch_money/client.js';
import { sync } from '../../src/integrations/lunch_money/sync.js';

test('rollingStartDate returns saved cursor when within 14d', () => {
  const today = new Date('2026-05-09T00:00:00Z');
  const r = rollingStartDate('2026-05-05', today);
  assert.equal(r, '2026-05-05');
});

test('rollingStartDate clamps to today−14d when cursor older', () => {
  const today = new Date('2026-05-09T00:00:00Z');
  const r = rollingStartDate('2026-04-01', today);
  assert.equal(r, '2026-04-25');
});

test('rollingStartDate uses today−14d when no cursor', () => {
  const today = new Date('2026-05-09T00:00:00Z');
  const r = rollingStartDate(null, today);
  assert.equal(r, '2026-04-25');
});

test('transactionToEvent shapes content + meta', () => {
  const t = { id: 5, amount: '12.50', payee: 'Coffee', category_name: 'Food', date: '2026-05-09', is_income: false, currency: 'USD' };
  const e = transactionToEvent(t);
  assert.equal(e.source, 'lunch_money');
  assert.equal(e.external_id, '5');
  assert.match(e.content, /Coffee/);
  assert.match(e.content, /\$12\.50/);
  assert.equal(e.meta.payee, 'Coffee');
});

test('sync calls API once and returns count + cursor', async () => {
  const fetchFn = mock.fn(async () => ({ ok: true, json: async () => ({ transactions: [
    { id: 1, amount: '10', date: '2026-05-09', is_income: false, payee: 'X', category_name: 'Y', currency: 'USD' },
    { id: 2, amount: '20', date: '2026-05-08', is_income: false, payee: 'Z', category_name: 'Y', currency: 'USD' },
  ] }) }));
  const captured = [];
  const r = await sync({
    secrets: { api_key: 'k' },
    log: () => {},
    cursor: null,
    capture: async (rows) => { captured.push(...rows); return {}; },
    fetchFn,
  });
  assert.equal(r.count, 2);
  assert.match(r.cursor.start_date, /^\d{4}-\d{2}-\d{2}$/);
});
```

`tests/unit/lunch-money-tool.test.js`:

```js
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createLunchMoneyQueryTool } from '../../src/integrations/lunch_money/tools/lunch-money-query.js';

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  return db;
}

test('lunch_money_query returns rows filtered by payee', async () => {
  const db = await fresh();
  await db.query(surql`CREATE events CONTENT ${{
    source: 'lunch_money', content: 'Coffee · -$5 · Food', ts: new Date('2026-05-09'),
    external_id: '1', meta: { payee: 'Coffee Co', amount: 5, date: '2026-05-09', category: 'Food' },
  }}`).collect();
  await db.query(surql`CREATE events CONTENT ${{
    source: 'lunch_money', content: 'Gas · -$30 · Auto', ts: new Date('2026-05-08'),
    external_id: '2', meta: { payee: 'Shell', amount: 30, date: '2026-05-08', category: 'Auto' },
  }}`).collect();
  const t = createLunchMoneyQueryTool({ db });
  const r = await t.handler({ payee_contains: 'coffee' });
  assert.equal(r.transactions.length, 1);
  assert.match(r.transactions[0].content, /Coffee/);
  await close(db);
});

test('lunch_money_query filters by min_amount', async () => {
  const db = await fresh();
  await db.query(surql`CREATE events CONTENT ${{
    source: 'lunch_money', content: 'a', ts: new Date(), external_id: 'a', meta: { amount: 5 },
  }}`).collect();
  await db.query(surql`CREATE events CONTENT ${{
    source: 'lunch_money', content: 'b', ts: new Date(), external_id: 'b', meta: { amount: 50 },
  }}`).collect();
  const t = createLunchMoneyQueryTool({ db });
  const r = await t.handler({ min_amount: 10 });
  assert.equal(r.transactions.length, 1);
  await close(db);
});
```

- [ ] **Step 6: Run + lint + commit**

```bash
npm test -- tests/unit/lunch-money-sync.test.js tests/unit/lunch-money-tool.test.js
npm run lint
git add src/integrations/lunch_money/ tests/unit/lunch-money-*.test.js
git commit -m "feat(integrations): lunch_money sync + 1 MCP tool"
```

---

## Task 8: Discord bot integration

**Files:**
- Create: `src/integrations/discord/manifest.js`
- Create: `src/integrations/discord/dispatcher.js`
- Create: `src/integrations/discord/reply.js`
- Create: `src/integrations/discord/commands.js`
- Create: `src/integrations/discord/start.js`
- Create: `src/integrations/discord/stop.js`
- Create: `tests/unit/discord-dispatcher.test.js`
- Create: `tests/unit/discord-reply.test.js`
- Create: `tests/fixtures/discord-events.js`
- Modify: `package.json` (add `discord.js` dep)

- [ ] **Step 1: Add discord.js dep**

```bash
cd /Users/iser/workspace/robin/robin-assistant-v2
npm install discord.js@^14
```

- [ ] **Step 2: Write `tests/fixtures/discord-events.js`**

```js
export function makeMessage({ id = 'm1', content = 'hello', author_id = 'u1', guild_id = 'g1', channel_id = 'c1', mentions_bot = false, dm = false }) {
  return {
    id,
    content,
    author: { id: author_id, bot: false },
    guildId: dm ? null : guild_id,
    channelId: channel_id,
    mentions: { has: (botId) => mentions_bot },
    reply: async (text) => ({ id: 'reply-' + id, content: text }),
  };
}

export function makeInteraction({ id = 'i1', commandName = '/help', user_id = 'u1', guild_id = 'g1' }) {
  return {
    id,
    isChatInputCommand: () => true,
    commandName,
    user: { id: user_id },
    guildId: guild_id,
    reply: async (text) => ({}),
  };
}
```

- [ ] **Step 3: Write `src/integrations/discord/dispatcher.js`**

```js
export function isAllowed({ allowlist, message, interaction }) {
  if (message) {
    const dm = !message.guildId;
    if (dm && allowlist.dm_user_ids?.includes(message.author.id)) return true;
    if (!dm && allowlist.guild_ids?.includes(message.guildId) && allowlist.user_ids?.includes(message.author.id)) return true;
    return false;
  }
  if (interaction) {
    return allowlist.guild_ids?.includes(interaction.guildId)
      && allowlist.user_ids?.includes(interaction.user.id);
  }
  return false;
}

export function classifyMessage(message, botUserId) {
  const dm = !message.guildId;
  if (dm) return 'dm';
  if (message.mentions.has(botUserId)) return 'mention';
  return 'other';
}

export function buildEventFromMessage(message, kind) {
  return {
    source: 'discord',
    content: message.content,
    ts: new Date(),
    external_id: message.id,
    trust: 'untrusted',
    meta: {
      discord_message_id: message.id,
      channel_id: message.channelId,
      guild_id: message.guildId,
      author_id: message.author.id,
      kind,
    },
  };
}

export function buildEventFromInteraction(interaction) {
  return {
    source: 'discord',
    content: interaction.commandName,
    ts: new Date(),
    external_id: interaction.id,
    trust: 'untrusted',
    meta: {
      discord_message_id: interaction.id,
      channel_id: null,
      guild_id: interaction.guildId,
      author_id: interaction.user.id,
      kind: 'slash',
    },
  };
}
```

- [ ] **Step 4: Write `src/integrations/discord/reply.js`**

```js
import { checkOutbound } from '../../outbound/policy.js';

export async function generateAndSendReply({ db, host, message, prompt }) {
  if (!host) {
    await message.reply('(robin: LLM host unavailable)');
    return { sent: false, reason: 'no_host' };
  }
  const llm = await host.invokeLLM(
    [{ role: 'user', content: prompt }],
    { tier: 'fast' },
  );
  const replyText = (llm.content ?? '').slice(0, 2000);
  const policy = await checkOutbound(db, { destination: 'discord', text: replyText });
  if (!policy.ok) {
    await message.reply(`(robin: reply blocked by outbound policy: ${policy.reason})`);
    return { sent: false, reason: policy.reason };
  }
  await message.reply(replyText);
  return { sent: true };
}
```

- [ ] **Step 5: Write `src/integrations/discord/commands.js`**

```js
const COMMANDS = [
  { name: 'new', description: 'Start a new Robin session' },
  { name: 'cancel', description: 'Cancel current session' },
  { name: 'help', description: 'Show Robin help' },
];

export async function registerSlashCommands({ applicationId, guildId, botToken, fetchFn = globalThis.fetch }) {
  const r = await fetchFn(`https://discord.com/api/v10/applications/${applicationId}/guilds/${guildId}/commands`, {
    method: 'PUT',
    headers: { Authorization: `Bot ${botToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(COMMANDS),
  });
  if (!r.ok) throw new Error(`discord command registration failed: ${r.status}`);
  return await r.json();
}
```

- [ ] **Step 6: Write `src/integrations/discord/start.js`**

```js
import { Client, GatewayIntentBits, Partials } from 'discord.js';
import { surql } from 'surrealdb';
import { buildEventFromInteraction, buildEventFromMessage, classifyMessage, isAllowed } from './dispatcher.js';
import { registerSlashCommands } from './commands.js';
import { generateAndSendReply } from './reply.js';

export async function start(ctx) {
  const { db, host, secrets } = ctx;
  if (!secrets?.bot_token) throw new Error('discord secrets missing bot_token');
  const allowlist = {
    user_ids: secrets.allowed_user_ids ?? [],
    guild_ids: secrets.allowed_guild_ids ?? [],
    dm_user_ids: secrets.allowed_user_ids ?? [],
  };

  const [rt] = await db.query(surql`SELECT value FROM type::record('runtime', 'integrations')`).collect();
  const registered = rt[0]?.value?.discord?.commands_registered_at;
  if (!registered && secrets.application_id) {
    for (const guildId of allowlist.guild_ids) {
      try {
        await registerSlashCommands({ applicationId: secrets.application_id, guildId, botToken: secrets.bot_token });
      } catch (e) {
        ctx.log(`slash registration failed for guild ${guildId}: ${e.message}`);
      }
    }
    await db.query(surql`UPSERT type::record('runtime', 'integrations')
      MERGE { value: { discord: { commands_registered_at: time::now() } } }`).collect();
  }

  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.DirectMessages],
    partials: [Partials.Channel],
  });

  client.on('messageCreate', async (message) => {
    try {
      if (message.author.bot) return;
      if (!isAllowed({ allowlist, message })) return;
      const kind = classifyMessage(message, client.user?.id);
      if (kind === 'other') return;
      const event = buildEventFromMessage(message, kind);
      await ctx.capture([event]);
      await generateAndSendReply({ db, host, message, prompt: message.content });
    } catch (e) {
      ctx.log(`messageCreate handler error: ${e.message}`);
    }
  });

  client.on('interactionCreate', async (interaction) => {
    try {
      if (!interaction.isChatInputCommand()) return;
      if (!isAllowed({ allowlist, interaction })) return;
      const event = buildEventFromInteraction(interaction);
      await ctx.capture([event]);
      await interaction.reply(`(robin: ${interaction.commandName} received)`);
    } catch (e) {
      ctx.log(`interactionCreate handler error: ${e.message}`);
    }
  });

  await client.login(secrets.bot_token);
  return client;
}
```

- [ ] **Step 7: Write `src/integrations/discord/stop.js`**

```js
export async function stop(ctx, client) {
  if (!client) return;
  try {
    await client.destroy();
  } catch (e) {
    ctx.log?.(`discord stop error: ${e.message}`);
  }
}
```

- [ ] **Step 8: Write `src/integrations/discord/manifest.js`**

```js
import { start } from './start.js';
import { stop } from './stop.js';

export const manifest = {
  name: 'discord',
  cadence: null,
  embed: false,
  capture_mode: 'insert-or-skip',
  auth: { kind: 'discord-bot' },
  start,
  stop,
  tools: [],
};
```

- [ ] **Step 9: Write tests**

`tests/unit/discord-dispatcher.test.js`:

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildEventFromInteraction, buildEventFromMessage, classifyMessage, isAllowed } from '../../src/integrations/discord/dispatcher.js';
import { makeInteraction, makeMessage } from '../fixtures/discord-events.js';

const allowlist = { user_ids: ['u1'], guild_ids: ['g1'], dm_user_ids: ['u1'] };

test('isAllowed: allowlisted DM passes', () => {
  const m = makeMessage({ author_id: 'u1', dm: true });
  assert.equal(isAllowed({ allowlist, message: m }), true);
});

test('isAllowed: non-allowlisted DM fails', () => {
  const m = makeMessage({ author_id: 'rando', dm: true });
  assert.equal(isAllowed({ allowlist, message: m }), false);
});

test('isAllowed: allowlisted guild + user passes', () => {
  const m = makeMessage({ author_id: 'u1', guild_id: 'g1' });
  assert.equal(isAllowed({ allowlist, message: m }), true);
});

test('isAllowed: allowlisted guild but wrong user fails', () => {
  const m = makeMessage({ author_id: 'rando', guild_id: 'g1' });
  assert.equal(isAllowed({ allowlist, message: m }), false);
});

test('isAllowed: interaction allowlist', () => {
  const i = makeInteraction({ user_id: 'u1', guild_id: 'g1' });
  assert.equal(isAllowed({ allowlist, interaction: i }), true);
});

test('classifyMessage: DM', () => {
  const m = makeMessage({ dm: true });
  assert.equal(classifyMessage(m, 'bot'), 'dm');
});

test('classifyMessage: mention', () => {
  const m = makeMessage({ mentions_bot: true });
  assert.equal(classifyMessage(m, 'bot'), 'mention');
});

test('classifyMessage: non-mention guild message → other', () => {
  const m = makeMessage({ mentions_bot: false });
  assert.equal(classifyMessage(m, 'bot'), 'other');
});

test('buildEventFromMessage stamps trust=untrusted', () => {
  const m = makeMessage({ id: 'm1' });
  const e = buildEventFromMessage(m, 'mention');
  assert.equal(e.source, 'discord');
  assert.equal(e.trust, 'untrusted');
  assert.equal(e.external_id, 'm1');
});
```

`tests/unit/discord-reply.test.js`:

```js
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { mock, test } from 'node:test';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { generateAndSendReply } from '../../src/integrations/discord/reply.js';
import { makeMessage } from '../fixtures/discord-events.js';

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  return db;
}

test('generateAndSendReply sends LLM-drafted clean reply', async () => {
  const db = await fresh();
  const host = { invokeLLM: async () => ({ content: 'hello world', usage: {} }) };
  const replies = [];
  const message = { ...makeMessage({}), reply: async (t) => { replies.push(t); } };
  const r = await generateAndSendReply({ db, host, message, prompt: 'p' });
  assert.equal(r.sent, true);
  assert.equal(replies[0], 'hello world');
  await close(db);
});

test('generateAndSendReply blocks PII reply', async () => {
  const db = await fresh();
  const host = { invokeLLM: async () => ({ content: 'card 4111 1111 1111 1111', usage: {} }) };
  const replies = [];
  const message = { ...makeMessage({}), reply: async (t) => { replies.push(t); } };
  const r = await generateAndSendReply({ db, host, message, prompt: 'p' });
  assert.equal(r.sent, false);
  assert.match(replies[0], /blocked/);
  await close(db);
});

test('generateAndSendReply with no host falls back', async () => {
  const db = await fresh();
  const replies = [];
  const message = { ...makeMessage({}), reply: async (t) => { replies.push(t); } };
  const r = await generateAndSendReply({ db, host: null, message, prompt: 'p' });
  assert.equal(r.sent, false);
  assert.equal(r.reason, 'no_host');
  assert.match(replies[0], /unavailable/);
  await close(db);
});
```

- [ ] **Step 10: Run + lint + commit**

```bash
npm test -- tests/unit/discord-dispatcher.test.js tests/unit/discord-reply.test.js
npm run lint
git add src/integrations/discord/ tests/unit/discord-*.test.js tests/fixtures/discord-events.js package.json package-lock.json
git commit -m "feat(integrations): discord bot — dispatcher, reply, slash commands, lifecycle"
```

---

## Task 9: integration_status + integration_run MCP tools + auth CLIs

**Files:**
- Create: `src/mcp/tools/integration-status.js`
- Create: `src/mcp/tools/integration-run.js`
- Create: `src/cli/commands/auth-gmail.js`
- Create: `src/cli/commands/auth-lunch-money.js`
- Create: `src/cli/commands/auth-discord.js`
- Create: `tests/unit/tool-integration-status.test.js`
- Create: `tests/unit/tool-integration-run.test.js`

- [ ] **Step 1: Write `src/mcp/tools/integration-status.js`**

```js
import { surql } from 'surrealdb';

export function createIntegrationStatusTool({ db }) {
  return {
    name: 'integration_status',
    description: 'Read integration health: cadence, last_sync_at, last_sync_ok, consecutive_failures, cursor.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' } },
    },
    handler: async (args) => {
      const [rows] = await db.query(surql`SELECT value FROM type::record('runtime', 'scheduler')`).collect();
      const integrations = rows[0]?.value?.integrations ?? {};
      if (args.name) {
        return { integration: integrations[args.name] ?? null };
      }
      return { integrations };
    },
  };
}
```

- [ ] **Step 2: Write `src/mcp/tools/integration-run.js`**

```js
const MIN_INTERVAL_MS = 30_000;

export function createIntegrationRunTool({ db, registry, runIntegrationSync }) {
  return {
    name: 'integration_run',
    description: 'Trigger an integration sync inline. Refuses on gateway integrations, in-flight syncs, or recent (<30s) successful runs.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
    handler: async (args) => {
      const integration = registry.get(args.name);
      if (!integration) return { ok: false, reason: 'unknown_integration', name: args.name };
      if (integration.cadence_ms === null) return { ok: false, reason: 'gateway_no_sync' };
      const [rows] = await db.query("SELECT value FROM type::record('runtime', 'scheduler')").collect();
      const row = rows[0]?.value?.integrations?.[args.name];
      if (row?.last_sync_at) {
        const elapsed = Date.now() - new Date(row.last_sync_at).getTime();
        if (elapsed < MIN_INTERVAL_MS) {
          return { ok: false, reason: 'too_recent', wait_seconds: Math.ceil((MIN_INTERVAL_MS - elapsed) / 1000) };
        }
      }
      return await runIntegrationSync(db, registry, args.name, { manual: true });
    },
  };
}
```

- [ ] **Step 3: Write the three auth CLI commands**

`src/cli/commands/auth-gmail.js`:

```js
import { confirm, input } from '../../cli/prompts.js';
import { runLoopbackAuth } from '../../integrations/_auth/oauth2-google.js';
import { readSecrets, writeSecrets } from '../../integrations/_auth/secrets-io.js';
import { spawn } from 'node:child_process';

function openUrl(url) {
  return new Promise((resolve, reject) => {
    const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
    const p = spawn(cmd, [url], { stdio: 'ignore', detached: true });
    p.on('error', reject);
    p.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`)));
  });
}

export async function authGmail(argv) {
  const existing = await readSecrets('gmail');
  if (existing) {
    const keep = await confirm('gmail.json already exists. Overwrite?');
    if (!keep) { console.log('aborted'); return; }
  }
  const client_id = await input('Google OAuth client_id: ');
  const client_secret = await input('Google OAuth client_secret: ');
  const tokens = await runLoopbackAuth({
    client_id,
    client_secret,
    scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
    openFn: openUrl,
  });
  await writeSecrets('gmail', { client_id, client_secret, ...tokens });
  console.log('gmail authenticated; secrets written.');
}
```

`src/cli/commands/auth-lunch-money.js`:

```js
import { input } from '../../cli/prompts.js';
import { validateApiKey } from '../../integrations/_auth/api-key.js';
import { writeSecrets } from '../../integrations/_auth/secrets-io.js';

export async function authLunchMoney() {
  const api_key = await input('Lunch Money API key: ');
  const me = await validateApiKey({
    baseUrl: 'https://dev.lunchmoney.app',
    key: api_key,
    testPath: '/v1/me',
  });
  await writeSecrets('lunch_money', { api_key });
  console.log(`lunch_money authenticated as ${me.user_email ?? me.user_name ?? '(unknown)'}; secrets written.`);
}
```

`src/cli/commands/auth-discord.js`:

```js
import { input } from '../../cli/prompts.js';
import { validateBotToken } from '../../integrations/_auth/discord-bot.js';
import { writeSecrets } from '../../integrations/_auth/secrets-io.js';

export async function authDiscord() {
  const bot_token = await input('Discord bot token: ');
  const me = await validateBotToken({ token: bot_token });
  const application_id = me.id;
  const allowed_user_ids = (await input('Allowed user IDs (comma-sep): ')).split(',').map((s) => s.trim()).filter(Boolean);
  const allowed_guild_ids = (await input('Allowed guild IDs (comma-sep): ')).split(',').map((s) => s.trim()).filter(Boolean);
  await writeSecrets('discord', { bot_token, application_id, allowed_user_ids, allowed_guild_ids });
  console.log(`discord authenticated as ${me.username}#${me.discriminator ?? ''}; secrets written.`);
}
```

- [ ] **Step 4: Create CLI prompts helper if absent**

Check `src/cli/prompts.js` exists; if not, write a minimal stdin-based version:

```js
import readline from 'node:readline/promises';

export async function input(prompt) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try { return await rl.question(prompt); } finally { rl.close(); }
}

export async function confirm(prompt) {
  const a = await input(`${prompt} [y/N] `);
  return /^y(es)?$/i.test(a.trim());
}
```

- [ ] **Step 5: Write tests**

`tests/unit/tool-integration-status.test.js`:

```js
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createIntegrationStatusTool } from '../../src/mcp/tools/integration-status.js';

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  return db;
}

test('integration_status returns empty on fresh DB', async () => {
  const db = await fresh();
  const t = createIntegrationStatusTool({ db });
  const r = await t.handler({});
  assert.deepEqual(r.integrations, {});
  await close(db);
});

test('integration_status returns named row when name passed', async () => {
  const db = await fresh();
  await db.query(surql`UPSERT type::record('runtime', 'scheduler') MERGE { value: {
    integrations: { gmail: { cadence_ms: 900_000, last_sync_ok: true } }
  } }`).collect();
  const t = createIntegrationStatusTool({ db });
  const r = await t.handler({ name: 'gmail' });
  assert.equal(r.integration.last_sync_ok, true);
  await close(db);
});
```

`tests/unit/tool-integration-run.test.js`:

```js
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createIntegrationRunTool } from '../../src/mcp/tools/integration-run.js';

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  return db;
}

test('integration_run rejects unknown integration', async () => {
  const db = await fresh();
  const t = createIntegrationRunTool({ db, registry: new Map(), runIntegrationSync: async () => {} });
  const r = await t.handler({ name: 'nope' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'unknown_integration');
  await close(db);
});

test('integration_run rejects gateway integration', async () => {
  const db = await fresh();
  const registry = new Map([['discord', { cadence_ms: null }]]);
  const t = createIntegrationRunTool({ db, registry, runIntegrationSync: async () => {} });
  const r = await t.handler({ name: 'discord' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'gateway_no_sync');
  await close(db);
});

test('integration_run refuses too_recent', async () => {
  const db = await fresh();
  await db.query(surql`UPSERT type::record('runtime', 'scheduler') MERGE { value: {
    integrations: { gmail: { cadence_ms: 900_000, last_sync_at: time::now() } }
  } }`).collect();
  const registry = new Map([['gmail', { cadence_ms: 900_000 }]]);
  const t = createIntegrationRunTool({ db, registry, runIntegrationSync: async () => ({ ok: true }) });
  const r = await t.handler({ name: 'gmail' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'too_recent');
  await close(db);
});

test('integration_run delegates to runIntegrationSync with manual: true', async () => {
  const db = await fresh();
  await db.query(surql`UPSERT type::record('runtime', 'scheduler') MERGE { value: {
    integrations: { gmail: { cadence_ms: 900_000, last_sync_at: null } }
  } }`).collect();
  let called;
  const registry = new Map([['gmail', { cadence_ms: 900_000 }]]);
  const t = createIntegrationRunTool({ db, registry, runIntegrationSync: async (db, reg, name, opts) => {
    called = { name, opts };
    return { ok: true, count: 5, cursor: { x: 1 }, duration_ms: 100 };
  } });
  const r = await t.handler({ name: 'gmail' });
  assert.equal(r.ok, true);
  assert.equal(called.opts.manual, true);
  await close(db);
});
```

- [ ] **Step 6: Run + lint + commit**

```bash
npm test -- tests/unit/tool-integration-status.test.js tests/unit/tool-integration-run.test.js
npm run lint
git add src/mcp/tools/integration-status.js src/mcp/tools/integration-run.js src/cli/commands/auth-*.js src/cli/prompts.js tests/unit/tool-integration-*.test.js
git commit -m "feat(mcp,cli): integration_status + integration_run tools; auth CLIs"
```

---

## Task 10: Integration management CLI commands

**Files:**
- Create: `src/cli/commands/integrations-list.js`
- Create: `src/cli/commands/integrations-status.js`
- Create: `src/cli/commands/integrations-run.js`
- Create: `src/cli/commands/integrations-discord-register.js`
- Modify: `src/cli/index.js`

- [ ] **Step 1: Write `src/cli/commands/integrations-list.js`**

```js
import { surql } from 'surrealdb';
import { close, connect } from '../../db/client.js';
import { ensureHome, paths } from '../../runtime/home.js';

export async function integrationsList() {
  await ensureHome();
  const p = paths();
  const db = await connect({ engine: `rocksdb://${p.db}` });
  try {
    const [rows] = await db.query(surql`SELECT value FROM type::record('runtime', 'scheduler')`).collect();
    const integrations = rows[0]?.value?.integrations ?? {};
    if (Object.keys(integrations).length === 0) { console.log('(no integrations registered)'); return; }
    for (const [name, row] of Object.entries(integrations)) {
      const cadence = row.cadence_ms ? `${row.cadence_ms / 60_000}m` : 'gateway';
      const last = row.last_sync_at ? new Date(row.last_sync_at).toISOString() : 'never';
      const ok = row.last_sync_ok === true ? 'OK' : (row.last_sync_ok === false ? 'FAIL' : '—');
      console.log(`${name.padEnd(15)}  ${cadence.padEnd(10)}  last=${last}  ${ok}`);
    }
  } finally { await close(db); }
}
```

- [ ] **Step 2: Write `src/cli/commands/integrations-status.js`**

```js
import { surql } from 'surrealdb';
import { close, connect } from '../../db/client.js';
import { ensureHome, paths } from '../../runtime/home.js';

export async function integrationsStatus(argv) {
  if (!argv[0]) { console.error('usage: robin integrations status <name> [--json]'); process.exit(1); }
  const name = argv[0];
  const json = argv.includes('--json');
  await ensureHome();
  const p = paths();
  const db = await connect({ engine: `rocksdb://${p.db}` });
  try {
    const [rows] = await db.query(surql`SELECT value FROM type::record('runtime', 'scheduler')`).collect();
    const row = rows[0]?.value?.integrations?.[name];
    if (!row) { console.log(`integration ${name} not registered`); return; }
    if (json) { console.log(JSON.stringify(row, null, 2)); return; }
    console.log(`name:                ${name}`);
    console.log(`cadence_ms:          ${row.cadence_ms ?? 'gateway'}`);
    console.log(`next_run_at:         ${row.next_run_at ?? '—'}`);
    console.log(`in_flight:           ${row.in_flight ?? false}`);
    console.log(`last_sync_at:        ${row.last_sync_at ?? '—'}`);
    console.log(`last_sync_ok:        ${row.last_sync_ok ?? '—'}`);
    console.log(`last_sync_count:     ${row.last_sync_count ?? '—'}`);
    console.log(`last_sync_error:     ${row.last_sync_error ?? '—'}`);
    console.log(`consecutive_failures: ${row.consecutive_failures ?? 0}`);
    console.log(`cursor:              ${JSON.stringify(row.cursor ?? null)}`);
  } finally { await close(db); }
}
```

- [ ] **Step 3: Write `src/cli/commands/integrations-run.js`**

```js
import { acquire } from '../../db/lock.js';
import { close, connect } from '../../db/client.js';
import { isPidAlive, readDaemonState } from '../../daemon/state.js';
import { createTransformersEmbedder } from '../../embed/embedder.js';
import { detectHost } from '../../hosts/detect.js';
import { createCapture } from '../../integrations/_framework/capture.js';
import { loadManifests } from '../../integrations/_framework/manifest-loader.js';
import { runIntegrationSync } from '../../integrations/_framework/run-sync.js';
import { readSecrets } from '../../integrations/_auth/secrets-io.js';
import { ensureHome, paths } from '../../runtime/home.js';
import { join } from 'node:path';

export async function integrationsRun(argv) {
  if (!argv[0]) { console.error('usage: robin integrations run <name>'); process.exit(1); }
  const name = argv[0];
  await ensureHome();
  const p = paths();
  const state = await readDaemonState(join(p.home, '.daemon.state'));
  if (state && isPidAlive(state.pid)) {
    console.error('daemon is running; stop it first or use the integration_run MCP tool. (`robin mcp stop`)');
    process.exit(1);
  }
  const release = await acquire(p.lock);
  try {
    const db = await connect({ engine: `rocksdb://${p.db}` });
    try {
      const embedder = await createTransformersEmbedder();
      const integrationsDir = new URL('../../integrations/', import.meta.url).pathname;
      const manifests = await loadManifests(integrationsDir);
      const target = manifests.find((m) => m.name === name);
      if (!target) { console.error(`integration ${name} not loaded`); process.exit(1); }
      const secrets = await readSecrets(name);
      const registry = new Map([[name, {
        cadence_ms: target.cadence_ms,
        sync: target.sync,
        secrets,
        capture: createCapture({ db, embedder, source: name, embed: target.embed, mode: target.capture_mode }),
      }]]);
      const r = await runIntegrationSync(db, registry, name, { manual: true });
      console.log(JSON.stringify(r, null, 2));
    } finally { await close(db); }
  } finally { await release(); }
}
```

- [ ] **Step 4: Write `src/cli/commands/integrations-discord-register.js`**

```js
import { registerSlashCommands } from '../../integrations/discord/commands.js';
import { readSecrets } from '../../integrations/_auth/secrets-io.js';

export async function integrationsDiscordRegister() {
  const secrets = await readSecrets('discord');
  if (!secrets?.bot_token || !secrets?.application_id) {
    console.error('discord not authenticated; run: robin auth discord');
    process.exit(1);
  }
  for (const guildId of secrets.allowed_guild_ids ?? []) {
    try {
      await registerSlashCommands({ applicationId: secrets.application_id, guildId, botToken: secrets.bot_token });
      console.log(`registered slash commands for guild ${guildId}`);
    } catch (e) {
      console.error(`failed for guild ${guildId}: ${e.message}`);
    }
  }
}
```

- [ ] **Step 5: Wire into `src/cli/index.js`**

Read first. Add new branches:

```js
if (cmd === 'auth') {
  const sub = argv[1];
  const map = { gmail: 'auth-gmail.js', lunch_money: 'auth-lunch-money.js', discord: 'auth-discord.js' };
  if (!map[sub]) { console.error('usage: robin auth <gmail|lunch_money|discord>'); process.exit(1); }
  const mod = await import(`./commands/${map[sub]}`);
  return Object.values(mod)[0](argv.slice(2));
}
if (cmd === 'integrations') {
  const sub = argv[1];
  if (sub === 'list') return (await import('./commands/integrations-list.js')).integrationsList();
  if (sub === 'status') return (await import('./commands/integrations-status.js')).integrationsStatus(argv.slice(2));
  if (sub === 'run') return (await import('./commands/integrations-run.js')).integrationsRun(argv.slice(2));
  if (sub === 'discord' && argv[2] === 'register-commands') {
    return (await import('./commands/integrations-discord-register.js')).integrationsDiscordRegister();
  }
  console.error('usage: robin integrations <list|status|run|discord register-commands>');
  process.exit(1);
}
```

- [ ] **Step 6: Smoke test + commit**

```bash
ROBIN_HOME=/tmp/robin-task10 ROBIN_HOST=claude_code node bin/robin migrate
ROBIN_HOME=/tmp/robin-task10 ROBIN_HOST=claude_code node bin/robin integrations list
ROBIN_HOME=/tmp/robin-task10 ROBIN_HOST=claude_code node bin/robin integrations status gmail
npm test
npm run lint
git add src/cli/commands/integrations-*.js src/cli/index.js
git commit -m "feat(cli): integrations list/status/run + discord register-commands"
```

---

## Task 11: AGENTS.md auto-section

**Files:**
- Modify: `src/install/agents-md.js`
- Modify: `tests/unit/agents-md.test.js`
- Create: `tests/unit/agents-md-integrations.test.js`

- [ ] **Step 1: Update `src/install/agents-md.js`**

Read first. Find the existing fenced section logic. Add a new function `integrationsSection(loadedManifests)` that returns:

```markdown
<!-- robin-integrations:start (auto-generated, do not hand-edit) -->
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

## Available integrations

<!-- per-integration list, generated from manifests -->
<!-- robin-integrations:end -->
```

Provide a top-level export `agentsMdContent({ integrations = [] } = {})` that splices the block in. Make sure the fence comments survive regeneration.

- [ ] **Step 2: Add tests**

`tests/unit/agents-md-integrations.test.js`:

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentsMdContent } from '../../src/install/agents-md.js';

test('agentsMdContent includes integrations fence even when empty', () => {
  const md = agentsMdContent({ integrations: [] });
  assert.match(md, /<!-- robin-integrations:start/);
  assert.match(md, /<!-- robin-integrations:end -->/);
});

test('agentsMdContent lists provided integrations', () => {
  const md = agentsMdContent({ integrations: [
    { name: 'gmail', cadence_ms: 900_000, tool_names: ['gmail_search', 'gmail_get_thread'] },
    { name: 'discord', cadence_ms: null, tool_names: [] },
  ] });
  assert.match(md, /gmail \(15m\): gmail_search, gmail_get_thread/);
  assert.match(md, /discord \(gateway\)/);
});

test('agentsMdContent freshness section instructs poll-every-2s', () => {
  const md = agentsMdContent({ integrations: [] });
  assert.match(md, /every 2s/);
  assert.match(md, /integration_run\(\{name\}\)/);
});
```

- [ ] **Step 3: Run + lint + commit**

```bash
npm test -- tests/unit/agents-md.test.js tests/unit/agents-md-integrations.test.js
npm run lint
git add src/install/agents-md.js tests/unit/agents-md.test.js tests/unit/agents-md-integrations.test.js
git commit -m "feat(install): AGENTS.md integrations auto-section"
```

---

## Task 12: Daemon wiring

**Files:**
- Modify: `src/daemon/server.js`

- [ ] **Step 1: Read current daemon entry point**

Survey what exists: tools array, scheduler instantiation, host detection, embedder, shutdown handlers.

- [ ] **Step 2: Add integrations registry build**

After DB + embedder + host are ready, before scheduler.start():

```js
import { resetInFlightFlags } from '../integrations/_framework/boot-cleanup.js';
import { loadManifests } from '../integrations/_framework/manifest-loader.js';
import { runIntegrationSync } from '../integrations/_framework/run-sync.js';
import { createCapture } from '../integrations/_framework/capture.js';
import { readSecrets } from '../integrations/_auth/secrets-io.js';
import { createIntegrationRunTool } from '../mcp/tools/integration-run.js';
import { createIntegrationStatusTool } from '../mcp/tools/integration-status.js';
import { surql } from 'surrealdb';

await resetInFlightFlags(dbHandle);
const integrationsDir = new URL('../integrations/', import.meta.url).pathname;
const manifests = await loadManifests(integrationsDir);
const registry = new Map();
const gatewayClients = new Map();

for (const m of manifests) {
  const secrets = await readSecrets(m.name);
  const capture = createCapture({ db: dbHandle, embedder: embedderWrap, source: m.name, embed: m.embed, mode: m.capture_mode });
  registry.set(m.name, { ...m, secrets, capture });
  // Persist initial cursor row if scheduled
  if (m.cadence_ms !== null) {
    await dbHandle.query(surql`UPSERT type::record('runtime', 'scheduler')
      MERGE { value: { integrations: { ${m.name}: ${{ cadence_ms: m.cadence_ms, next_run_at: new Date() }} } } }`).collect();
  }
  // Boot gateway integrations
  if (m.cadence_ms === null && m.start) {
    if (!secrets) { console.warn(`integration ${m.name}: gateway not started (no secrets)`); continue; }
    try {
      const ctx = { db: dbHandle, host: hostInstance, secrets, log: (...a) => console.log(`[${m.name}]`, ...a), capture };
      const client = await m.start(ctx);
      gatewayClients.set(m.name, client);
    } catch (e) {
      console.warn(`integration ${m.name}: gateway start failed: ${e.message}`);
    }
  }
}
```

- [ ] **Step 3: Register integration MCP tools**

```js
tools.push(createIntegrationStatusTool({ db: dbHandle }));
tools.push(createIntegrationRunTool({ db: dbHandle, registry, runIntegrationSync }));
for (const m of manifests) {
  for (const factory of m.tools ?? []) {
    try {
      tools.push(factory({ db: dbHandle }));
    } catch (e) {
      console.warn(`integration ${m.name}: tool factory failed: ${e.message}`);
    }
  }
}
```

- [ ] **Step 4: Wire scheduler with new API**

Replace the previous `createScheduler` call:

```js
const scheduler = createScheduler({
  listDue: async () => {
    const due = [];
    const [rows] = await dbHandle.query(surql`SELECT value FROM type::record('runtime', 'scheduler')`).collect();
    const integrations = rows[0]?.value?.integrations ?? {};
    const now = new Date();
    for (const [name, row] of Object.entries(integrations)) {
      if (!row.next_run_at) continue;
      if (new Date(row.next_run_at) <= now && !row.in_flight) due.push({ name, kind: 'integration' });
    }
    const dreamCursor = rows[0]?.value?.dream;
    if (dreamCursor?.next_run_at && new Date(dreamCursor.next_run_at) <= now) {
      due.push({ name: '__dream__', kind: 'dream' });
    }
    return due;
  },
  runOne: async (name) => {
    if (name === '__dream__') {
      const e = await idleEmbedder.get();
      const h = await getHost();
      return await dreamProcess(dbHandle, h, e);
    }
    return await runIntegrationSync(dbHandle, registry, name);
  },
  isOverflow: async () => {
    const [rows] = await dbHandle.query(`SELECT count() AS n FROM events WHERE biographed_at IS NONE GROUP ALL`).collect();
    return (rows[0]?.n ?? 0) >= 500;
  },
});
scheduler.start();
```

- [ ] **Step 5: Update shutdown handler**

```js
async function shutdown() {
  scheduler.stop();
  const grace = setTimeout(() => process.exit(1), 10_000);
  for (const [name, client] of gatewayClients) {
    const m = registry.get(name);
    if (m?.stop) await m.stop({ log: console.log }, client).catch(() => {});
  }
  await close(dbHandle).catch(() => {});
  clearTimeout(grace);
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
```

- [ ] **Step 6: Smoke test boot + run + lint + commit**

```bash
ROBIN_HOME=/tmp/robin-task12 ROBIN_HOST=claude_code node bin/robin migrate
ROBIN_HOME=/tmp/robin-task12 ROBIN_HOST=claude_code node src/daemon/server.js &
DAEMON_PID=$!
sleep 4
cat /tmp/robin-task12/.daemon.state
kill $DAEMON_PID
sleep 1
npm test
npm run lint
git add src/daemon/server.js
git commit -m "feat(daemon): wire integrations registry, scheduler, shutdown grace"
```

---

## Task 13: Integration tests

**Files:**
- Create: `tests/integration/gmail-full-sync.test.js`
- Create: `tests/integration/lunch-money-rolling-window.test.js`
- Create: `tests/integration/discord-allowlist.test.js`
- Create: `tests/integration/scheduler-multi-integration.test.js`
- Create: `tests/integration/integration-run-roundtrip.test.js`
- Create: `tests/integration/backoff-isolation.test.js`

These exercise the full path with mocked fetch. Reference shapes per spec section 6 testing strategy. Implementation pattern follows Phase 2c integration tests (mem:// + runMigrations + manual seeding + assertion-on-events-table).

- [ ] **Step 1-6: Write each integration test**

For each, follow the exact pattern from `tests/integration/dream-full-cycle.test.js` and `tests/integration/rule-approval-roundtrip.test.js` (Phase 2c). Each test:

1. Spins up mem:// db, runs migrations.
2. Builds a registry with mocked fetch via `mock.method(globalThis, 'fetch', ...)`.
3. Calls `runIntegrationSync` (or scheduler.tick) directly.
4. Asserts events table state, runtime row, etc.

- [ ] **Step 7: Run + commit**

```bash
npm test
npm run lint
git add tests/integration/
git commit -m "test(2d): integration coverage for sync, allowlist, backoff, run roundtrip"
```

---

## Task 14: CHANGELOG + tag v6.0.0-alpha.5

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Prepend CHANGELOG entry**

```markdown
## [6.0.0-alpha.5] — 2026-05-09

Phase 2d: integrations framework + Gmail + Lunch Money + Discord bot.

- New schema (migration 0006): `events.external_id` UNIQUE on `(source, external_id)`, `events.trust` marker, embedding relaxed to `option<>`, `outbound_refusals` table.
- **Integration framework** under `src/integrations/<name>/` — manifest + sync + tool factories + auth helpers. Heartbeat scheduler now drives per-integration cursors with per-name in-flight flags. Backoff: 3 consecutive scheduled failures double the cadence (capped at 24h); manual triggers don't feed backoff.
- **Three reference integrations:** gmail (15m, OAuth), lunch_money (1d, API key), discord (in-process gateway bot).
- **5 new MCP tools** (24 total daemon surface): `gmail_search`, `gmail_get_thread`, `lunch_money_query`, `integration_status`, `integration_run`.
- **9 new CLI commands:** `robin auth gmail/lunch_money/discord`, `robin integrations list/status/run`, `robin integrations discord register-commands`.
- **Outbound policy** (`src/outbound/policy.js`): PII / secret / verbatim-untrusted-quote (last 7d) guards. Discord bot replies pass through it; future github/spotify writes will too.
- **AGENTS.md** integrations auto-section regenerates on auth + install.
- **discord.js v14** added as production dependency.

Phase 2e candidates: Calendar/Drive/YouTube reusing Gmail's OAuth; github-write + spotify-write through outbound-policy; headless OAuth device flow.
```

- [ ] **Step 2: Commit + tag**

```bash
git add CHANGELOG.md
git commit -m "chore(2d): CHANGELOG for v6.0.0-alpha.5"
git tag v6.0.0-alpha.5
git tag -l 'v6.0.0-alpha*'
```

Expected: tag landed.

---

## Spec coverage cross-check

| Spec section | Tasks |
|---|---|
| 1. Scope | All tasks |
| 2. Framework SDK | Tasks 1, 3, 4, 5 |
| 3. Three integrations | Tasks 6, 7, 8 |
| 4. Migration 0006 + capture API + outbound policy | Tasks 0, 2, 3 |
| 5. CLI + MCP surface + AGENTS.md | Tasks 9, 10, 11 |
| 6. Testing | All test sub-steps + Task 13 |
| Daemon wiring | Task 12 |
| CHANGELOG + tag | Task 14 |

15 tasks total (0-14). Plan covers all spec requirements.
