const realDate = globalThis.Date;
let installed = null;

export function now() {
  const env = process.env.ROBIN_CLOCK;
  return env ? realDate.parse(env) : realDate.now();
}

export function today() {
  return new realDate(now()).toISOString().slice(0, 10);
}

export function nowIso() {
  return new realDate(now()).toISOString();
}

export function installClock(iso) {
  if (installed) uninstallClock();
  const frozenMs = realDate.parse(iso);
  if (Number.isNaN(frozenMs)) throw new Error(`installClock: invalid ISO ${iso}`);

  // eslint-disable-next-line no-global-assign
  globalThis.Date = class extends realDate {
    constructor(...args) {
      if (args.length === 0) super(frozenMs);
      else super(...args);
    }
    static now() { return frozenMs; }
    static parse = realDate.parse;
    static UTC = realDate.UTC;
  };
  installed = true;
  process.env.ROBIN_CLOCK = iso;
}

export function uninstallClock() {
  if (!installed) return;
  // eslint-disable-next-line no-global-assign
  globalThis.Date = realDate;
  installed = null;
}
