import { createHash } from 'node:crypto';
import type { Recipe } from './types.ts';

export interface LocateOpts {
  buttonText: RegExp;
  nearValueShape: RegExp;
}

/**
 * Self-contained page expression. Finds a visible button matching buttonText
 * (text or aria-label), preferring the one nearest an input/code/pre whose
 * value or text matches nearValueShape (tested in-page, never returned),
 * scrolls it into view and evaluates to {found:false} or {found:true,x,y}.
 * Deterministic text: it is hashed as-is. It never copies anything.
 */
export function buildLocateScript(opts: LocateOpts): string {
  const btn = opts.buttonText.toString();
  const val = opts.nearValueShape.toString();
  return `(() => {
  const BTN = ${btn};
  const VAL = ${val};
  const visible = (e) => {
    const r = e.getBoundingClientRect();
    const s = getComputedStyle(e);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  };
  const centre = (e) => {
    const r = e.getBoundingClientRect();
    return [r.left + r.width / 2, r.top + r.height / 2];
  };
  const holders = Array.from(document.querySelectorAll('input, code, pre')).filter((h) => {
    const t = ('value' in h && h.value) ? h.value : h.textContent;
    return VAL.test(String(t || '').trim());
  });
  const buttons = Array.from(document.querySelectorAll('button, [role="button"]')).filter((b) => {
    const label = (b.getAttribute('aria-label') || '') + ' ' + (b.textContent || '');
    return visible(b) && BTN.test(label);
  });
  if (buttons.length === 0) {
    return { found: false };
  }
  let best = buttons[0];
  let bestD = Infinity;
  for (const b of buttons) {
    const [bx, by] = centre(b);
    for (const h of holders) {
      const [hx, hy] = centre(h);
      const d = Math.hypot(bx - hx, by - hy);
      if (d < bestD) {
        bestD = d;
        best = b;
      }
    }
  }
  best.scrollIntoView({ block: 'center' });
  const [x, y] = centre(best);
  return { found: true, x: Math.round(x), y: Math.round(y) };
})()`;
}

export function scriptHashes(r: Recipe): string[] {
  return [r.precheck, r.locateReveal, r.locateCopy]
    .filter((s): s is string => typeof s === 'string')
    .map((s) => createHash('sha256').update(s).digest('hex'));
}

export const COPY_BUTTON = /copy/i;
export const REVEAL_BUTTON = /(reveal|show|view)/i;

export function standardLocators(shape: RegExp): { locateReveal: string; locateCopy: string } {
  return {
    locateReveal: buildLocateScript({ buttonText: REVEAL_BUTTON, nearValueShape: /./ }),
    locateCopy: buildLocateScript({ buttonText: COPY_BUTTON, nearValueShape: shape }),
  };
}
