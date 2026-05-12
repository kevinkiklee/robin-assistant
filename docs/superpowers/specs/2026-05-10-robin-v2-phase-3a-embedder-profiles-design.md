# Robin v2 Phase 3a — Pluggable Embedder Profiles + ROBIN_HOME Path Refactor

**Date:** 2026-05-10
**Status:** Approved (sections 1-6 brainstormed and iterated)
**Predecessor:** Phase 2f shipped at v6.0.0-alpha.7 (`b238616`).
**Coordinates with:** Phase 3b (migrator + missing integrations + cleanup) — separate spec, separate agent. Build order: 3a first.
**Target tag:** v6.0.0-alpha.8a

## 1. Scope and decomposition

Phase 3a (alpha.8a) ships:

1. **ROBIN_HOME path refactor.** Robin's data root moves from `~/.robin/` to `<package_root>/user-data/` — matching v1's pattern. `ROBIN_HOME` env var override still honored. Every reference to `~/.robin/` or `homedir() + '.robin'` in v2 is updated to use the centralized `paths()` helper.

2. **Pluggable embedder interface.** Replace v2's current single-implementation `createTransformersEmbedder` with an interface and three implementations.

3. **Three embedder profiles**, picked at install time:
   - **`mxbai-1024`** — `Xenova/mxbai-embed-large-v1`, 1024-dim, in-process via `@huggingface/transformers`. INT8-quantized: ~350MB on disk, ~600-800MB RAM. Auto-downloads on first call (~30s slow first call). No external dependency. **Default for new installs.**
   - **`qwen3-4096`** — `qwen3-embedding:8b` (Q4_K_M) via Ollama localhost HTTP. 4096-dim, ~5GB RAM. Setup: `brew install ollama` + `ollama pull qwen3-embedding:8b`.
   - **`gemini-3072`** — `gemini-embedding-001` via Google AI Studio API. 3072-dim, zero local. Requires `GEMINI_API_KEY`. Privacy disclosure required (free tier trains on input by default; paid tier or AI Studio data-collection opt-out for true privacy).

4. **Profile config at `<package_root>/user-data/config.json`** (filesystem, not SurrealDB — schema's HNSW dim depends on it).

5. **Three migration files at `0008-embedder-<profile>.surql`** (static, not templated). Migration runner picks the file matching the active profile.

6. **`robin install`** — multi-step idempotent flow combining Phase 2b's daemon supervision setup with Phase 3a's profile prompt. Re-runnable safely.

7. **`robin embedder switch <profile>`** — CLI to migrate between profiles. Drops + redefines HNSW indexes on `events`, `knowledge`, `entities`. Re-embeds all rows. Resumable on interrupt.

8. **Daemon-boot embedder health check** per active profile.

9. **Profile-drift detection.** Daemon-boot compares `<package_root>/user-data/config.json` against `runtime:embedder` row; refuses to start on mismatch.

10. **Removal of `Xenova/bge-small-en-v1.5@384`** as the active embedder. Phase 1's `0002-pin-embedding-dim.surql` (DIMENSION 384) is superseded by `0008-embedder-<profile>.surql`. v2's minimal existing data re-embeds in seconds during the switch.

**Realistic task count: ~30.** Breakdown: path refactor (4), embedder interface + factory (3), `InProcessEmbedder` (3), `OllamaEmbedder` (4), `GeminiApiEmbedder` (4), config-file profile selector + drift detection (3), three 0008 migrations (3), `robin install` profile prompt + multi-step flow (3), `robin embedder switch` CLI (3).

**Coordinates with Phase 3b (migrator):**
- 3a runs first to set the dim. 3b's migrator consumes the embedder polymorphically via `embedder.embed(text)`.
- 3b's spec must reference `<package_root>/user-data/secrets/.env` and `<package_root>/user-data/db/` (post-3a path refactor).
- Build order: 3a → 3b. Tag 3a as alpha.8a; 3b as alpha.8b (or alpha.9 if 3b spec slips).

## 2. ROBIN_HOME path refactor (foundational)

### Resolution

`<package_root>` = the directory containing v2's `package.json`, resolved by walking up from `import.meta.url`. For Kevin's setup: `~/workspace/robin/robin-assistant-v2/`. For npm-installed deployments: typically `node_modules/robin-assistant/`.

`<package_root>/user-data/` is the new default for everything that previously lived in `~/.robin/`.

### Caveat for npm installs

If `<package_root>` is inside `node_modules`, writing into `node_modules/robin-assistant/user-data/` works but gets wiped on `npm update`. **Such deployments must set `ROBIN_HOME` explicitly** (e.g. askrobin.io VM image: `ROBIN_HOME=/var/lib/robin`). The default is correct for development + Kevin's daily use + checked-out installations; npm-global users opt out via env var.

### `src/runtime/home.js` (rewritten)

```js
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';

function packageRoot() {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (dir !== '/') {
    if (existsSync(join(dir, 'package.json'))) return dir;
    dir = dirname(dir);
  }
  throw new Error('cannot resolve package root from src/runtime/home.js');
}

export function robinHome() {
  if (process.env.ROBIN_HOME) return resolve(process.env.ROBIN_HOME);
  return join(packageRoot(), 'user-data');
}

export function paths() {
  const home = robinHome();
  return {
    home,
    db: join(home, 'db'),
    secrets: join(home, 'secrets'),
    cache: join(home, 'cache'),
    config: join(home, 'config.json'),
    backup: join(home, 'backup'),
    daemonState: join(home, '.daemon.state'),
    daemonLock: join(home, '.daemon.lock'),
    migrationsDir: join(packageRoot(), 'src', 'schema', 'migrations'),
  };
}

export async function ensureHome() {
  const p = paths();
  for (const dir of [p.home, p.db, p.secrets, p.cache, p.backup]) {
    mkdirSync(dir, { recursive: true });
  }
}
```

### Files updated to use `paths()`

Every module that currently uses `process.env.ROBIN_HOME ?? join(homedir(), '.robin')` or hard-codes `~/.robin/`:

- `src/secrets/dotenv-io.js` — `secretsDir()` returns `paths().secrets`; `envFilePath()` returns `paths().secrets + '/.env'`
- `src/runtime/config.js` (NEW in 3a) — uses `paths().config`
- `src/integrations/_local/sqlite.js` — `cacheDir` uses `paths().cache + '/sqlite-snapshots'`
- `src/integrations/chrome/sync.js` — same
- `src/integrations/lrc/sync.js` — same
- `src/db/migrate.js` — backup tar location uses `paths().backup`
- `src/daemon/server.js` — daemon state, lock, port file
- `src/daemon/lock.js` — uses `paths().daemonLock`
- `src/daemon/state.js` — uses `paths().daemonState`
- `bin/robin` — `--version` output prints resolved `robinHome()` for diagnostics
- All CLI commands (`integrations-*.js`, `dream-run.js`, `secrets-*.js`, `auth-*.js`, `install.js`, etc.) — already use `paths()` via Phase 2 conventions; verify all call sites resolve correctly

### Tests

`tests/unit/runtime-home.test.js` (NEW):

- `paths()` resolves to `<package_root>/user-data/<subdir>` when `ROBIN_HOME` unset
- `ROBIN_HOME=/tmp/foo` → `paths().home === '/tmp/foo'`
- `paths().migrationsDir` resolves to source `src/schema/migrations` regardless of `ROBIN_HOME`
- `packageRoot()` walks up to v2's package.json correctly
- `ensureHome()` creates all subdirs with default mode

Existing tests that pre-seed `process.env.ROBIN_HOME = '/tmp/...'` continue to pass (env override honored).

### Migration step for Kevin's existing v2 data

Kevin's current `~/.robin/` likely contains alpha.7's test-run residuals (no real captured memory yet). Manual migration after Phase 3a ships:

```
$ robin install
[detects ~/.robin/ exists]
ℹ Robin's default data location moved to <package_root>/user-data/.
  To migrate existing data manually:
    mv ~/.robin/* <package_root>/user-data/
  Or set ROBIN_HOME=~/.robin to keep using the old location.

  Continue install? [Y/n]:
```

Documented in CHANGELOG. Not automated — `mv` on a system path is too risky to do automatically.

### Updated install command behavior

`robin install` post-message + reinstall messages reference `<package_root>/user-data/` paths instead of `~/.robin/`.

## 3. Embedder interface + three implementations

### Interface

`src/embed/types.js`:

```js
/**
 * @typedef {'mxbai-1024' | 'qwen3-4096' | 'gemini-3072'} EmbedderProfile
 *
 * @typedef {Object} Embedder
 * @property {EmbedderProfile} profile
 * @property {1024 | 4096 | 3072} dimension
 * @property {string} modelId
 * @property {(text: string) => Promise<Float32Array>} embed
 * @property {(texts: string[]) => Promise<Float32Array[]>} embedBatch
 * @property {() => Promise<void>} healthCheck
 * @property {(() => Promise<void>) | undefined} unload
 */
```

### Factory

`src/embed/factory.js`:

```js
import { readConfig } from '../runtime/config.js';
import { createInProcessEmbedder } from './in-process.js';
import { createOllamaEmbedder } from './ollama.js';
import { createGeminiEmbedder } from './gemini.js';

export async function createEmbedder() {
  const cfg = await readConfig();
  if (!cfg?.embedder_profile) {
    throw new Error('no embedder profile configured. Run `robin install` first.');
  }
  switch (cfg.embedder_profile) {
    case 'mxbai-1024':   return await createInProcessEmbedder();
    case 'qwen3-4096':   return await createOllamaEmbedder();
    case 'gemini-3072':  return await createGeminiEmbedder();
    default: throw new Error(`unknown embedder profile: ${cfg.embedder_profile}`);
  }
}
```

The existing Phase 2b `createIdleEmbedder({ factory, idleMs })` wrapper continues to work — it accepts a factory function and lazily resolves. `unload()` is called on idle if defined; for Ollama and Gemini profiles, undefined (no in-process state).

### `readConfig()` / `writeConfig()`

`src/runtime/config.js`:

```js
import { existsSync, readFileSync, writeFileSync, renameSync, chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { paths } from './home.js';

export async function readConfig() {
  const p = paths().config;
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf-8')); }
  catch (e) { throw new Error(`malformed ${p}: ${e.message}`); }
}

export async function writeConfig(cfg) {
  const p = paths().config;
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o644 });
  renameSync(tmp, p);
  chmodSync(p, 0o644);
}
```

Atomic temp-then-rename. 0644 perms (config is non-sensitive; secrets stay in `secrets/.env`).

### `InProcessEmbedder` (mxbai-1024)

```js
// src/embed/in-process.js
import { pipeline } from '@huggingface/transformers';

const MODEL = 'Xenova/mxbai-embed-large-v1';
const DIM = 1024;

export async function createInProcessEmbedder() {
  let extractor = null;

  async function getExtractor() {
    if (extractor) return extractor;
    extractor = await pipeline('feature-extraction', MODEL);
    return extractor;
  }

  return {
    profile: 'mxbai-1024',
    dimension: DIM,
    modelId: MODEL,
    embed: async (text) => {
      const ex = await getExtractor();
      const t = await ex(text, { pooling: 'mean', normalize: true });
      return Float32Array.from(t.tolist()[0]);
    },
    embedBatch: async (texts) => {
      const ex = await getExtractor();
      const t = await ex(texts, { pooling: 'mean', normalize: true });
      return t.tolist().map((row) => Float32Array.from(row));
    },
    healthCheck: async () => {},
    unload: async () => { extractor = null; },
  };
}
```

### `OllamaEmbedder` (qwen3-4096)

```js
// src/embed/ollama.js
const OLLAMA_HOST = process.env.OLLAMA_HOST ?? 'http://localhost:11434';
const MODEL = 'qwen3-embedding:8b';
const DIM = 4096;

class OllamaError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

async function ollamaPost(path, payload) {
  const r = await globalThis.fetch(`${OLLAMA_HOST}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new OllamaError(`ollama ${path} ${r.status}: ${await r.text()}`, r.status);
  return await r.json();
}

export async function createOllamaEmbedder() {
  let useBatch = true;

  async function embed(text) {
    if (useBatch) {
      try {
        const json = await ollamaPost('/api/embed', { model: MODEL, input: text });
        return Float32Array.from(json.embeddings[0]);
      } catch (e) {
        if (e.status === 404 || e.status === 405) { useBatch = false; }
        else { throw e; }
      }
    }
    const json = await ollamaPost('/api/embeddings', { model: MODEL, prompt: text });
    return Float32Array.from(json.embedding);
  }

  async function embedBatch(texts) {
    if (useBatch) {
      try {
        const json = await ollamaPost('/api/embed', { model: MODEL, input: texts });
        return json.embeddings.map((row) => Float32Array.from(row));
      } catch (e) {
        if (e.status !== 404 && e.status !== 405) throw e;
        useBatch = false;
      }
    }
    const out = [];
    for (const t of texts) out.push(await embed(t));
    return out;
  }

  async function healthCheck() {
    const r = await globalThis.fetch(`${OLLAMA_HOST}/api/tags`);
    if (!r.ok) throw new Error(`ollama unreachable at ${OLLAMA_HOST}`);
    const json = await r.json();
    const installed = (json.models ?? []).map((m) => m.name);
    if (!installed.some((n) => n.startsWith('qwen3-embedding:8b'))) {
      throw new Error(`ollama is running but qwen3-embedding:8b is not installed. Run: ollama pull qwen3-embedding:8b`);
    }
  }

  return { profile: 'qwen3-4096', dimension: DIM, modelId: MODEL, embed, embedBatch, healthCheck };
}
```

`OLLAMA_HOST` env var allows pointing at remote Ollama (not officially supported but works). Defensive endpoint detection: tries `/api/embed` (Ollama ≥ 0.1.46); falls back to `/api/embeddings` if missing.

### `GeminiApiEmbedder` (gemini-3072)

```js
// src/embed/gemini.js
import { requireSecret } from '../secrets/dotenv-io.js';

const SINGLE_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent';
const BATCH_ENDPOINT  = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents';
const MODEL = 'gemini-embedding-001';
const DIM = 3072;

class GeminiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

export async function createGeminiEmbedder() {
  // Per-call requireSecret is intentional: lets users re-auth without daemon restart.

  async function embed(text) {
    const apiKey = requireSecret('GEMINI_API_KEY');
    const r = await globalThis.fetch(`${SINGLE_ENDPOINT}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: `models/${MODEL}`, content: { parts: [{ text }] } }),
    });
    if (!r.ok) {
      throw new GeminiError(`gemini ${r.status}: ${await r.text().catch(() => '')}`, r.status);
    }
    const json = await r.json();
    return Float32Array.from(json.embedding.values);
  }

  async function embedBatch(texts) {
    const apiKey = requireSecret('GEMINI_API_KEY');
    const r = await globalThis.fetch(`${BATCH_ENDPOINT}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requests: texts.map((text) => ({ model: `models/${MODEL}`, content: { parts: [{ text }] } })),
      }),
    });
    if (!r.ok) {
      if (r.status === 404 || r.status === 405) {
        const out = [];
        for (const t of texts) out.push(await embed(t));
        return out;
      }
      throw new GeminiError(`gemini batch ${r.status}: ${await r.text().catch(() => '')}`, r.status);
    }
    const json = await r.json();
    return json.embeddings.map((e) => Float32Array.from(e.values));
  }

  async function healthCheck() {
    requireSecret('GEMINI_API_KEY');   // throws if missing; defers actual API call to first use
  }

  return { profile: 'gemini-3072', dimension: DIM, modelId: MODEL, embed, embedBatch, healthCheck };
}
```

`GeminiError.status` lets callers (migrator's batch loop, integration sync error path) detect 429 and back off. Rate-limiting is the caller's responsibility — embedder is intentionally simple.

### Profile-drift detection

A user could `vim <package_root>/user-data/config.json` and switch profile without running `robin embedder switch`. The HNSW index is at the OLD dim while the new embedder produces vectors at a NEW dim. First insert fails the array-length assertion.

**Defense**: each `0008-embedder-<profile>.surql` writes a `runtime:embedder` row with `{ profile, dimension, applied_at }`. Daemon-boot check compares `config.json.embedder_profile` against `runtime:embedder.profile`. Mismatch → daemon refuses to start with explicit instructions.

## 4. Migrations + `robin embedder switch` CLI

### Three static migration files

`src/schema/migrations/0008-embedder-mxbai-1024.surql`:

```surql
REMOVE INDEX events_vec ON events;
REMOVE FIELD embedding ON events;
DEFINE FIELD embedding ON events TYPE option<array<float>>
  ASSERT $value IS NONE OR array::len($value) = 1024;
DEFINE INDEX events_vec ON events FIELDS embedding HNSW DIMENSION 1024 DIST COSINE TYPE F32 EFC 200 M 16;

REMOVE INDEX knowledge_vec ON knowledge;
REMOVE FIELD embedding ON knowledge;
DEFINE FIELD embedding ON knowledge TYPE array<float> ASSERT array::len($value) = 1024;
DEFINE INDEX knowledge_vec ON knowledge FIELDS embedding HNSW DIMENSION 1024 DIST COSINE TYPE F32 EFC 200 M 16;

REMOVE INDEX entities_vec ON entities;
REMOVE FIELD embedding ON entities;
DEFINE FIELD embedding ON entities TYPE array<float> ASSERT array::len($value) = 1024;
DEFINE INDEX entities_vec ON entities FIELDS embedding HNSW DIMENSION 1024 DIST COSINE TYPE F32 EFC 200 M 16;

UPSERT type::record('runtime', 'embedder') CONTENT { value: { profile: 'mxbai-1024', dimension: 1024, applied_at: time::now() } };
```

`0008-embedder-qwen3-4096.surql` and `0008-embedder-gemini-3072.surql` are identical except DIMENSION (4096 / 3072) and profile/dimension fields. Static files; no template engine.

**Schema verification:**
- `events.embedding` stays `option<array<float>>` per Phase 2d migration 0006 (allows null for embed-skip integrations like Discord)
- `knowledge.embedding` stays `array<float>` non-option per Phase 2c
- `entities.embedding` stays `array<float>` non-option per Phase 2a

**Migration runner enhancement.** Existing runner from Phase 1 applies migrations in filename order. Phase 3a adds:

```js
// In runMigrations:
const cfg = await readConfig();
if (!cfg?.embedder_profile) {
  throw new Error('cannot run migrations: no embedder profile configured. Run `robin install` first.');
}

for (const filename of migrationFiles) {
  if (filename.startsWith('0008-embedder-') && filename !== `0008-embedder-${cfg.embedder_profile}.surql`) {
    continue;  // skip non-active embedder migrations
  }
  // ... apply as usual
}
```

### `robin embedder switch <profile>` CLI

```js
// src/cli/commands/embedder-switch.js
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { close, connect } from '../../db/client.js';
import { acquire } from '../../db/lock.js';
import { isPidAlive, readDaemonState } from '../../daemon/lock.js';
import { ensureHome, paths } from '../../runtime/home.js';
import { readConfig, writeConfig } from '../../runtime/config.js';
import { createEmbedder } from '../../embed/factory.js';

export async function embedderSwitch(argv) {
  const target = argv[0];
  if (!['mxbai-1024', 'qwen3-4096', 'gemini-3072'].includes(target)) {
    console.error('usage: robin embedder switch <mxbai-1024|qwen3-4096|gemini-3072>');
    process.exit(1);
  }
  await ensureHome();
  const p = paths();
  const state = await readDaemonState(p.daemonState);
  if (state && isPidAlive(state.pid)) {
    console.error('daemon is running; stop it first: robin mcp stop');
    process.exit(1);
  }
  const cfg = await readConfig();
  if (cfg?.embedder_profile === target) {
    console.log(`already on profile ${target}; nothing to do.`);
    return;
  }
  const release = await acquire(p.daemonLock);
  try {
    await writeConfig({ embedder_profile: target });
    const newEmbedder = await createEmbedder();
    await newEmbedder.healthCheck();   // throws if Ollama unreachable / Gemini key missing
    const db = await connect({ engine: `rocksdb://${p.db}` });
    try {
      const surql = readFileSync(join(p.migrationsDir, `0008-embedder-${target}.surql`), 'utf-8');
      await db.query(surql).collect();
      const totals = await countRowsToReembed(db);
      console.log(`Re-embedding ${totals.events} events, ${totals.knowledge} knowledge, ${totals.entities} entities. Resumable.`);
      await reembedTable(db, 'events', newEmbedder);
      await reembedTable(db, 'knowledge', newEmbedder);
      await reembedTable(db, 'entities', newEmbedder);
      console.log(`switched to ${target}.`);
    } finally { await close(db); }
  } catch (e) {
    if (cfg) await writeConfig(cfg);   // best-effort rollback
    throw e;
  } finally { await release(); }
}
```

`reembedTable(db, table, embedder)` walks rows in batches of 100, calls `embedder.embedBatch(rows.map(r => r.content))`, writes new vectors with `UPDATE ... SET embedding = ...`. Progress persisted to `runtime:embedder.switch_progress = { table, last_id, total, started_at }`. On interrupt, resuming reads progress and skips past `last_id`.

**Estimated re-embed time** for ~100k row backlog (post-3b migrator):
- mxbai (in-process, batch of 100, ~5ms/row effective): **~10 min**
- qwen3 (Ollama batch /api/embed, ~10ms/row): **~15 min**
- gemini (API batch, ~100ms/batch-of-100, 1500 RPM ≈ 2500 rows/min): **~40 min**

## 5. `robin install` — first-run profile prompt + multi-step flow

### Combined with Phase 2b's daemon install

Phase 2b's existing `robin install` does daemon supervision setup (launchd plist / systemd unit, `mcp install`). Phase 3a expands the same command into a multi-step idempotent flow — each step skips if already done:

1. **Pick embedder profile** (this section's prompt). Skipped if config already exists with a known profile.
2. **Apply migrations** — runs `robin migrate` internally. Idempotent. Applies 0001..0008-`<profile>`.
3. **Daemon supervision wire-up** (Phase 2b's existing logic). Idempotent.
4. **Print next-step guidance:** `ready. Run \`robin secrets import --from <v1-user-data>\` then \`robin migrate-from-v1\` next.`

### Flow

```
$ robin install

Welcome to Robin v2.

Robin uses an embedder to enable semantic recall over your memory. Choose one:

  1) mxbai-1024     local in-process    ~700MB RAM     MTEB retrieval ~60     [default]
                    Zero setup. Auto-downloads on first use.
                    Best for: VMs, constrained machines, "just works" path.

  2) qwen3-4096     local via Ollama    ~5GB RAM       MTEB retrieval ~68
                    Requires: brew install ollama && ollama pull qwen3-embedding:8b
                    Best for: personal machines with 16GB+ RAM, full privacy.

  3) gemini-3072    Google AI API       0 local        MTEB retrieval ~68
                    Requires: GEMINI_API_KEY in <package_root>/user-data/secrets/.env
                    Best for: zero-footprint deploys when privacy posture allows.

  (MTEB retrieval scores approximate; Q4 quantization on Qwen3 reduces ~2-3 points
  from F16 estimates. Quality differences in practice are smaller than scores suggest.)

Choice [1]: _
```

### Profile validation per choice

**`mxbai-1024`**: write config, continue to migrations + daemon setup steps.

**`qwen3-4096`**:
- Ping `${OLLAMA_HOST ?? 'http://localhost:11434'}/api/tags`
- Unreachable → print install commands (brew/curl), refuse to proceed
- Reachable but model missing → prompt `Run \`ollama pull qwen3-embedding:8b\` now? [Y/n]`. If yes, spawn synchronously with stdio inherited.
- Reachable + present → write config, continue

**`gemini-3072`**:
- Print disclosure block (verbatim):

```
⚠ Privacy notice for the gemini-3072 profile:

All event content captured by Robin's integrations (Gmail message bodies,
Google Calendar invites, Lunch Money transactions, Whoop health data, Linear
issues, Discord messages, browser history, Lightroom catalog metadata, etc.)
will be sent to Google's Gemini API for embedding.

Google's AI Studio FREE TIER uses input data for product improvement per
their terms. To prevent this:
  - Enable billing on your Google Cloud project (paid tier doesn't train), OR
  - Toggle data-collection opt-out in Google AI Studio settings

Type "i-understand" to continue, or anything else to abort:
```

- Strict input check (case-insensitive, whitespace-trimmed; `iunderstand` without hyphen aborts)
- If confirmed: check `secrets/.env` for `GEMINI_API_KEY`. Missing → print set-secret instructions and exit non-zero.
- If present: write config, continue

### Non-interactive flags

```
robin install --profile mxbai-1024
robin install --profile qwen3-4096
robin install --profile gemini-3072 --i-understand
```

`--profile <name>` skips the interactive prompt. For gemini, `--i-understand` (a flag, not a value) is required — explicit token of deliberate consent. Without it, gemini-3072 errors with `gemini-3072 requires --i-understand to confirm privacy disclosure non-interactively`.

For qwen3 in non-interactive mode, install fails immediately with helpful instructions if Ollama isn't already set up — no in-band pull. VM provisioning scripts run `ollama pull` themselves first.

### Reinstall semantics

```
$ robin install
Already configured (profile: mxbai-1024). All install steps complete.
To switch profiles:        robin embedder switch <profile>
To reinstall from scratch: robin install --force
```

`--force` requires `yes-drop-everything` confirmation phrase. Drops `<package_root>/user-data/db/`, removes config, re-prompts. Used rarely.

### Config validation at boot

Daemon-boot + every CLI command checks config validity:
- Missing config → "Run `robin install` first to choose an embedder profile."
- Malformed JSON → error with file path
- Unknown `embedder_profile` value → error listing valid values

### Existing `~/.robin/` migration

If `robin install` detects existing `~/.robin/` data on first run after Phase 3a:

```
ℹ Robin's default data location moved to <package_root>/user-data/.
  To migrate existing data manually:
    mv ~/.robin/* <package_root>/user-data/
  Or set ROBIN_HOME=~/.robin to keep using the old location.

  Continue install? [Y/n]:
```

Manual migration only — `mv` on system paths is too risky to automate.

## 6. Testing strategy + open questions + success criteria

### Unit tests (~35 new)

- `tests/unit/runtime-home.test.js` — `paths()` resolves to `<package_root>/user-data/<subdir>`; `ROBIN_HOME` override; `migrationsDir` resolves to source tree
- `tests/unit/runtime-config.test.js` — read returns null on missing; throws on malformed JSON; write atomic temp-rename; round-trip
- `tests/unit/embed-factory.test.js` — dispatches per profile; throws on missing config; throws on unknown profile
- `tests/unit/embed-in-process.test.js` — load lazy, `embed()` returns 1024 floats normalized, `embedBatch()` shape, `unload()` nullifies extractor
- `tests/unit/embed-ollama.test.js` — `/api/embed` happy path; falls back to `/api/embeddings` on 404/405; healthCheck reachable/unreachable/model-missing; `OLLAMA_HOST` env override
- `tests/unit/embed-gemini.test.js` — single + batch endpoints; 429 surfaces as `GeminiError.status === 429`; healthCheck (key-only); per-call requireSecret
- `tests/unit/profile-drift.test.js` — daemon-boot passes when config + runtime row match; refuses with clear message when they don't
- `tests/unit/embedder-switch.test.js` — refuses if daemon running; refuses if target equals current; resumable progress; reembed all 3 tables; rolls back config on health-check failure
- `tests/unit/install.test.js` (12 tests):
  - mxbai default
  - qwen3 happy
  - qwen3 unreachable
  - qwen3 missing model + Y (mocked spawn)
  - qwen3 missing model + n
  - gemini disclosure typo (aborts)
  - gemini disclosure abort (aborts)
  - gemini happy (with key)
  - gemini missing key
  - non-interactive --profile mxbai-1024
  - non-interactive --profile gemini-3072 without --i-understand (errors)
  - --force without confirmation phrase (aborts)
  - --force with phrase (drops DB, re-prompts)
  - malformed config (errors with valid-profiles message)

### Integration tests (~6 new)

- `tests/integration/embedder-end-to-end.test.js` — for each profile (mxbai actually loads, others mocked): apply 0008, write event with embed, recall by vector, assert dim
- `tests/integration/embedder-switch-roundtrip.test.js` — mxbai → qwen3 (mocked) → mxbai, all rows re-embedded each switch, dim assertions hold
- `tests/integration/install-flow.test.js` — full multi-step install (profile → migrate → mcp install) idempotent re-run
- `tests/integration/0008-migrations.test.js` — for each profile: apply 0001..0008-`<profile>`, assert HNSW dim via `INFO FOR TABLE`, assert vectors of right dim accept / wrong dim reject

### Open questions / known limitations

| # | Item | Resolution |
|---|---|---|
| 1 | Quantization quality loss for qwen3-Q4_K_M | Documented in install prompt; ~2-3 MTEB points from F16 |
| 2 | Gemini free-tier trains on input by default | Explicit disclosure required at install via `i-understand` |
| 3 | Ollama runtime crash mid-session | Embed calls fail → integration sync error path handles via `consecutive_failures` (Phase 2c backoff) |
| 4 | Config drift via manual edit | Daemon-boot check refuses; clear instructions in error |
| 5 | Concurrent `robin embedder switch` runs | File lock serializes |
| 6 | Re-embed pass interrupted | Resumable via `runtime:embedder.switch_progress` row |
| 7 | bge-small (current v2) model files left in HF cache | Not cleaned up; YAGNI |
| 8 | mxbai-embed-large-v1 first-call download (~350MB) | One-time slow first call documented |
| 9 | Voyage / other API providers not offered | Three-profile design picked; future profiles are additive (new entry + new 0008 file) |
| 10 | npm install in `node_modules/` writes to gitignored path | Such deployments must set `ROBIN_HOME` explicitly |
| 11 | Existing `~/.robin/` data on first 3a install | Manual migration step printed; not automated |
| 12 | Ollama and daemon on different machines | `OLLAMA_HOST` env var works; not officially supported |

### Success criteria for v6.0.0-alpha.8a

- All `~/.robin/` references in v2 source replaced with `paths()` helper; default resolves to `<package_root>/user-data/`
- `ROBIN_HOME` env var override honored everywhere
- All 3 embedder profiles implemented + tested
- Factory dispatches correctly; unknown profile throws; missing config throws
- `robin install` interactive flow works for all 3 profiles
- `robin install --profile <name>` non-interactive works; `--i-understand` required for gemini
- Three `0008-embedder-<profile>.surql` migrations apply correctly per profile
- `robin embedder switch <target>` re-embeds all 3 tables (events, knowledge, entities), resumable on interrupt
- Daemon-boot health check fires per profile (Ollama reachable + model present; gemini key set)
- Profile-drift detection refuses daemon start on mismatch
- All Phase 2d–2f tests pass after path refactor (no regression)
- `npm test` passes (target ~539 tests, +35 from alpha.7). `npm run lint` clean.
- Phase 2f's `bge-small-en-v1.5@384` is no longer the active embedder; old migration 0002 still in history but superseded by 0008
- Manual smoke checklist completed:
  - Real install with mxbai-1024 → first call downloads model → recall works
  - Real install with qwen3-4096 (with Ollama running) → recall works
  - Real install with gemini-3072 (Kevin's choice or skipped) → recall works
  - `robin embedder switch` between two profiles, mid-switch interrupt, resume completes
- CHANGELOG entry + `v6.0.0-alpha.8a` tag (or `v6.0.0-alpha.8` if 3b deferred)

### Sequencing with Phase 3b

3a runs first. 3b's migrator imports v1 data + re-embeds via the `Embedder` interface — works against any of the 3 profiles. 3b's spec must reference `<package_root>/user-data/` paths post-3a.

Build order: 3a → 3b. Tag 3a as alpha.8a; 3b as alpha.8b (or alpha.9 if 3b spec slips).
