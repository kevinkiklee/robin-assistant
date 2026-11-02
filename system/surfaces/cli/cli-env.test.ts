import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { loadCliEnv } from './cli-env.ts';

describe('loadCliEnv', () => {
  it('loads the resolved user-data dir', () => {
    const seen: string[] = [];
    loadCliEnv({ resolve: () => '/fake/user-data', load: (d) => seen.push(d) });
    assert.deepEqual(seen, ['/fake/user-data']);
  });
  it('never throws when the dir cannot be resolved or loaded', () => {
    assert.doesNotThrow(() =>
      loadCliEnv({
        resolve: () => {
          throw new Error('no instance');
        },
      }),
    );
    assert.doesNotThrow(() =>
      loadCliEnv({
        resolve: () => '/fake',
        load: () => {
          throw new Error('unreadable');
        },
      }),
    );
  });
  it('main() loads secrets before dispatching any command', () => {
    const src = readFileSync(join(import.meta.dirname, 'index.ts'), 'utf8');
    const body = src.slice(src.indexOf('async function main()'));
    const load = body.indexOf("if (cmd !== 'daemon') loadCliEnv();");
    assert.ok(load > 0, 'main calls loadCliEnv() for every command but the daemon');
    assert.ok(load < body.indexOf('switch (cmd)'), 'before the command switch');
  });
});
