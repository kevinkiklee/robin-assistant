import { withTimeout } from '../../lib/with-timeout.ts';
import type { LLMDispatcher } from '../llm/dispatcher.ts';

// Bug D/E mitigation — bound a single embed call. qwen3-embedding:8b on healthy
// Ollama returns in under a second; observed degradation on 2026-05-21 pushed a
// single embed call to 6+ seconds and a sibling biographer call hung indefinitely.
// 60s is generous (15× steady-state) but tight enough that a wedged call fails
// fast and the embedder batch keeps moving.
const EMBED_CALL_TIMEOUT_MS = 60_000;

// qwen3-embedding:8b advertises a 40,960-token context, but Ollama's default num_ctx for
// embedding models is lower in practice — a 130k-char (~32k token) document failed during
// the v2 backfill with "input length exceeds the context length". 30,000 characters is a
// conservative cap at ~7,500 tokens, well under any reasonable embedder limit, and only
// affects 12 rows of the v2 corpus (largest legitimate doc was a 130k-char daily briefing).
//
// We embed the head of the document rather than chunk-and-pool because:
//   1. Document topic + structure live in the first few KB for nearly all our event kinds
//      (briefings, conversations, integration ticks).
//   2. Chunk-and-pool is materially more code + state to maintain for a long-tail problem.
//   3. The original body is preserved in events_content.body; only the embedding vector
//      represents the truncated view. Full-text search (FTS5) still reads the entire body.
//
// If recall on long documents becomes a real complaint, the upgrade is chunk-and-pool here;
// no callers need to change.
export const EMBED_MAX_CHARS = 30_000;

/**
 * Normalize a content body to a string before truncation/embedding.
 *
 * `events_content.body` is declared `TEXT NOT NULL`, but SQLite is dynamically typed:
 * a row written with a Buffer binding (some historical ingest paths did this for bodies
 * that were runs of box-drawing/non-ASCII bytes) is stored with BLOB affinity and read
 * back by better-sqlite3 as a Node `Buffer`, not a string. Feeding a Buffer straight to
 * the Ollama embed call serialized it as `{"type":"Buffer","data":[…]}` — an OBJECT — and
 * Ollama rejected it with `400: cannot unmarshal object … of type string`. We decode
 * Buffers as UTF-8 (recovering the original text) and coerce any other non-string defensively.
 */
function bodyToString(body: unknown): string {
  if (typeof body === 'string') return body;
  if (Buffer.isBuffer(body)) return body.toString('utf8');
  if (body instanceof Uint8Array) return Buffer.from(body).toString('utf8');
  return String(body);
}

export function prepareForEmbed(body: string | Buffer | Uint8Array): string {
  const text = bodyToString(body);
  return text.length > EMBED_MAX_CHARS ? text.slice(0, EMBED_MAX_CHARS) : text;
}

export async function embedBody(
  dispatcher: LLMDispatcher,
  body: string | Buffer | Uint8Array,
): Promise<number[]> {
  const [vec] = await withTimeout(
    dispatcher.embed('embed', prepareForEmbed(body)),
    EMBED_CALL_TIMEOUT_MS,
    'embed-content',
  );
  if (!vec || vec.length === 0) throw new Error('empty embedding returned');
  return vec;
}
