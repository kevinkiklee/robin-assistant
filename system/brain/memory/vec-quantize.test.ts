import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import {
  VEC_SCALE,
  int8DistanceToFloat,
  quantizeToInt8,
  quantizeToInt8Json,
} from './vec-quantize.ts';

test('quantizeToInt8 scales, rounds, and clamps to int8 range', () => {
  const out = quantizeToInt8([0, 0.1, -0.1, 1, -1]);
  assert.equal(out[0], 0);
  assert.equal(out[1], Math.round(0.1 * VEC_SCALE)); // within range
  assert.equal(out[2], Math.round(-0.1 * VEC_SCALE));
  assert.equal(out[3], 127, 'clamps above 127');
  assert.equal(out[4], -128, 'clamps below -128');
});

test('quantizeToInt8Json is a JSON int8 array sqlite-vec can parse', () => {
  const json = quantizeToInt8Json([0, 0.1, -0.1]);
  assert.deepEqual(JSON.parse(json), [
    0,
    Math.round(0.1 * VEC_SCALE),
    Math.round(-0.1 * VEC_SCALE),
  ]);
  // sqlite-vec accepts it.
  const db = new Database(':memory:');
  sqliteVec.load(db);
  db.exec(`CREATE VIRTUAL TABLE t USING vec0(embedding int8[3])`);
  db.prepare(`INSERT INTO t(rowid, embedding) VALUES (1, vec_int8(?))`).run(json);
  const n = (db.prepare(`SELECT count(*) AS n FROM t`).get() as { n: number }).n;
  assert.equal(n, 1);
  db.close();
});

test('int8DistanceToFloat divides by the scale', () => {
  assert.equal(int8DistanceToFloat(VEC_SCALE), 1);
  assert.equal(int8DistanceToFloat(VEC_SCALE * 0.82), 0.82);
});

// Seeded RNG so the recall-equivalence check is deterministic.
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function unitVec(rng: () => number, dim: number): Float32Array {
  const v = new Float32Array(dim);
  let norm = 0;
  for (let i = 0; i < dim; i++) {
    v[i] = rng() * 2 - 1;
    norm += v[i] * v[i];
  }
  norm = Math.sqrt(norm);
  for (let i = 0; i < dim; i++) v[i] /= norm;
  return v;
}

test('int8 KNN preserves float32 ranking on 3072-d unit vectors (recall equivalence)', () => {
  const dim = 3072;
  const rng = mulberry32(42);
  const vecs = Array.from({ length: 40 }, () => unitVec(rng, dim));

  const fdb = new Database(':memory:');
  sqliteVec.load(fdb);
  fdb.exec(`CREATE VIRTUAL TABLE v USING vec0(embedding float[${dim}])`);
  const qdb = new Database(':memory:');
  sqliteVec.load(qdb);
  qdb.exec(`CREATE VIRTUAL TABLE v USING vec0(embedding int8[${dim}])`);
  const fi = fdb.prepare(`INSERT INTO v(rowid, embedding) VALUES (?, ?)`);
  const qi = qdb.prepare(`INSERT INTO v(rowid, embedding) VALUES (?, vec_int8(?))`);
  vecs.forEach((v, i) => {
    fi.run(BigInt(i + 1), Buffer.from(v.buffer));
    qi.run(BigInt(i + 1), quantizeToInt8Json(v));
  });

  let overlapSum = 0;
  let top1 = 0;
  const probes = vecs.slice(0, 8);
  for (const p of probes) {
    const fr = fdb
      .prepare(`SELECT rowid FROM v WHERE embedding MATCH ? AND k = 10 ORDER BY distance`)
      .all(Buffer.from(p.buffer)) as Array<{ rowid: number }>;
    const qr = qdb
      .prepare(`SELECT rowid FROM v WHERE embedding MATCH vec_int8(?) AND k = 10 ORDER BY distance`)
      .all(quantizeToInt8Json(p)) as Array<{ rowid: number }>;
    const fset = new Set(fr.map((r) => r.rowid));
    overlapSum += qr.filter((r) => fset.has(r.rowid)).length;
    if (fr[0]?.rowid === qr[0]?.rowid) top1++;
  }
  fdb.close();
  qdb.close();

  // Uniform-random unit vectors are a pessimistic case: in high dimensions they are
  // nearly equidistant, so the top-10 are clustered within a hair and quantization noise
  // can reorder near-ties. Real embeddings have semantic structure with clear nearest
  // neighbors and score ~10/10 (verified on the live corpus). 9.0 guards against a
  // catastrophic ranking regression while tolerating worst-case tie reordering.
  assert.equal(top1, probes.length, 'top-1 must match for every probe');
  assert.ok(
    overlapSum / probes.length >= 9.0,
    `top-10 overlap too low: ${overlapSum / probes.length}`,
  );
});

test('int8 distance / scale approximates the float L2 distance', () => {
  const dim = 3072;
  const rng = mulberry32(7);
  const a = unitVec(rng, dim);
  const b = unitVec(rng, dim);
  let sq = 0;
  for (let i = 0; i < dim; i++) sq += (a[i] - b[i]) ** 2;
  const floatL2 = Math.sqrt(sq);

  const qdb = new Database(':memory:');
  sqliteVec.load(qdb);
  qdb.exec(`CREATE VIRTUAL TABLE v USING vec0(embedding int8[${dim}])`);
  qdb.prepare(`INSERT INTO v(rowid, embedding) VALUES (1, vec_int8(?))`).run(quantizeToInt8Json(b));
  const row = qdb
    .prepare(`SELECT distance FROM v WHERE embedding MATCH vec_int8(?) AND k = 1`)
    .get(quantizeToInt8Json(a)) as { distance: number };
  qdb.close();

  const recovered = int8DistanceToFloat(row.distance);
  assert.ok(Math.abs(recovered - floatL2) < 0.05, `recovered ${recovered} vs float ${floatL2}`);
});
