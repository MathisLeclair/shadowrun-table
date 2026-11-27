// Searchable catalog list with an « Ajouter » button per row (spells, powers, qualities).
import { useMemo, useState, type ReactNode } from 'react';
import { SearchBox, Select, Empty, Button } from '../../lib/ui.tsx';
import { t, tn, compare } from '../../lib/i18n.ts';
import { fold } from './common.tsx';
import type { LooseCatalogItem } from './types.ts';
import { ItemRef } from '../books/BookRef.tsx';

const PAGE = 60;

interface PickerProps {
  items: LooseCatalogItem[];
  name: (item: LooseCatalogItem) => string;
  meta: (item: LooseCatalogItem) => ReactNode;
  categories?: Array<{ value: string; label: string }>;
  category?: (item: LooseCatalogItem) => string;
  extraFilter?: (item: LooseCatalogItem) => boolean;
  selected?: Set<string>;
  onAdd: (item: LooseCatalogItem) => void;
  disabled?: (item: LooseCatalogItem) => string | null;
  placeholder?: string;
  toolbar?: ReactNode;
  empty?: ReactNode;
}

/**
 * props: { items, name(item), meta(item) → vnode|string, categories?: [{ value, label }], category(item) → value,
 *          extraFilter?(item) → bool, selected: Set<id>, onAdd(item), disabled?(item) → string|null (reason),
 *          placeholder, toolbar? (vnode), empty }
 */
export default function Picker({ items, name, meta, categories, category, extraFilter, selected, onAdd, disabled, placeholder, toolbar, empty }: PickerProps) {
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
  return (
    <div className="cg-picker">
      <div className="row wrap gap-s">
        <SearchBox
          value={q}
          onChange={(v) => {
            setQ(v);
            setPage(1);
          }}
          placeholder={placeholder || t('Rechercher…')}
        />
        {categories && (
          <Select
            className="cg-picker-cat"
            value={cat}
            onChange={(v) => {
              setCat(v);
              setPage(1);
            }}
            options={[{ value: '', label: t('Toutes catégories') }, ...categories]}
          />
        )}
        {toolbar}
        <span className="small faint">{tn(list.length, '{n} résultat', '{n} résultats')}</span>
      </div>
      <div className="cg-picker-list">
        {shown.map((it) => {
          const isSel = selected?.has(it.id);
          const why = disabled ? disabled(it) : null;
          return (
            <div key={it.id} className={'cg-picker-row' + (isSel ? ' sel' : '')}>
              <div className="grow">
                <div className="cg-picker-name">
                  {name(it)}
                  {it.nameFr && it.nameFr !== it.name && name(it) !== it.name ? (
                    <>
                      {' '}
                      <span className="faint small">{it.name}</span>
                    </>
                  ) : (
                    ''
                  )}{' '}
                  <ItemRef item={it} />
                </div>
                <div className="small muted">{meta(it)}</div>
              </div>
              {isSel ? (
                <span className="small green">✓ {t('choisi')}</span>
              ) : (
                <Button small disabled={!!why} title={why || ''} onClick={() => onAdd(it)}>
                  + {t('Ajouter')}
                </Button>
              )}
            </div>
          );
        })}
        {!list.length && <Empty>{empty || t('Rien ne correspond.')}</Empty>}
        {shown.length < list.length && (
          <div className="center">
            <Button small variant="ghost" onClick={() => setPage(page + 1)}>
              {t('Afficher plus ({n})', { n: list.length - shown.length })}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
