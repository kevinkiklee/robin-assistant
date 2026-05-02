// Sanitize untrusted strings before they land in markdown files inside
// user-data/memory/. The goal is to neutralize three classes of substring
// that would otherwise let externally-authored content masquerade as Robin's
// own structured signals once it sits in memory.
//
// Class 1 — Capture tags (`[fact]`, `[correction]`, ...). If a synced subject
// line contained `[correction]`, the agent's capture loop or Dream's routing
// could pick it up as a real correction. Replace square brackets with
// full-width brackets so the literal text reads identically to a human but
// the parser-side regex (which keys on ASCII `[`/`]`) no longer matches.
//
// Class 2 — Role-shift markers (`[system: ...]`, `[assistant: ...]`,
// `[user: ...]`). Same treatment: rewrite the opening bracket so the
// `[<role>:` shape is broken. We don't try to scrub the whole role string;
// breaking the bracket is sufficient.
//
// Class 3 — Marker confusion (`<!-- UNTRUSTED-START`, `<!-- UNTRUSTED-END`).
// Synced content that contains a literal closing marker could prematurely
// terminate the wrapping in a knowledge file. Escape the leading `<!--`
// to `&lt;!--` so it renders the same in markdown but is no longer a
// valid HTML-comment opener that would close our wrap.

const CAPTURE_TAGS = ['fact', 'preference', 'decision', 'correction', 'task', 'update', 'derived', 'journal'];

const TAG_RE = new RegExp(`\\[(${CAPTURE_TAGS.join('|')})(\\|[^\\]]*)?\\]`, 'gi');
const ROLE_RE = /\[(system|assistant|user)\s*:/gi;
const MARKER_RE = /<!--\s*UNTRUSTED-(START|END)/gi;

export function sanitizeUntrustedString(s) {
  if (typeof s !== 'string') {
    throw new TypeError(`sanitizeUntrustedString expected a string, got ${typeof s}`);
  }
  let out = s;
  // Capture-tag literals → full-width brackets.
  out = out.replace(TAG_RE, (m) => `［${m.slice(1, -1)}］`);
  // Role-shift opening bracket → full-width.
  out = out.replace(ROLE_RE, (_m, role) => `［${role}:`);
  // Closing markers — escape the comment opener.
  out = out.replace(MARKER_RE, (_m, kind) => `&lt;!-- UNTRUSTED-${kind}`);
  return out;
}
