import { sha256 } from '../embed/hash.js';

export function sourceHash(v1_id) {
  return sha256(`v1:${v1_id}`);
}

export function buildFromV1({ v1_table, v1_id, migrated_at }) {
  return {
    v1_table,
    v1_id,
    source_hash: sourceHash(v1_id),
    migrated_at: migrated_at ?? new Date().toISOString(),
  };
}
