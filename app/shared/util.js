// Small helpers shared by server and client (pure ES module, no Node or DOM APIs).

let counter = 0;
/** Short unique id, e.g. "tok_lq3k9x2a". */
export function uid(prefix = 'id') {
  counter = (counter + 1) % 1296;
  const rand = Math.floor(Math.random() * 46656).toString(36).padStart(3, '0');
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36).padStart(2, '0')}${rand}`;
}

export function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

export function deepClone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

/** Format nuyen: 12500 -> "12 500¥". */
export function nuyen(n) {
  const v = Math.round(Number(n) || 0);
  return v.toLocaleString('fr-FR').replace(/ | /g, ' ') + '¥';
}

export function slug(s) {
  return String(s)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}
