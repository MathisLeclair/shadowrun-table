// Shared UI kit. Every module builds its screens from these so the app looks consistent.
// Usage: import { Button, Panel, ... } from '../../lib/ui.tsx';
import { useEffect, useRef, useState, type ReactNode, type ButtonHTMLAttributes, type HTMLAttributes, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { renderMarkdown } from './markdown.ts';
import { t, LANGS } from './i18n.ts';

/** Joins class names, skipping falsy values. */
export const cx = (...c: unknown[]): string => c.filter(Boolean).join(' ');

export type ButtonVariant = 'default' | 'primary' | 'ghost' | 'danger' | 'accent';

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; small?: boolean };
/** <Button variant="primary|ghost|danger|accent" small onClick title disabled>Label</Button> */
export function Button({ variant = 'default', small, className, children, ...rest }: ButtonProps) {
  return (
    <button className={cx('btn', `btn-${variant}`, small && 'btn-sm', className)} {...rest}>
      {children}
    </button>
  );
}

type IconButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { icon: ReactNode };
/** Square icon button: <IconButton icon="✕" title="Fermer" onClick=... /> */
export function IconButton({ icon, className, ...rest }: IconButtonProps) {
  return (
    <button className={cx('icon-btn', className)} {...rest}>
      {icon}
    </button>
  );
}

type PanelProps = Omit<HTMLAttributes<HTMLElement>, 'title'> & { title?: ReactNode; actions?: ReactNode; pad?: boolean };
/** Bordered box with optional title bar and actions on the right. */
export function Panel({ title, actions, children, className, pad = true, ...rest }: PanelProps) {
  return (
    <section className={cx('panel', className)} {...rest}>
      {(title || actions) && (
        <header className="panel-head">
          <h3>{title}</h3>
          <div className="panel-actions">{actions}</div>
        </header>
      )}
      <div className={pad ? 'panel-body' : 'panel-body nopad'}>{children}</div>
    </section>
  );
}

const modalStack: Array<{ onClose?: () => void }> = [];

interface ModalProps {
  title?: ReactNode;
  onClose?: () => void;
  width?: number;
  children?: ReactNode;
  actions?: ReactNode;
}
/** Centered overlay dialog. Closes on Escape and backdrop click. */
export function Modal({ title, onClose, width = 720, children, actions }: ModalProps) {
  const self = useRef<{ onClose?: () => void }>({});
  self.current.onClose = onClose;
  useEffect(() => {
    // Only the top-most open modal reacts to Escape.
    const me = self.current;
    modalStack.push(me);
    const k = (e: KeyboardEvent) => {
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
  // Rendered on <body>: a modal opened inside a workspace pane (isolated stacking context) must still cover the dock.
  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className="modal" style={{ width: `min(${width}px, calc(100vw - 24px))` }}>
        <header className="modal-head">
          <h2>{title}</h2>
          <div className="row gap-s">
            {actions}
            <IconButton icon="✕" title={t('Close')} onClick={onClose} />
          </div>
        </header>
        <div className="modal-body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

export interface TabDef<Id extends string = string> {
  id: Id;
  label: ReactNode;
  badge?: ReactNode;
}
interface TabsProps<Id extends string> {
  tabs: TabDef<Id>[];
  value: Id;
  onChange: (id: Id) => void;
  className?: string;
}
/** Horizontal tabs. tabs: [{ id, label, badge? }] */
export function Tabs<Id extends string>(props: TabsProps<Id>) {
  const { tabs, value, onChange } = props;
  return (
    <nav className={cx('tabs', props.className)}>
      {tabs.map((tb) => (
        <button key={tb.id} type="button" className={cx('tab', tb.id === value && 'active')} onClick={() => onChange(tb.id)}>
          {tb.label}
          {tb.badge ? <span className="tab-badge">{tb.badge}</span> : null}
        </button>
      ))}
    </nav>
  );
}

interface FieldProps {
  label?: ReactNode;
  hint?: ReactNode;
  children?: ReactNode;
  className?: string;
}
/** Label + control wrapper. */
export function Field(props: FieldProps) {
  const { label, hint, children } = props;
  // A div (not <label>): a label would forward clicks on its text to the first button inside (NumberInput's "−").
  return (
    <div className={cx('field', props.className)}>
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </div>
  );
}

interface TextInputProps {
  value?: string | null;
  onChange?: (value: string) => void;
  multiline?: boolean;
  /** Call onChange on every keystroke instead of on blur/Enter. */
  live?: boolean;
  placeholder?: string;
  rows?: number;
  className?: string;
  [attr: string]: unknown;
}
/**
 * Text input that only commits on blur/Enter (avoids a server round-trip per keystroke).
 * Pass live=true to call onChange on every keystroke instead.
 */
export function TextInput({ value, onChange, multiline, live, placeholder, rows = 4, className, ...rest }: TextInputProps) {
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
    className: cx('input', className),
    value: v,
    placeholder,
    onFocus: () => (focused.current = true),
    onChange: (e: { target: { value: string } }) => {
      setV(e.target.value);
      if (live) onChange?.(e.target.value);
    },
    onBlur: live ? () => (focused.current = false) : commit,
    onKeyDown: (e: { key: string; target: EventTarget }) => {
      if (!multiline && e.key === 'Enter') (e.target as HTMLElement).blur();
    },
    ...rest,
  };
  return multiline ? <textarea rows={rows} {...props} /> : <input type="text" {...props} />;
}

interface NumberInputProps {
  value?: number | string | null;
  onChange?: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  small?: boolean;
  className?: string;
  disabled?: boolean;
}
/** Numeric input with −/+ steppers. Commits on blur/Enter/step. */
export function NumberInput({ value, onChange, min = -Infinity, max = Infinity, step = 1, small, className, disabled }: NumberInputProps) {
  const [v, setV] = useState(String(value ?? 0));
  // Latest committed value: lets quick repeated clicks step from the value just committed, before the
  // parent has re-rendered with it (otherwise two fast "+" clicks both send value+1).
  const cur = useRef(value);
  useEffect(() => {
    cur.current = value;
    setV(String(value ?? 0));
  }, [value]);
  const dec = (String(step).split('.')[1] || '').length;
  const commit = (n: number | string) => {
    let num = Math.max(min, Math.min(max, Number(n)));
    if (Number.isNaN(num)) return setV(String(value ?? 0));
    if (dec) num = Number(num.toFixed(dec)); // no float noise with step 0.05 (5.35 + 0.05 = 5.4, not 5.3999…)
    setV(String(num));
    if (num !== cur.current) {
      cur.current = num;
      onChange?.(num);
    }
  };
  const stepBy = (d: number) => commit((Number(cur.current) || 0) + d);
  // The input comes FIRST in the DOM (the − button is moved before it with CSS order): if a caller wraps
  // this in a <label>, clicks on the label text then focus the input instead of pressing "−".
  return (
    <span className={cx('num', small && 'num-sm', className)}>
      <input
        type="number"
        disabled={disabled}
        value={v}
        min={min}
        max={max}
        step={step}
        onChange={(e) => setV(e.target.value)}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      />
      <button type="button" className="num-dec" disabled={disabled} onClick={() => stepBy(-step)}>
        −
      </button>
      <button type="button" className="num-inc" disabled={disabled} onClick={() => stepBy(step)}>
        +
      </button>
    </span>
  );
}

export type SelectOption<V extends string = string> = V | { value: V; label: ReactNode; disabled?: boolean };
interface SelectProps<V extends string> {
  value: V | null | undefined;
  onChange: (value: V) => void;
  options: SelectOption<V>[];
  className?: string;
  [attr: string]: unknown;
}
/** options: string[] or [{ value, label }] */
export function Select<V extends string>({ value, onChange, options, className, ...rest }: SelectProps<V>) {
  const opts = options.map((o) => (typeof o === 'object' ? o : { value: o, label: o }));
  return (
    <select className={cx('input', className)} value={value ?? ''} onChange={(e) => onChange(e.target.value as V)} {...rest}>
      {opts.map((o) => (
        <option key={o.value} value={o.value} disabled={'disabled' in o ? o.disabled : undefined}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

interface ToggleProps {
  value: boolean | null | undefined;
  onChange: (value: boolean) => void;
  label?: ReactNode;
  title?: string;
}
export function Toggle({ value, onChange, label, title }: ToggleProps) {
  return (
    <label className="toggle" title={title}>
      <input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} />
      <span className="toggle-track">
        <span className="toggle-thumb"></span>
      </span>
      {label && <span>{label}</span>}
    </label>
  );
}

export type BadgeColor = 'cyan' | 'magenta' | 'amber' | 'green' | 'red' | 'dim' | 'blue' | 'violet';
/** Small colored pill. */
export function Badge({ color = 'dim', children, title }: { color?: BadgeColor | string; children?: ReactNode; title?: string }) {
  return (
    <span className={`badge badge-${color}`} title={title}>
      {children}
    </span>
  );
}

export function Empty({ children }: { children?: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function SearchBox({ value, onChange, placeholder }: { value: string; onChange: (value: string) => void; placeholder?: string }) {
  return <input className="input search" type="search" value={value} placeholder={placeholder ?? t('Search…')} onChange={(e) => onChange(e.target.value)} />;
}

const LANG_NAMES: Record<string, string> = { fr: 'Français', en: 'English' }; // endonyms: never translated
/** FR | EN switch. value: 'fr'|'en'; onChange(lang). */
export function LangSwitch(props: { value: string; onChange: (lang: string) => void; className?: string }) {
  const { value, onChange } = props;
  return (
    <span className={cx('lang-switch', props.className)} role="group" aria-label={t('Language')}>
      {(LANGS as string[]).map((l) => (
        <button
          key={l}
          type="button"
          className={cx('lang-opt', l === value && 'active')}
          lang={l}
          title={LANG_NAMES[l]}
          aria-pressed={l === value ? 'true' : 'false'}
          onClick={() => l !== value && onChange(l)}
        >
          {l.toUpperCase()}
        </button>
      ))}
    </span>
  );
}

/** Renders markdown (headings, lists, bold/italic, links, tables, quotes, code). */
export function Markdown(props: { text?: string | null; className?: string; style?: CSSProperties }) {
  return <div className={cx('md', props.className)} style={props.style} dangerouslySetInnerHTML={{ __html: renderMarkdown(props.text || '') }} />;
}

/** Labelled stat box: <Stat label="Init" value="10 + 2D6" /> */
export function Stat({ label, value, title, accent }: { label: ReactNode; value: ReactNode; title?: string; accent?: string }) {
  return (
    <div className={cx('stat', accent && `stat-${accent}`)} title={title}>
      <span className="stat-value">{value}</span>
      <span className="stat-label">{label}</span>
    </div>
  );
}

/** Promise-based confirm (native dialog, keeps things simple). Pass an already translated message: confirmAction(t('…')). */
export function confirmAction(message: string): Promise<boolean> {
  return Promise.resolve(window.confirm(message));
}

export function promptText(message: string, initial = ''): Promise<string | null> {
  return Promise.resolve(window.prompt(message, initial));
}
