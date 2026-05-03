// system/tests/lib/ids.js
//
// Deterministic random patches for the e2e harness.
//
// Patched surfaces:
//   - Math.random
//   - globalThis.crypto.randomUUID
//   - globalThis.crypto.getRandomValues
//
// NOT patched: node:crypto's randomBytes / randomFillSync / etc. These
// live on an immutable ES module namespace and cannot be reassigned at
// runtime. Source code that needs deterministic bytes should use
// globalThis.crypto.getRandomValues (which IS patchable) or migrate to a
// shared lib/ids.js helper. Robin's package does not currently rely on
// node:crypto.randomBytes for any value that ends up in snapshot output,
// so this gap does not affect harness correctness today.

const realMathRandom = Math.random.bind(Math);
const realRandomUUID = globalThis.crypto?.randomUUID?.bind(globalThis.crypto);
const realGetRandomValues = globalThis.crypto?.getRandomValues?.bind(globalThis.crypto);

let state = null; // { seed, rand }

function hashSeed(seed) {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return (h ^ (h >>> 16)) >>> 0;
}

function mulberry32(seedInt) {
  let s = seedInt >>> 0;
  return function () {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function nextByte() {
  return Math.floor(state.rand() * 256);
}

export function installRandom(seed) {
  if (state) uninstallRandom();
  state = { seed, rand: mulberry32(hashSeed(seed)) };

  Math.random = state.rand;

  globalThis.crypto.randomUUID = function () {
    const bytes = Array.from({ length: 16 }, () => nextByte().toString(16).padStart(2, '0'));
    bytes[6] = '4' + bytes[6][1];
    bytes[8] = (['8', '9', 'a', 'b'][nextByte() % 4]) + bytes[8][1];
    return `${bytes.slice(0, 4).join('')}-${bytes.slice(4, 6).join('')}-${bytes.slice(6, 8).join('')}-${bytes.slice(8, 10).join('')}-${bytes.slice(10, 16).join('')}`;
  };

  globalThis.crypto.getRandomValues = function (view) {
    for (let i = 0; i < view.length; i++) view[i] = nextByte();
    return view;
  };

  process.env.ROBIN_RANDOM_SEED = seed;
}

export function uninstallRandom() {
  if (!state) return;
  Math.random = realMathRandom;
  if (realRandomUUID) globalThis.crypto.randomUUID = realRandomUUID;
  if (realGetRandomValues) globalThis.crypto.getRandomValues = realGetRandomValues;
  state = null;
  delete process.env.ROBIN_RANDOM_SEED;
}
