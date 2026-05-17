// prediction-taxonomy-cluster.js — pure greedy cosine-similarity clustering
// for the prediction-taxonomy dream step.
//
// Takes a list of { id, embedding } objects (embedding = Float32Array or
// number[], already L2-normalised by the embedder) and returns clusters as
// arrays of ids. Each prediction starts in its own singleton cluster; the
// greedy pass assigns each subsequent prediction to the first existing cluster
// whose centroid has cosine ≥ threshold. If none qualifies, a new cluster is
// started.
//
// Centroid is the element-wise mean of member embeddings, recomputed on each
// join. Normalization of the centroid is not required because we only compare
// against the raw cosine (dot product suffices for unit-normalised inputs, but
// for centroids of unit-normalised vectors the mean is no longer unit-normalised,
// so we use the full cosine formula here).

/**
 * Cosine similarity between two numeric arrays.
 * Returns 0 for zero-length or dimension-mismatched inputs.
 *
 * @param {Float32Array|number[]} a
 * @param {Float32Array|number[]} b
 * @returns {number}
 */
export function cosineSim(a, b) {
  if (!a || !b || a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Compute the element-wise mean of an array of equal-length numeric arrays.
 *
 * @param {Array<Float32Array|number[]>} vecs
 * @returns {number[]}
 */
function meanVector(vecs) {
  if (vecs.length === 0) return [];
  const dim = vecs[0].length;
  const acc = new Array(dim).fill(0);
  for (const v of vecs) {
    for (let i = 0; i < dim; i++) acc[i] += v[i];
  }
  const n = vecs.length;
  return acc.map((x) => x / n);
}

/**
 * Greedy single-pass cosine clustering.
 *
 * Each prediction is assigned to the first existing cluster whose centroid has
 * cosine ≥ threshold; otherwise a new cluster is started. Centroid is the
 * element-wise mean of member embeddings and is recomputed on each join.
 *
 * @param {Array<{id: string|object, embedding: Float32Array|number[]}>} items
 * @param {number} [threshold=0.75]
 * @returns {Array<{ids: Array<string|object>, centroid: number[]}>}
 */
export function greedyCluster(items, threshold = 0.75) {
  /** @type {Array<{ids: Array<string|object>, vecs: Array<Float32Array|number[]>, centroid: number[]}>} */
  const clusters = [];

  for (const item of items) {
    if (!item.embedding || item.embedding.length === 0) continue;

    let assigned = false;
    for (const cluster of clusters) {
      if (cosineSim(item.embedding, cluster.centroid) >= threshold) {
        cluster.ids.push(item.id);
        cluster.vecs.push(item.embedding);
        cluster.centroid = meanVector(cluster.vecs);
        assigned = true;
        break;
      }
    }

    if (!assigned) {
      clusters.push({
        ids: [item.id],
        vecs: [item.embedding],
        centroid: Array.from(item.embedding),
      });
    }
  }

  // Strip vecs from output (internal scratch only).
  return clusters.map(({ ids, centroid }) => ({ ids, centroid }));
}
