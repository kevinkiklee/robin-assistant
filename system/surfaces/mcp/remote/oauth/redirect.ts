/**
 * Redirect URI allowlist for dynamic client registration.
 *
 * Registration is open by design — Claude registers itself on first connect —
 * so without this, anyone could register `https://evil.example/cb`, send the
 * operator a genuine authorize link on the operator's own domain, and receive
 * the code if the operator types the access key. Pinning where a code can be
 * delivered turns that from a phishing win into a registration error.
 *
 * Checked at registration and again at authorize, so a client registered
 * before the allowlist (or before the allowlist was narrowed) can't use it.
 */

/** Hosts Claude's connector callback lives on. Subdomains are included. */
export const DEFAULT_REDIRECT_HOSTS: readonly string[] = ['claude.ai', 'claude.com'];

/** Plain http is allowed only to these, for local testing (RFC 8252 §7.3). */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1']);

export const REDIRECT_HOSTS_ENV = 'ROBIN_MCP_REDIRECT_HOSTS';

function hostMatches(hostname: string, allowed: string): boolean {
  return hostname === allowed || hostname.endsWith(`.${allowed}`);
}

export function isAllowedRedirectUri(uri: string, extraHosts: readonly string[] = []): boolean {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  // RFC 6749 §3.1.2: a redirect URI must not carry a fragment. Userinfo has no
  // place in a callback and is a classic way to make a URL read as another host.
  if (url.hash || uri.includes('#')) return false;
  if (url.username || url.password) return false;

  // URL lowercases and punycodes the hostname, so comparisons are exact.
  const hostname = url.hostname;
  if (url.protocol === 'http:') return LOOPBACK_HOSTS.has(hostname);
  if (url.protocol !== 'https:') return false;
  return [...DEFAULT_REDIRECT_HOSTS, ...extraHosts].some((h) => hostMatches(hostname, h));
}

/**
 * Parses the comma-separated extra-host list. Each entry must be a bare
 * hostname with at least one dot: a wildcard, scheme, path or bare TLD would
 * widen the allowlist far past what anyone meant, so it stops the server
 * instead of being silently accepted.
 */
export function parseRedirectHosts(raw: string | undefined): string[] {
  const entries = (raw ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  for (const entry of entries) {
    // Letters, digits and hyphens in two or more dot-separated labels. URL
    // parsing alone would accept `*.example.com` as a literal hostname.
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(entry)) {
      throw new Error(
        `${REDIRECT_HOSTS_ENV} entries must be bare hostnames like connector.example.com (subdomains are included automatically); got: ${entry}`,
      );
    }
  }
  return entries;
}
