import { stage1Resolve } from './stage1-exact.js';
import { stage2Resolve } from './stage2-embedding.js';
import { stage3Disambig } from './stage3-disambig.js';

export async function resolveEntity(db, embedder, host, { name, type, config }) {
  // Stage 1
  const s1 = await stage1Resolve(db, { name, type });
  if (s1) return { action: 'resolve', entityId: s1, stage: 1 };

  // Stage 2
  const s2 = await stage2Resolve(db, embedder, {
    name,
    type,
    highThreshold: config.stage2_high_threshold,
    lowThreshold: config.stage2_low_threshold,
  });
  if (s2.action === 'resolve') {
    return { action: 'resolve', entityId: s2.entityId, stage: 2, similarity: s2.similarity };
  }
  if (s2.action === 'none') {
    return { action: 'none', stage: 2 };
  }

  // Stage 2 escalated → Stage 3
  const s3 = await stage3Disambig(host, { mention: name, type, candidates: s2.candidates });
  if (s3.action === 'resolve') {
    return { action: 'resolve', entityId: s3.entityId, stage: 3 };
  }
  return { action: 'none', stage: 3 };
}
