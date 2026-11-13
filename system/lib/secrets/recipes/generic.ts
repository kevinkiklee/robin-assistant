import { createHash } from 'node:crypto';
import type { Recipe } from './types.ts';

export interface LocateOpts {
  buttonText: RegExp;
  nearValueShape: RegExp;
}

/** A button further than this (CSS px) from every key holder is never returned. */
export const MAX_HOLDER_DISTANCE = 400;

/**
 * Self-contained page expression. Finds a visible button matching buttonText
 * (text or aria-label) within MAX_HOLDER_DISTANCE px of a visible input/code/pre
 * whose value or text (or any whitespace/=/:-separated token of it) matches
 * nearValueShape (tested in-page, never returned), picks the nearest, scrolls it
 * into view instantly and evaluates to {found:false} or {found:true,x,y}.
 * With no matching holder there is NO fallback: it returns {found:false}, so a
 * stray "Copy ID" button is never clicked. Deterministic text: it is hashed
 * as-is. It never copies anything.
 */
export function buildLocateScript(opts: LocateOpts): string {
  const btn = opts.buttonText.toString();
  const val = opts.nearValueShape.toString();
  return `(() => {
  try {
    const BTN = ${btn};
    const VAL = ${val};
    const MAXD = ${MAX_HOLDER_DISTANCE};
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
      if (!visible(h)) return false;
      const t = String(('value' in h && h.value) ? h.value : h.textContent || '').trim();
      return VAL.test(t) || t.split(/[s=:]+/).some((p) => p !== '' && VAL.test(p));
    });
    if (holders.length === 0) {
      return { found: false };
    }
    const buttons = Array.from(document.querySelectorAll('button, [role="button"]')).filter((b) => {
      const label = (b.getAttribute('aria-label') || '') + ' ' + (b.textContent || '');
      return visible(b) && BTN.test(label);
    });
    let best = null;
    let bestD = MAXD;
    for (const b of buttons) {
      const [bx, by] = centre(b);
      for (const h of holders) {
        const [hx, hy] = centre(h);
        const d = Math.hypot(bx - hx, by - hy);
        if (d <= bestD) {
          bestD = d;
          best = b;
        }
      }
    }
    if (best === null) {
      return { found: false };
    }
    best.scrollIntoView({ block: 'center', behavior: 'instant' });
    const [x, y] = centre(best);
    return { found: true, x: Math.round(x), y: Math.round(y) };
  } catch (e) {
    return { found: false };
  }
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
