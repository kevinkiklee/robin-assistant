// The detector arg is currently unused — reserved for future
// repeat-query suppression.

import { surql } from 'surrealdb';
import { recall } from './index.js';

const PRIOR_TAIL_CHARS = 500;
const LINE_CONTENT_CHARS = 120;

function trimLine(s, max = LINE_CONTENT_CHARS) {
  if (typeof s !== 'string') return '';
  // Collapse newlines/tabs so the line stays single-line.
  const flat = s.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  return flat.slice(0, max).trimEnd();
}

function formatHitDate(ts) {
  if (!ts) return '????-??-??';
  const d = ts instanceof Date ? ts : new Date(ts);
  if (Number.isNaN(d.getTime())) return '????-??-??';
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

function formatHit(hit) {
  const date = formatHitDate(hit.ts);
  const content = trimLine(hit.content ?? '');
  const kind = hit?.meta?.kind;
  const tag = kind === 'episode_summary' ? 'episode' : 'event';
  return `[${tag} ${date}] ${content}`;
}

// Rough token estimator: 1 token ≈ 4 chars. Same convention as the
// existing biographer prompt sizing.
function estimateTokens(s) {
  return Math.ceil((typeof s === 'string' ? s.length : 0) / 4);
}

const OPEN = '<!-- relevant memory -->';
const CLOSE = '<!-- /relevant memory -->';
// Both markers + the two newlines between them and the body.
const FRAME_TOKENS = estimateTokens(`${OPEN}\n${CLOSE}\n`);

/**
 * Vector-search recent memory and format hits into an injection block.
 *
 * @param {object} args
 * @param {import('surrealdb').Surreal} args.db
 * @param {{embed:(t:string)=>Promise<Float32Array>}} args.embedder
 * @param {*} [args.detector]            Reserved for repeat-query suppression (4b).
 * @param {string} args.query             Current user message.
 * @param {string} [args.priorAssistant]  Previous assistant turn (we use the tail).
 * @param {number} [args.k]               Max hits (default 6).
 * @param {number} [args.recencyDays]     Recency window (default 30).
 * @param {number} [args.tokenBudget]     Total token cap for the block (default 1500).
 * @returns {Promise<{block:string, hits:number, tokens:number, latency_ms:number, truncated:boolean}>}
 */
export async function intuitionEndpoint({
  db,
  embedder,
  // detector — intentionally unused in 4a; see header comment.
  query,
  priorAssistant = '',
  k = 6,
  recencyDays = 30,
  tokenBudget = 1500,
}) {
  const start = Date.now();
  const safeQuery = typeof query === 'string' ? query : '';
  const safePrior = typeof priorAssistant === 'string' ? priorAssistant : '';

  // Combine current prompt with the tail of the prior assistant turn so
  // recall can latch onto the in-flight thread of conversation.
  const priorTail =
    safePrior.length > PRIOR_TAIL_CHARS
      ? safePrior.slice(safePrior.length - PRIOR_TAIL_CHARS)
      : safePrior;
  const combined = priorTail.length > 0 ? `${safeQuery}\n\n${priorTail}` : safeQuery;

  let hits = [];
  if (combined.trim().length > 0) {
    const since = new Date(Date.now() - recencyDays * 86400_000);
    const result = await recall(db, embedder, combined, {
      limit: k,
      since,
      explain: false,
    });
    hits = Array.isArray(result?.hits) ? result.hits : [];
  }

  let block = '';
  let truncated = false;
  let tokens = 0;
  if (hits.length > 0) {
    // Greedy-pack lines under the token budget.
    const lines = [];
    let used = FRAME_TOKENS;
    for (const hit of hits) {
      const line = formatHit(hit);
      const lineTokens = estimateTokens(`${line}\n`);
      if (used + lineTokens > tokenBudget) {
        truncated = true;
        break;
      }
      lines.push(line);
      used += lineTokens;
    }
    if (lines.length < hits.length) truncated = true;
    if (lines.length > 0) {
      block = `${OPEN}\n${lines.join('\n')}\n${CLOSE}`;
      tokens = estimateTokens(block);
    } else {
      // Even a single hit didn't fit. Surface the truncation in telemetry
      // so we can tune token_budget; emit no block.
      truncated = true;
    }
  }

  const latency_ms = Date.now() - start;

  // Telemetry write — must never break the response.
  try {
    await db
      .query(
        surql`CREATE runtime_intuition_telemetry CONTENT ${{
          query_chars: safeQuery.length,
          hits: hits.length,
          tokens_injected: tokens,
          latency_ms,
          truncated,
        }}`,
      )
      .collect();
  } catch {
    // Swallow — telemetry is advisory.
  }

  return { block, hits: hits.length, tokens, latency_ms, truncated };
}
