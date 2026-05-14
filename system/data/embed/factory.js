import { readConfig } from '../../config/paths.js';

// Wrap an embedder so every vector it returns is dimension-checked against
// its declared `dimension`. A mismatch usually means provider drift (e.g.
// Gemini API returning a different vector shape than the schema expects) or
// a misconfigured local model. Without this, the wrong-length vector lands
// in the per-profile embeddings table, the schema may accept it (the column
// is `array<float>` without a length constraint), and recall silently breaks
// because HNSW similarity scoring assumes the declared dimension.
function withDimensionCheck(inner) {
  const expected = inner.dimension;
  const profile = inner.profile ?? inner.modelId ?? 'unknown';
  function check(vec, kind) {
    if (!vec || vec.length !== expected) {
      throw new Error(
        `embedder[${profile}]: ${kind} returned ${vec?.length ?? 'no'} dims, expected ${expected}`,
      );
    }
  }
  return {
    ...inner,
    async embed(text) {
      const vec = await inner.embed(text);
      check(vec, 'embed');
      return vec;
    },
    async embedBatch(texts) {
      const vecs = await inner.embedBatch(texts);
      if (!Array.isArray(vecs) || vecs.length !== texts.length) {
        throw new Error(
          `embedder[${profile}]: embedBatch returned ${vecs?.length ?? 'no'} vectors for ${texts.length} inputs`,
        );
      }
      for (const v of vecs) check(v, 'embedBatch');
      return vecs;
    },
  };
}

export async function createEmbedder({ db } = {}) {
  const cfg = await readConfig();
  if (!cfg?.embedder_profile) {
    throw new Error('no embedder profile configured. Run `robin install` first.');
  }
  let inner;
  switch (cfg.embedder_profile) {
    case 'mxbai-1024': {
      const { createInProcessEmbedder } = await import('./in-process.js');
      inner = await createInProcessEmbedder();
      break;
    }
    case 'qwen3-4096': {
      const { createOllamaEmbedder } = await import('./ollama.js');
      inner = await createOllamaEmbedder();
      break;
    }
    case 'gemini-3072': {
      const { createGeminiEmbedder } = await import('./gemini.js');
      inner = await createGeminiEmbedder({ db });
      break;
    }
    default:
      throw new Error(`unknown embedder profile: ${cfg.embedder_profile}`);
  }
  return withDimensionCheck(inner);
}
