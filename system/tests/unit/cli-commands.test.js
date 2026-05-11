import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commands } from '../../runtime/cli/commands.js';

function walk(node, prefix = '') {
  const leaves = [];
  for (const [key, entry] of Object.entries(node)) {
    if (entry.subcommands) {
      leaves.push(...walk(entry.subcommands, `${prefix}${key} `));
    } else {
      leaves.push({ name: `${prefix}${key}`.trim(), entry });
    }
  }
  return leaves;
}

test('every leaf entry has import and export fields', () => {
  for (const leaf of walk(commands)) {
    assert.ok(typeof leaf.entry.import === 'string', `${leaf.name}: missing import`);
    assert.ok(typeof leaf.entry.export === 'string', `${leaf.name}: missing export`);
  }
});

test('every leaf module imports and exports the named function', async () => {
  const failures = [];
  for (const leaf of walk(commands)) {
    try {
      // Resolve the import path relative to system/runtime/cli/
      const mod = await import(`../../runtime/cli/${leaf.entry.import.replace(/^\.\//, '')}`);
      if (typeof mod[leaf.entry.export] !== 'function') {
        failures.push(
          `${leaf.name}: ${leaf.entry.import} has no function export ${leaf.entry.export}`,
        );
      }
    } catch (e) {
      failures.push(`${leaf.name}: failed to import ${leaf.entry.import}: ${e.message}`);
    }
  }
  assert.equal(failures.length, 0, failures.join('\n'));
});

test('no duplicate keys within any group', () => {
  function check(node, prefix = '') {
    const keys = Object.keys(node);
    assert.equal(new Set(keys).size, keys.length, `duplicate at ${prefix}`);
    for (const [k, entry] of Object.entries(node)) {
      if (entry.subcommands) check(entry.subcommands, `${prefix}${k}.`);
    }
  }
  check(commands);
});
