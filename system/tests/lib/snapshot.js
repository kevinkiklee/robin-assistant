import { readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync, renameSync, existsSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';

function* walk(rootDir, currentDir) {
  for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
    const full = join(currentDir, entry.name);
    if (entry.isDirectory()) yield* walk(rootDir, full);
    else if (entry.isFile()) yield relative(rootDir, full).split(sep).join('/');
  }
}

function matchesAnyGlob(relpath, globs) {
  for (const g of globs) {
    // Minimal glob: convert ** and * to regex parts.
    const re = new RegExp('^' + g
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, '.+')
      .replace(/\*/g, '[^/]+')
      + '$');
    if (re.test(relpath)) return true;
  }
  return false;
}

function looksBinary(buf) {
  // First 8KB; nul byte → binary.
  const slice = buf.subarray(0, Math.min(buf.length, 8192));
  for (let i = 0; i < slice.length; i++) if (slice[i] === 0) return true;
  return false;
}

export function captureTree(rootDir, ignoreGlobs = []) {
  if (!existsSync(rootDir)) return {};
  const out = {};
  for (const rel of walk(rootDir, rootDir)) {
    if (matchesAnyGlob(rel, ignoreGlobs)) continue;
    const buf = readFileSync(join(rootDir, rel));
    if (looksBinary(buf)) {
      throw new Error(`captureTree: binary file at ${rel} — Robin shouldn't write binaries; expand harness if intentional`);
    }
    out[rel] = buf.toString('utf8');
  }
  return out;
}

export function compareTrees(actualMap, expectedMap) {
  const actualKeys = new Set(Object.keys(actualMap));
  const expectedKeys = new Set(Object.keys(expectedMap));
  const missing = [...expectedKeys].filter((k) => !actualKeys.has(k)).sort();
  const unexpected = [...actualKeys].filter((k) => !expectedKeys.has(k)).sort();
  const contentDiffs = [];
  for (const k of [...expectedKeys].sort()) {
    if (actualKeys.has(k) && actualMap[k] !== expectedMap[k]) {
      contentDiffs.push({ relpath: k, expected: expectedMap[k], actual: actualMap[k] });
    }
  }
  return { missing, unexpected, contentDiffs };
}

export function writeTreeAtomic(targetDir, contentMap) {
  const tmp = targetDir + '.new';
  if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  for (const [rel, content] of Object.entries(contentMap)) {
    const full = join(tmp, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  if (existsSync(targetDir)) rmSync(targetDir, { recursive: true, force: true });
  renameSync(tmp, targetDir);
}

export function loadExpectedTree(expectedDir) {
  if (!existsSync(expectedDir)) return {};
  const out = {};
  for (const rel of walk(expectedDir, expectedDir)) {
    out[rel] = readFileSync(join(expectedDir, rel), 'utf8');
  }
  return out;
}

export function formatDiff({ missing, unexpected, contentDiffs }, { contentDiffCap = 5 } = {}) {
  const lines = [];
  const total = missing.length + unexpected.length + contentDiffs.length;
  lines.push(`  Tree differences (${total} files; ${contentDiffs.length} with content diffs):`);
  for (const m of missing) lines.push(`    [missing]    ${m}`);
  for (const u of unexpected) lines.push(`    [unexpected] ${u}`);
  for (const c of contentDiffs.slice(0, contentDiffCap)) {
    lines.push(`    [content]    ${c.relpath}`);
    lines.push('        --- expected');
    lines.push('        +++ actual');
    const exp = c.expected.split('\n');
    const act = c.actual.split('\n');
    for (const l of exp) lines.push(`        - ${l}`);
    for (const l of act) lines.push(`        + ${l}`);
  }
  if (contentDiffs.length > contentDiffCap) {
    lines.push(`    … and ${contentDiffs.length - contentDiffCap} more files differ — see preserved tempdir.`);
  }
  return lines.join('\n');
}
