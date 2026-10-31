import { buildDispatcherFromConfig } from '../../brain/llm/build-dispatcher.ts';
import type { LLMDispatcher } from '../../brain/llm/dispatcher.ts';
import { closeDb, openDb } from '../../brain/memory/db.ts';
import { allMigrations, applyMigrations } from '../../brain/memory/migrations/index.ts';
import { type RecallOptions, recall } from '../../brain/memory/recall.ts';
import { loadModels } from '../../kernel/config/load.ts';
import { dbFilePath, resolveUserDataDir } from '../../lib/paths.ts';
import { loadEnvFile } from '../../lib/secrets/load-env.ts';

function flagValue(args: string[], prefix: string): string | undefined {
  return args.find((a) => a.startsWith(prefix))?.slice(prefix.length);
}

/**
 * `robin recall [--debug] [--limit=N] [--mode=lex|vec|hybrid] <query…>`
 *
 * The first real CLI surface over `recall()`. Also the L2-floor tuning tool:
 * `robin recall --debug --mode=vec "<query>"` prints each vec hit's distance
 * (derived from `1 - score`), so the conservative `maxDistance` floor used by
 * auto-recall can be set from measured numbers rather than guessed.
 */
export async function runRecall(args: string[]): Promise<void> {
  const debug = args.includes('--debug');
  const limitRaw = flagValue(args, '--limit=');
  const modeRaw = flagValue(args, '--mode=');
  const limit = limitRaw ? Number(limitRaw) : 10;
  const mode: RecallOptions['mode'] | undefined =
    modeRaw === 'lex' || modeRaw === 'vec' || modeRaw === 'hybrid' ? modeRaw : undefined;

  const query = args
    .filter((a) => !a.startsWith('--'))
    .join(' ')
    .trim();
  if (!query) {
    console.error('usage: robin recall [--debug] [--limit=N] [--mode=lex|vec|hybrid] <query…>');
    process.exit(2);
  }

  const userData = resolveUserDataDir();
  // MCP servers / daemon load env at their entry points; a standalone CLI must too,
  // or the embed provider sees no GEMINI_API_KEY and vec recall silently degrades.
  loadEnvFile(userData);

  // Build the dispatcher; fall back to lex-only recall if no embed provider is wired.
  let dispatcher: LLMDispatcher | null = null;
  try {
    dispatcher = buildDispatcherFromConfig(loadModels(userData), { lenient: true });
  } catch (err) {
    console.error(`(no LLM dispatcher; lex-only) ${err instanceof Error ? err.message : err}`);
  }

  const db = openDb(dbFilePath(userData));
  applyMigrations(db, allMigrations);
  try {
    const hits = await recall(db, dispatcher, query, { limit, mode, source: 'manual' });
    if (hits.length === 0) {
      console.log('(no hits)');
      return;
    }
    hits.forEach((h, i) => {
      const tags = [h.source, h.kind].filter(Boolean).join(' ');
      let head = `${i + 1}. [${tags}] score=${h.score.toFixed(4)}`;
      if (debug) {
        if (h.source === 'vec') head += ` distance≈${(1 - h.score).toFixed(4)}`;
        if (h.ageDays !== undefined) head += ` age=${h.ageDays}d`;
        if (h.confidence != null) head += ` conf=${h.confidence}`;
      }
      console.log(head);
      console.log(`   ${h.body.replace(/\s+/g, ' ').slice(0, 200)}`);
    });
  } finally {
    closeDb(db);
  }
}
