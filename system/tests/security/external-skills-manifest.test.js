import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadManifest } from '../../scripts/lib/manifest.js';
import { checkExternalSkills } from '../../scripts/diagnostics/check-manifest.js';

describe('manifest: externalSkills field', () => {
  it('auto-fills externalSkills when missing (forward-compat)', () => {
    const ws = mkdtempSync(join(tmpdir(), 'robin-manifest-test-'));
    mkdirSync(join(ws, 'user-data/runtime/security'), { recursive: true });
    writeFileSync(
      join(ws, 'user-data/runtime/security/manifest.json'),
      JSON.stringify({ hooks: {}, mcpServers: { expected: [], writeCapable: [] } }, null, 2)
    );
    try {
      const m = loadManifest(ws);
      assert.ok(m.externalSkills);
      assert.deepEqual(m.externalSkills.knownNames, []);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

describe('check-manifest: checkExternalSkills', () => {
  it('flags an unmanaged external skill folder as drift', () => {
    const ws = mkdtempSync(join(tmpdir(), 'robin-tamper-skills-'));
    try {
      mkdirSync(join(ws, 'user-data/runtime/security'), { recursive: true });
      writeFileSync(
        join(ws, 'user-data/runtime/security/manifest.json'),
        JSON.stringify({ hooks: {}, mcpServers: { expected: [], writeCapable: [] }, externalSkills: { knownNames: [] } }, null, 2)
      );
      mkdirSync(join(ws, 'user-data/skills/external/foo'), { recursive: true });
      writeFileSync(
        join(ws, 'user-data/skills/external/foo/SKILL.md'),
        '---\nname: foo\ndescription: a test skill\n---\nbody\n'
      );
      const manifest = loadManifest(ws);
      const findings = checkExternalSkills(ws, manifest);
      assert.equal(findings.length, 1);
      assert.equal(findings[0].level, 'INFO');
      assert.match(findings[0].message, /foo/);
      assert.match(findings[0].message, /not in manifest/);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('does not flag folders that are listed in manifest knownNames', () => {
    const ws = mkdtempSync(join(tmpdir(), 'robin-tamper-skills-'));
    try {
      mkdirSync(join(ws, 'user-data/runtime/security'), { recursive: true });
      writeFileSync(
        join(ws, 'user-data/runtime/security/manifest.json'),
        JSON.stringify({ hooks: {}, mcpServers: { expected: [], writeCapable: [] }, externalSkills: { knownNames: ['foo'] } }, null, 2)
      );
      mkdirSync(join(ws, 'user-data/skills/external/foo'), { recursive: true });
      writeFileSync(
        join(ws, 'user-data/skills/external/foo/SKILL.md'),
        '---\nname: foo\ndescription: a test skill\n---\nbody\n'
      );
      const manifest = loadManifest(ws);
      const findings = checkExternalSkills(ws, manifest);
      assert.equal(findings.length, 0);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});
