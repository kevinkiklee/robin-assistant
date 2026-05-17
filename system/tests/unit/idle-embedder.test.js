import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { createIdleEmbedder } from '../../runtime/daemon/idle-embedder.js';

// Uses mock.timers so the idle-unload setTimeout fires under our control
// instead of via 200ms real waits.

async function drainMicrotasks(rounds = 6) {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

test('idle embedder loads on first use; unloads after timeout', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    let loadCount = 0;
    const factory = async () => {
      loadCount++;
      return { dimension: 1024, embed: async () => new Float32Array(1024) };
    };
    const ie = createIdleEmbedder({ factory, idleMs: 50 });
    const e1 = await ie.get();
    await e1.embed('a');
    ie.touch();
    // Idle-unload timer is `idleMs + 100` (150ms) past last touch. Advance the
    // clock past it and let the timer callback run.
    mock.timers.tick(200);
    await drainMicrotasks();
    const e2 = await ie.get();
    assert.ok(e2);
    assert.equal(loadCount, 2);
    ie.shutdown();
  } finally {
    mock.timers.reset();
  }
});

test('repeated touches keep embedder alive', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    let loadCount = 0;
    const factory = async () => {
      loadCount++;
      return { dimension: 1024 };
    };
    const ie = createIdleEmbedder({ factory, idleMs: 100 });
    await ie.get();
    for (let i = 0; i < 5; i++) {
      ie.touch();
      mock.timers.tick(30);
      await drainMicrotasks();
    }
    await ie.get();
    assert.equal(loadCount, 1);
    ie.shutdown();
  } finally {
    mock.timers.reset();
  }
});

test('concurrent get() calls share one factory load (no duplicate embedders)', async () => {
  // This test exercises the in-flight-promise dedup, which is independent of
  // the idle timer. Real awaits + real microtask ordering are fine here and
  // the small 20ms delay is the point of the test (gives both Promise.all
  // callers time to observe the in-flight state).
  let loadCount = 0;
  const factory = async () => {
    loadCount++;
    // Simulate a slow load so the second call sees the in-flight state.
    await new Promise((r) => setTimeout(r, 20));
    return { dimension: 1024, id: loadCount };
  };
  const ie = createIdleEmbedder({ factory, idleMs: 10_000 });
  const [a, b, c] = await Promise.all([ie.get(), ie.get(), ie.get()]);
  assert.equal(loadCount, 1, 'factory called exactly once across concurrent get() calls');
  assert.strictEqual(a, b, 'concurrent callers see the same instance');
  assert.strictEqual(b, c);
  ie.shutdown();
});
