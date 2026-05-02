// densify-report.js — markdown + summary.json writer for densify-wiki orchestrator.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function bullet(s) { return `- ${s}\n`; }

function passSection(title, body) { return `## ${title}\n\n${body}\n\n`; }

export function writeRunReport({ workspaceDir, date, mode, backupPath, passes, errors = [] }) {
  const outDir = join(workspaceDir, 'user-data', 'runtime', 'state', 'densify-wiki');
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

  const restoreCmd = backupPath ? `npm run restore -- --from ${backupPath}` : '(no backup taken)';

  let md = `# Densify-wiki run — ${date}\n\n`;
  md += `## Summary\n\n`;
  md += bullet(`Mode: --${mode}`);
  md += bullet(`Backup: ${backupPath ?? '(none)'}`);
  md += bullet(`Stubs created: ${passes.prePass0?.stubsCreated ?? 0}`);
  md += bullet(`Aliases added: ${passes.pass1?.aliasesAdded ?? 0}`);
  md += bullet(`Type flips: ${passes.pass1?.typeFlips ?? 0}`);
  md += bullet(`Wiki-links inserted: ${passes.pass2?.linksInserted ?? 0}`);
  md += bullet(`related: edges added: ${passes.pass3?.edgesAdded ?? 0}`);
  md += `\nRestore command: ${restoreCmd}\n\n`;

  md += passSection('Pre-Pass 0 — service-provider stubs (manual)',
    `${passes.prePass0?.stubsCreated ?? 0} stubs accounted for under \`knowledge/service-providers/\`.`);

  md += passSection('Pass 1 — alias expansion',
    (passes.pass1?.perFile ?? []).slice(0, 50)
      .map(p => `- \`${p.relPath}\`: +${p.added.length} aliases${p.typeFlipped ? ' (type flipped)' : ''}`).join('\n')
      || '(no changes)');

  md += passSection('Pass 2 — linker backfill',
    (passes.pass2?.perFile ?? []).slice(0, 50)
      .map(p => `- \`${p.relPath}\`: ${p.linkCount} links`).join('\n') || '(no changes)');

  md += passSection('Pass 3 — related: edges',
    `Pairs considered: ${passes.pass3?.pairsConsidered ?? 0}\n` +
    `After super-hub filter: ${passes.pass3?.pairsAfterFilter ?? 0}\n` +
    `Super-hubs filtered: ${(passes.pass3?.superHubs ?? []).join(', ') || '(none)'}\n` +
    `Edges added: ${passes.pass3?.edgesAdded ?? 0} across ${passes.pass3?.filesModified ?? 0} files\n`);

  md += passSection('Pass 4 — index regen',
    `ENTITIES.md row delta: ${passes.pass4?.entitiesDelta ?? 0}\n` +
    `LINKS.md edge delta: ${passes.pass4?.linksDelta ?? 0}`);

  md += `## Lint findings (warn-level, not auto-fixed)\n\n`;
  md += bullet(`missing-aliases: ${passes.lint?.missingAliases?.length ?? 0} files`);
  md += bullet(`type-mismatch: ${passes.lint?.typeMismatch?.length ?? 0} files`);
  md += bullet(`stale-related: ${passes.lint?.staleRelated?.length ?? 0} files`);
  md += bullet(`ambiguous-aliases (existing): ${passes.lint?.ambiguousAliases?.length ?? 0}`);
  md += bullet(`candidate-entities (existing): ${passes.lint?.candidateEntities?.length ?? 0}`);

  if (errors.length) {
    md += `\n## Errors\n\n${errors.map(e => `- ${e}`).join('\n')}\n`;
  }

  const markdownPath = join(outDir, `${date}.md`);
  const jsonPath = join(outDir, `${date}.json`);
  writeFileSync(markdownPath, md);

  const summary = {
    date,
    mode,
    exit_code: errors.length ? 1 : 0,
    backup_path: backupPath ?? null,
    restore_command: backupPath ? `npm run restore -- --from ${backupPath}` : null,
    counts: {
      stubs_created: passes.prePass0?.stubsCreated ?? 0,
      aliases_added: passes.pass1?.aliasesAdded ?? 0,
      type_flips: passes.pass1?.typeFlips ?? 0,
      links_inserted: passes.pass2?.linksInserted ?? 0,
      related_edges_added: passes.pass3?.edgesAdded ?? 0,
      lint_findings: {
        missing_aliases: passes.lint?.missingAliases?.length ?? 0,
        type_mismatch: passes.lint?.typeMismatch?.length ?? 0,
        stale_related: passes.lint?.staleRelated?.length ?? 0,
        ambiguous_aliases: passes.lint?.ambiguousAliases?.length ?? 0,
        candidate_entities: passes.lint?.candidateEntities?.length ?? 0,
      },
    },
    errors,
    passes: {
      pre_pass_0: passes.prePass0 ? 'ok' : 'skipped',
      pass_1: passes.pass1 ? 'ok' : 'skipped',
      pass_2: passes.pass2 ? 'ok' : 'skipped',
      pass_3: passes.pass3 ? 'ok' : 'skipped',
      pass_4: passes.pass4 ? 'ok' : 'skipped',
    },
  };
  writeFileSync(jsonPath, JSON.stringify(summary, null, 2));
  return { markdownPath, jsonPath };
}
