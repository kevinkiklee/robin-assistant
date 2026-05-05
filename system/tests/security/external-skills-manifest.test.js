import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadManifest } from '../../scripts/lib/manifest.js';

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
