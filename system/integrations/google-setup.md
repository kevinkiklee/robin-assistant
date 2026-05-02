# Google setup — Calendar + Gmail sync

A single OAuth client covers both. Read-only scopes: Robin never writes to
your calendar or sends mail.

## 1. Create the OAuth client

1. Open https://console.cloud.google.com/apis/credentials and pick a
   project (create one if needed — "Robin" is fine).
2. **Enable the APIs** in the same project:
   - Google Calendar API: https://console.cloud.google.com/apis/library/calendar-json.googleapis.com
   - Gmail API: https://console.cloud.google.com/apis/library/gmail.googleapis.com
3. Configure the **OAuth consent screen** (Audience) if it isn't already:
   - User type: **External**
   - Publishing status: **Testing** is fine for personal use
   - Add your own Google account under **Test users** — required while in
     Testing mode, otherwise the consent flow returns `403 access_denied`
4. Back in **Credentials → Create credentials → OAuth client ID**
   - Application type: **Desktop app** (not "Web application" — Web
     requires you to register every redirect URI in advance, and the
     auth-google script picks a random local port)
   - Name: anything ("Robin Desktop")
   - Click **Create**, copy the **Client ID** and **Client secret**

## 2. Drop the credentials into `.env`

```env
GOOGLE_OAUTH_CLIENT_ID=<your-client-id>
GOOGLE_OAUTH_CLIENT_SECRET=<your-client-secret>
```

(`GOOGLE_OAUTH_REFRESH_TOKEN=` will be filled in automatically by the next
step.)

## 3. Run the OAuth flow

```sh
node user-data/ops/scripts/auth-google.js
```

A browser tab opens to Google's consent screen. Click **Advanced →
Continue** if you see the unverified-app warning (expected for personal
OAuth clients in Testing mode), then **Allow** for Calendar + Gmail
read-only scopes. The script catches the redirect on
`http://127.0.0.1:<random-port>/oauth-callback`, exchanges the code for
tokens, and writes `GOOGLE_OAUTH_REFRESH_TOKEN` back to `.env`.

## 4. Bootstrap and enable the sync jobs

```sh
node user-data/ops/scripts/sync-calendar.js --bootstrap
node user-data/ops/scripts/sync-gmail.js --bootstrap
node bin/robin.js jobs enable sync-calendar
node bin/robin.js jobs enable sync-gmail
```

`sync-calendar` pulls 6-week events from every calendar you can read
(every 30 min). `sync-gmail` pulls last-30-days inbox metadata — sender,
subject, snippet, labels — but never message bodies (every 15 min).

## Common errors and fixes

| Symptom | Cause | Fix |
|---|---|---|
| `Error 400: redirect_uri_mismatch` | Client was created as "Web application" instead of "Desktop app" | Create a new Desktop OAuth client |
| `Error 403: access_denied` | Your account isn't on the Test users list | Add your account under OAuth consent screen → Test users |
| `Error 401: invalid_client` | Client ID/secret typo or pasted secret has trailing whitespace | Re-copy from console; check `.env` for stray quotes |
| Token exchange returned no `refresh_token` | The script always passes `prompt=consent` and `access_type=offline`, so this should not happen on first auth — usually means the auth flow was interrupted before consent was clicked | Re-run `auth-google.js` |

## Scopes

`https://www.googleapis.com/auth/calendar.readonly` and
`https://www.googleapis.com/auth/gmail.readonly`. Both are read-only.
Robin does not request mail-send or calendar-write scopes.
