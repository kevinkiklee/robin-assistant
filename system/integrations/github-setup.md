# GitHub setup — activity sync

Read-only token. Pulls your last-30-days events, releases from your
starred repos, and (with caveats) notifications.

## 1. Generate a fine-grained PAT

1. Open https://github.com/settings/personal-access-tokens/new
2. **Token name:** `robin-sync` (anything works)
3. **Expiration:** your call — 90 days or 1 year are reasonable
4. **Resource owner:** your account (or an org if you want Robin to see
   org repos)
5. **Repository access:** "All repositories" or pick specific ones
6. **Permissions** → Repository:
   - Contents: Read-only
   - Issues: Read-only
   - Metadata: Read-only (auto-required)
   - Pull requests: Read-only
7. **Generate token** → copy the value (starts with `github_pat_`)

## 2. Add to `.env`

```env
GITHUB_PAT=<github_pat_...>
```

## 3. Validate, bootstrap, enable

```sh
node user-data/ops/scripts/auth-github.js          # validates PAT, prints user + rate limit
node user-data/ops/scripts/sync-github.js --bootstrap
node bin/robin.js jobs enable sync-github
```

## Notifications limitation (fine-grained PATs)

GitHub's `/notifications` endpoint is **not exposed to fine-grained PATs**
as of this writing — there's no "Notifications" permission to grant.
`sync-github` detects the resulting `403` and skips notifications
gracefully; the rest of the sync (activity, releases) still works.

If you want notification sync, you have two options:

1. **Use a classic PAT** with the `notifications` scope (less granular —
   classic PATs are scoped per-account, not per-repo). Generate at
   https://github.com/settings/tokens — set scope `notifications` plus
   whatever repo access you want, then paste it as `GITHUB_PAT` in `.env`.
2. **Skip it** — check notifications in the GitHub UI or the GitHub MCP
   server (if your AI host supports one).

## Stars and releases

`sync-github` checks the `/releases` endpoint of every repo *you have
starred* (capped at 50) for new releases in the last 30 days. If you have
zero starred repos, the releases section will be empty. This is about
repos *you've starred*, not repos that have starred your projects.

## Scopes (recap)

| Permission | Scope | Used for |
|---|---|---|
| Contents | Read | Listing releases |
| Metadata | Read | Auto-required by GitHub |
| Issues | Read | Issue events in activity |
| Pull requests | Read | PR events in activity |
| (none for notifications — see above) | | |
