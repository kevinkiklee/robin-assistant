import { requireSecret } from '../../config/secrets.js';

const SINGLE_ENDPOINT =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent';
const BATCH_ENDPOINT =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents';
const MODEL = 'gemini-embedding-001';
const DIM = 3072;
// BatchEmbedContents accepts at most 100 requests per call. Larger inputs
// must be split client-side; we chunk transparently inside embedBatch.
const MAX_BATCH = 100;

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

  async function embedBatchChunk(texts) {
    const apiKey = requireSecret('GEMINI_API_KEY');
    // 429 (RESOURCE_EXHAUSTED) is a transient rate-limit signal. We retry
    // with exponential backoff so a large backfill drains across rate-limit
    // windows instead of bailing out. 5xx errors get the same treatment.
    const MAX_ATTEMPTS = 6;
    let attempt = 0;
    while (true) {
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
      if (r.ok) {
        const json = await r.json();
        return json.embeddings.map((e) => Float32Array.from(e.values));
      }
      if (r.status === 404 || r.status === 405) {
        // Endpoint not available for this account/region — fall back to
        // single-text embed for each input.
        const out = [];
        for (const t of texts) out.push(await embed(t));
        return out;
      }
      const retriable = r.status === 429 || r.status >= 500;
      if (!retriable || attempt >= MAX_ATTEMPTS - 1) {
        throw new GeminiError(
          `gemini batch ${r.status}: ${await r.text().catch(() => '')}`,
          r.status,
        );
      }
      // Exponential backoff: 4s, 8s, 16s, 32s, 64s, 128s. Capped, jittered.
      const delayMs =
        Math.min(2000 * 2 ** (attempt + 1), 120000) + Math.floor(Math.random() * 1000);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      attempt += 1;
    }
  }

  async function embedBatch(texts) {
    // Gemini's BatchEmbedContents endpoint accepts ≤100 requests per call.
    // Callers (e.g. the resumable backfill walking 200-row DB chunks) can
    // hand us anything; we split transparently here so they don't need to
    // know the provider's limit.
    if (texts.length <= MAX_BATCH) return embedBatchChunk(texts);
    const out = [];
    for (let i = 0; i < texts.length; i += MAX_BATCH) {
      const slice = texts.slice(i, i + MAX_BATCH);
      const vecs = await embedBatchChunk(slice);
      for (const v of vecs) out.push(v);
    }
    return out;
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
