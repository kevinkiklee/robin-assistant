// system/scripts/lib/sessions.js
//
// Reads user-data/state/sessions.md and returns the most-recent
// session-id for a given platform whose last-active is within 2h.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

export function mostRecentSessionId(workspaceDir, platform, opts = {}) {
  const now = opts.now ?? new Date();
  const file = join(workspaceDir, 'user-data/state/sessions.md');
  if (!existsSync(file)) return null;
  const text = readFileSync(file, 'utf8');

  // Match table rows: "| <session> | <iso-timestamp> |"
  const rowRe = /^\|\s*([^\s|][^|]*?)\s*\|\s*([0-9T:.\-Z]+)\s*\|/gm;
  let best = null;
  let m;
  while ((m = rowRe.exec(text)) !== null) {
    const sid = m[1].trim();
    const ts = m[2].trim();
    if (!sid.startsWith(`${platform}-`)) continue;
    const t = new Date(ts);
    if (Number.isNaN(t.getTime())) continue;
    if (Math.abs(now.getTime() - t.getTime()) > TWO_HOURS_MS) continue;
    if (!best || t > best.t) best = { sid, t };
  }
  return best?.sid ?? null;
}
