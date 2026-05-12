# Robin v2 Phase 2e — .env Secrets Layer + Calendar/Drive/YouTube + github_write

**Date:** 2026-05-09
**Status:** Approved (sections 1-6 brainstormed and iterated)
**Predecessor:** Phase 2d shipped at v6.0.0-alpha.5 (`e58a915`).
**Target tag:** v6.0.0-alpha.6

## 1. Scope and decomposition

Phase 2e ships:

1. **Secrets layer rework.** Replaces Phase 2d's per-integration JSON files (`~/.robin/secrets/<name>.json`) with a single .env at `${ROBIN_HOME}/secrets/.env`, read on-demand via `requireSecret(key)` / `saveSecret(key, value)` helpers modeled on v1's `system/scripts/sync/lib/secrets.js` (lazy reads, no `process.env` pollution, atomic writes). v2 is alpha-only — JSON files are deleted cleanly, no fallback shim.

2. **`robin secrets import --from <path> [--force]` CLI** — one-shot copy that reads `<path>/runtime/secrets/.env` (or `<path>` if it ends in `.env`), writes to `${ROBIN_HOME}/secrets/.env` with 0600 perms. Refuses if v2 .env exists unless `--force`. No path auto-detection; error message suggests `~/workspace/robin/robin-assistant/user-data` for Kevin's setup.

3. **Phase 2d auth CLIs deprecated and removed.** `robin auth gmail/lunch_money/discord` files deleted. The OAuth loopback code in `_auth/oauth2-google.js` stays for 2f's headless OAuth.

4. **Three new read-sync integrations** all reusing `GOOGLE_OAUTH_REFRESH_TOKEN` + `GOOGLE_OAUTH_CLIENT_ID` + `GOOGLE_OAUTH_CLIENT_SECRET`:
   - **google_calendar** (30m, ±14d window, upsert mode)
   - **google_drive** (4h, 30d/200-cap first sync, upsert mode)
   - **youtube** (24h, full re-scan, insert-or-skip)

5. **github_write MCP tool** — 4 actions (`create-issue`, `comment`, `label`, `mark-read`). Text actions route through `outbound-policy.js`; non-text actions skip the policy. Reads `GITHUB_PAT` from .env. **Tool-only integration** (third manifest kind alongside sync/gateway).

6. **Phase 2d integrations migrated** to read .env keys instead of JSON files. Gmail uses `GOOGLE_OAUTH_*`, Lunch Money uses `LUNCH_MONEY_API_KEY`, Discord uses `DISCORD_BOT_TOKEN` + `DISCORD_ALLOWED_USER_IDS` + `DISCORD_ALLOWED_GUILD_IDS` + `DISCORD_APPLICATION_ID` (comma-sep where multi-valued). Names verified against v1 verbatim.

7. **No schema migration.** Migration 0007 already accepts arbitrary `events.source` strings. Secrets layer is filesystem-only.

8. **Migration order** (release-note step, not fallback shim): user runs `robin secrets import --from <v1-user-data>` once. Without that step every integration fails with "missing secret: <KEY>". Documented in CHANGELOG and `robin install` post-message. Daemon also logs a one-line warning at boot if `${ROBIN_HOME}/secrets/.env` is missing entirely.

Not in 2e: spotify-write (2f), headless OAuth `--code` flag (2f), rate limiter (deferred until needed), other v1 integrations.

## 2. Secrets layer

### File and helper

`${ROBIN_HOME}/secrets/.env` — POSIX dotenv format. Key=value lines, no quotes. Comments `# ...` and blank lines ignored. Malformed lines (no `=`) silently skipped, matching v1. 0600 perms enforced on every write.

```js
// src/secrets/dotenv-io.js
export function requireSecret(key);     // throws "missing secret: <key>"
export function getSecret(key);         // returns null if missing
export function saveSecret(key, value); // atomic temp-then-rename, preserves siblings, 0600
export function importFrom(srcPath, { force = false }); // atomic temp-then-rename
```

Atomic temp-then-rename in both `saveSecret` and `importFrom` means daemon's occasional refresh-token rotation can't corrupt the file mid-write. Last-write-wins is acceptable for single-user setup.

Lazy reads — every `requireSecret(key)` re-parses (1-3ms; called 2-3x/session). Matches v1; prevents stale-cache bugs after rotation.

### Manifest signature change

```js
// src/integrations/gmail/manifest.js (post-2e)
export const manifest = {
  name: 'gmail',
  cadence: '15m',
  embed: true,
  capture_mode: 'insert-or-skip',
  secrets: {
    env_keys: ['GOOGLE_OAUTH_REFRESH_TOKEN', 'GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET'],
  },
  sync,
  tools: [createGmailSearchTool, createGmailGetThreadTool],
};
```

`secrets.env_keys` optional, defaults to `[]`. The `auth: { kind, scopes }` field from 2d is dropped.

Both sync AND gateway integrations receive uniformly-shaped `ctx.secrets`:

```js
// In runIntegrationSync (sync) and start() (gateway), building ctx
const secrets = {};
for (const key of manifest.secrets?.env_keys ?? []) {
  // Lazy reader: each access re-reads file, picking up rotations mid-session.
  // Synchronous throw on missing key caught by runIntegrationSync's try/catch.
  Object.defineProperty(secrets, key, { get: () => requireSecret(key), enumerable: true });
}
ctx.secrets = secrets;
ctx.saveSecret = saveSecret;  // for token rotation (Spotify 2f mostly)
```

### CLI

```
robin secrets import --from <path> [--force]   # copy v1 .env to v2 location
robin secrets list                             # key NAMES only, NEVER values or partial values
robin secrets set <KEY>                        # interactive prompt, no echo
robin secrets set <KEY>=<value>                # accepted, warns about shell history
```

Unknown keys (e.g. `EBIRD_API_KEY` for an integration not ported) sit unused; v2 only reads keys it asks for.

### Loading semantics

Daemon does NOT proactively check required env keys at registration. Integrations load even with missing secrets; first `sync()` surfaces `last_sync_error: "missing secret: X"` and `consecutive_failures` ticks per backoff logic. Matches v1's lazy behavior.

Daemon DOES log a one-line warning at boot if `${ROBIN_HOME}/secrets/.env` doesn't exist:

```
[daemon] no secrets file at ${ROBIN_HOME}/secrets/.env — integrations will fail.
         Run: robin secrets import --from <v1-user-data>  (or `robin secrets set <KEY>` per integration)
```

### Daemon-running interaction

All `secrets *` CLIs touch `${ROBIN_HOME}/secrets/.env`, NOT the SurrealDB. Don't need the file lock. Safe alongside running daemon. Daemon picks up new values on next `requireSecret` call — no restart needed for re-auth or rotation. (Improvement over 2d's "restart the daemon" requirement.)

## 3. Calendar / Drive / YouTube integrations

### Shared OAuth concerns

`src/integrations/_auth/google-token-cache.js` — singleton:

```js
let cached = null;             // { access_token, expires_at }
let refreshPromise = null;     // dedupe concurrent refreshes

export async function getGoogleAccessToken({ secrets, fetchFn }) {
  const now = Date.now();
  if (cached && cached.expires_at - now > 60_000) return cached.access_token;
  if (refreshPromise) return refreshPromise.then((c) => c.access_token);
  refreshPromise = doRefresh(secrets, fetchFn).finally(() => { refreshPromise = null; });
  cached = await refreshPromise;
  return cached.access_token;
}
```

In-memory only. **No disk cache.** Daemon restart costs one extra token refresh (~200ms). Refresh-promise singleton prevents concurrent refreshes from gmail+calendar+drive+youtube.

`refresh_token` rotation: `ctx.saveSecret('GOOGLE_OAUTH_REFRESH_TOKEN', new_value)` writes to .env.

### google_calendar

| Field | Value |
|---|---|
| **Cadence** | `30m` |
| **Embed** | `true` |
| **Capture mode** | `upsert` |
| **Window** | events ±14d from now |
| **Cursor** | `{ updated_min }` — first sync: no `updatedMin`; subsequent: saved cursor |
| **Content** | `"<summary> · <start_iso> – <end_iso> · <attendee_count> attendees"`. Cancelled: `"[CANCELLED] <summary> ..."` (upsert overwrites; latest state wins) |
| **Meta** | `{ event_id, calendar_id, status, organizer_email, attendees, location, html_link, etag }` |
| **External_id** | `event_id` |
| **MCP tools** | `calendar_list_events({ since?, until?, limit? = 50 })` (DB); `calendar_get_event({ event_id })` (LIVE — current state, not stale snapshot) |

API: `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=...&timeMax=...&updatedMin=...&singleEvents=true&maxResults=250`. Pagination via `nextPageToken`.

### google_drive

| Field | Value |
|---|---|
| **Cadence** | `4h` |
| **Embed** | `true` |
| **Capture mode** | `upsert` |
| **First sync** | `files.list?q=modifiedTime > '<30d ago>'&orderBy=modifiedTime desc`, capped at **200 most-recent**, then `changes.getStartPageToken` saved as cursor |
| **Cursor** | `{ start_page_token }` — `changes.list?pageToken=<saved>` for delta after first sync |
| **Content** | `"<name> · <mimeType> · modified <date> · owner <owner_email>"` |
| **Meta** | `{ file_id, mime_type, web_view_link, owners, modified_time, parents, shared, size }` |
| **External_id** | `file_id` |
| **MCP tools** | `drive_search({ query, limit? = 20 })` (live `files.list?q=name contains 'X'`); `drive_get_file({ file_id })` (live; metadata always; body for text mimes ≤**100KB**, refuses larger with `web_view_link`). Google Workspace formats need `files.export` not `files.get`; **2e supports Docs export to text/plain only**, Sheets/Slides return metadata + browser link |

Body content NEVER captured at sync time.

### youtube

| Field | Value |
|---|---|
| **Cadence** | `24h` |
| **Embed** | `true` |
| **Capture mode** | `insert-or-skip` |
| **Cursor** | `{ last_run_at }` (full re-scan; dedup via external_id) |
| **Sync execution** | Three top-level fetches in parallel via `Promise.all`; each paginates sequentially internally |
| **Content (sub)** | `"sub: <channel_title> (<subscriber_count> subs)"` |
| **Content (playlist)** | `"playlist: <title> (<item_count> videos)"` |
| **Content (liked)** | `"liked: <video_title> · <channel_title>"` |
| **Meta** | per-kind: `{ kind: 'subscription'|'playlist'|'liked_video', channel_id?, playlist_id?, video_id? }` |
| **External_id** | `sub:<channel_id>`, `playlist:<playlist_id>`, `liked:<video_id>` |
| **MCP tools** | `youtube_list_subscriptions({ limit? = 50 })`, `youtube_list_liked({ limit? = 50 })` (DB; max 200) |

**Known limitation:** unsubscribe detection. Old subscriptions stay as events. Stale-state cleanup deferred to 2f.

## 4. github_write integration + outbound writes

### Three integration kinds

| Kind | Detected by | Examples |
|---|---|---|
| **sync** | `cadence_ms !== null` AND `manifest.sync` | gmail, lunch_money, calendar, drive, youtube |
| **gateway** | `cadence_ms === null` AND `manifest.start` | discord |
| **tool-only** | `cadence_ms === null` AND no `start` AND `tools.length > 0` | github_write |

Daemon's manifest-loop in `src/daemon/server.js` adds an explicit branch for tool-only: skip scheduler-cursor seeding AND `start()` call, just register tools.

### Manifest

```js
// src/integrations/github_write/manifest.js
import { createGitHubWriteTool } from './tools/github-write.js';

export const manifest = {
  name: 'github_write',
  cadence: null,
  embed: true,                    // create-issue/comment captures are searchable
  capture_mode: 'insert-or-skip',
  secrets: { env_keys: ['GITHUB_PAT'] },
  tools: [createGitHubWriteTool],
};
```

### `github_write` MCP tool

```ts
github_write({
  action: 'create-issue' | 'comment' | 'label' | 'mark-read',
  args: {
    // create-issue
    repo?: string,           // 'owner/repo'
    title?: string,
    body?: string,
    labels?: string[],

    // comment
    issue_id?: number,
    body?: string,           // (overloaded)

    // label
    issue_id?: number,
    add?: string[],
    remove?: string[],

    // mark-read
    notification_id?: string,
  }
}) → { ok: true, url, id } | { ok: false, reason, blocked_by? }
```

### Outbound policy routing

| Action | Policy applied to | Captures audit row? |
|---|---|---|
| `create-issue` | `title + '\n' + body + '\n' + labels.join(',')` | Sent → events row (`source='github_write'`, `external_id='<repo>:<number>'`). Blocked → outbound_refusals row. |
| `comment` | `body` | Sent → events row (`external_id='<repo>:<number>:<comment_id>'`). Blocked → outbound_refusals row. |
| `label` | (no text — skip policy) | Daemon log only. |
| `mark-read` | (no text) | Daemon log only. |

**Asymmetric audit by design:** `recall('issue I labeled with bug')` won't find anything; only text writes become events. Documented in AGENTS.md.

Deterministic ID hashes the slash in `<repo>` (per Phase 2d sanitize), but readable `meta.repo`/`meta.number` round-trip cleanly.

### Implementation

```js
// src/integrations/github_write/client.js
import { requireSecret } from '../../secrets/dotenv-io.js';

async function githubFetch(path, { method = 'GET', body, fetchFn = globalThis.fetch }) {
  const r = await fetchFn(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${requireSecret('GITHUB_PAT')}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`github ${path} ${r.status}: ${await r.text().catch(() => '')}`);
  return r.status === 204 ? null : await r.json();
}

export async function createIssue({ repo, title, body, labels });    // POST /repos/<repo>/issues
export async function addComment({ repo, issue_id, body });          // POST /repos/<repo>/issues/<id>/comments
export async function applyLabels({ repo, issue_id, add, remove });  // sequential POST add + DELETE remove
export async function markNotificationRead({ notification_id });     // VERIFY against v1 — likely DELETE /notifications/threads/<id>
```

### Tool handler

Factory takes a pre-built capture closure (reuses 2d's `createCapture`):

```js
export function createGitHubWriteTool({ db, capture }) {
  return {
    name: 'github_write',
    description: 'Write to GitHub: create-issue, comment, label, or mark-read.',
    inputSchema: { /* full per-action schema; required: action */ },
    handler: async (args) => {
      switch (args.action) {
        case 'create-issue': {
          const a = args.args;
          const text = `${a.title}\n${a.body ?? ''}\n${(a.labels ?? []).join(',')}`;
          const policy = await checkOutbound(db, { destination: 'github_write', text });
          if (!policy.ok) return { ok: false, reason: 'outbound_blocked', blocked_by: policy.reason };
          const r = await createIssue(a);
          await capture([{
            source: 'github_write',
            content: text,
            external_id: `${a.repo}:${r.number}`,
            meta: { action: 'create-issue', repo: a.repo, number: r.number, url: r.html_url },
          }]);
          return { ok: true, url: r.html_url, id: r.number };
        }
        // ...comment / label / mark-read
        default:
          return { ok: false, reason: 'unknown_action', action: args.action };
      }
    },
  };
}
```

### `integrations list` and `integration_run` for tool-only

- `integrations list` reads from BOTH manifest registry AND `runtime:scheduler.integrations`. Tool-only shows as `<name>  tool-only  ─`.
- `integration_run({ name: 'github_write' })` refuses with `{ ok: false, reason: 'tool_only_no_sync' }` (new enum value).

### Rate limit (deferred)

GitHub PATs default 5,000 req/hour. No rate limiter in 2e. **2f follow-up** if it becomes an issue.

## 5. CLI + MCP surface + AGENTS.md

### New CLI commands

```
robin secrets import --from <path> [--force]
robin secrets list                             # key NAMES only
robin secrets set <KEY>                        # interactive (no echo)
robin secrets set <KEY>=<value>                # accepted, warns about shell history
```

### Removed CLI commands and files (deleted in 2e)

```
src/cli/commands/auth-gmail.js
src/cli/commands/auth-lunch-money.js
src/cli/commands/auth-discord.js
src/cli/index.js — `auth` branch removed
src/integrations/_auth/secrets-io.js — replaced by src/secrets/dotenv-io.js
```

OAuth helper code in `_auth/oauth2-google.js` stays (used by 2f's headless OAuth; Phase 2d unit tests remain).

### Secrets-io.js consumers requiring migration

All rewired from `readSecrets(name) → JSON object` to `requireSecret(KEY) → string`:
- `src/integrations/gmail/sync.js` (via `ensureFreshToken` migration)
- `src/integrations/gmail/tools/gmail-search.js`
- `src/integrations/gmail/tools/gmail-get-thread.js`
- `src/integrations/lunch_money/sync.js`
- `src/integrations/discord/start.js`
- `src/integrations/_auth/oauth2-google.js` (writeback paths)
- `tests/unit/auth-*.test.js` assertions on writeSecrets()

### Updated CLI

`robin integrations list` reads from BOTH manifest registry AND scheduler runtime row, merging:

```
$ robin integrations list
gmail            15m         last=2026-05-09T14:30:00Z  OK
lunch_money      1d          last=2026-05-09T04:00:00Z  OK
google_calendar  30m         last=never                 ─
google_drive     4h          last=never                 ─
youtube          1d          last=never                 ─
discord          gateway     ─                          ─
github_write     tool-only   ─                          ─
```

### MCP tools

| Tool (new in 2e) | Wraps | Live or DB |
|---|---|---|
| `calendar_list_events({ since?, until?, limit? })` | curated SurrealQL | DB |
| `calendar_get_event({ event_id })` | live API | Live |
| `drive_search({ query, limit? })` | live `files.list` | Live |
| `drive_get_file({ file_id })` | live `files.get` (+ `files.export` for Docs, ≤100KB body fetch) | Live |
| `youtube_list_subscriptions({ limit? })` | curated SurrealQL | DB |
| `youtube_list_liked({ limit? })` | curated SurrealQL | DB |
| `github_write({ action, args })` | live API + outbound-policy + audit capture | Live + DB write |

Total daemon surface: **24 + 7 = 31 tools**.

`integration_run` enum gets new reason: `tool_only_no_sync`.

### AGENTS.md

Auto-section restructured into three regenerated sub-blocks (all inside one fence):

```markdown
<!-- robin-integrations:start (auto-generated, do not hand-edit) -->
## Integration data freshness
[unchanged from 2d]

## Outbound writes (github_write)

Use `github_write` for create-issue, comment, label, mark-read. Text content
(create-issue body, comment body) passes through outbound-policy — PII /
secret / verbatim-untrusted-quote checks. If blocked, the tool returns
{ ok: false, reason: 'outbound_blocked', blocked_by: '<policy reason>' };
DON'T retry by paraphrasing to bypass the guard — surface the block to the
user and ask for guidance.

create-issue and comment writes are captured to events (recall searchable);
label and mark-read are NOT captured (no text content). Don't expect
recall('issue I labeled X') to find anything.

## Available integrations
[regenerated list]
<!-- robin-integrations:end -->
```

### `robin install` post-message

```
✓ robin v6.0.0-alpha.6 installed
ℹ Phase 2e changed the secrets layer: integrations now read from
  ${ROBIN_HOME}/secrets/.env, not per-integration JSON files.

  If upgrading from 2d:
    rm -rf ${ROBIN_HOME}/secrets/*.json
    robin secrets import --from /path/to/v1/user-data
```

## 6. Testing strategy + open questions + success criteria

### Testing strategy

**New unit tests:**
- `dotenv-io` (requireSecret throws / getSecret null / saveSecret atomic / importFrom force)
- `secrets-cli-list` (names only)
- `secrets-cli-import` (copy with 0600, refuses without --force)
- `google-token-cache` (refresh-promise singleton dedupes)
- `calendar-sync` (first-sync ±14d, delta updatedMin, cancelled prefix)
- `drive-sync` (first-sync 30d/200, delta page_token, metadata-only)
- `drive-tools` (search shape, get_file 100KB cap, Workspace metadata-only)
- `youtube-sync` (parallel three top-level, per-kind external_id format)
- `github-write-tool` (4 actions, policy text-only, blocked → outbound_blocked, tool-only refuses run)
- `manifest-tool-only` (third kind detection)
- `agents-md-2e` (three-sub-block structure, outbound-writes caveat)

**Updated unit tests:**
- All Phase 2d auth tests rewritten to `requireSecret` / `saveSecret`
- 2d gmail/discord tool tests get same treatment
- `agents-md-integrations.test.js` updated to expect new integrations

**New integration tests:**
- `secrets-import-roundtrip` (write fake v1 .env to tmp; import; readable via requireSecret)
- `google-shared-oauth` (gmail+calendar+drive hit one mocked refresh; assert single fetch)
- `calendar-rolling-window` (first → delta; cancelled tracked across both)
- `youtube-three-kinds` (single sync produces three event kinds)
- `github-write-roundtrip` (create-issue policy passes → events row; comment PII blocks → refusals; label no event)

### Open questions / known limitations

| # | Item | Resolution |
|---|---|---|
| 1 | YouTube unsubscribe detection | Deferred to 2f |
| 2 | Drive Workspace Sheets/Slides metadata only | Documented |
| 3 | github_write rate limiter | Deferred to 2f |
| 4 | Concurrent .env writes between v1+v2 daemons | Atomic temp-rename mitigates; both running unsupported |
| 5 | No proactive missing-key check | Lazy; matches v1 |
| 6 | OAuth helper unused in 2e | Reserved for 2f headless |
| 7 | `auth` CLI removed; users edit .env or use `secrets set` | Documented in install post-message |

### Success criteria for v6.0.0-alpha.6

- 7 new MCP tools registered; daemon exposes 31 tools.
- `robin secrets import --from <v1-path>` round-trips v1 .env to v2 with 0600 perms.
- Calendar/Drive/YouTube sync against mocked APIs in tests; manual smoke against real APIs before tag.
- github_write all 4 actions exercised manually with policy gating.
- `npm test` passes (target ~370 tests, +30 from 2d). `npm run lint` clean.
- All references to deleted `secrets-io.js` removed; no orphan imports.
- AGENTS.md auto-section regenerates with all 7 integrations + outbound-writes caveat.
- `robin integrations list` shows all with appropriate kind labels.
- CHANGELOG entry + `v6.0.0-alpha.6` tag.
