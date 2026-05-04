// Unit tests for system/scripts/lib/needs-input.js helpers.
//
// The needs-input.js module manages user-data/runtime/state/needs-your-input.md,
// the single user-facing surface for items Dream wants the user to review
// (promotion proposals, telemetry alerts, conversation pruning candidates, etc.).
// All mutations must be atomic and idempotent — Dream re-runs daily and must
// not duplicate sections.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendSection,
  clearSection,
  clearFile,
  readSections,
  needsInputPath,
} from '../../scripts/lib/needs-input.js';

function makeWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), 'ni-'));
  // Look like a robin workspace root — needed by validateWorkspaceRoot.
  mkdirSync(join(dir, 'bin'), { recursive: true });
  writeFileSync(join(dir, 'bin/robin.js'), '#!/usr/bin/env node\n');
  mkdirSync(join(dir, 'user-data/runtime/state'), { recursive: true });
  return dir;
}

describe('needs-input.js', () => {
  describe('appendSection', () => {
    it('creates the file with frontmatter when missing', () => {
      const ws = makeWorkspace();
      appendSection(ws, 'Action-trust promotion proposals', '- foo\n');
      const text = readFileSync(needsInputPath(ws), 'utf8');
      assert.match(text, /^---\n/);
      assert.match(text, /generated_by: dream\n/);
      assert.match(text, /# Needs your input/);
      assert.match(text, /## Action-trust promotion proposals/);
      assert.match(text, /- foo/);
    });

    it('appends a new section to an existing file', () => {
      const ws = makeWorkspace();
      appendSection(ws, 'Action-trust promotion proposals', '- proposal A\n');
      appendSection(ws, 'Recall telemetry', '- bytes rising\n');
      const sections = readSections(ws);
      assert.ok(sections['Action-trust promotion proposals']);
      assert.ok(sections['Recall telemetry']);
    });

    it('replaces an existing section idempotently rather than duplicating', () => {
      const ws = makeWorkspace();
      appendSection(ws, 'Action-trust promotion proposals', '- proposal A\n');
      appendSection(ws, 'Action-trust promotion proposals', '- proposal A (updated)\n');
      const text = readFileSync(needsInputPath(ws), 'utf8');
      const matches = text.match(/## Action-trust promotion proposals/g) || [];
      assert.equal(matches.length, 1, 'section header should appear exactly once');
      assert.match(text, /proposal A \(updated\)/);
      assert.doesNotMatch(text, /^- proposal A$/m);
    });

    it('removes the empty-state placeholder when adding the first real section', () => {
      const ws = makeWorkspace();
      clearFile(ws); // creates the file with the _(no items)_ placeholder
      appendSection(ws, 'Test', '- one\n');
      const text = readFileSync(needsInputPath(ws), 'utf8');
      assert.doesNotMatch(text, /no items/);
    });
  });

  describe('clearSection', () => {
    it('removes a named section from the file', () => {
      const ws = makeWorkspace();
      appendSection(ws, 'Section A', '- one\n');
      appendSection(ws, 'Section B', '- two\n');
      clearSection(ws, 'Section A');
      const sections = readSections(ws);
      assert.ok(!sections['Section A']);
      assert.ok(sections['Section B']);
    });

    it('is a no-op when the section is absent', () => {
      const ws = makeWorkspace();
      appendSection(ws, 'Section A', '- one\n');
      // Should not throw.
      clearSection(ws, 'Section that does not exist');
      const sections = readSections(ws);
      assert.ok(sections['Section A']);
    });

    it('is a no-op when the file is missing', () => {
      const ws = makeWorkspace();
      // Should not throw or create the file.
      clearSection(ws, 'Anything');
      assert.equal(existsSync(needsInputPath(ws)), false);
    });

    it('writes the empty-state placeholder when the last section is removed', () => {
      const ws = makeWorkspace();
      appendSection(ws, 'Only Section', '- one\n');
      clearSection(ws, 'Only Section');
      const text = readFileSync(needsInputPath(ws), 'utf8');
      assert.match(text, /no items/);
    });
  });

  describe('clearFile', () => {
    it('resets the file to the empty-state placeholder', () => {
      const ws = makeWorkspace();
      appendSection(ws, 'Section A', '- one\n');
      appendSection(ws, 'Section B', '- two\n');
      clearFile(ws);
      const text = readFileSync(needsInputPath(ws), 'utf8');
      assert.match(text, /no items/);
      assert.doesNotMatch(text, /Section A/);
    });

    it('creates the file with placeholder when missing', () => {
      const ws = makeWorkspace();
      clearFile(ws);
      assert.ok(existsSync(needsInputPath(ws)));
      const text = readFileSync(needsInputPath(ws), 'utf8');
      assert.match(text, /^---\n/);
      assert.match(text, /no items/);
    });
  });

  describe('readSections', () => {
    it('returns an empty map when the file is missing', () => {
      const ws = makeWorkspace();
      assert.deepEqual(readSections(ws), {});
    });

    it('returns an empty map when the file has only the placeholder', () => {
      const ws = makeWorkspace();
      clearFile(ws);
      assert.deepEqual(readSections(ws), {});
    });

    it('parses each ## section name → body', () => {
      const ws = makeWorkspace();
      appendSection(ws, 'Section A', '- one\n- two\n');
      appendSection(ws, 'Section B', 'narrative body\n');
      const sections = readSections(ws);
      assert.equal(Object.keys(sections).length, 2);
      assert.match(sections['Section A'], /- one/);
      assert.match(sections['Section A'], /- two/);
      assert.match(sections['Section B'], /narrative body/);
    });
  });

  describe('atomicity', () => {
    it('writes never leave a half-written file even on rapid succession', () => {
      const ws = makeWorkspace();
      // Drive several writes back-to-back; verify the file is always
      // parseable (no torn frontmatter, no stray tmp files left behind).
      for (let i = 0; i < 20; i++) {
        appendSection(ws, `Section ${i % 3}`, `- iteration ${i}\n`);
      }
      const text = readFileSync(needsInputPath(ws), 'utf8');
      assert.match(text, /^---\n/);
      assert.match(text, /# Needs your input/);
      // No leftover tmp files in the same directory.
      const dir = join(ws, 'user-data/runtime/state');
      const entries = readdirSync(dir);
      const tmps = entries.filter((e) => e.includes('needs-your-input.md.tmp'));
      assert.deepEqual(tmps, []);
    });
  });
});
