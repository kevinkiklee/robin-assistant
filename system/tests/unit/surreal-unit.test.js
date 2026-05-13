import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateSurrealUnit } from '../../runtime/install/surreal-unit.js';

test('generateSurrealUnit produces a user unit with absolute surreal binary, Restart=on-failure, and storage args', () => {
  const txt = generateSurrealUnit({
    surrealBin: '/usr/local/bin/surreal',
    dbDir: '/home/x/.robin-data/data/db',
    logPath: '/home/x/.robin-data/runtime/logs/surreal.log',
  });
  assert.match(txt, /\[Unit\]/);
  assert.match(txt, /\[Service\]/);
  assert.match(txt, /\[Install\]/);
  assert.match(txt, /Restart=on-failure/);
  assert.match(
    txt,
    /ExecStart=\/usr\/local\/bin\/surreal start --bind 127\.0\.0\.1:8000 --user root --pass root --log info surrealkv:\/\/\/home\/x\/\.robin-data\/data\/db/,
  );
  assert.match(txt, /Environment=PATH=\/usr\/local\/bin:/);
  assert.match(txt, /append:\/home\/x\/\.robin-data\/runtime\/logs\/surreal\.log/);
});

test('generateSurrealUnit honors overrides for bind, credentials, and storage', () => {
  const txt = generateSurrealUnit({
    surrealBin: '/opt/surreal',
    bind: '0.0.0.0:9000',
    user: 'admin',
    pass: 'hunter2',
    storage: 'rocksdb',
    dbDir: '/var/db',
    logPath: '/var/log/surreal.log',
  });
  assert.match(
    txt,
    /ExecStart=\/opt\/surreal start --bind 0\.0\.0\.0:9000 --user admin --pass hunter2 --log info rocksdb:\/\/\/var\/db/,
  );
});

test('generateSurrealUnit throws when required fields are missing', () => {
  assert.throws(
    () => generateSurrealUnit({ dbDir: '/x', logPath: '/y' }),
    /surrealBin is required/,
  );
  assert.throws(
    () => generateSurrealUnit({ surrealBin: '/s', logPath: '/y' }),
    /dbDir is required/,
  );
  assert.throws(
    () => generateSurrealUnit({ surrealBin: '/s', dbDir: '/x' }),
    /logPath is required/,
  );
});
