/**
 * The consent screen. Claude opens this in the user's browser during the OAuth
 * flow, and it is the only place a human is in the loop — so it is also where
 * access is actually decided. The access key entered here is what distinguishes
 * the operator from anyone else who has found the endpoint; the OAuth machinery around
 * it only carries the resulting grant.
 *
 * Deliberately dependency-free and self-contained: no external CSS, no scripts.
 */

export interface ConsentParams {
  clientId: string;
  /** Self-reported at registration — shown, never trusted. */
  clientName?: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  state: string;
  resource: string;
  scope: string;
  error?: string;
}

/** Escape everything interpolated — these values arrive from the query string. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Longest client name shown; registration is open, so it is attacker-sized. */
const MAX_CLIENT_NAME = 80;

/**
 * The host the code will be delivered to. This, not the client name, is what
 * the operator should check: the allowlist pins it, the name is self-reported.
 */
function redirectHost(uri: string): string {
  try {
    return new URL(uri).host;
  } catch {
    return uri;
  }
}

function hidden(name: string, value: string): string {
  return `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`;
}

export function consentPage(params: ConsentParams): string {
  const fields = [
    hidden('response_type', 'code'),
    hidden('client_id', params.clientId),
    hidden('redirect_uri', params.redirectUri),
    hidden('code_challenge', params.codeChallenge),
    hidden('code_challenge_method', params.codeChallengeMethod),
    hidden('state', params.state),
    hidden('resource', params.resource),
    hidden('scope', params.scope),
  ].join('\n      ');

  const error = params.error ? `<p class="error" role="alert">${escapeHtml(params.error)}</p>` : '';
  const name = params.clientName?.trim().slice(0, MAX_CLIENT_NAME) || 'an unnamed client';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Authorize access to Robin</title>
<style>
  :root { color-scheme: light dark; }
  body {
    font: 16px/1.5 ui-sans-serif, system-ui, -apple-system, sans-serif;
    margin: 0; min-height: 100vh; display: grid; place-items: center;
    background: Canvas; color: CanvasText;
  }
  main { width: min(28rem, 92vw); padding: 2rem 0; }
  h1 { font-size: 1.25rem; margin: 0 0 .25rem; }
  p { margin: .5rem 0; }
  .muted { opacity: .7; font-size: .9rem; }
  .scope { border: 1px solid color-mix(in srgb, CanvasText 20%, transparent);
           border-radius: .5rem; padding: .75rem 1rem; margin: 1.25rem 0; }
  .scope ul { margin: .5rem 0 0; padding-left: 1.1rem; }
  label { display: block; font-weight: 600; margin-bottom: .35rem; }
  input[type=password] {
    width: 100%; padding: .6rem .7rem; font: inherit; border-radius: .5rem;
    border: 1px solid color-mix(in srgb, CanvasText 35%, transparent);
    background: Field; color: FieldText; box-sizing: border-box;
  }
  button {
    margin-top: 1rem; width: 100%; padding: .7rem 1rem; font: inherit;
    font-weight: 600; border: 0; border-radius: .5rem; cursor: pointer;
    background: CanvasText; color: Canvas;
  }
  .check { display: flex; gap: .6rem; align-items: flex-start; font-weight: 400; }
  .check input { margin-top: .3rem; flex: none; }
  .error { color: #b3261e; font-weight: 600; }
  @media (prefers-color-scheme: dark) { .error { color: #f2b8b5; } }
  .who { font-size: 1.05rem; margin: 1rem 0 .25rem; }
  .who strong { word-break: break-word; }
</style>
</head>
<body>
<main>
  <h1>Authorize access to Robin</h1>
  <p class="who"><strong class="client">${escapeHtml(name)}</strong> is asking to read your Robin memory.</p>
  <p class="who">Approving sends you to <strong class="host">${escapeHtml(redirectHost(params.redirectUri))}</strong></p>
  <p class="muted">If you did not start connecting a client to Robin just now, close this page.</p>
  ${error}
  <div class="scope">
    <strong>This grants read access to:</strong>
    <ul>
      <li>memory search, recall and the entity graph</li>
      <li>beliefs, journals, predictions and recommendations</li>
      <li>skills, integration status, metrics and health</li>
    </ul>
    <p class="muted">It can never run jobs, spend money, or change daemon state.</p>
  </div>
  <form method="post" action="/oauth/authorize">
      ${fields}
    <div class="scope">
      <label class="check">
        <input type="checkbox" name="grant_write" value="1">
        <span><strong>Also allow writing to memory</strong><br>
        <span class="muted">remember, believe, predict, recommend, record corrections.
        Leave unchecked for a read-only connection.</span></span>
      </label>
    </div>
    <label for="access_key">Robin access key</label>
    <input id="access_key" name="access_key" type="password" autocomplete="off"
           autofocus required spellcheck="false">
    <button type="submit">Authorize</button>
  </form>
  <p class="muted">Full callback: <code>${escapeHtml(params.redirectUri)}</code></p>
</main>
</body>
</html>`;
}

/**
 * Shown instead of the consent form when the flow can't be valid — unknown
 * client, or a redirect URI that isn't registered or allowlisted. RFC 6749
 * §4.1.2.1: tell the human, never redirect to an unverified target.
 */
export function consentErrorPage(message: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Cannot authorize this client</title>
<style>
  :root { color-scheme: light dark; }
  body {
    font: 16px/1.5 ui-sans-serif, system-ui, -apple-system, sans-serif;
    margin: 0; min-height: 100vh; display: grid; place-items: center;
    background: Canvas; color: CanvasText;
  }
  main { width: min(28rem, 92vw); padding: 2rem 0; }
  h1 { font-size: 1.25rem; margin: 0 0 .5rem; }
</style>
</head>
<body>
<main>
  <h1>Cannot authorize this client</h1>
  <p>${escapeHtml(message)}</p>
</main>
</body>
</html>`;
}
