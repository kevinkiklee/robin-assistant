import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { main } from '../../../bin/robin.js';

async function captureStdout(fn) {
  const chunks = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (s) => { chunks.push(typeof s === 'string' ? s : s.toString()); return true; };
  try { const result = await fn(); return { result, output: chunks.join('') }; }
  finally { process.stdout.write = original; }
}

async function captureStderr(fn) {
  const chunks = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = (s) => { chunks.push(typeof s === 'string' ? s : s.toString()); return true; };
  try { const result = await fn(); return { result, output: chunks.join('') }; }
  finally { process.stderr.write = original; }
}

describe('bin/robin: skill dispatcher', () => {
  it('prints skill help with no subcommand', async () => {
    const { result, output } = await captureStdout(() => main(['skill'], process.env));
    assert.equal(result.exitCode, 0);
    assert.match(output, /usage: robin skill/);
  });

  it('returns non-zero with unknown subcommand', async () => {
    const { result, output } = await captureStderr(() => main(['skill', 'nonsense'], process.env));
    assert.notEqual(result.exitCode, 0);
    assert.match(output, /unknown skill subcommand/);
  });

  it('robin help mentions skill', async () => {
    const { result, output } = await captureStdout(() => main([], process.env));
    assert.equal(result.exitCode, 0);
    assert.match(output, /robin skill/);
  });
});
