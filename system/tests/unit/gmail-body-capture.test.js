// Body extraction from Gmail format=full payloads. Covers the MIME-walk,
// base64url decode, text/plain preference, HTML fallback, and the 8KB
// truncation. The gmail integration switched from format=metadata to
// format=full to feed full bodies into embeddings + recall.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BODY_MAX_BYTES,
  buildEventFromMessage,
  extractBody,
  stripHtml,
  truncateBody,
} from '../../io/integrations/gmail/client.js';

function b64url(s) {
  return Buffer.from(s, 'utf8').toString('base64url');
}

function singlePartPlain(text) {
  return {
    mimeType: 'text/plain',
    headers: [
      { name: 'Subject', value: 'plain test' },
      { name: 'From', value: 'a@b.c' },
    ],
    body: { data: b64url(text) },
  };
}

function multipartAlt({ plain, html }) {
  return {
    mimeType: 'multipart/alternative',
    headers: [
      { name: 'Subject', value: 'alt test' },
      { name: 'From', value: 'a@b.c' },
    ],
    parts: [
      { mimeType: 'text/plain', body: { data: b64url(plain) } },
      { mimeType: 'text/html', body: { data: b64url(html) } },
    ],
  };
}

function htmlOnly(html) {
  return {
    mimeType: 'text/html',
    headers: [
      { name: 'Subject', value: 'html only' },
      { name: 'From', value: 'a@b.c' },
    ],
    body: { data: b64url(html) },
  };
}

test('extractBody decodes a single-part text/plain message', () => {
  const body = extractBody(singlePartPlain('hello world'));
  assert.equal(body, 'hello world');
});

test('extractBody prefers text/plain over text/html in multipart/alternative', () => {
  const body = extractBody(
    multipartAlt({ plain: 'plain version', html: '<p>html version</p>' }),
  );
  assert.equal(body, 'plain version');
});

test('extractBody falls back to text/html (tags stripped) when no plain part', () => {
  const body = extractBody(htmlOnly('<p>Hello <b>world</b>!</p>'));
  assert.equal(body, 'Hello world!');
});

test('extractBody handles nested multipart/mixed → multipart/alternative', () => {
  const payload = {
    mimeType: 'multipart/mixed',
    parts: [
      {
        mimeType: 'multipart/alternative',
        parts: [
          { mimeType: 'text/plain', body: { data: b64url('inner plain') } },
          { mimeType: 'text/html', body: { data: b64url('<p>inner html</p>') } },
        ],
      },
      { mimeType: 'application/pdf', filename: 'receipt.pdf', body: { attachmentId: 'a1' } },
    ],
  };
  assert.equal(extractBody(payload), 'inner plain');
});

test('extractBody returns empty string when no usable part exists', () => {
  assert.equal(extractBody(null), '');
  assert.equal(extractBody({ mimeType: 'image/jpeg' }), '');
  assert.equal(extractBody({ mimeType: 'multipart/mixed', parts: [] }), '');
});

test('extractBody decodes base64url with - and _ characters', () => {
  // The string ">>?" encodes to "Pj4_" in base64url (vs "Pj4/" in base64).
  // Underscore in the input means base64url decode is required.
  const data = Buffer.from('>>?', 'utf8').toString('base64url');
  assert.ok(data.includes('_'), 'fixture should contain a _');
  const body = extractBody({
    mimeType: 'text/plain',
    body: { data },
  });
  assert.equal(body, '>>?');
});

test('stripHtml removes script + style blocks and decodes common entities', () => {
  const html =
    '<style>p{color:red}</style><script>alert(1)</script>' +
    '<p>5 &gt; 3 &amp; 2 &lt; 4 &quot;quote&quot; &#39;apos&#39;</p>';
  const out = stripHtml(html);
  assert.equal(out, '5 > 3 & 2 < 4 "quote" \'apos\'');
});

test('stripHtml converts block tags to newlines', () => {
  const html = '<p>line one</p><p>line two</p><br>line three';
  const out = stripHtml(html);
  // Block tags become \n; consecutive blank lines collapse to one blank
  // (max two \n in a row). Order is preserved.
  assert.match(out, /line one[\n]+line two[\n]+line three/);
});

test('truncateBody caps at BODY_MAX_BYTES with truncation marker', () => {
  const big = 'a'.repeat(BODY_MAX_BYTES + 5000);
  const out = truncateBody(big);
  assert.ok(Buffer.byteLength(out, 'utf8') <= BODY_MAX_BYTES, 'over cap');
  assert.ok(out.endsWith('…[truncated]'), 'expected truncation marker');
});

test('truncateBody passes through under-cap content unchanged', () => {
  const small = 'a'.repeat(100);
  assert.equal(truncateBody(small), small);
});

test('truncateBody handles empty/null input', () => {
  assert.equal(truncateBody(''), '');
  assert.equal(truncateBody(null), '');
});

test('buildEventFromMessage embeds body into content and meta.body', () => {
  const msg = {
    id: 'm1',
    threadId: 't1',
    snippet: 'preview snippet',
    labelIds: ['INBOX'],
    internalDate: '1700000000000',
    payload: singlePartPlain('full body text here'),
  };
  const event = buildEventFromMessage(msg);
  assert.match(event.content, /Subject: plain test \| From: a@b\.c/);
  assert.match(event.content, /preview snippet/);
  assert.match(event.content, /full body text here/);
  assert.equal(event.meta.body, 'full body text here');
  assert.equal(event.meta.gmail_id, 'm1');
});

test('buildEventFromMessage with empty body keeps legacy content shape', () => {
  const msg = {
    id: 'm-empty',
    threadId: 't-empty',
    snippet: 'just a snippet',
    labelIds: ['INBOX'],
    internalDate: '1700000000000',
    payload: {
      headers: [
        { name: 'Subject', value: 'no body' },
        { name: 'From', value: 'a@b.c' },
      ],
      mimeType: 'multipart/mixed',
      parts: [{ mimeType: 'application/pdf', body: { attachmentId: 'a1' } }],
    },
  };
  const event = buildEventFromMessage(msg);
  assert.equal(event.content, 'Subject: no body | From: a@b.c\njust a snippet');
  assert.equal(event.meta.body, '');
});

test('buildEventFromMessage truncates oversized bodies', () => {
  const big = 'x'.repeat(BODY_MAX_BYTES + 2000);
  const msg = {
    id: 'm-big',
    threadId: 't-big',
    snippet: 's',
    labelIds: ['INBOX'],
    internalDate: '1700000000000',
    payload: singlePartPlain(big),
  };
  const event = buildEventFromMessage(msg);
  assert.ok(Buffer.byteLength(event.meta.body, 'utf8') <= BODY_MAX_BYTES);
  assert.ok(event.meta.body.endsWith('…[truncated]'));
});
