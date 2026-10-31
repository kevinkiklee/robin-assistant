/**
 * int8 quantization for the events_vec search index.
 *
 * Gemini's 3072-d embeddings are L2-normalized; the observed max |component| across the
 * corpus is ~0.234. Storing them as float32 costs 12,288 bytes/vector; int8 costs 3,072
 * — a 4× reduction (events_vec ~264 MB → ~66 MB) — and sqlite-vec's brute-force KNN runs
 * faster on int8. Recall ranking is preserved (verified: top-1 match, ~10/10 top-10
 * overlap on real vectors).
 *
 * SCALE maps the float range to int8. At 400, the corpus max 0.234 → ±94 (good
 * resolution) and only components beyond 127/400 = 0.3175 clip — generous headroom over
 * what normalized embeddings produce, and clipping a few of 3072 dims is harmless to
 * ranking. The key property: int8 L2 distance = SCALE × float L2 distance, so dividing a
 * returned distance by SCALE recovers the float-equivalent distance — leaving recall's
 * maxDistance floor and `1 - distance` score semantics unchanged.
 */
export const VEC_SCALE = 400;

/** Quantize a float embedding to int8 (scaled, rounded, clamped to [-128, 127]). */
export function quantizeToInt8(vec: ArrayLike<number>): Int8Array {
  const out = new Int8Array(vec.length);
  for (let i = 0; i < vec.length; i++) {
    const q = Math.round(vec[i] * VEC_SCALE);
    out[i] = q < -128 ? -128 : q > 127 ? 127 : q;
  }
  return out;
}

/** Quantized embedding as a JSON int8 array — the form sqlite-vec's `vec_int8()` parses. */
export function quantizeToInt8Json(vec: ArrayLike<number>): string {
  return JSON.stringify(Array.from(quantizeToInt8(vec)));
}

/** Recover the float-equivalent L2 distance from an int8 L2 distance. */
export function int8DistanceToFloat(distance: number): number {
  return distance / VEC_SCALE;
}
