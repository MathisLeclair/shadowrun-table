// Searchable catalog list with an « Ajouter » button per row (spells, powers, qualities).
import { useMemo, useState } from 'preact/hooks';
import { html, SearchBox, Select, Empty, Button } from '../../lib/ui.js';
import { t, tn, compare } from '../../lib/i18n.js';
import { fold } from './common.js';

const PAGE = 60;

/**
 * props: { items, name(item), meta(item) → vnode|string, categories?: [{ value, label }], category(item) → value,
 *          extraFilter?(item) → bool, selected: Set<id>, onAdd(item), disabled?(item) → string|null (reason),
 *          placeholder, toolbar? (vnode), empty }
 */
export default function Picker({ items, name, meta, categories, category, extraFilter, selected, onAdd, disabled, placeholder, toolbar, empty }) {
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('');
  const [page, setPage] = useState(1);
  const list = useMemo(() => {
    const needle = fold(q.trim());
    const words = needle ? needle.split(/\s+/) : [];
    return items
      .filter((it) => (!cat || category?.(it) === cat) && (!extraFilter || extraFilter(it)))
      .filter((it) => {
        if (!words.length) return true;
        const hay = fold(`${it.name} ${it.nameFr || ''} ${it.category || ''} ${it.categoryFr || ''}`);
        return words.every((w) => hay.includes(w));
      })
      .sort((a, b) => compare(name(a), name(b)));
  }, [items, q, cat, extraFilter]);
  const shown = list.slice(0, PAGE * page);
  return html`<div class="cg-picker">
    <div class="row wrap gap-s">
      <${SearchBox} value=${q} onChange=${(v) => (setQ(v), setPage(1))} placeholder=${placeholder || t('Rechercher…')} />
      ${categories && html`<${Select} class="cg-picker-cat" value=${cat} onChange=${(v) => (setCat(v), setPage(1))} options=${[{ value: '', label: t('Toutes catégories') }, ...categories]} />`}
      ${toolbar}
      <span class="small faint">${tn(list.length, '{n} résultat', '{n} résultats')}</span>
    </div>
    <div class="cg-picker-list">
      ${shown.map((it) => {
        const isSel = selected?.has(it.id);
        const why = disabled ? disabled(it) : null;
        return html`<div key=${it.id} class=${'cg-picker-row' + (isSel ? ' sel' : '')}>
          <div class="grow">
            <div class="cg-picker-name">${name(it)}${it.nameFr && it.nameFr !== it.name && name(it) !== it.name ? html` <span class="faint small">${it.name}</span>` : ''}</div>
            <div class="small muted">${meta(it)}</div>
          </div>
          ${isSel
            ? html`<span class="small green">✓ ${t('choisi')}</span>`
            : html`<${Button} small disabled=${!!why} title=${why || ''} onClick=${() => onAdd(it)}>+ ${t('Ajouter')}</${Button}>`}
        </div>`;
      })}
      ${!list.length && html`<${Empty}>${empty || t('Rien ne correspond.')}</${Empty}>`}
      ${shown.length < list.length && html`<div class="center"><${Button} small variant="ghost" onClick=${() => setPage(page + 1)}>${t('Afficher plus ({n})', { n: list.length - shown.length })}</${Button}></div>`}
    </div>
  </div>`;
}
