import { readConfig } from '../../config/paths.js';

export async function createEmbedder({ db } = {}) {
  const cfg = await readConfig();
  if (!cfg?.embedder_profile) {
    throw new Error('no embedder profile configured. Run `robin install` first.');
  }
  switch (cfg.embedder_profile) {
    case 'mxbai-1024': {
      const { createInProcessEmbedder } = await import('./in-process.js');
      return await createInProcessEmbedder();
    }
    case 'qwen3-4096': {
      const { createOllamaEmbedder } = await import('./ollama.js');
      return await createOllamaEmbedder();
    }
    case 'gemini-3072': {
      const { createGeminiEmbedder } = await import('./gemini.js');
      return await createGeminiEmbedder({ db });
    }
    default:
      throw new Error(`unknown embedder profile: ${cfg.embedder_profile}`);
  }
}
