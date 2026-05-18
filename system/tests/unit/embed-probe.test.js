// Tests for the synthetic embed probe writer. Verifies that the success
// path writes `last_success_ts` and clears `last_error`, and the failure
// path preserves the prior timestamp while recording the error message.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeEmbedProbe } from '../../data/embed/probe.js';

function makeFakeDb({ selectRows = [], onUpsert = () => {} } = {}) {
  const calls = [];
  return {
    calls,
    query(sql, params) {
      calls.push({ sql, params });
      if (/^\s*SELECT/i.test(sql)) {
        return { collect: async () => selectRows };
      }
      // UPSERT
      return {
        collect: async () => {
          onUpsert(params ?? {});
          return [];
        },
      };
    },
  };
}

test('writeEmbedProbe success path writes last_success_ts and null last_error', async () => {
  let upserted = null;
  const db = makeFakeDb({
    selectRows: [],
    onUpsert: (fields) => {
      upserted = fields;
    },
  });
  const embedFn = async () => new Array(1024).fill(0.1);
  const before = Date.now();
  const result = await writeEmbedProbe(db, embedFn);
  const after = Date.now();
  assert.equal(result.ok, true);
  assert.equal(result.error, null);
  assert.ok(upserted, 'UPSERT was issued');
  assert.equal(upserted.last_error, null);
  assert.match(upserted.last_success_ts, /^\d{4}-\d{2}-\d{2}T/);
  const ts = new Date(upserted.last_success_ts).getTime();
  assert.ok(ts >= before && ts <= after, 'last_success_ts is current');
});

test('writeEmbedProbe failure path preserves prior last_success_ts and records error', async () => {
  const priorTs = '2026-05-16T11:00:00.000Z';
  let upserted = null;
  const db = makeFakeDb({
    selectRows: [{ last_success_ts: priorTs }],
    onUpsert: (fields) => {
      upserted = fields;
    },
  });
  const embedFn = async () => {
    throw new Error('embedder offline');
  };
  const result = await writeEmbedProbe(db, embedFn);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'embedder offline');
  assert.ok(upserted);
  assert.equal(upserted.last_success_ts, priorTs, 'prior ts preserved on failure');
  assert.equal(upserted.last_error, 'embedder offline');
});

test('writeEmbedProbe failure with no prior row writes null last_success_ts', async () => {
  let upserted = null;
  const db = makeFakeDb({
    selectRows: [],
    onUpsert: (fields) => {
      upserted = fields;
    },
  });
  const embedFn = async () => {
    throw new Error('boom');
  };
  const result = await writeEmbedProbe(db, embedFn);
  assert.equal(result.ok, false);
  assert.equal(upserted.last_success_ts, null);
  assert.equal(upserted.last_error, 'boom');
});

test('writeEmbedProbe rejects empty-vector returns as failure', async () => {
  let upserted = null;
  const db = makeFakeDb({
    selectRows: [],
    onUpsert: (fields) => {
      upserted = fields;
    },
  });
  const embedFn = async () => [];
  const result = await writeEmbedProbe(db, embedFn);
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /empty vector/);
  assert.equal(upserted.last_error, result.error);
});

test('writeEmbedProbe missing embedFn returns ok:false without throwing', async () => {
  const db = makeFakeDb();
  const result = await writeEmbedProbe(db, null);
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /embedFn/);
});
