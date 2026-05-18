// Shared JSON envelope shape for every `robin <subcmd> --json` output.
// Contract: { ok: boolean, command: string, data?: object, error?: { reason, message }, took_ms: number }.

export function okEnvelope({ command, data, took_ms }) {
  return { ok: true, command, data, took_ms };
}

export function errorEnvelope({ command, reason, message, took_ms }) {
  return { ok: false, command, error: { reason, message }, took_ms };
}
