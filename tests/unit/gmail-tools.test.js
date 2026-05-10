import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGmailGetThreadTool } from '../../src/integrations/gmail/tools/gmail-get-thread.js';
import { createGmailSearchTool } from '../../src/integrations/gmail/tools/gmail-search.js';

test('gmail_search has correct shape', () => {
  const t = createGmailSearchTool();
  assert.equal(t.name, 'gmail_search');
  assert.ok(t.inputSchema.required.includes('query'));
  assert.ok(typeof t.handler === 'function');
});

test('gmail_get_thread has correct shape', () => {
  const t = createGmailGetThreadTool();
  assert.equal(t.name, 'gmail_get_thread');
  assert.ok(t.inputSchema.required.includes('thread_id'));
});

test('gmail_search throws when not authenticated', async () => {
  process.env.ROBIN_HOME = `/tmp/robin-no-auth-${Date.now()}`;
  const { createGmailSearchTool: factory } = await import(
    `../../src/integrations/gmail/tools/gmail-search.js?cb=${Date.now()}`
  );
  const t = factory();
  await assert.rejects(() => t.handler({ query: 'x' }), /not authenticated/);
});
