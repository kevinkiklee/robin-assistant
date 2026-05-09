import { sha256 } from './hash.js';

/**
 * @typedef {Object} Embedder
 * @property {number} dimension
 * @property {string} modelId
 * @property {(text: string) => Promise<Float32Array>} embed
 * @property {(texts: string[]) => Promise<Float32Array[]>} embedBatch
 */

// Deterministic non-cryptographic vector derived from sha256 of the input.
// Used in tests; *not* a substitute for a real embedder for recall quality.
export function createStubEmbedder({ dimension = 768 } = {}) {
  return {
    dimension,
    modelId: 'stub:sha256',
    embed: async (text) => stubVector(text, dimension),
    embedBatch: async (texts) => texts.map((t) => stubVector(t, dimension)),
  };
}

function stubVector(text, dim) {
  const seed = sha256(text); // 64 hex chars → 32 bytes of entropy
  const out = new Float32Array(dim);
  for (let i = 0; i < dim; i++) {
    const start = (i * 2) % 64;
    const byte = Number.parseInt(seed.slice(start, start + 2), 16);
    out[i] = (byte / 255) * 2 - 1; // [-1, 1]
  }
  // L2 normalise so cosine similarity is well-behaved
  let mag = 0;
  for (let i = 0; i < dim; i++) mag += out[i] * out[i];
  mag = Math.sqrt(mag);
  if (mag > 0) for (let i = 0; i < dim; i++) out[i] /= mag;
  return out;
}

// Real embedder lazy-loaded in Task 12.
// Note: package was migrated from @xenova/transformers to @huggingface/transformers
// (the maintained successor). The pipeline API is the same.
export async function createTransformersEmbedder({ modelId = 'Xenova/bge-base-en-v1.5' } = {}) {
  const { pipeline } = await import('@huggingface/transformers');
  const extractor = await pipeline('feature-extraction', modelId);
  // Probe dimension with a sentinel embedding
  const probe = await extractor('probe', { pooling: 'mean', normalize: true });
  const dimension = probe.data.length;
  return {
    dimension,
    modelId,
    embed: async (text) => {
      const out = await extractor(text, { pooling: 'mean', normalize: true });
      return new Float32Array(out.data);
    },
    embedBatch: async (texts) => {
      const out = [];
      for (const t of texts) {
        out.push((await extractor(t, { pooling: 'mean', normalize: true })).data);
      }
      return out.map((d) => new Float32Array(d));
    },
  };
}

const OOM_PATTERNS = /\b(out of memory|allocation failed|enomem|cannot allocate)\b/i;

export async function batchEmbed(inner, texts, { startSize = 64 } = {}) {
  const out = new Array(texts.length);
  let i = 0;
  let size = Math.min(startSize, texts.length);
  while (i < texts.length) {
    const slice = texts.slice(i, i + size);
    try {
      const vecs = await inner(slice);
      for (let j = 0; j < vecs.length; j++) out[i + j] = vecs[j];
      i += slice.length;
      // Optimistically grow back toward startSize on success
      if (size < startSize) size = Math.min(startSize, size * 2);
    } catch (e) {
      if (!OOM_PATTERNS.test(String(e.message)) || size === 1) {
        throw e;
      }
      size = Math.max(1, Math.floor(size / 2));
    }
  }
  return out;
}
