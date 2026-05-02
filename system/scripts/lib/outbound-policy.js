// Outbound policy gate (cycle-1b).
//
// Three layers — taint check (sentence-hash match against untrusted-index),
// sensitive-shape detection (PII patterns + process.env values), and
// credential-derived target allowlist. Each write tool (github-write,
// spotify-write, discord-bot reply path) calls assertOutboundContentAllowed
// before its outbound HTTP call. Throws OutboundPolicyError on violation;
// caller logs to policy-refusals.log and either exits 11 (one-shot scripts)
// or replaces the content with a refusal note (long-lived discord-bot).

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadOrRefreshIndex, splitSentences, fnv1a64, findSourceForHash } from '../sync/lib/untrusted-index.js';

export class OutboundPolicyError extends Error {
  constructor(reason, layer) {
    super(reason);
    this.name = 'OutboundPolicyError';
    this.reason = reason;
    this.layer = layer;
  }
}

// PII shape patterns (reused from redact.js, but pre-compiled for outbound checks).
// Note: redact.js's patterns are not directly exported as an array; we maintain
// a parallel set here. If redact.js patterns change, update this list too.
const PII_PATTERNS = [
  { name: 'url-cred', re: /(https?:\/\/)([^:\s/@]+):([^@\s]+)@/ },
  { name: 'api-key', re: /\b(sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{36,}|gho_[A-Za-z0-9]{36,}|xoxb-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/ },
  { name: 'ssn', re: /\b\d{3}-\d{2}-\d{4}\b/ },
];

function checkTaint({ content, workspaceDir }) {
  const idx = loadOrRefreshIndex(workspaceDir);
  if (idx.allHashes.size === 0) return;  // empty haystack — no false matches.

  // Fast path: hash-level match against outbound's own sentences.
  const sentences = splitSentences(content);
  for (const s of sentences) {
    if (s.length < 20) continue;
    const h = fnv1a64(s);
    if (idx.allHashes.has(h)) {
      const source = findSourceForHash({ sources: idx.sources }, h) || 'unknown';
      throw new OutboundPolicyError(
        `outbound content quotes a sentence from ${source}`,
        1
      );
    }
  }

  // Slow path: substring match. Catches cases where an indexed sentence
  // appears INSIDE the outbound (e.g., the agent prepends "Reposting: " to
  // a quoted issue body). Normalize outbound the same way splitSentences
  // does — lowercase, collapse whitespace — so the comparison is robust.
  const normalizedOutbound = content.toLowerCase().replace(/\s+/g, ' ');
  for (const { sentence, source } of idx.allSentences) {
    if (sentence.length < 20) continue;
    if (normalizedOutbound.includes(sentence)) {
      throw new OutboundPolicyError(
        `outbound content quotes a sentence from ${source}`,
        1
      );
    }
  }
}

function checkSensitiveShapes({ content }) {
  // PII patterns.
  for (const { name, re } of PII_PATTERNS) {
    if (re.test(content)) {
      throw new OutboundPolicyError(`outbound content matches sensitive pattern (${name})`, 2);
    }
  }
  // process.env value substring check (high-entropy tokens >=30 chars).
  for (const [key, value] of Object.entries(process.env)) {
    if (!value) continue;
    if (value.length < 30) continue;
    if (!/^[A-Za-z0-9_-]+$/.test(value)) continue;
    if (content.includes(value)) {
      throw new OutboundPolicyError(`outbound content includes value of process.env.${key}`, 2);
    }
  }
}

const GITHUB_ALLOWLIST_REL = 'user-data/state/github-allowlist-cache.json';

function loadGithubAllowlist(workspaceDir) {
  const p = join(workspaceDir, GITHUB_ALLOWLIST_REL);
  if (!existsSync(p)) return null;  // not yet populated; fail-open for first call
  try {
    const data = JSON.parse(readFileSync(p, 'utf-8'));
    if (!Array.isArray(data.repos)) return null;
    const ageMs = Date.now() - new Date(data.fetched_at).getTime();
    const ttlMs = (data.ttl_seconds ?? 3600) * 1000;
    if (ageMs > ttlMs) return null;  // stale; trigger refetch
    return data.repos;
  } catch {
    return null;
  }
}

function checkGithubTarget({ target, workspaceDir }) {
  if (!target.startsWith('github:')) return;
  const repo = target.slice('github:'.length);
  const allow = loadGithubAllowlist(workspaceDir);
  // null = no cache yet; allow (caller may populate cache after first call).
  // [] = explicit empty list; treat as deny-all.
  if (allow === null) return;
  if (!allow.includes(repo)) {
    throw new OutboundPolicyError(`github target ${repo} not in PAT scope`, 3);
  }
}

function checkSpotifyTarget({ target }) {
  if (!target.startsWith('spotify:')) return;
  // Spotify OAuth is user-bound; no fine-grained allowlist enforceable here.
  // Sanity check: target must be 'spotify:user:...' (not 'spotify:app:...' or other prefixes).
  if (!target.startsWith('spotify:user:')) {
    throw new OutboundPolicyError(`spotify target ${target} must be spotify:user:*`, 3);
  }
}

function checkDiscordTarget({ target, ctx }) {
  if (!target.startsWith('discord:')) return;
  if (!ctx?.inboundOrigin) return;  // bot didn't pass inboundOrigin → can't check
  if (target !== ctx.inboundOrigin) {
    throw new OutboundPolicyError(
      `discord target ${target} differs from inbound origin ${ctx.inboundOrigin}`,
      3
    );
  }
}

function checkTarget({ target, workspaceDir, ctx }) {
  checkGithubTarget({ target, workspaceDir });
  checkSpotifyTarget({ target });
  checkDiscordTarget({ target, ctx });
}

export function assertOutboundContentAllowed({ content, target, workspaceDir, ctx = {} }) {
  if (typeof content !== 'string') {
    throw new TypeError('assertOutboundContentAllowed: content must be a string');
  }
  if (!target) {
    throw new TypeError('assertOutboundContentAllowed: target is required');
  }
  if (!workspaceDir) {
    throw new TypeError('assertOutboundContentAllowed: workspaceDir is required');
  }
  checkTaint({ content, workspaceDir });
  checkSensitiveShapes({ content });
  checkTarget({ target, workspaceDir, ctx });
}

// Helper used by write tools to log a refusal in a uniform shape.
export function buildRefusalEntry({ target, error, content }) {
  return {
    kind: 'outbound',
    target,
    layer: String(error.layer ?? 'unknown'),
    reason: error.reason ?? error.message ?? 'unknown',
    contentHash: fnv1a64(content),
  };
}
