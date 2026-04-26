import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

export function createTempDir() {
  return mkdtempSync(join(tmpdir(), 'arc-test-'));
}

export function cleanTempDir(dir) {
  rmSync(dir, { recursive: true, force: true });
}

export function writeJson(dir, filename, data) {
  writeFileSync(join(dir, filename), JSON.stringify(data, null, 2) + '\n');
}

export function readJson(dir, filename) {
  return JSON.parse(readFileSync(join(dir, filename), 'utf-8'));
}

export function fileExists(dir, ...parts) {
  try {
    readFileSync(join(dir, ...parts));
    return true;
  } catch {
    return false;
  }
}

export function readText(dir, ...parts) {
  return readFileSync(join(dir, ...parts), 'utf-8');
}
