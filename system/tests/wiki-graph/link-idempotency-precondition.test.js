import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyEntityLinks } from '../../scripts/wiki-graph/lib/apply-entity-links.js';
import { buildEntityRegistry } from '../../scripts/wiki-graph/lib/build-entity-registry.js';

test('applyEntityLinks: already-linked input is a no-op (return value AND disk)', async () => {
  // The Task 5 PostToolUse hook depends on this invariant: when Claude writes
  // a memory file that already contains the canonical link, the linker MUST
  // not rewrite the file — otherwise the rewrite re-fires the hook and loops.
  // This exercises the bodyAlreadyLinksTarget short-circuit in apply-entity-links.js
  // (line ~58), which is a different code path from "un-linked → linked → no-op".
  const ws = await mkdtemp(join(tmpdir(), 'robin-link-idem-'));
  const memDir = join(ws, 'user-data/memory');
  await mkdir(join(memDir, 'profile'), { recursive: true });
  await mkdir(join(memDir, 'knowledge/people'), { recursive: true });

  // identity.md must use `canonical` (not `description`) so buildEntityRegistry
  // registers Kevin as a linkable entity (see build-entity-registry.js:95).
  await writeFile(
    join(memDir, 'profile/identity.md'),
    '---\ncanonical: Kevin K Lee\naliases: [Kevin, Kevin K Lee]\n---\n# Self\n',
  );
  const targetRel = 'knowledge/people/jane.md';
  const targetAbs = join(memDir, targetRel);
  // Pre-linked content: the link target+format the linker itself produces
  // (from knowledge/people/jane.md → profile/identity.md is ../../profile/identity.md).
  const preLinked =
    '---\ndescription: Jane\n---\nJane went to lunch with [Kevin](../../profile/identity.md).\n';
  await writeFile(targetAbs, preLinked);

  const before = await readFile(targetAbs, 'utf-8');
  const reg = await buildEntityRegistry(ws);
  const result = await applyEntityLinks(ws, targetRel, reg);

  assert.equal(result.inserted, 0, 'no insertions expected on already-linked input');
  assert.equal(result.written, false, 'no write expected on already-linked input');
  const after = await readFile(targetAbs, 'utf-8');
  assert.equal(after, before, 'disk bytes must be unchanged on already-linked input');
});
