/**
 * Chrome integration "client" — read-side helpers over the local SQLite
 * History snapshot. Distinct from the sync entry point so individual
 * fragments (URL→host parsing, time conversion) are unit-testable.
 *
 * Convention parity with other integrations: every integration module set
 * has client.js even when there's no remote API. Chrome's source is local,
 * so the helpers are filesystem/conversion utilities.
 */

// Chrome stores visit_time as microseconds since 1601-01-01 UTC (the Windows
// FILETIME epoch). 1601→1970 is 11_644_473_600 seconds = 11_644_473_600_000_000
// microseconds. JS Date wants ms since 1970, so divide the remainder by 1000.
const CHROME_EPOCH_OFFSET_US = 11_644_473_600_000_000;

export function chromeTimeToDate(visit_time) {
  return new Date((visit_time - CHROME_EPOCH_OFFSET_US) / 1000);
}

export function dateToChromeTime(date) {
  return date.getTime() * 1000 + CHROME_EPOCH_OFFSET_US;
}

export function urlToHost(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}
