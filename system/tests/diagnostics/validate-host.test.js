import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { parseClaudeCode } from '../../scripts/diagnostics/lib/parsers/claude-code.js';
import { parseCodex } from '../../scripts/diagnostics/lib/parsers/codex.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const VALIDATOR = join(REPO_ROOT, 'system', 'scripts', 'diagnostics', 'validate-host.js');

function runValidator(args) {
  try {
    const out = execFileSync('node', [VALIDATOR, ...args, '--json'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { exitCode: 0, output: out };
  } catch (e) {
    return { exitCode: e.status ?? 1, output: e.stdout?.toString?.() ?? '' };
  }
}

describe('claude-code parser', () => {
  it('parses JSONL tool calls', () => {
    const transcript = [
      JSON.stringify({ name: 'Read', input: { file_path: 'AGENTS.md' } }),
      JSON.stringify({ name: 'Read', input: { file_path: 'user-data/memory/INDEX.md' } }),
      JSON.stringify({ name: 'Write', input: { file_path: 'user-data/memory/streams/inbox.md' } }),
    ].join('\n');
    const r = parseClaudeCode(transcript);
    assert.deepEqual(r.reads, ['AGENTS.md', 'user-data/memory/INDEX.md']);
    assert.deepEqual(r.writes, ['user-data/memory/streams/inbox.md']);
  });

  it('falls back to free-text Read("...") patterns', () => {
    const transcript = `Read("AGENTS.md")\nEdit("user-data/memory/streams/inbox.md")`;
    const r = parseClaudeCode(transcript);
    assert.ok(r.reads.includes('AGENTS.md'));
    assert.ok(r.writes.includes('user-data/memory/streams/inbox.md'));
  });

  it('strips absolute repo prefix from paths', () => {
    const transcript = JSON.stringify({
      name: 'Read',
      input: { file_path: '/Users/iser/workspace/robin/robin-assistant/AGENTS.md' },
    });
    const r = parseClaudeCode(transcript);
    assert.deepEqual(r.reads, ['AGENTS.md']);
  });
});

describe('codex parser', () => {
  it('parses tool_call events with cat read pattern', () => {
    const transcript = [
      JSON.stringify({
        type: 'tool_call',
        tool: 'shell',
        arguments: { command: ['cat', 'AGENTS.md'] },
      }),
      JSON.stringify({
        type: 'tool_call',
        tool: 'shell',
        arguments: { command: ['echo', 'hi', '>', 'user-data/memory/streams/inbox.md'] },
      }),
    ].join('\n');
    const r = parseCodex(transcript);
    assert.ok(r.reads.includes('AGENTS.md'));
    assert.ok(r.writes.includes('user-data/memory/streams/inbox.md'));
  });

  it('parses dedicated read_file/write_file events', () => {
    const transcript = [
      JSON.stringify({ type: 'tool_call', tool: 'read_file', arguments: { path: 'AGENTS.md' } }),
      JSON.stringify({
        type: 'tool_call',
        tool: 'write_file',
        arguments: { path: 'user-data/memory/streams/inbox.md' },
      }),
    ].join('\n');
    const r = parseCodex(transcript);
    assert.deepEqual(r.reads, ['AGENTS.md']);
    assert.deepEqual(r.writes, ['user-data/memory/streams/inbox.md']);
  });
});

describe('validate-host scenarios', () => {
  function withTempTranscript(content, fn) {
    const dir = join(tmpdir(), `robin-validate-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, '01-cold.jsonl');
    writeFileSync(path, content);
    try {
      return fn(path);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('scenario 2 passes when inbox.md is written and capture-rules is not loaded', () => {
    const transcript = JSON.stringify({
      name: 'Write',
      input: { file_path: 'user-data/memory/streams/inbox.md' },
    });
    withTempTranscript(transcript, (p) => {
      const { exitCode, output } = runValidator([
        '--host=claude-code',
        `--transcript=${p}`,
        '--scenario=2',
      ]);
      assert.equal(exitCode, 0);
      const result = JSON.parse(output)[0];
      assert.equal(result.result, 'pass');
    });
  });

  it('scenario 2 hard-fails when inbox.md not written', () => {
    const transcript = JSON.stringify({
      name: 'Read',
      input: { file_path: 'AGENTS.md' },
    });
    withTempTranscript(transcript, (p) => {
      const { exitCode, output } = runValidator([
        '--host=claude-code',
        `--transcript=${p}`,
        '--scenario=2',
      ]);
      assert.equal(exitCode, 1);
      const result = JSON.parse(output)[0];
      assert.equal(result.result, 'hard-fail');
    });
  });

  it('scenario 3 hard-fails when morning-briefing.md not fetched', () => {
    const transcript = JSON.stringify({
      name: 'Read',
      input: { file_path: 'AGENTS.md' },
    });
    withTempTranscript(transcript, (p) => {
      const { exitCode, output } = runValidator([
        '--host=claude-code',
        `--transcript=${p}`,
        '--scenario=3',
      ]);
      assert.equal(exitCode, 1);
      const result = JSON.parse(output)[0];
      assert.equal(result.result, 'hard-fail');
    });
  });

  it('scenario 4 passes when rules/README.md is read', () => {
    const transcript = JSON.stringify({
      name: 'Read',
      input: { file_path: 'system/rules/README.md' },
    });
    withTempTranscript(transcript, (p) => {
      const { exitCode, output } = runValidator([
        '--host=claude-code',
        `--transcript=${p}`,
        '--scenario=4',
      ]);
      assert.equal(exitCode, 0);
      const result = JSON.parse(output)[0];
      assert.equal(result.result, 'pass');
    });
  });
});
