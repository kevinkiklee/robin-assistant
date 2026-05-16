import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentsMdContent } from '../../runtime/install/agents-md.js';

test('agentsMdContent — git-hygiene block present', () => {
  const md = agentsMdContent({});
  assert.match(md, /<!-- robin-git-hygiene:start/);
  assert.match(md, /<!-- robin-git-hygiene:end -->/);
});

test('agentsMdContent — git-hygiene forbids -a and -am explicitly', () => {
  const md = agentsMdContent({});
  assert.match(md, /Never use `-a` or `-am`/);
});

test('agentsMdContent — git-hygiene recommends atomic single-command commit', () => {
  const md = agentsMdContent({});
  assert.match(md, /git commit -m "msg" -- file1 file2 file3/);
});

test('agentsMdContent — git-hygiene names the race window', () => {
  const md = agentsMdContent({});
  assert.match(md, /race[\s\S]window/);
});

test('agentsMdContent — git-hygiene flags concurrent agent sessions', () => {
  const md = agentsMdContent({});
  assert.match(md, /concurrent agent sessions/);
});
