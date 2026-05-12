// Cosine similarity reduces to a plain dot product because every embedder
// in `system/data/embed/` returns L2-normalised vectors (`normalize: true`
// for transformers, explicit normalisation for stubs). If a new embedder is
// added that does NOT normalise, the threshold below becomes meaningless
// and this helper needs to divide by the magnitudes.
function cosine(a, b) {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

export function createRepeatQueryDetector({
  windowMinutes = 5,
  similarityThreshold = 0.95,
  maxPerSession = 5,
} = {}) {
  const windowMs = windowMinutes * 60_000;
  const bySession = new Map();

  function prune(now, history) {
    while (history.length > 0 && now - history[0].ts > windowMs) history.shift();
  }

  return {
    observe(sessionId, queryVec) {
      const now = Date.now();
      let h = bySession.get(sessionId);
      if (!h) {
        h = [];
        bySession.set(sessionId, h);
      }
      prune(now, h);
      h.push({ vec: queryVec, ts: now });
      if (h.length > maxPerSession) h.shift();
    },
    check(sessionId, queryVec) {
      const now = Date.now();
      const h = bySession.get(sessionId);
      if (!h) return { repeat: false };
      prune(now, h);
      for (const { vec } of h) {
        if (cosine(vec, queryVec) >= similarityThreshold) return { repeat: true };
      }
      return { repeat: false };
    },
  };
}
