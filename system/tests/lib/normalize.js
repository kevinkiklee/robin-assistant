const ANSI = /\x1B\[[0-9;]*[A-Za-z]/g;
const ISO_TS = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z/g;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export function normalize(text, ctx) {
  let out = String(text);
  // 1. Strip ANSI
  out = out.replace(ANSI, '');
  // 2. LF-normalize
  out = out.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  // 3. Workspace prefix → <WS>
  if (ctx.workspace) {
    // Longest-match-first: try with trailing slash first, then without.
    const ws = ctx.workspace;
    out = out.split(ws + '/').join('<WS>/').split(ws).join('<WS>');
  }
  // 4. ISO timestamps within ±1 day of frozen clock → <TS>
  if (ctx.clockMs) {
    out = out.replace(ISO_TS, (m) => {
      const t = Date.parse(m);
      if (Number.isNaN(t)) return m;
      return Math.abs(t - ctx.clockMs) <= ONE_DAY_MS ? '<TS>' : m;
    });
  }
  // 5. Per-scenario normalizers
  for (const { from, to } of ctx.extra ?? []) {
    out = out.replace(from, to);
  }
  return out;
}
