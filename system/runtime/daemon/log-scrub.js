// Scrub well-known secret shapes from anything written to the daemon's
// stdout/stderr. The daemon has no central logger — code uses bare
// `console.*`, third-party modules write directly to the streams, and
// native bindings dump errors with raw response bodies. Patching the
// underlying write streams is the only chokepoint that covers every path
// without rewriting every call site.
//
// Threat model: defends the on-disk log (runtime/logs/daemon.log) against
// accidental token capture from error messages, integration response
// bodies, and stack traces. Does NOT defend against an attacker with
// in-memory access to the daemon process — secrets remain in heap.

const PATTERNS = [
  // Compose order matters only for overlap: prefix-anchored shapes first
  // so a generic "Bearer …" rule doesn't eat a GitHub PAT before its
  // specific rule fires.
  { name: 'github_pat', regex: /\bghp_[A-Za-z0-9]{30,}\b/g },
  { name: 'github_oauth', regex: /\bgho_[A-Za-z0-9]{30,}\b/g },
  { name: 'github_server', regex: /\bghs_[A-Za-z0-9]{30,}\b/g },
  { name: 'github_user', regex: /\bghu_[A-Za-z0-9]{30,}\b/g },
  { name: 'github_refresh', regex: /\bghr_[A-Za-z0-9]{30,}\b/g },
  { name: 'gitlab_pat', regex: /\bglpat-[A-Za-z0-9_-]{20,}\b/g },
  { name: 'anthropic_key', regex: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { name: 'openai_key', regex: /\bsk-[A-Za-z0-9]{32,}\b/g },
  { name: 'slack_bot', regex: /\bxoxb-\d+-\d+-[A-Za-z0-9]+\b/g },
  { name: 'slack_user', regex: /\bxoxp-\d+-\d+-\d+-[A-Za-z0-9]+\b/g },
  { name: 'slack_app', regex: /\bxapp-\d+-[A-Za-z0-9-]+-[A-Za-z0-9]+\b/g },
  { name: 'aws_access_key', regex: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: 'google_api_key', regex: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: 'jwt', regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { name: 'pem_private_key', regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  // Generic bearer last — broad enough to catch Robin's own internal
  // token if it ever leaks into an error message. Requires ≥20 chars of
  // base64-ish payload so it doesn't fire on prose like "Bearer with me".
  { name: 'bearer_token', regex: /\bBearer\s+[A-Za-z0-9_\-=.+/]{20,}/gi },
];

export function scrub(s) {
  if (typeof s !== 'string' || s.length === 0) return s;
  let out = s;
  for (const p of PATTERNS) out = out.replace(p.regex, `<redacted:${p.name}>`);
  return out;
}

// Patch a writable stream's `write` so every line going through it is
// scrubbed. Idempotent: stores the original under a private symbol and
// re-uses it on subsequent calls so a second install is a no-op.
const ORIG = Symbol.for('robin.logScrub.origWrite');

function patchStream(stream) {
  if (!stream || typeof stream.write !== 'function') return;
  const orig = stream[ORIG] ?? stream.write.bind(stream);
  stream[ORIG] = orig;
  stream.write = function patchedWrite(chunk, encodingOrCb, cb) {
    try {
      if (typeof chunk === 'string') {
        return orig(scrub(chunk), encodingOrCb, cb);
      }
      if (Buffer.isBuffer(chunk)) {
        const enc = typeof encodingOrCb === 'string' ? encodingOrCb : 'utf8';
        return orig(scrub(chunk.toString(enc)), encodingOrCb, cb);
      }
    } catch {
      // Never break logging because of a scrub failure — fall through to
      // the original write with the unmodified chunk.
    }
    return orig(chunk, encodingOrCb, cb);
  };
}

export function installLogScrub({ stdout = process.stdout, stderr = process.stderr } = {}) {
  patchStream(stdout);
  patchStream(stderr);
}
