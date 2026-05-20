import { randomBytes } from 'node:crypto';

const TRUSTED = 'trusted';

let nonceFactory = (): string => randomBytes(6).toString('base64url');

/** Test-only hook. Pass null to restore the real factory. */
export function setNonceFactoryForTests(fn: (() => string) | null): void {
  nonceFactory = fn ?? ((): string => randomBytes(6).toString('base64url'));
}

function attr(name: string, value: unknown): string {
  if (value == null) return '';
  const s = String(value).replace(/"/g, '&quot;');
  return ` ${name}="${s}"`;
}

/**
 * Wrap inbound untrusted content in a nonce-suffixed close tag. The unique
 * nonce in the close tag is the security boundary — even if the wrapped text
 * contains a literal `</untrusted-content>` injection attempt, it won't match
 * the per-call close tag.
 *
 * Returns text unchanged when `trust === 'trusted'` or undefined (no nonce
 * overhead when the source is already trusted).
 */
export interface WrapUntrustedOpts {
  source?: string;
  eventId?: string | number;
  trust?: string;
}

export function wrapUntrusted(text: string, opts: WrapUntrustedOpts = {}): string {
  if (opts.trust === TRUSTED || opts.trust == null) return text;
  const nonce = nonceFactory();
  return (
    `<untrusted-content nonce="${nonce}"${attr('source', opts.source)}${attr('event-id', opts.eventId)}>` +
    `${text}` +
    `</untrusted-content-${nonce}>`
  );
}

export interface DiscordWrapOpts {
  userId?: string;
  channelId?: string;
  ts?: string | Date;
}

export function wrapDiscordMessage(text: string, opts: DiscordWrapOpts = {}): string {
  const nonce = nonceFactory();
  return (
    `<discord-message-from nonce="${nonce}"${attr('user', opts.userId)}${attr('channel', opts.channelId)}${attr('ts', opts.ts)}>` +
    `${text}` +
    `</discord-message-from-${nonce}>`
  );
}
