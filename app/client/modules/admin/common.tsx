// Small helpers shared by the admin page and the Foundry upload panel.
import { t, getLang } from '../../lib/i18n.js';

/** 1234567 → '1,2 Mo' (fr) / '1.2 MB' (en). */
export function fmtBytes(n: unknown): string {
  const v = Number(n) || 0;
  const en = getLang() === 'en';
  const dec = (x: number, d: number) => (en ? x.toFixed(d) : x.toFixed(d).replace('.', ','));
  if (v >= 1e9) return `${dec(v / 1e9, 2)} ${en ? 'GB' : 'Go'}`;
  if (v >= 1e6) return `${dec(v / 1e6, 1)} ${en ? 'MB' : 'Mo'}`;
  if (v >= 1e3) return `${Math.round(v / 1e3)} ${en ? 'kB' : 'ko'}`;
  return `${v} ${en ? 'B' : 'o'}`;
}

/** Upload progress value: 0..1 while sending, 'server' while the server processes it. */
export type UploadProgress = number | 'server';

/** Upload progress: value 0..1 while sending, 'server' while the server processes it. */
export function Progress({ value, serverLabel }: { value: UploadProgress; serverLabel: string }) {
  const server = value === 'server';
  const pct = server ? 100 : Math.round((Number(value) || 0) * 100);
  return (
    <div className="col gap-s">
      <div className={'admin-progress' + (server ? ' indeterminate' : '')}>
        <div style={{ width: `${pct}%` }}></div>
      </div>
      <span className="muted small">{server ? serverLabel : t('Envoi… {pct} %', { pct })}</span>
    </div>
  );
}
