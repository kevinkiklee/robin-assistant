// Structured logger module.
//
// Emits a single JSON line per call: {ts, level, event, ...fields}.
// `event` is required — callers must classify; this is what enables grep/
// aggregation in daemon.log without resorting to fragile regex over freeform
// messages.
//
// `setSink(fn)` lets tests capture lines without writing to stdout. Pass
// `null` to restore the default.
//
// `log.debug` only emits when `ROBIN_DEBUG=1` — debug calls are otherwise a
// no-op so silenced sites stay silent in production.

const defaultSink = (line) => process.stdout.write(`${line}\n`);
let _sink = defaultSink;

export function setSink(fn) {
  _sink = fn ?? defaultSink;
}

function emit(level, payload) {
  if (!payload || typeof payload.event !== 'string') {
    throw new Error('log: payload.event is required');
  }
  const line = JSON.stringify({ ts: new Date().toISOString(), level, ...payload });
  _sink(line);
}

export const log = {
  info: (payload) => emit('info', payload),
  warn: (payload) => emit('warn', payload),
  error: (payload) => emit('error', payload),
  debug: (payload) => {
    if (process.env.ROBIN_DEBUG === '1') emit('debug', payload);
  },
};
