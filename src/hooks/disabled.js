import { closeSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from '../runtime/data-store.js';

function disabledPath() {
  return join(paths.data.home(), 'hooks-disabled.txt');
}

function readLines() {
  try {
    return readFileSync(disabledPath(), 'utf8').split('\n');
  } catch {
    return null;
  }
}

function parseEntries(lines) {
  const set = new Set();
  for (const raw of lines) {
    const line = raw.replace(/#.*$/, '').trim();
    if (line) set.add(line);
  }
  return set;
}

export function isHookDisabled(phase) {
  const lines = readLines();
  if (lines === null) return false;
  return parseEntries(lines).has(phase);
}

function atomicWrite(contents) {
  const target = disabledPath();
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  const fd = openSync(tmp, 'w', 0o644);
  try {
    writeSync(fd, contents);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, target);
}

export function addDisabled(phase) {
  const lines = readLines() ?? [];
  const set = parseEntries(lines);
  if (set.has(phase)) return;
  const trimmed = lines.length && lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines;
  const next = [...trimmed, phase, ''].join('\n');
  atomicWrite(next);
}

export function removeDisabled(phase) {
  const lines = readLines();
  if (lines === null) return;
  const kept = lines.filter((raw) => {
    const stripped = raw.replace(/#.*$/, '').trim();
    return stripped !== phase;
  });
  const next = kept.join('\n');
  atomicWrite(next);
}
