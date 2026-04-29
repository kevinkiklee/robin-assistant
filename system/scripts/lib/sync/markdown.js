import { writeFileSync, readFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { applyRedaction } from './redact.js';

const MEMORY_PREFIX = 'user-data/memory/';

function shouldRedact(relPath) {
  const norm = relPath.replace(/\\/g, '/');
  return norm.startsWith(MEMORY_PREFIX);
}

export async function atomicWrite(workspaceDir, relPath, content) {
  let body = content;
  if (shouldRedact(relPath)) {
    const { redacted, count } = applyRedaction(content);
    if (count > 0) {
      body = `<!-- redaction: ${count} matches blocked -->\n${redacted}`;
    }
  }
  const full = join(workspaceDir, relPath);
  mkdirSync(dirname(full), { recursive: true });
  const tmp = `${full}.tmp`;
  writeFileSync(tmp, body);
  renameSync(tmp, full);
}

export async function openItem(workspaceDir, relPath, fetcher) {
  const full = join(workspaceDir, relPath);
  if (existsSync(full)) {
    return readFileSync(full, 'utf-8');
  }
  const body = await fetcher();
  await atomicWrite(workspaceDir, relPath, body);
  return readFileSync(full, 'utf-8');
}

function escapeCell(s) {
  return String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

export function writeTable({ columns, rows }) {
  const header = `| ${columns.join(' | ')} |`;
  const divider = `|${columns.map(() => '---').join('|')}|`;
  const body = rows.map(
    (row) => `| ${columns.map((c) => escapeCell(row[c])).join(' | ')} |`
  );
  return [header, divider, ...body].join('\n') + '\n';
}
