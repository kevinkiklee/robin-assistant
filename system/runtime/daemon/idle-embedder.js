export function createIdleEmbedder({ factory, idleMs = 600_000 }) {
  let embedder = null;
  // Promise of an in-flight factory() so concurrent callers share one load.
  // Without this, two near-simultaneous get() calls each fire factory() and
  // one of the resulting embedders is silently leaked when the second write
  // overwrites the first.
  let loading = null;
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
      if (!embedder) {
        if (!loading) {
          loading = (async () => {
            try {
              embedder = await factory();
              return embedder;
            } finally {
              loading = null;
            }
          })();
        }
        await loading;
      }
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
      loading = null;
    },
  };
}
