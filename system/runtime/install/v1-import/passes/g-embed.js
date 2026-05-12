// passes/g-embed.js — run the embedding backfill across events + memos + entities.
//
// Delegates to `system/cognition/jobs/internal/embeddings-backfill.js` so the
// migrator doesn't reinvent the embed/cursor/profile-table machinery. With
// `embed: 'defer'`, this pass is a no-op (the heartbeat will pick everything
// up on its normal schedule).

export async function passEmbed({ db, mode, report }) {
  if (mode !== 'sync') return { summary: 'deferred' };
  try {
    const mod = await import('../../../../cognition/jobs/internal/embeddings-backfill.js');
    const fn = mod.default ?? mod.embeddingsBackfill;
    const summary = await fn({ db });
    return { summary };
  } catch (e) {
    report.errors.push({ pass: 'G', message: e.message });
    return { summary: `error: ${e.message}` };
  }
}
