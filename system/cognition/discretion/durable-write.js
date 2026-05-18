import { PII_PATTERNS, SECRET_PATTERNS } from './outbound-patterns.js';
import { scanForVerbatimQuote } from './verbatim-scan.js';
import { logRefusal } from './refusal-log.js';

const GATE_BY_DESTINATION = {
  remember:             { pii: true, secret: true, verbatim: true,  taint: true  },
  ingest:               { pii: true, secret: true, verbatim: true,  taint: false },
  record_correction:    { pii: true, secret: true, verbatim: true,  taint: false },
  update_rule:          { pii: true, secret: true, verbatim: true,  taint: false },
  update_action_policy: { pii: true, secret: true, verbatim: true,  taint: false },
};

let envOverride = null;

function mode() {
  if (envOverride != null) return envOverride;
  return process.env.ROBIN_INJECTION_GUARD ?? 'log';
}

export function __setEnvForTests(m) { envOverride = m; }

async function logAndMaybeRefuse(db, { destination, reason, text }) {
  await logRefusal(db, {
    direction: 'outbound',
    destination,
    reason: `durable-write:${reason}`,
    payload: text,
  });
  const m = mode();
  if (m === 'enforce') return { ok: false, reason };
  return { ok: true };
}

export async function checkDurableWrite(db, { destination, text, sessionTaint, force } = {}) {
  if (mode() === 'off') return { ok: true };
  const gates = GATE_BY_DESTINATION[destination];
  if (!gates) return { ok: true };

  if (gates.pii) {
    for (const p of PII_PATTERNS) {
      const m = p.regex.exec(text);
      if (m && (!p.mask || p.mask(m[0]))) {
        return logAndMaybeRefuse(db, { destination, reason: `pii:${p.name}`, text });
      }
    }
  }
  if (gates.secret) {
    for (const p of SECRET_PATTERNS) {
      if (p.regex.test(text)) {
        return logAndMaybeRefuse(db, { destination, reason: `secret:${p.name}`, text });
      }
    }
  }
  if (gates.verbatim) {
    const hit = await scanForVerbatimQuote(db, text);
    if (hit.found) {
      return logAndMaybeRefuse(db, { destination, reason: 'untrusted_quote', text });
    }
  }
  if (gates.taint && sessionTaint?.tainted && !force) {
    return logAndMaybeRefuse(db, { destination, reason: 'session_tainted', text });
  }
  return { ok: true };
}
