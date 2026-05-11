import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderHelp } from '../../runtime/cli/commands/help.js';
import { commands } from '../../runtime/cli/commands.js';

test('renderHelp produces a non-empty string with expected sections', () => {
  const out = renderHelp(commands);
  assert.ok(out.length > 100);
  assert.match(out, /COMMANDS/);
  // Spot-check a few known commands
  assert.match(out, /install/);
  assert.match(out, /mcp/);
  assert.match(out, /integrations/);
  // Spot-check the recursively-nested entry
  assert.match(out, /register-commands/);
});
