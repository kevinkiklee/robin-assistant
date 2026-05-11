import { pipeline } from '@huggingface/transformers';

const MODEL = 'mixedbread-ai/mxbai-embed-large-v1';
const DIM = 1024;

export async function createInProcessEmbedder() {
  let extractor = null;

  async function getExtractor() {
    if (extractor) return extractor;
    extractor = await pipeline('feature-extraction', MODEL);
    return extractor;
  }

  return {
    profile: 'mxbai-1024',
    dimension: DIM,
    modelId: MODEL,
    embed: async (text) => {
      const ex = await getExtractor();
      const t = await ex(text, { pooling: 'cls', normalize: true });
      return Float32Array.from(t.tolist()[0]);
    },
    embedBatch: async (texts) => {
      const ex = await getExtractor();
      const t = await ex(texts, { pooling: 'cls', normalize: true });
      return t.tolist().map((row) => Float32Array.from(row));
    },
    healthCheck: async () => {},
    unload: async () => {
      extractor = null;
    },
  };
}
