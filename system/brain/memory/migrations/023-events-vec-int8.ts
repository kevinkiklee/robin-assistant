import { quantizeToInt8Json } from '../vec-quantize.ts';
import type { Migration } from './types.ts';

export const migration023: Migration = {
  version: 23,
  name: 'events-vec-int8',
  up: (db) => {
    // Convert events_vec from float[3072] to int8[3072] — 4× smaller (~264 MB → ~66 MB)
    // and a faster brute-force KNN, with recall ranking preserved (see vec-quantize.ts).
    // We read each float vector, quantize with the shared scale, and rebuild the table
    // (vec0 has no RENAME or ALTER, so it's drop + recreate). Quantization must match the
    // scale used by recall.ts and reindex.ts — hence the shared quantizeToInt8Json.
    //
    // Float buffers are streamed via iterate() and reduced to compact int8 JSON up front,
    // so the original table can be dropped without holding all float vectors in memory at
    // once (the live corpus is ~21k × 12 KB).
    const staged: Array<{ rowid: number; json: string }> = [];
    for (const row of db.prepare(`SELECT rowid, embedding FROM events_vec`).iterate() as Iterable<{
      rowid: number;
      embedding: Buffer;
    }>) {
      const b = row.embedding;
      const f = new Float32Array(b.buffer, b.byteOffset, b.length / 4);
      staged.push({ rowid: row.rowid, json: quantizeToInt8Json(f) });
    }

    db.exec(`DROP TABLE events_vec`);
    db.exec(`CREATE VIRTUAL TABLE events_vec USING vec0(embedding int8[3072])`);
    const ins = db.prepare(`INSERT INTO events_vec(rowid, embedding) VALUES (?, vec_int8(?))`);
    for (const s of staged) ins.run(BigInt(s.rowid), s.json);
  },
};
