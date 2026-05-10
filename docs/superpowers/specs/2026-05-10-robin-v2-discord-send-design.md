# Robin v2 — `discord_send` MCP tool

**Status:** Design (pre-implementation)
**Date:** 2026-05-10
**Predecessors:** Phase 2d (`v6.0.0-alpha.5`, integrations + discord gateway), Phase 2f (`v6.0.0-alpha.7`, `spotify_write` + sliding-1h rate limiter).
**Phase note:** A Phase 2g leftover, not part of the Phase 4 envelope. Small, additive, no schema change.

---

## 1. Goal

Give the agent a way to send Discord messages through Robin's existing in-process discord gateway. Mirror the shape of `github_write` and `spotify_write` so the existing outbound-policy + rate-limit + capture story applies unchanged.

## 2. Out of scope

- Threads as a first-class action (parent-guild allowlist still works — sending into a thread channel is treated like any other channel).
- @-mentions (raw text only; if the agent writes `<@123>` the recipient sees the mention, but no helper renders one for it).
- Message edit/delete, reactions, file uploads, voice, embeds. None of that is in v1 either.
- Adding new secrets. Reuses `DISCORD_BOT_TOKEN` / `DISCORD_ALLOWED_USER_IDS` / `DISCORD_ALLOWED_GUILD_IDS`.

## 3. Surface

Tool factory at `src/integrations/discord/tools/discord-send.js`, registered via `manifest.tools`:

```ts
{
  name: 'discord_send',
  description: 'Send a Discord DM or channel message through robin\'s gateway. Allowlist-gated.',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['send_dm', 'send_channel'] },
      args: { type: 'object' }
    },
    required: ['action', 'args']
  }
}
```

`args` shapes:

- `send_dm`: `{ user_id: string, content: string }`
- `send_channel`: `{ channel_id: string, content: string }`

Return shape mirrors `spotify_write`:

- success: `{ ok: true, message_id, channel_id }`
- failure: `{ ok: false, reason: '...', detail?: '...' }`

## 4. Gates (in order)

1. **Rate limit** — `checkRateLimit(db, 'discord_send')` with default 10/hr; override via `DISCORD_SEND_RATE_LIMIT` env var (mirrors `GITHUB_WRITE_RATE_LIMIT` / `SPOTIFY_WRITE_RATE_LIMIT`).
2. **Args present** — refuse with `{ ok: false, reason: 'missing_arg', arg: '...' }` if `user_id`/`channel_id`/`content` missing or empty.
3. **Content cap** — Discord's hard limit is 2000 chars. Refuse with `{ ok: false, reason: 'content_too_long', max: 2000, given: N }`. (Refuse, not truncate, to match spotify_write playlist-add behavior.)
4. **Gateway live** — refuse with `{ ok: false, reason: 'discord_not_running' }` if `getGatewayClient('discord')` returns `null`. The discord integration only boots when its bot token is set.
5. **Allowlist** — read `DISCORD_ALLOWED_USER_IDS` and `DISCORD_ALLOWED_GUILD_IDS` from `.env` on each call (cheap, dotenv-cached) so admin updates take effect without a daemon restart. For `send_dm`: `user_id` ∈ user-id list. For `send_channel`: fetch the channel, check `channel.guildId` against guild-id list. Threads pass via their parent guild (`channel.guildId` exists on thread channels in discord.js v14). Refuse with `{ ok: false, reason: 'not_allowed' }`.
6. **Outbound policy** — `checkOutbound(db, { destination: 'discord_send', text: content })`. PII / secret / verbatim-untrusted-quote patterns. Refusals are auto-logged to `outbound_refusals` by `checkOutbound`.

## 5. Capture on success

Capture sent message to `events`:

```js
{
  source: 'discord_send',
  content: content.slice(0, 200),
  external_id: message.id,
  meta: {
    action,                  // 'send_dm' | 'send_channel'
    target: action === 'send_dm' ? { user_id } : { channel_id, guild_id },
    length: content.length,
  }
}
```

Same insert-or-skip dedup as other write surfaces; the `external_id` is the Discord message snowflake which is unique by definition.

## 6. Daemon plumbing change

`src/daemon/server.js` already keeps `gatewayClients = new Map()`. Add a `getGatewayClient` lookup to the factory ctx so tool factories can reach the live `Client` at handler time:

```js
const tool = factory({
  db: dbHandle,
  embedder: embedderWrap,
  capture: reg?.capture,
  getGatewayClient: (name) => gatewayClients.get(name) ?? null,
});
```

Existing factories (`github-write`, `spotify-write`) ignore the new field — additive change. The existing factory invocations in `src/integrations/discord/start.js` are unchanged; the gateway still owns the `Client` lifecycle.

## 7. Manifest change

`src/integrations/discord/manifest.js`:

```diff
- tools: [],
+ tools: [createDiscordSendTool],
```

Where `createDiscordSendTool` is imported from `./tools/discord-send.js`.

## 8. Tests

All unit, no new integration test (would require a real Discord gateway):

- **Tool exists + schema** — registered, `name === 'discord_send'`, schema validates the two action shapes.
- **Missing args** — each of `user_id`, `channel_id`, `content` empty/missing → `missing_arg`.
- **Rate limit** — stub `checkRateLimit` to return `{ ok: false, reason: 'rate_limited', retry_after_s: 1234 }` → propagated unchanged.
- **Content cap** — 2001-char content → `content_too_long`.
- **Gateway not running** — `getGatewayClient` returns `null` → `discord_not_running`.
- **DM allowlist miss** — `user_id` not in allowlist → `not_allowed`.
- **Channel allowlist miss** — channel's `guildId` not in allowlist → `not_allowed`.
- **Outbound refusal** — text contains a PII pattern → `outbound_blocked` with `blocked_by: 'pii:...'`; one row written to `outbound_refusals`.
- **Happy-path DM + channel** — mocked client.send returns `{ id: '<snowflake>' }`; one event captured with the right shape.
- **Thread channel** — mocked thread channel with `isThread() === true` and a parent `guildId` in allowlist sends successfully.

Test file: `tests/unit/discord-send.test.js`. Mocked `Client` with stubbed `users.fetch` / `channels.fetch` / `.send` per discord.js v14 surface.

## 9. AGENTS.md

The existing `<!-- robin-integrations:start -->` Outbound writes section already lists `github_write` and `spotify_write`. Append `discord_send` with the same shape. The section regenerator (`src/install/agents-md.js`) builds from manifest data, so adding the tool factory should auto-include it on next regen — verify in implementation that the regenerator picks up tool-only entries on a gateway integration.

## 10. Telemetry / observability

No new tables. Existing surfaces:

- Successes: events row + daemon stdout (`[discord_send] sent dm to <user> · <N> chars`).
- Refusals: `outbound_refusals(direction='outbound')` row, surfaced via `robin refusals list`.
- Rate-limited counts: existing `runtime:outbound_rate.discord_send` sliding window.

## 11. Risk register

- **Misuse via spoofed `channel_id`.** Mitigated by the channel-fetch + guild-allowlist check. Discord's REST API rejects unknown IDs with 404 → mapped to `{ ok: false, reason: 'channel_not_found' }`.
- **DM to a user who has DMs closed.** discord.js throws `DiscordAPIError[50007]` (Cannot send messages to this user). Map to `{ ok: false, reason: 'dms_closed' }`.
- **Allowlist drift after start.** Two code paths read `DISCORD_ALLOWED_*`: the gateway's `messageCreate` handler reads at boot (for inbound message gating), and `discord_send` reads on each call (for outbound gating). Admin updates take effect for outbound writes immediately; inbound gating still needs a daemon restart, same as today.
- **Bot token rotation.** Out of scope. Same as today: `robin auth discord` rewrites `.env`, daemon must restart to pick up the new token.

## 12. Migration / rollout

No migration. Strictly additive. After merge:

1. Restart daemon (`robin mcp restart`) so the new tool factory binds to the live gateway.
2. Verify with `robin integrations list` (discord row unchanged) and an MCP `tools/list` from a fresh agent session.

No hook change → no `robin install --hooks-only` needed.
