import { requireSecret } from '../secrets/dotenv-io.js';

const SINGLE_ENDPOINT =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent';
const BATCH_ENDPOINT =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents';
const MODEL = 'gemini-embedding-001';
const DIM = 3072;

class GeminiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'GeminiError';
    this.status = status;
  }
}

export async function createGeminiEmbedder() {
  // Per-call requireSecret is intentional: lets users re-auth without daemon restart.

  async function embed(text) {
    const apiKey = requireSecret('GEMINI_API_KEY');
    const r = await globalThis.fetch(`${SINGLE_ENDPOINT}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: `models/${MODEL}`, content: { parts: [{ text }] } }),
    });
    if (!r.ok) {
      throw new GeminiError(`gemini ${r.status}: ${await r.text().catch(() => '')}`, r.status);
    }
    const json = await r.json();
    return Float32Array.from(json.embedding.values);
  }

  async function embedBatch(texts) {
    const apiKey = requireSecret('GEMINI_API_KEY');
    const r = await globalThis.fetch(`${BATCH_ENDPOINT}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requests: texts.map((text) => ({
          model: `models/${MODEL}`,
          content: { parts: [{ text }] },
        })),
      }),
    });
    if (!r.ok) {
      if (r.status === 404 || r.status === 405) {
        const out = [];
        for (const t of texts) out.push(await embed(t));
        return out;
      }
      throw new GeminiError(
        `gemini batch ${r.status}: ${await r.text().catch(() => '')}`,
        r.status,
      );
    }
    const json = await r.json();
    return json.embeddings.map((e) => Float32Array.from(e.values));
  }

  async function healthCheck() {
    requireSecret('GEMINI_API_KEY'); // throws if missing; defers actual API call to first use
  }

  async function unload() {
    // no-op: API has no local state
  }

  return {
    profile: 'gemini-3072',
    dimension: DIM,
    modelId: MODEL,
    embed,
    embedBatch,
    healthCheck,
    unload,
  };
}
