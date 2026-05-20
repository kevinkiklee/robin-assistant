import assert from 'node:assert/strict';
import { test } from 'node:test';
import { wrapHtml } from './template.ts';

const BASE_INPUT = {
  title: 'Hello World',
  description: 'A short description.',
  slug: 'hello-world',
  bodyHtml: '<p>body</p>',
  dateUtc: '2026-05-20',
  publicBaseUrl: 'https://example.test',
};

test('wrapHtml: emits doctype + canonical URL', () => {
  const html = wrapHtml(BASE_INPUT);
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /rel="canonical" href="https:\/\/example\.test\/p\/hello-world"/);
});

test('wrapHtml: includes title + description meta tags', () => {
  const html = wrapHtml(BASE_INPUT);
  assert.match(html, /<title>Hello World<\/title>/);
  assert.match(html, /name="description" content="A short description\."/);
  assert.match(html, /property="og:description" content="A short description\."/);
});

test('wrapHtml: skips description meta when null', () => {
  const html = wrapHtml({ ...BASE_INPUT, description: null });
  assert.ok(!html.includes('name="description"'));
  assert.ok(!html.includes('og:description'));
});

test('wrapHtml: escapes special characters in title + description', () => {
  const html = wrapHtml({
    ...BASE_INPUT,
    title: '<script>alert(1)</script>',
    description: 'A & B "c"',
  });
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /A &amp; B &quot;c&quot;/);
});

test('wrapHtml: includes the body html verbatim inside <main>', () => {
  const html = wrapHtml({ ...BASE_INPUT, bodyHtml: '<p>raw &lt;body&gt;</p>' });
  assert.match(html, /<main class="prose">\s*<p>raw &lt;body&gt;<\/p>\s*<\/main>/s);
});

test('wrapHtml: footer carries the rendered date', () => {
  const html = wrapHtml({ ...BASE_INPUT, dateUtc: '2030-01-15' });
  assert.match(html, /Published with Robin · 2030-01-15/);
});
