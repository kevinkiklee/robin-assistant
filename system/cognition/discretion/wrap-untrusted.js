// system/cognition/discretion/wrap-untrusted.js
import { randomBytes } from 'node:crypto';

const TRUSTED = 'trusted';

let nonceFactory = () => randomBytes(6).toString('base64url');

/** Test-only hook. Pass null to restore the real factory. */
export function __setNonceFactoryForTests(fn) {
  nonceFactory = fn ?? (() => randomBytes(6).toString('base64url'));
}

function attr(name, value) {
  // Best-effort attribute escape — keeps the agent's read clean. Inner content
  // is NOT escaped; the nonce-suffixed close tag is the security boundary,
  // not HTML escaping (LLMs don't parse HTML).
  if (value == null) return '';
  const s = String(value).replace(/"/g, '&quot;');
  return ` ${name}="${s}"`;
}

export function wrapUntrusted(text, { source, eventId, trust } = {}) {
  if (trust === TRUSTED || trust == null) return text;
  const nonce = nonceFactory();
  return (
    `<untrusted-content nonce="${nonce}"${attr('source', source)}${attr('event-id', eventId)}>` +
    `${text}` +
    `</untrusted-content-${nonce}>`
  );
}

export function wrapDiscordMessage(text, { userId, channelId, ts } = {}) {
  const nonce = nonceFactory();
  return (
    `<discord-message-from nonce="${nonce}"${attr('user', userId)}${attr('channel', channelId)}${attr('ts', ts)}>` +
    `${text}` +
    `</discord-message-from-${nonce}>`
  );
}

export function wrapDiscordReply(text, { userId, ts } = {}) {
  const nonce = nonceFactory();
  return (
    `<discord-message-reply nonce="${nonce}"${attr('user', userId)}${attr('ts', ts)}>` +
    `${text}` +
    `</discord-message-reply-${nonce}>`
  );
}

export function wrapEntityRecord(record, { trust } = {}) {
  const serialized = JSON.stringify(record);
  if (trust === TRUSTED || trust == null) return serialized;
  const nonce = nonceFactory();
  return (
    `<untrusted-content nonce="${nonce}" record-type="entity"${attr('event-id', record?.id)}>` +
    `${serialized}` +
    `</untrusted-content-${nonce}>`
  );
}

/** trusted < untrusted-mixed < untrusted */
export function mergeTrust(trusts) {
  if (!trusts || trusts.length === 0) return 'trusted';
  let worst = 'trusted';
  for (const t of trusts) {
    if (t === 'untrusted') return 'untrusted';
    if (t === 'untrusted-mixed') worst = 'untrusted-mixed';
  }
  return worst;
}
