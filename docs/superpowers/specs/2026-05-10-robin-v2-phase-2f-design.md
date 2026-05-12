# Robin v2 Phase 2f — OAuth Generalization + spotify-write + Headless OAuth + Rate Limiter + 8 Read-Sync Integrations

**Date:** 2026-05-10
**Status:** Approved (sections 1-7 brainstormed and iterated)
**Predecessor:** Phase 2e shipped at v6.0.0-alpha.6 (`9bcf781`).
**Target tag:** v6.0.0-alpha.7

## 1. Scope and decomposition

Phase 2f ships v1 read-sync near-parity + write-path #2 + framework gaps in one bundle:

1. **OAuth2 generalization.** `_auth/oauth2-google.js` → `_auth/oauth2.js` with PROVIDERS registry (`google`, `spotify`, `whoop`; future-extensible by registry edit). `google-token-cache.js` → `token-cache.js` keyed by provider. Refresh-token rotation handled when provider declares `rotatesRefreshToken: true`. **Cross-cutting refactor:** all Phase 2e Google integrations (gmail/calendar/drive/youtube) migrate to the new signature in early tasks before any new integration ships.

2. **Headless OAuth `--code` flag — Google only in 2f.** `_auth/oauth2.js` adds `runHeadlessAuth({ provider: 'google', scopes, prompt })`. Whoop and Spotify don't need this in 2f because tokens import from v1's .env via `robin secrets import`.

3. **Per-tool rate limiter.** New `runtime:outbound_rate` row with nested `{ <tool>: { recent_writes: [ts, ...] } }`. Sliding 1-hour window. Default cap 10/hr/tool. Per-tool overrides via env (`GITHUB_WRITE_RATE_LIMIT`, `SPOTIFY_WRITE_RATE_LIMIT`).

4. **spotify-write** — tool-only integration with 3 actions (`queue`, `skip`, `playlist-add`). First integration to actually exercise refresh-token rotation via `ctx.saveSecret`.

5. **8 read-sync integrations** (Apple Photos dropped per user directive):
   - **weather** (6h, public Open-Meteo, NYC default via `WEATHER_LOCATION`)
   - **ebird** (12h, `EBIRD_API_KEY`, Central Park default)
   - **chrome** (1d, local SQLite copy-snapshot pattern)
   - **whoop** (30m during 4-9am EDT only — quiet_window mechanism; OAuth via Whoop provider)
   - **lrc** (1w, local SQLite at `LRC_CATALOG_PATH`)
   - **linear** (1h, `LINEAR_PAT`)
   - **nhl** (12h, public stats API, `NHL_TEAM=NYR` default)
   - **ga** (1d, GA4 — reuses `GOOGLE_OAUTH_*` but **requires extra scope**; lazy-detect → user runs `robin auth google --code`)

6. **Local-SQLite reading** (chrome, lrc) uses **better-sqlite3** as a transient client lib: copy-to-tmp → query → delete. Never used as storage. SurrealDB remains the sole datastore.

7. **Whoop's quiet_window.** Manifest declares optional `quiet_window: { tz, active_hours }`. After each sync, `runIntegrationSync` advances `next_run_at` to the next active-window start if `now + cadence` falls outside.

8. **Manifest preflight.** New optional async `manifest.preflight()` export. Local-SQLite integrations use it to detect missing source files. Failed preflight → integration moves to an `unavailable` list (separate from `loaded`); daemon stays up; `integrations list` shows the row with `unavailable <error message>`.

9. **No schema migration.** New flexible `runtime:outbound_rate` row uses the existing FLEXIBLE runtime table.

10. **v1 env var name verification (Task 0).** Plan-time grep of v1's `auth-*.js` + `oauth.js` ensures v2's expected env keys match v1's verbatim. Mismatches → manifest's `secrets.env_keys` updated to match v1.

11. **Migration order.** Token-cache migration (sections 2 + token-cache.js rename) happens before any new integration ships. Existing 2e integrations work uninterrupted on the new helper.

Not in 2f: Apple Photos (dropped), spotify-write extended actions, headless OAuth for Whoop/Spotify (defer until first-time onboarding case arises).

**Realistic task count: ~55.** Breakdown: v1 env var verification (1), OAuth refactor (4), spotify-write + rate limiter (5), headless OAuth flow (3), 8 sync integrations (~4 tasks each = 32), local-SQLite shared utility + preflight (2), Whoop quiet-window scheduler change (2), daemon wiring + AGENTS.md (3), integration tests (4), CHANGELOG + tag (1).

## 2. OAuth2 generalization

### PROVIDERS registry

`src/integrations/_auth/oauth2.js` (replaces `oauth2-google.js`):

```js
export const PROVIDERS = {
  google: {
    tokenUrl: 'https://oauth2.googleapis.com/token',
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    refreshTokenEnv: 'GOOGLE_OAUTH_REFRESH_TOKEN',
    clientIdEnv: 'GOOGLE_OAUTH_CLIENT_ID',
    clientSecretEnv: 'GOOGLE_OAUTH_CLIENT_SECRET',
    rotatesRefreshToken: false,
    extraAuthParams: { access_type: 'offline', prompt: 'consent' },
  },
  spotify: {
    tokenUrl: 'https://accounts.spotify.com/api/token',
    authUrl: 'https://accounts.spotify.com/authorize',
    refreshTokenEnv: 'SPOTIFY_REFRESH_TOKEN',
    clientIdEnv: 'SPOTIFY_CLIENT_ID',
    clientSecretEnv: 'SPOTIFY_CLIENT_SECRET',
    rotatesRefreshToken: true,
    extraAuthParams: {},
  },
  whoop: {
    tokenUrl: 'https://api.prod.whoop.com/oauth/oauth2/token',
    authUrl: 'https://api.prod.whoop.com/oauth/oauth2/auth',
    refreshTokenEnv: 'WHOOP_REFRESH_TOKEN',
    clientIdEnv: 'WHOOP_CLIENT_ID',
    clientSecretEnv: 'WHOOP_CLIENT_SECRET',
    rotatesRefreshToken: true,
    extraAuthParams: {},
  },
};

function provider(name) {
  const p = PROVIDERS[name];
  if (!p) throw new Error(`unknown OAuth provider: ${name}`);
  return p;
}
```

`extraAuthParams` carries per-provider quirks. Validation throws on unknown providers immediately.

The helper signature:

```js
export async function ensureFreshToken(providerName, secrets, deps = {}) {
  const p = provider(providerName);
  // returns { access_token, expires_at, refresh_token? }
  // refresh_token included ONLY if p.rotatesRefreshToken AND response contained one
}
```

Both `runLoopbackAuth` and `runHeadlessAuth` exist; both reuse `exchangeCode`.

### Manifest-declared scopes

```js
secrets: {
  env_keys: ['GOOGLE_OAUTH_REFRESH_TOKEN', 'GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET'],
  oauth: { provider: 'google', scopes: ['https://www.googleapis.com/auth/gmail.readonly'] },
},
```

`robin auth google --code` scans loaded manifests, collects `secrets.oauth.scopes` for `provider === 'google'`, deduplicates, requests the union.

### Token cache singleton

```js
// src/integrations/_auth/token-cache.js
import { saveSecret as saveSecretFn } from '../../secrets/dotenv-io.js';
import { ensureFreshToken, PROVIDERS } from './oauth2.js';

const caches = new Map();
const refreshPromises = new Map();

export async function getAccessToken({ provider, secrets, fetchFn, saveSecret = saveSecretFn }) {
  if (!PROVIDERS[provider]) throw new Error(`unknown OAuth provider: ${provider}`);
  const now = Date.now();
  const cached = caches.get(provider);
  if (cached && cached.expires_at - now > 60_000) return cached.access_token;
  if (refreshPromises.has(provider)) return refreshPromises.get(provider).then((c) => c.access_token);

  const promise = ensureFreshToken(provider, secrets, { fetchFn })
    .then((result) => {
      caches.set(provider, { access_token: result.access_token, expires_at: result.expires_at });
      if (PROVIDERS[provider].rotatesRefreshToken && result.refresh_token) {
        try {
          saveSecret(PROVIDERS[provider].refreshTokenEnv, result.refresh_token);
        } catch (e) {
          console.warn(`[token-cache] saveSecret(${PROVIDERS[provider].refreshTokenEnv}) failed: ${e.message}`);
        }
      }
      return caches.get(provider);
    })
    .finally(() => { refreshPromises.delete(provider); });
  refreshPromises.set(provider, promise);
  return (await promise).access_token;
}

export function _resetCache(provider) {
  if (provider) {
    caches.delete(provider);
    refreshPromises.delete(provider);
  } else {
    caches.clear();
    refreshPromises.clear();
  }
}
```

Per-provider refresh-promise locks. saveSecret failure is non-fatal; in-memory token survives daemon lifetime.

### Migration of 2e Google integrations

| Phase 2e form | Phase 2f form |
|---|---|
| `getGoogleAccessToken({ secrets, fetchFn })` | `getAccessToken({ provider: 'google', secrets, fetchFn, saveSecret })` |
| `import { _resetCache } from '../_auth/google-token-cache.js'` | `import { _resetCache } from '../_auth/token-cache.js'` |
| `_resetCache()` | `_resetCache('google')` |

Tools called from non-ctx contexts import `saveSecret` from `dotenv-io.js` directly. Sync functions use `ctx.saveSecret`.

Files touched: `gmail/sync.js`, `gmail/tools/gmail-search.js`, `gmail/tools/gmail-get-thread.js`, `google_calendar/sync.js`, `google_calendar/tools/calendar-get-event.js`, `google_drive/sync.js`, `google_drive/tools/drive-search.js`, `google_drive/tools/drive-get-file.js`, `youtube/sync.js`, plus all their tests. ~14 files.

### Headless OAuth `--code` flow

```js
export async function runHeadlessAuth({ provider: providerName, scopes, prompt = console.log, readCode }) {
  const p = provider(providerName);
  const { verifier, challenge } = generatePKCE();
  const state = base64url(randomBytes(16));
  const url = buildAuthUrl({ provider: providerName, scopes, challenge, state });

  prompt(`\nOpen this URL in any browser (on any machine):\n  ${url}\n`);
  prompt(`After authorizing, the browser will redirect to:`);
  prompt(`  http://127.0.0.1:53682/callback?code=<CODE>&state=<STATE>`);
  prompt(`The page will fail to load (nothing is listening on the VM). Copy the code= parameter.`);
  const code = await readCode();

  return await exchangeCode({ provider: providerName, code, verifier, redirectUri: 'http://127.0.0.1:53682/callback' });
}
```

CLI: `robin auth google [--code [<CODE>]]`, `robin auth spotify [--code [<CODE>]]`, `robin auth whoop [--code [<CODE>]]`.

**`--code` parsing forms:**

| Invocation | Behavior |
|---|---|
| `robin auth google` | Loopback flow |
| `robin auth google --code` | Headless interactive (readline prompt) |
| `robin auth google --code=<VALUE>` | Headless inline |
| `robin auth google --code <VALUE>` | Rejected as ambiguous |

Interactive prompt uses `readline.createInterface(...).question(...)` — NOT raw-mode hidden input. The OAuth code is single-use and worthless after exchange.

### Test isolation note

`_resetCache(provider)` per-test for any provider exercised. Cleaner than global reset.

## 3. Per-tool rate limiter

### Storage

Single flexible row at `runtime:outbound_rate` with nested per-tool structure:

```
runtime:outbound_rate = {
  value: {
    github_write:  { recent_writes: ['2026-05-10T01:23:45Z', ...] },
    spotify_write: { recent_writes: [...] },
  }
}
```

ISO-8601 strings. Sliding window: anything older than 1h pruned at check time.

### Helper

`src/outbound/rate-limit.js` — `checkRateLimit(db, toolName)` returns `{ ok: true, used, cap }` or `{ ok: false, reason: 'rate_limited', wait_seconds, used, cap }`. Defaults to 10/hr/tool. Per-tool override via `<TOOL>_RATE_LIMIT` env var.

**Concurrency note:** read-modify-write race on `recent_writes` array. Two concurrent calls can overshoot the cap by N-1 (where N = concurrent calls). **Accepted** — soft cap is forgiving; platform-level rate limits are the real backstop.

**Counter increments before policy check; doesn't roll back on policy refusal or API failure.** Rationale: a buggy agent burning quota on PII-blocked retries should self-terminate via rate limit rather than spin indefinitely.

**Defensive check:** if `recent_writes` is malformed (non-array), treat as empty.

### Outbound-tool handler order

1. **Rate check** (`checkRateLimit`)
2. **Outbound-policy** (`checkOutbound`) — text actions only
3. **API call**
4. **Audit capture** — text actions only (events row)

### Tests

- Empty → 1st write proceeds
- 10 → 11th refused with correct `wait_seconds`
- `mock.timers` 1h elapsed → counter prunes
- Env override → smaller cap takes effect
- Malformed `recent_writes` → recovered
- PII-blocked write still increments counter

## 4. spotify-write integration

### Manifest

```js
export const manifest = {
  name: 'spotify_write',
  cadence: null,
  embed: true,
  capture_mode: 'insert-or-skip',
  secrets: {
    env_keys: ['SPOTIFY_REFRESH_TOKEN', 'SPOTIFY_CLIENT_ID', 'SPOTIFY_CLIENT_SECRET'],
    oauth: { provider: 'spotify', scopes: ['user-modify-playback-state', 'playlist-modify-private', 'playlist-modify-public', 'user-library-modify'] },
  },
  tools: [createSpotifyWriteTool],
};
```

Tool-only kind (third type from 2e).

### Actions

```ts
spotify_write({
  action: 'queue' | 'skip' | 'playlist-add',
  args: {
    track_uri?: string,            // queue
    playlist_id?: string,          // playlist-add
    track_uris?: string[],         // playlist-add: up to 100
  },
}) → { ok: true, ... } | { ok: false, reason, ... }
```

| Action | Rate limit | Outbound policy | Captures audit row? |
|---|---|---|---|
| `queue` | Yes | Run on `track_uri` | Daemon log only |
| `skip` | Yes | (no text) | Daemon log only |
| `playlist-add` | Yes | Run on `track_uris.join(', ')` | events row (`source='spotify_write'`, `external_id='<playlist_id>:<batch_ts>'`) |

### Implementation

`src/integrations/spotify_write/client.js` — Spotify REST helpers (`queueTrack`, `skipTrack`, `addToPlaylist`). All go through `getAccessToken({ provider: 'spotify', saveSecret })` for token rotation.

`src/integrations/spotify_write/tools/spotify-write.js` — single tool with action discriminator. Error mapping:

```js
function mapSpotifyError(e) {
  if (e?.status === 404) return { ok: false, reason: 'no_active_device' };
  if (e?.status === 403 && /premium/i.test(e.message ?? '')) return { ok: false, reason: 'premium_required' };
  if (/missing secret/.test(e?.message ?? '')) {
    return { ok: false, reason: 'not_authenticated', detail: 'spotify not authenticated; run: robin secrets import --from <v1-user-data>' };
  }
  return { ok: false, reason: 'spotify_error', detail: e?.message };
}
```

### Refresh-token rotation

First integration whose calls actually trigger token rotation. Spotify rotates on most refreshes. Rotation handled inside `token-cache.js`; integration code just calls `getAccessToken({ provider: 'spotify', saveSecret })`. Per-rotation tests live in `tests/unit/token-cache.test.js`.

## 5. Eight read-sync integrations

Grouped by API/auth shape. All declare `secrets.env_keys` per Phase 2e pattern.

### 5a. Public API + API key — weather, ebird, nhl, linear

#### weather

- **Cadence:** `6h`. **Embed:** true. **Capture mode:** upsert.
- **API:** Open-Meteo (public, no auth).
- **Config:** `WEATHER_LOCATION` env var (NYC `40.7128,-74.0060` default).
- **Cursor:** `{ last_run_at }`.
- **Captures:** one event per day. `external_id`: `weather:<YYYY-MM-DD>`. Content: `"<location_name> · <today_high>°F / <today_low>°F · <conditions> · sunrise <hh:mm> · sunset <hh:mm>"`.
- **MCP tools:** `weather_today()` (DB).

#### ebird

- **Cadence:** `12h`. **Embed:** true. **Capture mode:** insert-or-skip.
- **Secrets:** `EBIRD_API_KEY`. Hotspot `EBIRD_HOTSPOT=L191106` default (Central Park).
- **Cursor:** `{ last_run_at }`.
- **Captures:** one event per recent observation. **Per-sync API cap: 100** (`back=14`). Long-term accumulation via insert-or-skip dedup. `external_id`: `ebird:<obs_id>`.
- **MCP tools:** `ebird_recent({ days?, location_id?, limit? })` (DB).

#### nhl

- **Cadence:** `12h`. **Embed:** true. **Capture mode:** upsert.
- **API:** NHL public stats API. `NHL_TEAM=NYR` default.
- **Captures:** three event kinds: schedule (`nhl:game:<game_id>`), standings snapshot (`nhl:standings:<YYYY-MM-DD>`), summary (`nhl:summary:<YYYY-MM-DD>`).
- **MCP tools:** `nhl_recent({ team?, limit? })`, `nhl_standings()` (both DB).

#### linear

- **Cadence:** `1h`. **Embed:** true. **Capture mode:** upsert.
- **Secrets:** `LINEAR_PAT`.
- **Cursor:** `{ updated_after }` via `filter: { updatedAt: { gte: $cursor } }`.
- **First-sync:** paginates up to 200 most-recently-updated active issues across 4 pages of 50.
- **Captures:** one event per active issue. `external_id`: `linear:<identifier>`.
- **MCP tools:** `linear_active_issues({ team?, assignee?, limit? })` (DB), `linear_get_issue({ identifier })` (live; reads `LINEAR_PAT` at handler time).

### 5b. OAuth — whoop

- **Cadence:** `30m`. **Quiet window:** `{ tz: 'America/New_York', active_hours: [4, 5, 6, 7, 8] }`. DST handled via `Intl.DateTimeFormat`.
- **Secrets:** `WHOOP_REFRESH_TOKEN`, `WHOOP_CLIENT_ID`, `WHOOP_CLIENT_SECRET`. **OAuth scopes:** `read:recovery`, `read:sleep`, `read:workout`, `read:cycles`, `read:profile`. PROVIDERS entry added in §2.
- **Cursor:** four sub-cursors `{ recovery: <ts>, sleep: <ts>, workout: <ts>, cycle: <ts> }`.
- **Sync:** four parallel fetches via `Promise.all`.
- **Captures:** one event per record per kind. Kind-prefixed external_ids: `whoop:recovery:<id>`, etc.
- **MCP tools:** `whoop_recent({ kind?, limit? })`, `whoop_today()` (DB; "today" uses quiet_window's tz).

### 5c. Google Analytics 4 — ga

- **Cadence:** `1d`. **Embed:** true. **Capture mode:** upsert.
- **Secrets:** reuses `GOOGLE_OAUTH_*`. **OAuth scope:** `analytics.readonly`. **`GA4_PROPERTY_ID` required.**
- **First-call 403 detection:** body contains `"status": "PERMISSION_DENIED"` OR `"reason": "ACCESS_TOKEN_SCOPE_INSUFFICIENT"` OR scope-keyword in message. Sync logs re-auth instruction (`robin auth google --code`); next sync after re-auth succeeds.
- **Cursor:** `{ last_date: 'YYYY-MM-DD' }` — rolling 30-day window.
- **Captures:** one event per day per property. `external_id`: `ga:<property_id>:<YYYY-MM-DD>`.
- **MCP tools:** `ga_recent({ days? = 7 })` (DB).

### 5d. Local SQLite — chrome, lrc

#### Shared utility

`src/integrations/_local/sqlite.js`:

```js
import { copyFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';

export function readSqliteSnapshot({ srcPath, cacheDir, snapshotName, queryFn }) {
  if (!existsSync(srcPath)) {
    throw new Error(`source not found: ${srcPath}`);
  }
  mkdirSync(cacheDir, { recursive: true });
  const tmpPath = join(cacheDir, `${snapshotName}-${Date.now()}.sqlite`);
  copyFileSync(srcPath, tmpPath);
  let db;
  try {
    db = new Database(tmpPath, { readonly: true, fileMustExist: true });
    return queryFn(db);
  } finally {
    db?.close();
    try { unlinkSync(tmpPath); } catch {}
  }
}
```

Pattern: copy → query → delete. Cache dir: `${ROBIN_HOME}/cache/sqlite-snapshots/`. better-sqlite3 used solely as a transient client lib; never stores Robin data.

#### Manifest preflight

```js
export const manifest = {
  preflight: async () => {
    const path = resolveSource();
    if (!existsSync(path)) throw new Error(`source not found: ${path}`);
  },
};
```

`loadManifests` calls `await m.preflight?.()` after `validateManifest`. Failure → manifest moved to `unavailable` list. Daemon registry holds only `loaded`. CLI `integrations list` reads both lists.

#### chrome

- **Cadence:** `1d`. **Embed:** true. **Capture mode:** insert-or-skip.
- **Source:** `~/Library/Application Support/Google/Chrome/Default/History` (`CHROME_HISTORY_PATH` override).
- **Cursor:** `{ since_visit_id }`.
- **SQLite query:**
  ```sql
  SELECT v.id, v.visit_time, u.url, u.title, v.transition
  FROM visits v JOIN urls u ON v.url = u.id
  WHERE v.id > ?
  ORDER BY v.id DESC LIMIT 200
  ```
  `visit_time` conversion: `new Date((visit_time - 11644473600000000) / 1000)`.
- **Captures (two kinds):**
  - Per-visit: `external_id`: `chrome:visit:<visit_id>`.
  - Top-domains: `external_id`: `chrome:top_domains:<YYYY-MM-DD>`.
- **MCP tools:** `chrome_recent_visits({ limit? = 20 })`, `chrome_top_domains({ days? = 7 })`.

#### lrc

- **Cadence:** `1w`. **Embed:** true. **Capture mode:** upsert.
- **Source:** `LRC_CATALOG_PATH` env var.
- **Captures:** single weekly summary event. `external_id`: `lrc:<YYYY-MM-DD>`.
- **MCP tools:** `lrc_summary()` (DB).

### Tools needing secrets at handler time

- `linear_get_issue` — reads `LINEAR_PAT` via `requireSecret`
- (Google tools already follow this pattern from 2e)

## 6. CLI + MCP surface + AGENTS.md

### New CLI commands

```
robin auth google [--code [<CODE>]]
robin auth spotify [--code [<CODE>]]
robin auth whoop [--code [<CODE>]]
```

`--code` parsing per §2's table. Re-introduces auth CLIs that 2e removed — needed for headless flow + first-time provider onboarding.

### v1 env var name compatibility

**Plan Task 0 — verify v1 env var names:** grep v1's `auth-*.js` and `oauth.js` for actual env var names. Update v2's `secrets.env_keys` per integration if names diverge from §2/§4/§5 expectations.

| Integration | v2 expects | v1 source |
|---|---|---|
| weather | (none) | (none) |
| ebird | `EBIRD_API_KEY` | `auth-ebird.js` |
| nhl | (none) | (none) |
| linear | `LINEAR_PAT` | `auth-linear.js` |
| whoop | `WHOOP_REFRESH_TOKEN`, `WHOOP_CLIENT_ID`, `WHOOP_CLIENT_SECRET` | `auth-whoop.js` |
| ga | `GOOGLE_OAUTH_*` (already correct from 2e) | shared with gmail |
| spotify_write | `SPOTIFY_REFRESH_TOKEN`, `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET` | `auth-spotify.js` |

### Updated `integrations list`

```
gmail            15m         last=2026-05-10T14:30:00Z  OK
google_calendar  30m         last=2026-05-10T14:00:00Z  OK
google_drive     4h          last=2026-05-10T12:00:00Z  OK
youtube          1d          last=2026-05-10T04:00:00Z  OK
ga               1d          last=never                 ─
lunch_money      1d          last=2026-05-10T04:00:00Z  OK
weather          6h          last=2026-05-10T12:00:00Z  OK
ebird            12h         last=2026-05-10T08:00:00Z  OK
nhl              12h         last=2026-05-10T08:00:00Z  OK
linear           1h          last=2026-05-10T15:00:00Z  OK
whoop            30m         last=2026-05-10T05:00:00Z  OK
chrome           1d          last=2026-05-10T03:00:00Z  OK
lrc              1w          last=never                 ─
discord          gateway     ─                          ─
github_write     tool-only   ─                          ─
spotify_write    tool-only   ─                          ─
```

**16 total integrations.** Failure detail surfaces via `integrations status <name>`.

### MCP tools (new in 2f)

| Tool | Wraps | Live or DB |
|---|---|---|
| `weather_today()` | DB | DB |
| `ebird_recent({ days?, location_id?, limit? })` | DB | DB |
| `nhl_recent({ team?, limit? })` | DB | DB |
| `nhl_standings()` | DB | DB |
| `linear_active_issues({ team?, assignee?, limit? })` | DB | DB |
| `linear_get_issue({ identifier })` | live GraphQL | Live |
| `whoop_recent({ kind?, limit? })` | DB | DB |
| `whoop_today()` | DB | DB |
| `ga_recent({ days? })` | DB | DB |
| `chrome_recent_visits({ limit? })` | DB | DB |
| `chrome_top_domains({ days? })` | DB | DB |
| `lrc_summary()` | DB | DB |
| `spotify_write({ action, args })` | live API + outbound-policy + rate-limit + audit | Live + DB |

**13 new tools.** Phase 2e ended at 31 → Phase 2f → **44 total daemon surface.**

### AGENTS.md

Auto-section now lists 16 integrations. Outbound writes section gains spotify_write + rate-limiter language:

```markdown
## Outbound writes (github_write, spotify_write)

Use `github_write` for create-issue/comment/label/mark-read; `spotify_write` for queue/skip/playlist-add. Both go through:
1. Per-tool rate limit (default 10/hr, refuses with `rate_limited`)
2. Outbound-policy (PII / secret / verbatim-untrusted-quote)
3. The actual API call

If a write returns `{ ok: false, reason: 'rate_limited', wait_seconds: N }`, wait at least `N`s before retrying. DON'T loop on retry — the rate counter increments on every attempt.

If a write returns `{ ok: false, reason: 'outbound_blocked', blocked_by: '<policy reason>' }`, surface to user. DON'T paraphrase to bypass.

Audit trail differs by action:
- create-issue, comment, playlist-add → captured to events (recall searchable)
- label, mark-read, queue, skip → daemon log only
```

### `robin install` post-message

```
✓ robin v6.0.0-alpha.7 installed
ℹ Phase 2f added 8 read-sync integrations + spotify-write + headless OAuth.

If upgrading from 2e:
  - existing Google integrations keep working (token cache migrated transparently)
  - Whoop / Spotify: if not already in .env (post-import), run `robin auth whoop` / `robin auth spotify`
  - GA4 needs analytics.readonly scope: robin auth google --code
  - chrome/lrc: ensure source files exist; check `robin integrations list`

Note: better-sqlite3 native dep added. If postinstall failed:
  macOS: `xcode-select --install` then rerun `npm install`
```

## 7. Testing strategy + open questions + success criteria

### Testing strategy

**OAuth + token cache:** PROVIDERS validation, `ensureFreshToken` per provider, rotation only for `rotatesRefreshToken: true`, unknown provider throws, per-provider singleton, refresh-promise dedup, saveSecret success + failure, `_resetCache(provider)` isolation, `runHeadlessAuth` with stub `readCode`, CLI `robin auth google [--code]` paths.

**Rate limiter:** empty → ok, 10 → 11th refused, 1h elapsed (mock.timers) → reset, env override, malformed `recent_writes` recovery, soft-cap overshoot documented.

**spotify-write:** 3 actions × happy path, missing-arg refusals, 404 → no_active_device, 403 premium → premium_required, missing-secret → not_authenticated, 100/101 track boundary, rate-limit short-circuit before policy.

**Per-integration unit tests** (~4 each × 8 = ~32 tests): weather/ebird/nhl/linear/whoop/ga/chrome/lrc — sync + tool tests each. Local-SQLite tests use fixture SQLite in `/tmp`.

**Quiet-window scheduler:** Whoop manifest with quiet_window; advances next_run_at correctly. Mocks date via mock.timers.

**Manifest preflight:** preflight throws → `unavailable` list; clean → `loaded`. CLI `integrations list` reads both.

**Integration tests:**
- oauth-multi-provider (gmail + spotify_write parallel; per-provider lock independence)
- spotify-rotation-roundtrip (saveSecret stub called with new token)
- whoop-quiet-window (next_run_at advance to next 4am)
- ga-scope-error (403 → re-auth → success)
- chrome-snapshot (fixture SQLite → events table)
- integrations-list-unavailable (preflight failure surfaces in CLI)

**Manual smoke before tag** — Kevin's local machine:
- `robin auth google --code` round-trip (re-auth with full scope union including analytics.readonly)
- Real chrome + lrc sync against Kevin's local files
- spotify-write `queue` against Kevin's active Spotify session
- whoop sync within the 4-9am window

### Open questions / known limitations

| # | Item | Resolution |
|---|---|---|
| 1 | better-sqlite3 native binding | Prebuilds for darwin/linux x64/arm64; postinstall compile fallback. `xcode-select --install` if compile fails. |
| 2 | Whoop quiet_window DST corner cases | Acceptable per Intl.DateTimeFormat; fall-back hour duplication doesn't overlap 4-9am window. |
| 3 | Rate limiter race condition | Soft cap; small overshoot acceptable. Mutex deferred. |
| 4 | saveSecret failure during refresh-token rotation | In-memory cache survives; logged warning; user re-auths if .env stays stale. |
| 5 | GA4 error detection | Detects via `PERMISSION_DENIED` / `ACCESS_TOKEN_SCOPE_INSUFFICIENT` / scope keyword. Robust against minor Google format changes. |
| 6 | spotify-write authorization for non-collaborator playlists | Spotify treats public playlists as immutable; tool returns API's 403 verbatim. |
| 7 | 16 total integrations — long table | `robin integrations list` becomes long. Acceptable; could add filtering in 2g. |
| 8 | Chrome locked-file copy may fail on Windows | Section assumes macOS / Linux. Documented as macOS/Linux-only. |
| 9 | Preflight runs at boot only, not periodically | If user grants access mid-session, daemon doesn't pick up until restart. Acceptable. |

### Success criteria for v6.0.0-alpha.7

- 13 new MCP tools registered (44 total daemon surface).
- v1 env var names verified at Task 0; manifests updated to match if needed.
- OAuth refactor: all 4 Phase 2e Google integrations pass tests with new `getAccessToken({ provider: 'google', ... })` signature; no behavior regression.
- Spotify refresh-token rotation triggers `saveSecret` callback with new token (via test stub).
- Whoop quiet_window correctly skips outside 4-9am EDT in test (mocked date) + manual smoke.
- GA4 scope-error → re-auth → success flow demonstrated in integration test.
- Local-SQLite snapshot pattern works against fixture files; preflight correctly skips when source absent.
- Rate limiter exercised for both github_write and spotify_write.
- Manifest preflight integrates cleanly: `integrations list` shows unavailable rows.
- AGENTS.md regenerates with 16 integrations + updated outbound-writes language.
- `npm test` passes (target ~467 tests, +73 from 2e). `npm run lint` clean.
- 16 integrations total in `integrations list`.
- Manual smoke checklist completed.
- CHANGELOG entry + `v6.0.0-alpha.7` tag.
