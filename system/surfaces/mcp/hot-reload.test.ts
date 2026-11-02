import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readBuildStamp } from '../../lib/build-stamp.ts';
import {
  assertDeepHashCoherent,
  createReloadableDispatch,
  isStale,
  type ToolCb,
} from './hot-reload.ts';

function tmpRepoRoot(): string {
  return mkdtempSync(join(tmpdir(), 'robin-hot-reload-'));
}

function writeStamp(
  repoRoot: string,
  sha: string,
  at: string = new Date().toISOString(),
  deepHash?: string,
): void {
  mkdirSync(join(repoRoot, 'dist'), { recursive: true });
  const lines = deepHash !== undefined ? [sha, at, deepHash] : [sha, at];
  writeFileSync(join(repoRoot, 'dist', '.build-stamp'), `${lines.join('\n')}\n`);
}

/** Never touches the filesystem or a real module loader — records how many
 * times it was invoked and resolves/rejects on demand, exactly what the
 * contract requires unit tests use in place of the real cache-busted import. */
function fakeLog() {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

function textOf(result: unknown): string {
  const r = result as { content: Array<{ text: string }> };
  return r.content[0]?.text ?? '';
}

function textCb(label: string): ToolCb {
  return (async () => ({ content: [{ type: 'text' as const, text: label }] })) as ToolCb;
}

test('hot-reload: matching sha → cb passes through, rebuild never called', async () => {
  const repoRoot = tmpRepoRoot();
  writeStamp(repoRoot, 'sha1');
  let rebuildCalls = 0;
  const dispatch = createReloadableDispatch({
    repoRoot,
    initialSha: 'sha1',
    rebuild: async () => {
      rebuildCalls++;
      return new Map();
    },
    log: fakeLog(),
  });
  const original = textCb('original');
  const wrapped = dispatch.wrap('foo', original);

  const result = await wrapped({}, {} as never);

  assert.equal(textOf(result), 'original');
  assert.equal(rebuildCalls, 0, 'rebuild must never be called when the sha already matches');
});

test('hot-reload: stale sha + rebuild succeeds → new table cb wins, old cb unused', async () => {
  const repoRoot = tmpRepoRoot();
  writeStamp(repoRoot, 'sha1');
  let rebuildCalls = 0;
  let originalCalls = 0;
  const original: ToolCb = (async () => {
    originalCalls++;
    return { content: [{ type: 'text' as const, text: 'original' }] };
  }) as ToolCb;
  const newCb = textCb('new-from-reload');

  const dispatch = createReloadableDispatch({
    repoRoot,
    initialSha: 'sha1',
    rebuild: async () => {
      rebuildCalls++;
      return new Map([['foo', newCb]]);
    },
    log: fakeLog(),
  });
  const wrapped = dispatch.wrap('foo', original);

  // Rebuild moves out from under the process — dist/.build-stamp advances.
  writeStamp(repoRoot, 'sha2');
  const result = await wrapped({}, {} as never);

  assert.equal(textOf(result), 'new-from-reload');
  assert.equal(rebuildCalls, 1);
  assert.equal(
    originalCalls,
    0,
    'the originally-registered cb must not run once a reload swaps it out',
  );

  // A second call at the same sha must not rebuild again.
  await wrapped({}, {} as never);
  assert.equal(rebuildCalls, 1, 'no repeat rebuild while the sha is unchanged');
});

test('hot-reload: stale sha + rebuild throws → loud error naming both SHAs, original cb not invoked, no retry until the sha moves', async () => {
  const repoRoot = tmpRepoRoot();
  writeStamp(repoRoot, 'sha1');
  let rebuildCalls = 0;
  let originalCalls = 0;
  const original: ToolCb = (async () => {
    originalCalls++;
    return { content: [{ type: 'text' as const, text: 'original' }] };
  }) as ToolCb;

  const dispatch = createReloadableDispatch({
    repoRoot,
    initialSha: 'sha1',
    rebuild: async () => {
      rebuildCalls++;
      throw new Error('boom: dynamic import failed');
    },
    log: fakeLog(),
  });
  const wrapped = dispatch.wrap('foo', original);

  writeStamp(repoRoot, 'sha2');
  const first = (await wrapped({}, {} as never)) as { isError?: boolean };

  assert.equal(rebuildCalls, 1);
  assert.equal(originalCalls, 0, 'a failed reload must not silently fall through to the old cb');
  assert.equal(first.isError, true);
  const firstText = textOf(first);
  assert.match(firstText, /sha2/, 'error text must name the built (stale) sha');
  assert.match(firstText, /sha1/, 'error text must name the running (active) sha');
  assert.match(firstText, /reconnect/i);
  assert.match(
    firstText,
    /boom: dynamic import failed/,
    'the underlying rebuild error reason must be surfaced',
  );

  // Repeated calls at the same still-broken sha keep erroring, without
  // re-invoking rebuild (retry only happens when the sha changes again).
  const second = (await wrapped({}, {} as never)) as { isError?: boolean };
  assert.equal(rebuildCalls, 1, 'must not retry the same known-bad sha on every call');
  assert.equal(second.isError, true);
});

test('hot-reload: a second sha change after a failure retries rebuild', async () => {
  const repoRoot = tmpRepoRoot();
  writeStamp(repoRoot, 'sha1');
  let rebuildCalls = 0;
  const dispatch = createReloadableDispatch({
    repoRoot,
    initialSha: 'sha1',
    rebuild: async () => {
      rebuildCalls++;
      if (rebuildCalls === 1) throw new Error('first rebuild fails');
      return new Map([['foo', textCb('recovered')]]);
    },
    log: fakeLog(),
  });
  const wrapped = dispatch.wrap('foo', textCb('original'));

  writeStamp(repoRoot, 'sha2');
  const failed = (await wrapped({}, {} as never)) as { isError?: boolean };
  assert.equal(failed.isError, true);
  assert.equal(rebuildCalls, 1);

  // Move to a third sha — a fresh target, so the sticky failure guard must
  // not suppress this attempt.
  writeStamp(repoRoot, 'sha3');
  const recovered = await wrapped({}, {} as never);
  assert.equal(rebuildCalls, 2, 'a new sha must trigger a fresh rebuild attempt');
  assert.equal(textOf(recovered), 'recovered');

  // And it settles: no further rebuild calls at the now-matching sha.
  await wrapped({}, {} as never);
  assert.equal(rebuildCalls, 2);
});

test('hot-reload: no dist/.build-stamp on disk (dev mode) → permanent no-op, cb passes through', async () => {
  const repoRoot = tmpRepoRoot(); // deliberately no dist/ dir at all
  let rebuildCalls = 0;
  const dispatch = createReloadableDispatch({
    repoRoot,
    initialSha: null, // dev mode: nothing was loaded from a stamp either
    rebuild: async () => {
      rebuildCalls++;
      return new Map();
    },
    log: fakeLog(),
  });
  const wrapped = dispatch.wrap('foo', textCb('original'));

  const result = await wrapped({}, {} as never);

  assert.equal(textOf(result), 'original');
  assert.equal(rebuildCalls, 0);
});

test('hot-reload: checkAndReload is exposed and idempotent to call directly', async () => {
  const repoRoot = tmpRepoRoot();
  writeStamp(repoRoot, 'sha1');
  let rebuildCalls = 0;
  const dispatch = createReloadableDispatch({
    repoRoot,
    initialSha: 'sha1',
    rebuild: async () => {
      rebuildCalls++;
      return new Map([['foo', textCb('reloaded')]]);
    },
    log: fakeLog(),
  });

  writeStamp(repoRoot, 'sha2');
  await dispatch.checkAndReload();
  await dispatch.checkAndReload();
  assert.equal(rebuildCalls, 1, 'calling checkAndReload directly is idempotent per sha');

  const wrapped = dispatch.wrap('foo', textCb('original'));
  const result = await wrapped({}, {} as never);
  assert.equal(
    textOf(result),
    'reloaded',
    'a table built before wrap() is registered still applies',
  );
});

// ── review finding 1: LOADED_SHA baseline, not a fresh disk read ───────────

test('hot-reload: initialSha is the baseline, not a fresh disk read at construction (remote per-request regression)', async () => {
  const repoRoot = tmpRepoRoot();
  // What's already on disk the moment the dispatch is constructed — e.g. the
  // remote HTTP surface building a server per request, long after a rebuild
  // landed. A disk-read baseline would read THIS value and wrongly conclude
  // "already fresh", permanently defeating the reload.
  writeStamp(repoRoot, 'disk-sha-at-construction');
  let rebuildCalls = 0;
  const dispatch = createReloadableDispatch({
    repoRoot,
    initialSha: 'baked-in-sha', // what this process's callbacks were ACTUALLY built from
    rebuild: async () => {
      rebuildCalls++;
      return new Map([['foo', textCb('reloaded')]]);
    },
    log: fakeLog(),
  });
  const wrapped = dispatch.wrap('foo', textCb('original'));

  // Disk stamp is untouched since construction — the bug this guards against
  // is a baseline that silently matches it anyway.
  const result = await wrapped({}, {} as never);

  assert.equal(
    rebuildCalls,
    1,
    'initialSha must be honored as the baseline, not overwritten by a disk read',
  );
  assert.equal(textOf(result), 'reloaded');
});

test('hot-reload: initialSha undefined falls back to LOADED_SHA (production default), not a disk read', async () => {
  const repoRoot = tmpRepoRoot();
  writeStamp(repoRoot, 'disk-sha');
  let rebuildCalls = 0;
  // LOADED_SHA is null in every test process (no `pnpm build` runs before
  // `pnpm test`) — omitting initialSha here must behave exactly like passing
  // `null`, i.e. NOT like reading 'disk-sha' off disk.
  const dispatch = createReloadableDispatch({
    repoRoot,
    rebuild: async () => {
      rebuildCalls++;
      return new Map([['foo', textCb('reloaded')]]);
    },
    log: fakeLog(),
  });
  const wrapped = dispatch.wrap('foo', textCb('original'));

  const result = await wrapped({}, {} as never);
  assert.equal(
    rebuildCalls,
    1,
    'omitted initialSha must default to LOADED_SHA (null in tests), not a disk read',
  );
  assert.equal(textOf(result), 'reloaded');
});

// ── review finding 2: deep-tree hash guard ──────────────────────────────────

test('assertDeepHashCoherent: matching hashes → no throw', () => {
  assert.doesNotThrow(() => assertDeepHashCoherent('deep-aaa', 'deep-aaa'));
});

test('assertDeepHashCoherent: either side null → no throw (legacy stamp / unhashable build)', () => {
  assert.doesNotThrow(() => assertDeepHashCoherent(null, 'deep-bbb'));
  assert.doesNotThrow(() => assertDeepHashCoherent('deep-aaa', null));
  assert.doesNotThrow(() => assertDeepHashCoherent(null, null));
});

test('assertDeepHashCoherent: differing non-null hashes → throws, mentions reconnect', () => {
  assert.throws(() => assertDeepHashCoherent('deep-aaa', 'deep-bbb'), /reconnect/i);
});

test('hot-reload: deep-hash mismatch → rebuild refuses the swap, loud error mentions reconnect + both hashes', async () => {
  const repoRoot = tmpRepoRoot();
  writeStamp(repoRoot, 'sha1', undefined, 'deep-aaa');
  const loadedDeepHash = 'deep-aaa'; // captured "at process start", mirrors server.ts's LOADED_DEEP_HASH
  let rebuildCalls = 0;
  const dispatch = createReloadableDispatch({
    repoRoot,
    initialSha: 'sha1',
    // Mirrors server.ts's real rebuild: re-reads the current stamp itself and
    // guards on the deep hash before doing anything else.
    rebuild: async () => {
      rebuildCalls++;
      const stamp = readBuildStamp(repoRoot);
      assertDeepHashCoherent(loadedDeepHash, stamp?.deepHash ?? null);
      return new Map([['foo', textCb('should never be reached')]]);
    },
    log: fakeLog(),
  });
  const wrapped = dispatch.wrap('foo', textCb('original'));

  // sha AND the deep tree both moved — a real change outside this reload's
  // own reach.
  writeStamp(repoRoot, 'sha2', undefined, 'deep-bbb');
  const result = (await wrapped({}, {} as never)) as { isError?: boolean };

  assert.equal(rebuildCalls, 1);
  assert.equal(result.isError, true);
  const text = textOf(result);
  assert.match(text, /reconnect/i);
  assert.match(text, /deep-module hash mismatch/i);
  assert.match(text, /deep-aaa/);
  assert.match(text, /deep-bbb/);
});

test('hot-reload: legacy 2-line stamp (no deep hash) → deep-hash guard skipped, reload proceeds on sha alone', async () => {
  const repoRoot = tmpRepoRoot();
  writeStamp(repoRoot, 'sha1'); // no deepHash argument → 2-line stamp
  const loadedDeepHash = 'some-loaded-deep-hash'; // baseline HAS a value; current stamp will not
  let rebuildCalls = 0;
  const dispatch = createReloadableDispatch({
    repoRoot,
    initialSha: 'sha1',
    rebuild: async () => {
      rebuildCalls++;
      const stamp = readBuildStamp(repoRoot);
      assertDeepHashCoherent(loadedDeepHash, stamp?.deepHash ?? null);
      return new Map([['foo', textCb('reloaded-legacy')]]);
    },
    log: fakeLog(),
  });
  const wrapped = dispatch.wrap('foo', textCb('original'));

  writeStamp(repoRoot, 'sha2'); // still 2-line — legacy stamp, no deep hash
  const result = await wrapped({}, {} as never);

  assert.equal(rebuildCalls, 1);
  assert.equal(
    textOf(result),
    'reloaded-legacy',
    'a null deep hash on either side must not block the reload',
  );
});

// ── review finding 3: single-flight rebuild ─────────────────────────────────

test('hot-reload: two concurrent stale calls share one in-flight rebuild', async () => {
  const repoRoot = tmpRepoRoot();
  writeStamp(repoRoot, 'sha1');
  let rebuildCalls = 0;
  let resolveRebuild: ((table: Map<string, ToolCb>) => void) | undefined;
  const dispatch = createReloadableDispatch({
    repoRoot,
    initialSha: 'sha1',
    rebuild: () => {
      rebuildCalls++;
      return new Promise<Map<string, ToolCb>>((resolve) => {
        resolveRebuild = resolve;
      });
    },
    log: fakeLog(),
  });
  const wrapped = dispatch.wrap('foo', textCb('original'));

  writeStamp(repoRoot, 'sha2');
  // Both calls start before the rebuild resolves — JS run-to-completion
  // semantics mean each runs synchronously up to its own first await, so by
  // the time both calls have been made, whichever ran first has already
  // registered the in-flight rebuild for the second to find.
  const p1 = wrapped({}, {} as never);
  const p2 = wrapped({}, {} as never);
  assert.equal(rebuildCalls, 1, 'a second concurrent stale call must not start its own rebuild');

  resolveRebuild?.(new Map([['foo', textCb('reloaded')]]));
  const [r1, r2] = await Promise.all([p1, p2]);

  assert.equal(textOf(r1), 'reloaded');
  assert.equal(textOf(r2), 'reloaded');
  assert.equal(rebuildCalls, 1, 'still exactly one rebuild after both callers observe the result');
});

test('hot-reload: in-flight rebuild is cleared on settle, so the NEXT stale sha starts a fresh one', async () => {
  const repoRoot = tmpRepoRoot();
  writeStamp(repoRoot, 'sha1');
  let rebuildCalls = 0;
  const dispatch = createReloadableDispatch({
    repoRoot,
    initialSha: 'sha1',
    rebuild: async () => {
      rebuildCalls++;
      return new Map([['foo', textCb(`gen-${rebuildCalls}`)]]);
    },
    log: fakeLog(),
  });
  const wrapped = dispatch.wrap('foo', textCb('original'));

  writeStamp(repoRoot, 'sha2');
  await wrapped({}, {} as never);
  assert.equal(rebuildCalls, 1);

  writeStamp(repoRoot, 'sha3');
  const result = await wrapped({}, {} as never);
  assert.equal(
    rebuildCalls,
    2,
    'the in-flight slot must be free again for a later, unrelated reload',
  );
  assert.equal(textOf(result), 'gen-2');
});

// ── review minor: tool absent from a reloaded table ─────────────────────────

test('hot-reload: a tool absent from the reloaded table returns a clear error, not a fallback to the closed-DB original cb', async () => {
  const repoRoot = tmpRepoRoot();
  writeStamp(repoRoot, 'sha1');
  const dispatch = createReloadableDispatch({
    repoRoot,
    initialSha: 'sha1',
    rebuild: async () => new Map([['bar', textCb('bar-only')]]), // 'foo' no longer exists in the new build
    log: fakeLog(),
  });
  const wrapped = dispatch.wrap('foo', textCb('original'));

  writeStamp(repoRoot, 'sha2');
  const result = (await wrapped({}, {} as never)) as { isError?: boolean };

  assert.equal(result.isError, true);
  assert.match(textOf(result), /absent from the reloaded build/i);
  assert.match(textOf(result), /'foo'/);
});

// ── dirty-tree rebuilds: the stamp sha does NOT move for uncommitted work ────

test('hot-reload: same sha but moved deep hash (dirty-tree rebuild) still counts as stale', async () => {
  // `pnpm build` stamps `git rev-parse --short HEAD`, which does not change
  // when the tree is dirty — the normal state during development. Gating
  // staleness on the sha alone meant this process kept serving the PREVIOUS
  // build silently, with no reload attempt and no error: the exact
  // silent-stale-code failure the stamp exists to prevent.
  const repoRoot = tmpRepoRoot();
  writeStamp(repoRoot, 'sha1', undefined, 'deep-aaa');
  let rebuildCalls = 0;
  const dispatch = createReloadableDispatch({
    repoRoot,
    initialSha: 'sha1',
    initialDeepHash: 'deep-aaa',
    rebuild: async () => {
      rebuildCalls++;
      return new Map([['foo', textCb('reloaded')]]);
    },
    log: fakeLog(),
  });
  const wrapped = dispatch.wrap('foo', textCb('original'));

  await wrapped({}, {} as never);
  assert.equal(rebuildCalls, 0, 'identical stamp → nothing to do');

  writeStamp(repoRoot, 'sha1', undefined, 'deep-bbb'); // rebuilt, HEAD unmoved

  const result = await wrapped({}, {} as never);
  assert.equal(rebuildCalls, 1, 'a rebuild with an unchanged HEAD must still trigger a reload');
  assert.equal(textOf(result), 'reloaded');
});

test('hot-reload: a failed dirty-tree reload is sticky, not retried on every call', async () => {
  const repoRoot = tmpRepoRoot();
  writeStamp(repoRoot, 'sha1', undefined, 'deep-aaa');
  let rebuildCalls = 0;
  const dispatch = createReloadableDispatch({
    repoRoot,
    initialSha: 'sha1',
    initialDeepHash: 'deep-aaa',
    rebuild: async () => {
      rebuildCalls++;
      throw new Error('deep-module hash mismatch (simulated)');
    },
    log: fakeLog(),
  });
  const wrapped = dispatch.wrap('foo', textCb('original'));

  writeStamp(repoRoot, 'sha1', undefined, 'deep-bbb');

  const first = (await wrapped({}, {} as never)) as { isError?: boolean };
  const second = (await wrapped({}, {} as never)) as { isError?: boolean };

  assert.equal(first.isError, true);
  assert.equal(second.isError, true, 'still loudly stale');
  assert.equal(rebuildCalls, 1, 'must not burn an import + DB open on every subsequent call');
  assert.match(textOf(second), /reconnect/i);
});

test('hot-reload: a sticky dirty-tree failure retries once the deep hash moves again', async () => {
  // A broken build replaced by a good one must recover without a restart —
  // the same property the sha-keyed sticky failure already had.
  const repoRoot = tmpRepoRoot();
  writeStamp(repoRoot, 'sha1', undefined, 'deep-aaa');
  let rebuildCalls = 0;
  const dispatch = createReloadableDispatch({
    repoRoot,
    initialSha: 'sha1',
    initialDeepHash: 'deep-aaa',
    rebuild: async () => {
      rebuildCalls++;
      const stamp = readBuildStamp(repoRoot);
      if (stamp?.deepHash === 'deep-bad') throw new Error('bad build');
      return new Map([['foo', textCb('recovered')]]);
    },
    log: fakeLog(),
  });
  const wrapped = dispatch.wrap('foo', textCb('original'));

  writeStamp(repoRoot, 'sha1', undefined, 'deep-bad');
  const failed = (await wrapped({}, {} as never)) as { isError?: boolean };
  assert.equal(failed.isError, true);
  assert.equal(rebuildCalls, 1);

  writeStamp(repoRoot, 'sha1', undefined, 'deep-good'); // fixed build lands
  const result = await wrapped({}, {} as never);

  assert.equal(rebuildCalls, 2, 'a new deep hash is a new target, so it must be retried');
  assert.equal(textOf(result), 'recovered');
});

// ── isStale: the sha half must keep its original null-sensitive semantics ────

test('isStale: a null loaded sha against a real on-disk sha is stale (and vice versa)', () => {
  // tsx dev loaded no stamp while dist/ has one. Requiring both sides to be
  // non-null here silently disables the reload for exactly this case — it
  // passes on any machine with dist/ built and only fails where LOADED_SHA is
  // null, which is how it reached CI green-locally/red-remotely.
  assert.equal(isStale(null, null, 'disk-sha', null), true);
  assert.equal(isStale('disk-sha', null, null, null), true);
});

test('isStale: identical sha and deep hash is not stale', () => {
  assert.equal(isStale('sha1', 'deep-aaa', 'sha1', 'deep-aaa'), false);
  assert.equal(isStale(null, null, null, null), false);
});

test('isStale: deep hash moving under an unchanged sha is stale', () => {
  assert.equal(isStale('sha1', 'deep-aaa', 'sha1', 'deep-bbb'), true);
});

test('isStale: a missing deep hash on either side never alone implies staleness', () => {
  assert.equal(isStale('sha1', null, 'sha1', 'deep-bbb'), false);
  assert.equal(isStale('sha1', 'deep-aaa', 'sha1', null), false);
});
