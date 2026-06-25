// system/lib/sky/deliver.ts
import type { RobinDb } from '../../brain/memory/db.ts';
import { recordAlert, resolveAlert } from '../../kernel/runtime/alert-store.ts';
import { notifyMacOSAction } from '../../integrations/builtin/notify/index.ts';
import { mergeMatches } from './recipes.ts';
import type { Notification, RecipeMatch } from './types.ts';

const defaultDeliver = async (n: Notification) => {
  await notifyMacOSAction({ title: n.title, message: n.message });
};

export async function fireMatches(opts: {
  db: RobinDb;
  matches: RecipeMatch[];
  openKeys: string[];
  deliver?: (n: Notification) => Promise<void>;
}): Promise<{ fired: string[]; resolved: string[] }> {
  const deliver = opts.deliver ?? defaultDeliver;
  const matchedKeys = new Set(opts.matches.map((m) => m.key));

  // Silent-cancel: previously-open sky alerts no longer matching.
  const resolved: string[] = [];
  for (const key of opts.openKeys) {
    if (!matchedKeys.has(key)) {
      resolveAlert(opts.db, 'sky', key);
      resolved.push(key);
    }
  }

  // Record and deliver only truly new matches (not already open).
  const newMatches = opts.matches.filter((m) => !opts.openKeys.includes(m.key));
  const fired: string[] = [];
  for (const m of newMatches) {
    recordAlert(opts.db, { severity: 'info', source: 'sky', key: m.key, message: `${m.title} — ${m.body}`, context: { recipe: m.recipe, window: m.window, date: m.windowDate } });
    fired.push(m.key);
  }
  for (const note of mergeMatches(newMatches)) await deliver(note);

  return { fired, resolved };
}
