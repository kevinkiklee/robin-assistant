import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateSurrealPlist } from '../../runtime/install/surreal-plist.js';

test('generateSurrealPlist produces a valid plist with absolute surreal binary, KeepAlive=true, and storage args', () => {
  const xml = generateSurrealPlist({
    surrealBin: '/opt/homebrew/bin/surreal',
    dbDir: '/Users/x/.robin-data/db',
    logPath: '/Users/x/.robin-data/cache/logs/surreal.log',
  });
  assert.match(xml, /<key>Label<\/key>\s*<string>io\.robin-assistant\.surreal<\/string>/);
  assert.match(xml, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(xml, /<key>KeepAlive<\/key>\s*<true\/>/);
  // First ProgramArguments entry must be the absolute surreal binary.
  assert.match(
    xml,
    /<key>ProgramArguments<\/key>\s*<array>\s*<string>\/opt\/homebrew\/bin\/surreal<\/string>\s*<string>start<\/string>/,
  );
  assert.match(xml, /<string>--bind<\/string>\s*<string>127\.0\.0\.1:8000<\/string>/);
  assert.match(xml, /<string>--user<\/string>\s*<string>root<\/string>/);
  assert.match(xml, /<string>--pass<\/string>\s*<string>root<\/string>/);
  // Storage URL combines the storage scheme with the db dir path, using the
  // standard `scheme:///absolute-path` form that surreal v3 expects.
  assert.match(xml, /<string>surrealkv:\/\/\/Users\/x\/\.robin-data\/db<\/string>/);
  assert.match(xml, /<key>PATH<\/key>\s*<string>\/opt\/homebrew\/bin:/);
  assert.match(xml, /\/Users\/x\/\.robin-data\/cache\/logs\/surreal\.log/);
});

test('generateSurrealPlist accepts overrides for bind, user, pass, storage', () => {
  const xml = generateSurrealPlist({
    surrealBin: '/usr/local/bin/surreal',
    bind: '127.0.0.1:18127',
    user: 'admin',
    pass: 'hunter2',
    storage: 'rocksdb',
    dbDir: '/var/db',
    logPath: '/var/log/surreal.log',
  });
  assert.match(xml, /<string>--bind<\/string>\s*<string>127\.0\.0\.1:18127<\/string>/);
  assert.match(xml, /<string>--user<\/string>\s*<string>admin<\/string>/);
  assert.match(xml, /<string>--pass<\/string>\s*<string>hunter2<\/string>/);
  assert.match(xml, /<string>rocksdb:\/\/\/var\/db<\/string>/);
});

test('generateSurrealPlist throws when required fields are missing', () => {
  assert.throws(
    () => generateSurrealPlist({ dbDir: '/x', logPath: '/y' }),
    /surrealBin is required/,
  );
  assert.throws(
    () => generateSurrealPlist({ surrealBin: '/s', logPath: '/y' }),
    /dbDir is required/,
  );
  assert.throws(
    () => generateSurrealPlist({ surrealBin: '/s', dbDir: '/x' }),
    /logPath is required/,
  );
});

test('generateSurrealPlist escapes XML special chars in paths', () => {
  const xml = generateSurrealPlist({
    surrealBin: '/opt/r&d/surreal',
    dbDir: '/Users/<weird>/db',
    logPath: '/Users/<weird>/log',
  });
  assert.match(xml, /\/opt\/r&amp;d\/surreal/);
  assert.match(xml, /\/Users\/&lt;weird&gt;\/db/);
  assert.doesNotMatch(xml, /\/opt\/r&d\//);
});
