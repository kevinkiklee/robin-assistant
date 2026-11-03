import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { listScheduledIntegrations } from './doctor-set.ts';

function setup(entries: Record<string, string>): string {
  const ud = mkdtempSync(join(tmpdir(), 'robin-doctorset-'));
  for (const [name, platformsYaml] of Object.entries(entries)) {
    const dir = join(ud, 'extensions', 'integrations', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'integration.yaml'),
      `name: ${name}\nversion: 1.0.0\nschedule: "0 * * * *"\n${platformsYaml}`,
    );
  }
  return ud;
}

const names = (ud: string, platform: string) =>
  listScheduledIntegrations(ud, platform)
    .map((i) => i.name)
    .filter((n) => n.startsWith('zz-'))
    .sort();

test('doctor path: malformed platforms are ignored (listed everywhere), never throw', () => {
  const ud = setup({
    'zz-str': 'platforms: windows\n',
    'zz-unknown': 'platforms: [windows]\n',
    'zz-obj': 'platforms: {a: 1}\n',
    'zz-num': 'platforms: 7\n',
  });
  for (const platform of ['linux', 'darwin']) {
    assert.deepEqual(names(ud, platform), ['zz-num', 'zz-obj', 'zz-str', 'zz-unknown'], platform);
  }
  for (const i of listScheduledIntegrations(ud)) {
    if (i.name.startsWith('zz-')) assert.equal(i.platforms, undefined);
  }
});

test('doctor path: valid darwin-only is dropped on linux, kept on darwin', () => {
  const ud = setup({ 'zz-mac': 'platforms: [darwin]\n', 'zz-any': '' });
  assert.deepEqual(names(ud, 'linux'), ['zz-any']);
  assert.deepEqual(names(ud, 'darwin'), ['zz-any', 'zz-mac']);
});
