import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkPublishDiscretion, findBookingReference } from './discretion.ts';

const page = (body: string, head = '') =>
  `<!doctype html><html><head><title>t</title>${head}</head><body>${body}</body></html>`;

test('findBookingReference: record locators and confirmation numbers, not prose', () => {
  assert.equal(findBookingReference('NW 0000 · Northwind code ZT7RW2'), 'ZT7RW2');
  assert.equal(findBookingReference('Confirmation #: 84721956'), '84721956');
  assert.equal(findBookingReference('record locator ABC12D'), 'ABC12D');
  assert.equal(findBookingReference('PNR XYZ789'), 'XYZ789');
  assert.equal(findBookingReference('run a code review before merging'), null);
  assert.equal(findBookingReference('zip code 10001'), null);
  assert.equal(findBookingReference('booking 2026 trips'), null);
});

test('findBookingReference: separators, keyword suffixes and lowercase locators', () => {
  assert.equal(findBookingReference('Confirmation | ZT7RW2'), 'ZT7RW2');
  assert.equal(findBookingReference('Confirmation number is ZT7RW2'), 'ZT7RW2');
  assert.equal(findBookingReference('Booking ref ZT7RW2'), 'ZT7RW2');
  assert.equal(findBookingReference('Reservation ID: ZT7RW2'), 'ZT7RW2');
  assert.equal(findBookingReference('Locator — ZT7RW2'), 'ZT7RW2');
  assert.equal(findBookingReference('Locator - XYZ789'), 'XYZ789');
  assert.equal(findBookingReference('{conf:"ZT7RW2"}'), 'ZT7RW2');
  assert.equal(findBookingReference('record locator qx9z4k'), 'qx9z4k');
  assert.equal(findBookingReference('PNR abc12d'), 'abc12d');
});

test('findBookingReference: prose, statuses and code around the keywords stay clean', () => {
  for (const text of [
    'Reservation | CONFIRMED',
    'Booking | Status',
    'confirmation required before travel',
    'booking code2026 in lower case after a weak keyword',
    'return code || DEFAULT_VALUE',
    'codeVERSION2 = 1',
    'nginx configuration ABCDEF',
    '<code>ABCDEF</code>',
    '.booking-code{color:#FF00AA}',
    'https://www.booking.com/hotel/us/ABCDEF12.html',
    '<pre><code class="language-ts">x</code></pre>',
  ]) {
    assert.equal(findBookingReference(text), null, text);
  }
});

test('checkPublishDiscretion: a booking ref in a rendered table row is refused', () => {
  const r = checkPublishDiscretion(
    page('<table><tr><td>Confirmation</td><td>ZT7RW2</td></tr></table>'),
  );
  assert.equal(r.ok, false);
  assert.ok(!r.ok && r.reason.startsWith('booking reference'));
});

test('checkPublishDiscretion: booking ref in visible text is refused, masked', () => {
  const r = checkPublishDiscretion(
    page('<p>Return flight booked. Northwind Air code <b>ZT7RW2</b></p>'),
  );
  assert.equal(r.ok, false);
  assert.ok(!r.ok && r.reason.includes('ZT••••') && !r.reason.includes('ZT7RW2'));
});

test('checkPublishDiscretion: a booking ref inside page JavaScript data is refused', () => {
  for (const js of [
    'const trip = { "confirmation": "ZT7RW2", leg: 1 };',
    "const flight = { pnr: 'XYZ789' };",
    'const code = "ABC12D";',
  ]) {
    const r = checkPublishDiscretion(page('<div id="m"></div>', `<script>${js}</script>`));
    assert.equal(r.ok, false, js);
    assert.ok(!r.ok && r.reason.startsWith('booking reference'), js);
  }
});

test('checkPublishDiscretion: markup attributes and class names are not booking refs', () => {
  const r = checkPublishDiscretion(
    page(
      '<pre><code class="language-ts">x</code></pre><a href="https://www.booking.com/hotel/us/ABCDEF12.html">hotel</a>',
      '<style>.booking-code{color:#FF00AA}</style>',
    ),
  );
  assert.deepEqual(r, { ok: true });
});

test('checkPublishDiscretion: a credential inside page JavaScript is refused', () => {
  const r = checkPublishDiscretion(
    page('<div id="m"></div>', `<script>const k = "sk-ant-${'a'.repeat(40)}";</script>`),
  );
  assert.equal(r.ok, false);
  assert.ok(!r.ok && r.reason.startsWith('secret:'));
});

test('checkPublishDiscretion: SVG path digits and JS arrays are not PII', () => {
  const r = checkPublishDiscretion(
    page(
      '<svg viewBox="0 0 900 900"><path d="M120-35-2400 L100-20-3000"/></svg><p>Plan</p>',
      '<script>const pts = [123-45-6789];</script>',
    ),
  );
  assert.deepEqual(r, { ok: true });
});
