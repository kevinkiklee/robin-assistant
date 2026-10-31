import {
  applyCorrectionTopics,
  proposeCorrectionTopics,
  type TopicProposal,
} from '../../brain/learning/correction-topics.ts';
import { buildDispatcherFromConfig } from '../../brain/llm/build-dispatcher.ts';
import type { LLMDispatcher } from '../../brain/llm/dispatcher.ts';
import { closeDb, openDb } from '../../brain/memory/db.ts';
import { allMigrations, applyMigrations } from '../../brain/memory/migrations/index.ts';
import { loadModels } from '../../kernel/config/load.ts';
import { dbFilePath, resolveUserDataDir } from '../../lib/paths.ts';
import { loadEnvFile } from '../../lib/secrets/load-env.ts';

const USAGE = 'usage: robin corrections topics [--apply] [--limit=N]';

function flagValue(args: string[], prefix: string): string | undefined {
  return args.find((a) => a.startsWith(prefix))?.slice(prefix.length);
}

/** Human-readable dry-run/apply report. Exported for tests. */
export function formatTopicProposals(proposals: TopicProposal[], applied: number | null): string {
  const lines: string[] = [];
  const linked = proposals.filter((p) => p.topic);
  for (const p of proposals) {
    const head = `#${p.correctionId} ${p.correction.replace(/\s+/g, ' ').slice(0, 100)}`;
    if (p.topic) lines.push(`${head}\n    → ${p.topic}`);
    else if (p.candidates.length === 0) lines.push(`${head}\n    → (no live candidate topic)`);
    else
      lines.push(
        `${head}\n    → null (candidates: ${p.candidates.map((c) => c.topic).join(', ')})`,
      );
  }
  lines.push('');
  lines.push(
    `${proposals.length} topic-less corrections judged — ${linked.length} linked, ${proposals.length - linked.length} left topic-less.`,
  );
  lines.push(
    applied === null
      ? 'Dry run — nothing written. Re-run with --apply to set these topics; the nightly dream pass then applies them.'
      : `Wrote ${applied} topic(s). apply-corrections picks them up on the next dream run.`,
  );
  return lines.join('\n');
}

/**
 * `robin corrections topics [--apply] [--limit=N]` — LLM-assign belief topics to
 * topic-less corrections (classify role, batched) so apply-corrections can retract the
 * refuted belief and assert the correction. Dry-run by default.
 */
export async function runCorrectionsCommand(args: string[]): Promise<void> {
  const sub = args[0];
  /* biome-ignore-start lint/suspicious/noConsole: CLI output */
  if (sub !== 'topics') {
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }
  const apply = args.includes('--apply');
  const limitRaw = flagValue(args, '--limit=');
  const limit = limitRaw ? Number(limitRaw) : undefined;
  if (limit !== undefined && !(Number.isInteger(limit) && limit > 0)) {
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }

  const userData = resolveUserDataDir();
  loadEnvFile(userData);
  let llm: LLMDispatcher;
  try {
    llm = buildDispatcherFromConfig(loadModels(userData), { lenient: true });
  } catch (err) {
    console.error(`corrections topics needs an LLM (classify role): ${String(err)}`);
    process.exitCode = 1;
    return;
  }
  const db = openDb(dbFilePath(userData));
  applyMigrations(db, allMigrations);
  try {
    const proposals = await proposeCorrectionTopics(db, llm, { limit });
    const applied = apply ? applyCorrectionTopics(db, proposals) : null;
    console.log(formatTopicProposals(proposals, applied));
  } finally {
    closeDb(db);
  }
  /* biome-ignore-end lint/suspicious/noConsole: CLI output */
}
