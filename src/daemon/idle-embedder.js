export function createIdleEmbedder({ factory, idleMs = 600_000 }) {
  let embedder = null;
  let lastTouch = 0;
  let timer = null;

  function scheduleUnload() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      if (Date.now() - lastTouch >= idleMs) {
        embedder = null;
      }
    }, idleMs + 100);
    timer.unref?.();
  }

  return {
    async get() {
      lastTouch = Date.now();
      if (!embedder) embedder = await factory();
      scheduleUnload();
      return embedder;
    },
    touch() {
      lastTouch = Date.now();
      scheduleUnload();
    },
    shutdown() {
      if (timer) clearTimeout(timer);
      embedder = null;
    },
  };
}
