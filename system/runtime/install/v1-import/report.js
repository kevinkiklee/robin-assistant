// report.js — accumulate per-pass counts + warnings + errors and render the
// summary that import-v1 prints (and writes to cache/).

export function newReport() {
  return {
    started_at: new Date(),
    finished_at: null,
    embed_mode: 'sync',
    embedder_profile: null,
    counts: {
      entities: { created: 0, merged: 0, skipped: 0 },
      memos: 0,
      memos_skipped: 0,
      edges: 0,
      events: 0,
      events_skipped: 0,
      rules: 0,
      patterns: 0,
      refusals: 0,
      source_files: 0,
      chunked: 0,
    },
    breakdown_events: { journal: 0, log: 0, decision: 0, inbox: 0, correction: 0 },
    breakdown_edges: { about: 0, mentions: 0, derived_from: 0, supersedes: 0 },
    embed_summary: null,
    warnings: {
      unresolved_link: [],
      missing_source: [],
      undated_event: [],
      long_content_chunked: [],
    },
    notes: {
      entity_alias_kept_both: [],
    },
    errors: [],
  };
}

export function renderReport(report) {
  const dur = report.finished_at
    ? `${((report.finished_at - report.started_at) / 1000).toFixed(1)}s`
    : 'in progress';
  const lines = [];
  lines.push('=== robin import-v1 — report ===');
  lines.push(`Started:  ${report.started_at.toISOString()}`);
  lines.push(`Duration: ${dur}`);
  if (report.embedder_profile) lines.push(`Embedder profile: ${report.embedder_profile}`);
  lines.push(`Embed mode: ${report.embed_mode}`);
  lines.push('');
  lines.push('Imported (new):');
  lines.push(`  entities          ${report.counts.entities.created + report.counts.entities.merged}`);
  lines.push(`    (created: ${report.counts.entities.created}, merged: ${report.counts.entities.merged})`);
  lines.push(`  memos             ${report.counts.memos}`);
  lines.push(`  edges             ${report.counts.edges}`);
  lines.push(`  events            ${report.counts.events}`);
  lines.push(`  rules             ${report.counts.rules}`);
  lines.push(`  patterns          ${report.counts.patterns}`);
  lines.push(`  refusals          ${report.counts.refusals}`);
  lines.push(`  source files      ${report.counts.source_files}`);
  if (report.counts.chunked > 0) lines.push(`  chunked memos     ${report.counts.chunked}`);
  lines.push('');
  lines.push('Skipped (already imported):');
  lines.push(`  memos:  ${report.counts.memos_skipped}`);
  lines.push(`  events: ${report.counts.events_skipped}`);
  lines.push(`  entities (alias-merged on second pass): ${report.counts.entities.merged}`);
  lines.push('');
  const totalWarn = Object.values(report.warnings).reduce((a, w) => a + w.length, 0);
  if (totalWarn > 0) {
    lines.push('Warnings:');
    for (const [k, v] of Object.entries(report.warnings)) {
      if (v.length > 0) lines.push(`  ${k}: ${v.length}`);
    }
    lines.push('');
  }
  lines.push(`Errors: ${report.errors.length}`);
  if (report.errors.length > 0) {
    for (const e of report.errors.slice(0, 10)) {
      lines.push(`  [${e.pass}] ${e.file ?? e.row?.from_path ?? ''}: ${e.message}`);
    }
    if (report.errors.length > 10) lines.push(`  ... and ${report.errors.length - 10} more`);
    lines.push('');
  }
  if (report.embed_summary) lines.push(`Embedding backfill: ${report.embed_summary}`);
  return lines.join('\n');
}
