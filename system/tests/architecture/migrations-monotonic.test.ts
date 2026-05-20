import assert from 'node:assert/strict';
import { test } from 'node:test';
import { allMigrations } from '../../system/brain/memory/migrations/index.ts';

test('migrations: versions are sequential starting at 1', () => {
  for (let i = 0; i < allMigrations.length; i++) {
    assert.equal(
      allMigrations[i].version,
      i + 1,
      `migration at index ${i} has non-sequential version ${allMigrations[i].version}`,
    );
  }
});

test('migrations: names are kebab-case', () => {
  for (const m of allMigrations) {
    assert.match(
      m.name,
      /^[a-z0-9-]+$/,
      `migration ${m.version} name "${m.name}" is not kebab-case`,
    );
  }
});
