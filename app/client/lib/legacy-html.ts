// TRANSITIONAL — delete once every module is converted to .tsx (React migration, see AGENTS.md).
// `html` tagged templates (htm) written for Preact, rendered by React. Translates the Preact-isms the old modules use:
// class → className, for → htmlFor, CSS strings in style → objects, lowercase attributes (readonly, maxlength…),
// SVG dash-case attributes, onDblClick, and onChange on text fields (Preact = native « change », i.e. on blur/Enter;
// React's onChange fires on every keystroke).
import { createElement, type ReactNode } from 'react';
import htm from 'htm';

type Props = Record<string, unknown> | null;

const ATTRS: Record<string, string> = {
  class: 'className',
  for: 'htmlFor',
  autofocus: 'autoFocus',
  readonly: 'readOnly',
  tabindex: 'tabIndex',
  maxlength: 'maxLength',
  minlength: 'minLength',
  colspan: 'colSpan',
  rowspan: 'rowSpan',
  inputmode: 'inputMode',
  spellcheck: 'spellCheck',
  contenteditable: 'contentEditable',
  crossorigin: 'crossOrigin',
  srcset: 'srcSet',
  enterkeyhint: 'enterKeyHint',
  autocomplete: 'autoComplete',
  onDblClick: 'onDoubleClick',
  onFocusIn: 'onFocus',
  onFocusOut: 'onBlur',
};
const TEXT_TYPES = new Set(['', 'text', 'search', 'number', 'email', 'password', 'tel', 'url']);

/** "margin-top:14px; --x: 1" → { marginTop: '14px', '--x': '1' } */
function styleObject(css: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const decl of css.split(';')) {
    const i = decl.indexOf(':');
    if (i < 0) continue;
    const k = decl.slice(0, i).trim();
    const v = decl.slice(i + 1).trim();
    if (!k) continue;
    out[k.startsWith('--') ? k : k.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())] = v;
  }
  return out;
}

function normalize(type: unknown, props: Props): Props {
  if (!props) return props;
  const p: Record<string, unknown> = { ...props };
  if (typeof p.style === 'string') p.style = styleObject(p.style);
  if (typeof type !== 'string') {
    // Component: converted components read className, unconverted ones still read class — give both.
    if (p.class !== undefined && p.className === undefined) p.className = p.class;
    return p;
  }
  for (const [from, to] of Object.entries(ATTRS)) {
    if (from in p) {
      if (p[to] === undefined) p[to] = p[from];
      delete p[from];
    }
  }
  for (const k of Object.keys(p)) {
    // SVG / misc dash-case attributes (stroke-width…) → camelCase; data-* and aria-* stay as they are.
    if (k.includes('-') && !k.startsWith('data-') && !k.startsWith('aria-')) {
      p[k.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())] = p[k];
      delete p[k];
    }
  }
  const isText = type === 'textarea' || (type === 'input' && TEXT_TYPES.has(String(p.type ?? '')));
  if (isText && typeof p.onChange === 'function') {
    // Native « change » semantics: commit on blur (if the value changed) or Enter, never per keystroke.
    const onChange = p.onChange as (e: unknown) => void;
    const onBlur = p.onBlur as ((e: unknown) => void) | undefined;
    const onKeyDown = p.onKeyDown as ((e: KeyboardEvent) => void) | undefined;
    let start: string | null = null;
    delete p.onChange;
    const onFocus = p.onFocus as ((e: unknown) => void) | undefined;
    p.onFocus = (e: { target: HTMLInputElement }) => {
      start = e.target.value;
      onFocus?.(e);
    };
    p.onBlur = (e: { target: HTMLInputElement }) => {
      if (start === null || e.target.value !== start) onChange(e);
      start = null;
      onBlur?.(e);
    };
    if (type === 'input') {
      p.onKeyDown = (e: KeyboardEvent & { target: HTMLInputElement }) => {
        if (e.key === 'Enter' && e.target.value !== start) {
          start = e.target.value;
          onChange(e);
        }
        onKeyDown?.(e);
      };
    }
    // value + native onChange and no onInput: Preact let the user type freely; React would freeze the field.
    // Make it uncontrolled (the value shown is refreshed when the element remounts).
    if ('value' in p && p.onInput === undefined) {
      p.defaultValue = p.value;
      delete p.value;
    }
  }
  if ('value' in p && typeof p.onInput === 'function' && p.onChange === undefined && type !== 'select') {
    // Preact listens to « input »; React needs onChange to consider a controlled field editable.
    p.onChange = p.onInput;
    delete p.onInput;
  }
  return p;
}

function h(type: unknown, props: Props, ...children: ReactNode[]) {
  return createElement(type as string, normalize(type, props), ...children);
}

/** Legacy htm templates rendered with React (transitional). New code uses JSX in .tsx files. */
export const html = htm.bind(h) as (strings: TemplateStringsArray, ...values: unknown[]) => any;
