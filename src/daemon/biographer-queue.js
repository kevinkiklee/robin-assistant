export function createBiographerQueue({ worker, dedupe = false }) {
  const queue = [];
  const inflight = new Map();
  let running = false;

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
    if (dedupe && inflight.has(id)) return inflight.get(id);
    const promise = new Promise((resolve, reject) => {
      queue.push({ id, resolve, reject });
    });
    if (dedupe) inflight.set(id, promise);
    drain();
    return promise;
  }

  return { enqueue };
}
