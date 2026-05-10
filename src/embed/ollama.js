const OLLAMA_HOST = process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434';
const MODEL = 'qwen3-embedding:8b';
const DIM = 4096;

class OllamaError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'OllamaError';
    this.status = status;
  }
}

async function ollamaPost(path, payload) {
  const r = await globalThis.fetch(`${OLLAMA_HOST}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new OllamaError(`ollama ${path} ${r.status}: ${body}`, r.status);
  }
  return await r.json();
}

export async function createOllamaEmbedder() {
  let useBatch = true;

  async function embed(text) {
    if (useBatch) {
      try {
        const json = await ollamaPost('/api/embed', { model: MODEL, input: [text] });
        return Float32Array.from(json.embeddings[0]);
      } catch (e) {
        if (e.status === 404 || e.status === 405) {
          useBatch = false;
        } else {
          throw e;
        }
      }
    }
    const json = await ollamaPost('/api/embeddings', { model: MODEL, prompt: text });
    return Float32Array.from(json.embedding);
  }

  async function embedBatch(texts) {
    if (useBatch) {
      try {
        const json = await ollamaPost('/api/embed', { model: MODEL, input: texts });
        return json.embeddings.map((row) => Float32Array.from(row));
      } catch (e) {
        if (e.status !== 404 && e.status !== 405) throw e;
        useBatch = false;
      }
    }
    const out = [];
    for (const t of texts) out.push(await embed(t));
    return out;
  }

  async function healthCheck() {
    const r = await globalThis.fetch(`${OLLAMA_HOST}/api/tags`);
    if (!r.ok) throw new Error(`ollama unreachable at ${OLLAMA_HOST}`);
    const json = await r.json();
    const installed = (json.models ?? []).map((m) => m.name);
    if (!installed.some((n) => n.startsWith('qwen3-embedding:8b'))) {
      throw new Error('qwen3-embedding:8b is not installed. Run `ollama pull qwen3-embedding:8b`.');
    }
  }

  return {
    profile: 'qwen3-4096',
    dimension: DIM,
    modelId: MODEL,
    embed,
    embedBatch,
    healthCheck,
  };
}
