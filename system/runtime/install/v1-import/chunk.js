// chunk.js — split long memo content at paragraph breaks.
//
// Neither `data/embed/backfill.js` nor `cognition/jobs/internal/embeddings-backfill.js`
// chunk; oversized seeds break the whole batch. We pre-chunk anything past
// `THRESHOLD` so each chunk fits in the embedder's context window.
//
// Output preserves the original full body as the PARENT memo's content and
// emits CHILD chunks linked via `edges:[derived_from, child, parent]`. Recall
// can hit either; the parent stays addressable as a coherent unit.

export const CHUNK_THRESHOLD = 8000;
export const CHUNK_TARGET = 6000;

/**
 * Decide whether content needs chunking. Cheap predicate.
 */
export function needsChunking(content) {
  return typeof content === 'string' && content.length > CHUNK_THRESHOLD;
}

/**
 * Split content at paragraph boundaries (`\n\n`), packing into ~CHUNK_TARGET-char
 * windows without splitting a paragraph. If a single paragraph exceeds CHUNK_TARGET,
 * it's emitted on its own.
 *
 * @param {string} content
 * @returns {string[]} Non-empty chunks in original order.
 */
export function splitAtParagraphs(content) {
  if (!needsChunking(content)) return [content];
  const paragraphs = content
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  const chunks = [];
  let buf = '';
  for (const p of paragraphs) {
    const candidate = buf ? `${buf}\n\n${p}` : p;
    if (candidate.length > CHUNK_TARGET && buf) {
      chunks.push(buf);
      buf = p;
    } else {
      buf = candidate;
    }
  }
  if (buf) chunks.push(buf);
  return chunks;
}
