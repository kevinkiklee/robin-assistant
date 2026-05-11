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
      const { id, resolve, reject } = queue.shift();
      try {
        const result = await worker(id);
        resolve(result);
      } catch (e) {
        reject(e);
      }
      if (dedupe) inflight.delete(id);
    }
    running = false;
  }

  function enqueue(id) {
    // Dedupe check FIRST — returning an existing in-flight promise must
    // never count against the cap.
    if (dedupe && inflight.has(id)) return inflight.get(id);

    if (depth() >= maxPending) {
      skippedSinceBoot++;
      lastSkippedAt = new Date();
      console.warn(
        `[biographer] queue at cap (${maxPending}), skipping ${id} ` +
          '(will be picked up on next /internal/biographer/process-pending)',
      );
      return { skipped: true };
    }

    const promise = new Promise((resolve, reject) => {
      queue.push({ id, resolve, reject });
    });
    if (dedupe) inflight.set(id, promise);
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
