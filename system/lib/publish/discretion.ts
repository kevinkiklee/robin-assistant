import { checkInbound, checkOutbound } from '../discretion/policy.ts';
import { htmlToText } from '../html-text.ts';

/**
 * Publish-time discretion: the last check before a page leaves for a public
 * (unguessable but unauthenticated) URL. Same patterns Discord delivery uses
 * (lib/discretion), split by where they're reliable:
 *
 *   - PII shapes (card/SSN/SIN) on the VISIBLE text — SVG path data and JS
 *     number arrays produce digit runs that look like an SSN in raw markup.
 *   - Credential shapes on the FULL page — a key inside page JavaScript is
 *     the leak that matters now that pages run scripts.
 *   - Booking references (publish-only rule): "confirmation/record locator/
 *     PNR/booking code XXXXXX". With a surname, a record locator is enough to
 *     change or cancel a booking — a credential, not trip detail (a code on a
 *     published trip page, 2026-10-26).
 *
 *     Checked on the visible text AND the full page: page JS can hold a
 *     locator in a data object (`{ "confirmation": "ZT7RW2" }`). The keyword
 *     anchor keeps SVG/number-array noise out, unlike the PII digit shapes.
 *
 * Refuses by default; `--allow-sensitive` overrides for a known false positive.
 */

// Keyword, then up to two qualifiers ("number is", "ref", "ID"), then an
// optional separator: `:`/`#`/`=` (JS/JSON: `pnr: 'X'`, `{conf:"X"}`), `|`
// (htmlToText joins table cells with " | "), or a dash ("Locator — X"; an
// ASCII hyphen only with spaces round it). Keywords and qualifiers must end at
// a non-alphanumeric, so `codeVERSION2` and `configuration` aren't keywords;
// a following `-`/`.` (`booking-code`, `booking.com/`) never reaches a code.
const BOOKING_RE =
  /\b(confirmation|conf\.?|record\s+locator|locator|pnr|booking|reservation|code)(?![A-Za-z0-9])(?:\s+(?:code|number|num|no\.?|#|ref\.?|reference|id|is|was)(?![A-Za-z0-9])){0,2}["']?(?:\s*[:#=|—–]|\s+-(?=\s))?\s*["']?([A-Za-z0-9]{6,10})\b/gi;

// After these keywords a lower-case run with a digit is still a locator
// ("record locator qx9z4k"); after `code`/`booking` it's prose or an identifier.
const STRONG_KEYWORD = /^(?:confirmation|record\s+locator|locator|pnr)$/i;

// All-caps status words that land in the code slot of a table row
// ("Reservation | CONFIRMED").
const STATUS_WORDS = new Set([
  'CONFIRMED',
  'PENDING',
  'CANCELLED',
  'CANCELED',
  'REQUIRED',
  'BOOKED',
  'STATUS',
  'NUMBER',
  'DETAILS',
]);

export function findBookingReference(text: string): string | null {
  for (const m of text.matchAll(BOOKING_RE)) {
    const ref = m[2];
    if (STATUS_WORDS.has(ref.toUpperCase())) continue;
    // Locators are upper-case letters/digits; lower-case words ("code review")
    // are prose — unless a strong keyword precedes a letters-and-digits run.
    if (/^[A-Z0-9]+$/.test(ref)) return ref;
    if (
      STRONG_KEYWORD.test(m[1]) &&
      /^[a-z0-9]+$/.test(ref) &&
      /\d/.test(ref) &&
      /[a-z]/.test(ref)
    ) {
      return ref;
    }
  }
  return null;
}

function mask(ref: string): string {
  return `${ref.slice(0, 2)}${'•'.repeat(Math.max(0, ref.length - 2))}`;
}

/** Check the final rendered page (both formats render to HTML first). */
export function checkPublishDiscretion(html: string): { ok: true } | { ok: false; reason: string } {
  const visible = htmlToText(html);
  const outbound = checkOutbound({ text: visible });
  if (!outbound.ok) return outbound;
  const inbound = checkInbound(html);
  if (!inbound.ok) return inbound;
  const ref = findBookingReference(visible) ?? findBookingReference(html);
  if (ref) return { ok: false, reason: `booking reference (${mask(ref)})` };
  return { ok: true };
}
