// Redaction policy for the PostToolUse hook (spec 6.4): which saved values to
// hide, and how to hide them inside a tool's output without changing its shape.
// Every hook run is a fresh process, so values are read on each call and never
// cached or written anywhere.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { parseEnvFile, readEnvFile } from '../env-file.ts';
import { isSecretClassName, secretsPaths } from '../store.ts';

export const REDACTED = '[REDACTED-SECRET]';
const MIN_LENGTH = 16;

/** Paths listed in redact-files.txt: one per line, `#` comments, `~` expanded, relative to the list's folder. */
function listedFiles(listPath: string): string[] {
  let text: string;
  try {
    text = readFileSync(listPath, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    if (t === '~') out.push(homedir());
    else if (t.startsWith('~/')) out.push(join(homedir(), t.slice(2)));
    else out.push(isAbsolute(t) ? t : resolve(dirname(listPath), t));
  }
  return out;
}

/** A listed file's content, or undefined when it no longer exists. Anything else (a directory, EACCES) throws. */
function readListed(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
}

/**
 * Every value to hide: all `vault.env` values, secret-class values from Robin's
 * `.env` and `daemon.env`, and the trimmed content of each file listed in
 * `redact-files.txt` (whole file, each line, each KEY=value value). Values under
 * 16 chars are skipped. Deduped, longest first.
 */
export function loadRedactionValues(userData: string): string[] {
  const p = secretsPaths(userData);
  const values = new Set<string>();
  const add = (v: string): void => {
    if (v.length >= MIN_LENGTH) values.add(v);
  };
  for (const v of readEnvFile(p.vault).values()) add(v);
  for (const file of [p.robinEnv, p.daemonEnv]) {
    for (const [name, v] of readEnvFile(file)) if (isSecretClassName(name)) add(v);
  }
  for (const file of listedFiles(p.redactFiles)) {
    const text = readListed(file);
    if (text === undefined) continue;
    // The whole file, each line (a PEM body), and each KEY=value value (an env file).
    add(text.trim());
    for (const line of text.split(/\r?\n/)) add(line.trim());
    for (const v of parseEnvFile(text).values()) add(v);
  }
  return [...values].sort((a, b) => b.length - a.length);
}

/**
 * The base64 characters that depend only on `bytes`, for each of the three
 * byte alignments the value could sit at inside a longer encoded string
 * (e.g. `user:key` in a Basic auth header).
 */
function base64Cores(bytes: Buffer, alphabet: 'base64' | 'base64url'): string[] {
  const out: string[] = [];
  for (let k = 0; k < 3; k++) {
    const enc = Buffer.concat([Buffer.alloc(k), bytes])
      .toString(alphabet)
      .replace(/=+$/, '');
    const start = Math.ceil((8 * k) / 6);
    const end = Math.floor((8 * (k + bytes.length)) / 6);
    if (end - start >= MIN_LENGTH) out.push(enc.slice(start, end));
  }
  return out;
}

const jsonEscape = (s: string): string => JSON.stringify(s).slice(1, -1);

/**
 * The forms a value commonly takes in tool output: raw, JSON-escaped (once,
 * twice, and with `\/` as PHP writes it), URL-encoded (component and form
 * style), hex, base64/base64url at any alignment.
 */
function encodedForms(value: string): string[] {
  const bytes = Buffer.from(value, 'utf8');
  const hex = bytes.toString('hex');
  const json = jsonEscape(value);
  const forms = new Set<string>([
    value,
    json,
    json.replace(/\//g, '\\/'),
    jsonEscape(json),
    encodeURIComponent(value),
    new URLSearchParams({ v: value }).toString().slice(2),
    hex,
    hex.toUpperCase(),
    ...base64Cores(bytes, 'base64'),
    ...base64Cores(bytes, 'base64url'),
  ]);
  return [...forms].filter((f) => f.length > 0);
}

/**
 * Replaces every span of `s` covered by any needle with the marker. Spans from
 * all needles are merged first, so overlapping or nested matches (a key inside
 * a connection URL, two keys sharing a run) leave no fragment of either.
 */
function redactString(s: string, needles: string[]): string {
  const spans: [number, number][] = [];
  for (const n of needles) {
    for (let i = s.indexOf(n); i >= 0; i = s.indexOf(n, i + 1)) spans.push([i, i + n.length]);
  }
  if (spans.length === 0) return s;
  spans.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  let out = '';
  let pos = 0;
  let [curStart, curEnd] = spans[0];
  for (const [st, en] of spans.slice(1)) {
    if (st <= curEnd) {
      if (en > curEnd) curEnd = en;
      continue;
    }
    out += s.slice(pos, curStart) + REDACTED;
    pos = curEnd;
    [curStart, curEnd] = [st, en];
  }
  return out + s.slice(pos, curStart) + REDACTED + s.slice(curEnd);
}

/** An image content block: `type: 'image'` carrying `data` or `source`. Other `type: 'image'` objects are walked. */
function isImageBlock(v: object): boolean {
  return (
    !Array.isArray(v) &&
    (v as { type?: unknown }).type === 'image' &&
    (Object.hasOwn(v, 'data') || Object.hasOwn(v, 'source'))
  );
}

/**
 * Sets `key` on `out` as an own data property (so `__proto__` is kept as a key,
 * not a prototype change), adding `_2`, `_3`… when the key is already taken.
 */
function setOwnKey(out: Record<string, unknown>, key: string, value: unknown): void {
  let k = key;
  for (let n = 2; Object.hasOwn(out, k); n++) k = `${key}_${n}`;
  Object.defineProperty(out, k, { value, enumerable: true, writable: true, configurable: true });
}

/**
 * Walks `output` and redacts every string in it (object keys and values, array
 * items, any depth). Image blocks and non-strings pass through untouched.
 * Returns the original reference when nothing matched; never mutates input.
 */
export function redactOutput(
  output: unknown,
  values: string[],
): { changed: boolean; output: unknown } {
  if (values.length === 0) return { changed: false, output };
  const needles = [...new Set(values.flatMap(encodedForms))].sort((a, b) => b.length - a.length);
  let changed = false;

  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      const r = redactString(v, needles);
      if (r !== v) changed = true;
      return r;
    }
    if (typeof v !== 'object' || v === null || isImageBlock(v)) return v;
    if (Array.isArray(v)) return v.map(walk);
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) setOwnKey(out, walk(k) as string, walk(val));
    return out;
  };

  const redacted = walk(output);
  return changed ? { changed, output: redacted } : { changed: false, output };
}
