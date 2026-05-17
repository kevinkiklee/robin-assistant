import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  __test__,
  createBrowserExtractTool,
  createBrowserScreenshotTool,
  createBrowserVisitTool,
} from '../../io/mcp/tools/browser.js';

const { isPrivateOrLocalUrl } = __test__;

test('isPrivateOrLocalUrl blocks loopback', () => {
  assert.equal(isPrivateOrLocalUrl('http://127.0.0.1/'), true);
  assert.equal(isPrivateOrLocalUrl('http://localhost:1234/'), true);
  assert.equal(isPrivateOrLocalUrl('http://my-machine.local/'), true);
});

test('isPrivateOrLocalUrl blocks RFC1918', () => {
  assert.equal(isPrivateOrLocalUrl('http://10.0.0.1/'), true);
  assert.equal(isPrivateOrLocalUrl('http://192.168.1.1/'), true);
  assert.equal(isPrivateOrLocalUrl('http://172.16.0.1/'), true);
  assert.equal(isPrivateOrLocalUrl('http://172.31.255.255/'), true);
});

test('isPrivateOrLocalUrl allows public', () => {
  assert.equal(isPrivateOrLocalUrl('https://example.com/'), false);
  assert.equal(isPrivateOrLocalUrl('https://askrobin.io/'), false);
});

test('isPrivateOrLocalUrl blocks non-http(s)', () => {
  assert.equal(isPrivateOrLocalUrl('file:///etc/passwd'), true);
  assert.equal(isPrivateOrLocalUrl('javascript:alert(1)'), true);
  assert.equal(isPrivateOrLocalUrl('ftp://example.com/'), true);
});

test('isPrivateOrLocalUrl blocks malformed urls', () => {
  assert.equal(isPrivateOrLocalUrl('not a url'), true);
});

test('browser tools expose correct names + schemas', () => {
  const visit = createBrowserVisitTool();
  const ss = createBrowserScreenshotTool();
  const ex = createBrowserExtractTool();
  assert.equal(visit.name, 'browser_visit');
  assert.equal(ss.name, 'browser_screenshot');
  assert.equal(ex.name, 'browser_extract');
  assert.ok(visit.inputSchema.required.includes('url'));
  assert.ok(ex.inputSchema.required.includes('selectors'));
});

test('browser_visit refuses private URLs without invoking Playwright', async () => {
  const tool = createBrowserVisitTool();
  const r = await tool.handler({ url: 'http://localhost/' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'url_blocked');
});

test('browser_extract refuses private URLs', async () => {
  const tool = createBrowserExtractTool();
  const r = await tool.handler({ url: 'http://10.0.0.1/', selectors: ['h1'] });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'url_blocked');
});

test('browser_visit returns playwright_unavailable when not installed', async () => {
  const tool = createBrowserVisitTool();
  const r = await tool.handler({ url: 'https://example.com/' });
  // Playwright not installed in this repo; expect unavailable.
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'playwright_unavailable');
});
