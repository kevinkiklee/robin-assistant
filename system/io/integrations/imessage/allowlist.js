// Reads the user's iMessage allowlist file. Format: one entry per line,
// either `handle:<normalized-handle>` for DMs or `chat:<guid>` for groups.
// Lines starting with `#` are comments. Blank lines ignored.
//
// Default path: <user-data>/io/integrations/imessage/allowlist.txt
//
// Returned shape mirrors what normalize.js#isAllowed consumes:
//   { directHandles: Set<string>, groupChats: Set<string> }

import { readFileSync, existsSync } from 'node:fs';
import { normalizeHandle } from './normalize.js';

export function parseAllowlist(text) {
  const directHandles = new Set();
  const groupChats = new Set();
  if (typeof text !== 'string') return { directHandles, groupChats };
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    if (line.startsWith('handle:')) {
      const h = normalizeHandle(line.slice('handle:'.length));
      if (h) directHandles.add(h);
    } else if (line.startsWith('chat:')) {
      const g = line.slice('chat:'.length).trim();
      if (g) groupChats.add(g);
    }
    // Silently skip unrecognized prefixes — forward-compat for future kinds.
  }
  return { directHandles, groupChats };
}

export function loadAllowlist(path) {
  if (!path || !existsSync(path)) {
    return { directHandles: new Set(), groupChats: new Set() };
  }
  return parseAllowlist(readFileSync(path, 'utf8'));
}
