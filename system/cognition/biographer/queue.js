function dedupeKey(payload) {
  if (payload && typeof payload === 'object' && typeof payload.__queueKey === 'string') {
    return payload.__queueKey;
  }
  return payload;
}

export function createBiographerQueue({ worker, dedupe = false, maxPending = 1000 } = {}) {
  const queue = [];
  const inflight = new Map();
  let running = false;
  let skippedSinceBoot = 0;
  let lastSkippedAt = null;

  function depth() {
    return queue.length + (running ? 1 : 0);
  }

  async function drain() {
    if (running) return;
    running = true;
    while (queue.length > 0) {
      const { payload, key, resolve, reject } = queue.shift();
      try {
        const result = await worker(payload);
        resolve(result);
      } catch (e) {
        reject(e);
      }
      if (dedupe) inflight.delete(key);
    }
    running = false;
  }

  function enqueue(payload) {
    const key = dedupe ? dedupeKey(payload) : undefined;
    // Dedupe check FIRST — returning an existing in-flight promise must
    // never count against the cap.
    if (dedupe && inflight.has(key)) return inflight.get(key);

    if (depth() >= maxPending) {
      skippedSinceBoot++;
      lastSkippedAt = new Date();
      const tag =
        payload && typeof payload === 'object' && typeof payload.__queueKey === 'string'
          ? payload.__queueKey
          : String(payload);
      console.warn(
        `[biographer] queue at cap (${maxPending}), skipping ${tag} ` +
          '(will be picked up on next /internal/biographer/process-pending)',
      );
      return { skipped: true };
    }

    const promise = new Promise((resolve, reject) => {
      queue.push({ payload, key, resolve, reject });
    });
    if (dedupe) inflight.set(key, promise);
    drain();
    return promise;
  }

  return {
    enqueue,
    get pendingDepth() {
      return depth();
    },
    get skippedSinceBoot() {
      return skippedSinceBoot;
    },
    get lastSkippedAt() {
      return lastSkippedAt;
    },
  };
}
