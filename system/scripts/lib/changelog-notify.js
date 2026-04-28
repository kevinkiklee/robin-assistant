import { existsSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export async function checkChangelog(workspaceDir = process.cwd()) {
  const clPath = join(workspaceDir, 'system/CHANGELOG.md');
  const stampPath = join(workspaceDir, 'user-data/.last-seen-changelog');
  if (!existsSync(clPath)) return { notice: null };

  const clMtime = statSync(clPath).mtimeMs;
  const lastSeen = existsSync(stampPath) ? Number(readFileSync(stampPath, 'utf-8')) : 0;
  if (clMtime <= lastSeen) return { notice: null };

  const content = readFileSync(clPath, 'utf-8');
  const firstEntry = extractFirstEntry(content);
  writeFileSync(stampPath, String(clMtime));
  return { notice: firstEntry ?? null };
}

/**
 * Extract the first `## ` entry from a CHANGELOG, including its body up to the
 * next `## ` heading or end of file. Handles both `## [3.0.0] - unreleased`
 * and `## 2.1.0 — Memory Indexing` heading styles.
 */
function extractFirstEntry(content) {
  const lines = content.split(/\r?\n/);
  let startIdx = -1;
  let endIdx = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) {
      if (startIdx === -1) {
        startIdx = i;
      } else {
        endIdx = i;
        break;
      }
    }
  }
  if (startIdx === -1) return null;
  return lines.slice(startIdx, endIdx).join('\n').trim();
}
