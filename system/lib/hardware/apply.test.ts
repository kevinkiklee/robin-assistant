import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parse as parseYaml } from 'yaml';
import { writeHardwareYaml } from './apply.ts';

test('apply: writes hardware.yaml with detected profile + runtime block', () => {
  const dir = mkdtempSync(join(tmpdir(), 'robin-hw-'));
  const path = writeHardwareYaml(dir, {
    cpu: 'Apple M4 Pro',
    arch: 'arm64',
    ram_gb: 48,
    os: 'darwin-26.x',
    profile: 'm4-apple-silicon',
  });
  const doc = parseYaml(readFileSync(path, 'utf8'));
  assert.equal(doc.detected.profile, 'm4-apple-silicon');
  assert.equal(doc.runtime.ollama_backend, 'mlx');
  assert.equal(doc.runtime.max_concurrent_models, 2);
  assert.equal(doc.scheduling.prefer_overnight.enabled, true);
});

test('apply: chooses cloud-only profile for unknown hardware', () => {
  const dir = mkdtempSync(join(tmpdir(), 'robin-hw-'));
  const path = writeHardwareYaml(dir, {
    cpu: 'Intel Xeon',
    arch: 'x64',
    ram_gb: 8,
    os: 'linux-6',
    profile: 'cloud-only',
  });
  const doc = parseYaml(readFileSync(path, 'utf8'));
  assert.equal(doc.runtime.max_concurrent_models, 0);
});
