import rehypeParse from 'rehype-parse';
import { unified } from 'unified';

// Minimal hast shapes, as in lib/publish/html-page.ts.
interface HastNode {
  type: string;
  children?: HastNode[];
}
interface Element extends HastNode {
  type: 'element';
  tagName: string;
  properties: Record<string, unknown>;
  children: HastNode[];
}

/** A named form control, as the form that owns it would submit it. */
export interface FormControl {
  name: string;
  type: string;
  value: string;
}

export interface ParsedForm {
  method: string;
  action: string;
  /** Every named control the browser would consider for submission. */
  controls: FormControl[];
}

const CONTROLS = new Set(['input', 'select', 'textarea', 'button']);

function prop(node: Element, key: string): string {
  const value = node.properties?.[key];
  if (Array.isArray(value)) return value.join(' ');
  return value === undefined || value === null ? '' : String(value);
}

function elements(node: HastNode): Element[] {
  return (node.children ?? []).filter((c): c is Element => c.type === 'element');
}

/**
 * Parses HTML the way a browser does and resolves form ownership per the HTML
 * spec: a control belongs to the form its `form` attribute names, otherwise to
 * its nearest `<form>` ancestor, otherwise to no form. A control in no form is
 * never submitted, which is the bug a hand-built POST from a test cannot see.
 */
export function parseForms(html: string): ParsedForm[] {
  const tree = unified().use(rehypeParse).parse(html) as unknown as HastNode;
  const forms = new Map<Element, ParsedForm>();
  const byId = new Map<string, ParsedForm>();

  const collect = (node: HastNode): void => {
    for (const el of elements(node)) {
      if (el.tagName === 'form') {
        const form: ParsedForm = {
          method: prop(el, 'method').toLowerCase() || 'get',
          action: prop(el, 'action'),
          controls: [],
        };
        forms.set(el, form);
        const id = prop(el, 'id');
        if (id) byId.set(id, form);
      }
      collect(el);
    }
  };
  collect(tree);

  const assign = (node: HastNode, enclosing: ParsedForm | undefined): void => {
    for (const el of elements(node)) {
      const here = forms.get(el) ?? enclosing;
      if (CONTROLS.has(el.tagName)) {
        const name = prop(el, 'name');
        const formAttr = prop(el, 'form');
        const owner = formAttr ? byId.get(formAttr) : here;
        if (name && owner) {
          owner.controls.push({
            name,
            type: prop(el, 'type').toLowerCase() || 'text',
            value: prop(el, 'value'),
          });
        }
      }
      assign(el, here);
    }
  };
  assign(tree, undefined);

  return [...forms.values()];
}

/**
 * Builds the body a browser would POST for `form`: `filled` is typed into
 * text/password fields, `checked` names the ticked checkboxes. A checkbox
 * submits its `value` (default "on") only when ticked.
 */
export function submitForm(
  form: ParsedForm,
  input: { filled?: Record<string, string>; checked?: string[] } = {},
): URLSearchParams {
  const body = new URLSearchParams();
  for (const control of form.controls) {
    if (control.type === 'submit' || control.type === 'button') continue;
    if (control.type === 'checkbox' || control.type === 'radio') {
      if (input.checked?.includes(control.name)) body.append(control.name, control.value || 'on');
      continue;
    }
    body.append(control.name, input.filled?.[control.name] ?? control.value);
  }
  return body;
}

/** The one form on the consent page that posts the decision. */
export function decisionForm(html: string): ParsedForm {
  const matches = parseForms(html).filter(
    (f) => f.method === 'post' && f.action === '/oauth/authorize',
  );
  if (matches.length !== 1) {
    throw new Error(`expected exactly one decision form, found ${matches.length}`);
  }
  return matches[0] as ParsedForm;
}
