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
 * (text, aria-label or title) within MAX_HOLDER_DISTANCE px of a visible key
 * holder — an input/textarea/code/pre, or any element whose OWN text nodes
 * (dashboards often render keys in a plain div/span) — whose value or text
 * (or any whitespace/=/:-separated token of it) matches
 * nearValueShape (tested in-page, never returned), picks the nearest, scrolls it
 * into view instantly and evaluates to {found:false} or {found:true,x,y}.
 * With no matching holder there is NO fallback: it returns {found:false}, so a
 * stray "Copy ID" button is never clicked. Deterministic text: it is hashed
 * as-is. It never copies anything.
 */
/**
 * Shared in-page helpers (template text, hashed with each script). Walks the
 * document, every open shadow root and every same-origin iframe; `q(sel)`
 * returns `{el, dx, dy}` with the frame offset so centres are top-viewport
 * coordinates. Expects `VAL` to be defined by the caller.
 */
const SCAN_HELPERS = `    const roots = [];
    const walk = (root, dx, dy) => {
      roots.push({ root, dx, dy });
      for (const el of Array.from(root.querySelectorAll('*'))) {
        if (el.shadowRoot) walk(el.shadowRoot, dx, dy);
        if (el.tagName === 'IFRAME') {
          try {
            const d = el.contentDocument;
            if (d) {
              const r = el.getBoundingClientRect();
              walk(d, dx + r.left, dy + r.top);
            }
          } catch (e) {}
        }
      }
    };
    walk(document, 0, 0);
    const q = (sel) =>
      roots.flatMap(({ root, dx, dy }) => Array.from(root.querySelectorAll(sel)).map((el) => ({ el, dx, dy })));
    const visible = (e) => {
      const r = e.getBoundingClientRect();
      const s = getComputedStyle(e);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
    };
    const centre = (h) => {
      const r = h.el.getBoundingClientRect();
      return [h.dx + r.left + r.width / 2, h.dy + r.top + r.height / 2];
    };
    const matches = (t) => VAL.test(t) || t.split(/[\\s=:]+/).some((p) => p !== '' && VAL.test(p));
    const ownText = (e) =>
      Array.from(e.childNodes || [])
        .filter((n) => n.nodeType === 3)
        .map((n) => n.textContent || '')
        .join('')
        .trim();
    const labelOf = (b) =>
      (b.getAttribute('aria-label') || '') + ' ' + (b.getAttribute('title') || '') + ' ' + (b.textContent || '');`;

/**
 * Structure-only probe for when locateCopy finds nothing. Returns counts,
 * whether ANY text or value anywhere has the key's shape, and up to 120
 * elements under the top-most dialog (or body): tag, role, a label kept only
 * if it is letters/spaces ≤30 chars, own-text length + shape boolean, value
 * length + shape boolean, shadow-host flag and rect. Never returns page text,
 * class names or attribute values beyond those safe labels.
 */
export function buildInspectScript(shape: RegExp): string {
  return `(() => {
  try {
    const VAL = ${shape.toString()};
${SCAN_HELPERS}
    const safe = (s) => {
      const t = String(s || '').replace(/\\s+/g, ' ').trim();
      if (t === '') return '';
      return /^[A-Za-z][A-Za-z ,.'-]{0,29}$/.test(t) ? t : '<other>';
    };
    const dialogs = q('[role="dialog"], [role="alertdialog"], dialog[open]').filter(({ el }) => visible(el));
    const top = dialogs.length ? dialogs[dialogs.length - 1] : { el: document.body, dx: 0, dy: 0 };
    const inside = q('*').filter(({ el }) => el === top.el || top.el.contains(el) || (el.getRootNode && el.getRootNode().host && top.el.contains(el.getRootNode().host)));
    const all = q('*');
    let anyShape = false;
    for (const { el } of all) {
      const v = 'value' in el && typeof el.value === 'string' ? el.value : '';
      if (matches(ownText(el)) || (v && matches(v.trim()))) {
        anyShape = true;
        break;
      }
    }
    const els = inside.slice(0, 120).map((h) => {
      const el = h.el;
      const r = el.getBoundingClientRect();
      const own = ownText(el);
      const v = 'value' in el && typeof el.value === 'string' ? el.value.trim() : '';
      const isBtn = el.tagName === 'BUTTON' || el.getAttribute('role') === 'button';
      return {
        tag: String(el.tagName || '').toLowerCase(),
        role: safe(el.getAttribute('role')),
        label: safe(isBtn ? labelOf(el) : (el.getAttribute('aria-label') || el.getAttribute('title') || '')),
        ownLen: own.length,
        ownShape: own !== '' && matches(own),
        valueLen: v.length,
        valueShape: v !== '' && matches(v),
        shadow: !!el.shadowRoot,
        visible: visible(el),
        x: Math.round(h.dx + r.left),
        y: Math.round(h.dy + r.top),
        w: Math.round(r.width),
        h: Math.round(r.height),
      };
    });
    return {
      frames: roots.length,
      dialogs: dialogs.length,
      shadowHosts: all.filter(({ el }) => !!el.shadowRoot).length,
      iframes: all.filter(({ el }) => el.tagName === 'IFRAME').length,
      anyShape,
      els,
    };
  } catch (e) {
    return { error: true };
  }
})()`;
}

export function buildLocateScript(opts: LocateOpts): string {
  const btn = opts.buttonText.toString();
  const val = opts.nearValueShape.toString();
  return `(() => {
  try {
    const BTN = ${btn};
    const VAL = ${val};
    const MAXD = ${MAX_HOLDER_DISTANCE};
${SCAN_HELPERS}
    const fields = q('input, textarea, code, pre').filter(({ el }) => {
      const t = String(('value' in el && el.value) ? el.value : el.textContent || '').trim();
      return matches(t);
    });
    const plain = q('*').filter(({ el }) => matches(ownText(el)));
    const seen = new Set();
    const holders = [...fields, ...plain].filter((h) => {
      if (seen.has(h.el)) return false;
      seen.add(h.el);
      return visible(h.el);
    });
    if (holders.length === 0) {
      return { found: false };
    }
    const buttons = q('button, [role="button"]').filter(({ el }) => visible(el) && BTN.test(labelOf(el)));
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
    best.el.scrollIntoView({ block: 'center', behavior: 'instant' });
    const [x, y] = centre(best);
    return { found: true, x: Math.round(x), y: Math.round(y) };
  } catch (e) {
    return { found: false };
  }
})()`;
}

export function scriptHashes(r: Recipe): string[] {
  return [r.precheck, r.locateReveal, r.locateCopy, r.inspectReveal]
    .filter((s): s is string => typeof s === 'string')
    .map((s) => createHash('sha256').update(s).digest('hex'));
}

export const COPY_BUTTON = /copy/i;
export const REVEAL_BUTTON = /(reveal|show|view)/i;

export function standardLocators(shape: RegExp): {
  locateReveal: string;
  locateCopy: string;
  inspectReveal: string;
} {
  return {
    locateReveal: buildLocateScript({ buttonText: REVEAL_BUTTON, nearValueShape: /./ }),
    locateCopy: buildLocateScript({ buttonText: COPY_BUTTON, nearValueShape: shape }),
    inspectReveal: buildInspectScript(shape),
  };
}
