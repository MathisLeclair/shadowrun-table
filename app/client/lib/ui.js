// Shared UI kit. Every module builds its screens from these so the app looks consistent.
// Usage: import { html, Button, Panel, ... } from '../../lib/ui.js';
import { h } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import htm from 'htm';
import { renderMarkdown } from './markdown.js';
import { t, LANGS } from './i18n.js';

export const html = htm.bind(h);

const cx = (...c) => c.filter(Boolean).join(' ');

/** <Button variant="primary|ghost|danger|accent" small onClick title disabled>Label</Button> */
export function Button({ variant = 'default', small, class: klass, children, ...rest }) {
  return html`<button class=${cx('btn', `btn-${variant}`, small && 'btn-sm', klass)} ...${rest}>${children}</button>`;
}

/** Square icon button: <IconButton icon="✕" title="Fermer" onClick=... /> */
export function IconButton({ icon, class: klass, ...rest }) {
  return html`<button class=${cx('icon-btn', klass)} ...${rest}>${icon}</button>`;
}

/** Bordered box with optional title bar and actions on the right. */
export function Panel({ title, actions, children, class: klass, pad = true, ...rest }) {
  return html`<section class=${cx('panel', klass)} ...${rest}>
    ${(title || actions) && html`<header class="panel-head"><h3>${title}</h3><div class="panel-actions">${actions}</div></header>`}
    <div class=${pad ? 'panel-body' : 'panel-body nopad'}>${children}</div>
  </section>`;
}

const modalStack = [];

/** Centered overlay dialog. Closes on Escape and backdrop click. */
export function Modal({ title, onClose, width = 720, children, actions }) {
  const self = useRef({});
  self.current.onClose = onClose;
  useEffect(() => {
    // Only the top-most open modal reacts to Escape.
    const me = self.current;
    modalStack.push(me);
    const k = (e) => {
      if (e.key === 'Escape' && modalStack[modalStack.length - 1] === me) {
        e.stopPropagation();
        me.onClose?.();
      }
    };
    addEventListener('keydown', k);
    return () => {
      removeEventListener('keydown', k);
      const i = modalStack.indexOf(me);
      if (i >= 0) modalStack.splice(i, 1);
    };
  }, []);
  return html`<div class="modal-backdrop" onMouseDown=${(e) => e.target === e.currentTarget && onClose?.()}>
    <div class="modal" style=${{ width: `min(${width}px, calc(100vw - 24px))` }}>
      <header class="modal-head">
        <h2>${title}</h2>
        <div class="row gap-s">${actions}<${IconButton} icon="✕" title=${t('Fermer')} onClick=${onClose} /></div>
      </header>
      <div class="modal-body">${children}</div>
    </div>
  </div>`;
}

/** Horizontal tabs. tabs: [{ id, label, badge? }] */
export function Tabs({ tabs, value, onChange, class: klass }) {
  return html`<nav class=${cx('tabs', klass)}>
    ${tabs.map(
      (t) => html`<button type="button" class=${cx('tab', t.id === value && 'active')} onClick=${() => onChange(t.id)}>
        ${t.label}${t.badge ? html`<span class="tab-badge">${t.badge}</span>` : null}
      </button>`
    )}
  </nav>`;
}

/** Label + control wrapper. */
export function Field({ label, hint, children, class: klass }) {
  // A div (not <label>): a label would forward clicks on its text to the first button inside (NumberInput's "−").
  return html`<div class=${cx('field', klass)}><span class="field-label">${label}</span>${children}${hint && html`<span class="field-hint">${hint}</span>`}</div>`;
}

/**
 * Text input that only commits on blur/Enter (avoids a server round-trip per keystroke).
 * Pass live=true to call onChange on every keystroke instead.
 */
export function TextInput({ value, onChange, multiline, live, placeholder, rows = 4, class: klass, ...rest }) {
  const [v, setV] = useState(value ?? '');
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setV(value ?? '');
  }, [value]);
  const commit = () => {
    focused.current = false;
    if ((value ?? '') !== v) onChange?.(v);
  };
  const props = {
    class: cx('input', klass),
    value: v,
    placeholder,
    onFocus: () => (focused.current = true),
    onInput: (e) => {
      setV(e.target.value);
      if (live) onChange?.(e.target.value);
    },
    onBlur: live ? () => (focused.current = false) : commit,
    onKeyDown: (e) => {
      if (!multiline && e.key === 'Enter') e.target.blur();
    },
    ...rest,
  };
  return multiline ? html`<textarea rows=${rows} ...${props}></textarea>` : html`<input type="text" ...${props} />`;
}

/** Numeric input with −/+ steppers. Commits on blur/Enter/step. */
export function NumberInput({ value, onChange, min = -Infinity, max = Infinity, step = 1, small, class: klass, disabled }) {
  const [v, setV] = useState(String(value ?? 0));
  // Latest committed value: lets quick repeated clicks step from the value just committed, before the
  // parent has re-rendered with it (otherwise two fast "+" clicks both send value+1).
  const cur = useRef(value);
  useEffect(() => {
    cur.current = value;
    setV(String(value ?? 0));
  }, [value]);
  const dec = (String(step).split('.')[1] || '').length;
  const commit = (n) => {
    let num = Math.max(min, Math.min(max, Number(n)));
    if (Number.isNaN(num)) return setV(String(value ?? 0));
    if (dec) num = Number(num.toFixed(dec)); // no float noise with step 0.05 (5.35 + 0.05 = 5.4, not 5.3999…)
    setV(String(num));
    if (num !== cur.current) {
      cur.current = num;
      onChange?.(num);
    }
  };
  const stepBy = (d) => commit((Number(cur.current) || 0) + d);
  // The input comes FIRST in the DOM (the − button is moved before it with CSS order): if a caller wraps
  // this in a <label>, clicks on the label text then focus the input instead of pressing "−".
  return html`<span class=${cx('num', small && 'num-sm', klass)}>
    <input type="number" disabled=${disabled} value=${v} min=${min} max=${max} step=${step}
      onInput=${(e) => setV(e.target.value)} onBlur=${(e) => commit(e.target.value)}
      onKeyDown=${(e) => e.key === 'Enter' && e.target.blur()} />
    <button type="button" class="num-dec" disabled=${disabled} onClick=${() => stepBy(-step)}>−</button>
    <button type="button" class="num-inc" disabled=${disabled} onClick=${() => stepBy(step)}>+</button>
  </span>`;
}

/** options: string[] or [{ value, label }] */
export function Select({ value, onChange, options, class: klass, ...rest }) {
  const opts = options.map((o) => (typeof o === 'object' ? o : { value: o, label: o }));
  return html`<select class=${cx('input', klass)} value=${value} onChange=${(e) => onChange(e.target.value)} ...${rest}>
    ${opts.map((o) => html`<option value=${o.value} selected=${o.value === value}>${o.label}</option>`)}
  </select>`;
}

export function Toggle({ value, onChange, label, title }) {
  return html`<label class="toggle" title=${title}>
    <input type="checkbox" checked=${!!value} onChange=${(e) => onChange(e.target.checked)} />
    <span class="toggle-track"><span class="toggle-thumb"></span></span>
    ${label && html`<span>${label}</span>`}
  </label>`;
}

/** Small colored pill. color: 'cyan' | 'magenta' | 'amber' | 'green' | 'red' | 'dim' */
export function Badge({ color = 'dim', children, title }) {
  return html`<span class=${`badge badge-${color}`} title=${title}>${children}</span>`;
}

export function Empty({ children }) {
  return html`<div class="empty">${children}</div>`;
}

export function SearchBox({ value, onChange, placeholder }) {
  return html`<input class="input search" type="search" value=${value} placeholder=${placeholder ?? t('Rechercher…')} onInput=${(e) => onChange(e.target.value)} />`;
}

const LANG_NAMES = { fr: 'Français', en: 'English' }; // endonyms: never translated
/** FR | EN switch. value: 'fr'|'en'; onChange(lang). */
export function LangSwitch({ value, onChange, class: klass }) {
  return html`<span class=${cx('lang-switch', klass)} role="group" aria-label=${t('Langue')}>
    ${LANGS.map(
      (l) => html`<button type="button" class=${cx('lang-opt', l === value && 'active')} lang=${l} title=${LANG_NAMES[l]}
        aria-pressed=${l === value ? 'true' : 'false'} onClick=${() => l !== value && onChange(l)}>${l.toUpperCase()}</button>`
    )}
  </span>`;
}

/** Renders markdown (headings, lists, bold/italic, links, tables, quotes, code). */
export function Markdown({ text, class: klass }) {
  return html`<div class=${cx('md', klass)} dangerouslySetInnerHTML=${{ __html: renderMarkdown(text || '') }}></div>`;
}

/** Labelled stat box: <Stat label="Init" value="10 + 2D6" /> */
export function Stat({ label, value, title, accent }) {
  return html`<div class=${cx('stat', accent && `stat-${accent}`)} title=${title}><span class="stat-value">${value}</span><span class="stat-label">${label}</span></div>`;
}

/** Promise-based confirm (native dialog, keeps things simple). Pass an already translated message: confirmAction(t('…')). */
export function confirmAction(message) {
  return Promise.resolve(window.confirm(message));
}

export function promptText(message, initial = '') {
  return Promise.resolve(window.prompt(message, initial));
}

const loadedCss = new Set();
/** Load a module stylesheet once, e.g. loadCss('/modules/map/map.css'). Call at module top level. */
export function loadCss(href) {
  if (loadedCss.has(href)) return;
  loadedCss.add(href);
  const l = document.createElement('link');
  l.rel = 'stylesheet';
  l.href = href;
  document.head.appendChild(l);
}
