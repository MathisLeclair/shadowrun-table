// Nested item lists of the sheet: weapon accessories, armor / vehicle mods, lifestyle options, martial art techniques.
// Read-only chips for everyone, GM editor (actor/addSubItem, updateSubItem, removeSubItem) in edit mode.
import { useEffect, useMemo, useState } from 'react';
import { Button, NumberInput, TextInput, Select, Toggle, IconButton, confirmAction } from '../../lib/ui.tsx';
import { send, loadCatalog } from '../../lib/net.ts';
import { toast } from '../../lib/ui-store.ts';
import { t, tk, itemName, fmtNuyen, getLang } from '../../lib/i18n.js';
import { costBreakdown } from '/shared/lifestyle.js';
import { Overlay } from './common.tsx';
import { CatalogPicker } from './editors.tsx';
import { SUB_LISTS, SUB_LABELS, LIFESTYLE_BASES, VEHICLE_MOD_CATEGORIES, weaponMods, armorMods, vehicleSlots, vehicleSlotsByCategory } from './sheet-data.js';
import { fmtNum, signed } from './common.tsx';
import { quote, upgradeFields, fold } from '../shop/rules.js';
import { ItemRef, BookRef } from './ext.ts';
import type { ReactNode } from 'react';
import type { Actor, Armor, CatalogItem, Lifestyle, Vehicle, Weapon } from '../../../shared/types.ts';
import type { AnyItem, CatalogConversion, FieldDef } from './types.ts';

const MOUNT_LABELS: Record<string, string> = { Top: tk('Dessus'), Under: tk('Dessous'), Barrel: tk('Canon'), Stock: tk('Crosse'), Side: tk('Côté'), Internal: tk('Interne'), '': tk('Sans montage') };
export const mountLabel = (m: string | null | undefined): string => t(MOUNT_LABELS[m || ''] || m);
export const lifestyleBaseLabel = (b: string | null | undefined): string => {
  const base = (LIFESTYLE_BASES as Record<string, { label: string }>)[b ?? ''];
  return base ? t(base.label) : b || '—';
};

/**
 * Values of an upgrade picked from the catalog that depend on the item it goes on (rules.js upgradeFields, like the shop):
 * capacity « Capacity × 0.5 » (YNT Softweave), slots « Body ≥ 4 » (Gecko Tips), price « Weapon Cost » (Smartgun System,
 * Internal)… The parent's catalog entry is loaded for its capacity / stats / price. Returns the sub-item to add.
 */
async function withParentValues(file: string, item: AnyItem, entry: CatalogItem | null | undefined, list: string, parent: AnyItem): Promise<AnyItem> {
  if (!['accessories', 'armormods', 'vehiclemods'].includes(file) || !entry) return item;
  let parentCat: CatalogItem | null = null;
  try {
    const data = await loadCatalog<CatalogItem>(list);
    if (Array.isArray(data)) parentCat = data.find((e) => parent.catalogId && e.id === parent.catalogId) || data.find((e) => fold(e.name) === fold(parent.name) || (e.nameFr && fold(e.nameFr) === fold(parent.name))) || null;
  } catch {}
  let parentValue: number | null = null;
  if (parent.paid !== undefined && parent.paid !== null && parent.paid !== '' && Number.isFinite(Number(parent.paid))) parentValue = Number(parent.paid);
  else if (parentCat) {
    try {
      parentValue = quote(parentCat, { rating: parent.rating }).unitCost;
    } catch {}
  }
  const fields = upgradeFields as unknown as (file: string, entry: CatalogItem, parent: AnyItem, opts: { rating?: number; parentCat: CatalogItem | null; parentValue: number | null }) => AnyItem;
  return { ...item, ...fields(file, entry, parent, { rating: item.rating, parentCat, parentValue }) };
}

/** Catalogs that feed each nested list (GM « + Depuis le catalogue »). Techniques come from the martial art's own entry. */
const SUB_CATALOGS: Record<string, string> = { 'weapons.accessories': 'accessories', 'armor.mods': 'armormods', 'vehicles.mods': 'vehiclemods', 'lifestyles.qualities': 'lifestylequalities' };

/** Field schemas of the nested editors. `fx` = stored inside item.effects. Labels are French keys. */
const mountOptions = () => Object.keys(MOUNT_LABELS).map((m) => ({ value: m, label: mountLabel(m) }));
const SUB_FIELDS: Record<string, FieldDef[]> = {
  'weapons.accessories': [
    { k: 'name', label: tk('Nom'), w: 170 }, { k: 'mount', label: tk('Montage'), type: 'select', options: mountOptions }, { k: 'rating', label: tk('Indice'), type: 'num' },
    { k: 'accuracy', fx: true, label: tk('Préc.'), type: 'num' }, { k: 'rc', fx: true, label: tk('RC'), type: 'num' }, { k: 'smartgun', fx: true, label: tk('Smartgun'), type: 'bool' },
    { k: 'included', label: tk('Intégré'), type: 'bool' }, { k: 'cost', label: tk('Coût (¥)'), type: 'num', step: 25 }, { k: 'notes', label: tk('Notes'), w: 140 },
  ],
  'armor.mods': [
    { k: 'name', label: tk('Nom'), w: 170 }, { k: 'rating', label: tk('Indice'), type: 'num' }, { k: 'capacity', label: tk('Capacité'), type: 'num' },
    { k: 'armor', fx: true, label: tk('Armure +'), type: 'num' }, { k: 'included', label: tk('Intégré'), type: 'bool' }, { k: 'cost', label: tk('Coût (¥)'), type: 'num', step: 50 }, { k: 'notes', label: tk('Notes'), w: 140 },
  ],
  'vehicles.mods': [
    { k: 'name', label: tk('Nom'), w: 170 }, { k: 'category', label: tk('Catégorie'), w: 90 }, { k: 'rating', label: tk('Indice'), type: 'num' }, { k: 'slots', label: tk('Emplacements'), type: 'num' },
    { k: 'included', label: tk('Intégré'), type: 'bool' }, { k: 'cost', label: tk('Coût (¥)'), type: 'num', step: 100 }, { k: 'notes', label: tk('Notes'), w: 140 },
  ],
  'lifestyles.qualities': [
    { k: 'name', label: tk('Nom'), w: 190 }, { k: 'category', label: tk('Catégorie'), w: 110 }, { k: 'cost', label: tk('¥ / mois'), type: 'num', step: 25 },
    { k: 'multiplier', label: tk('% du loyer'), type: 'num', step: 5 }, { k: 'baseOnly', label: tk('% du coût de base seul'), type: 'bool' }, { k: 'lp', label: tk('PS'), type: 'num' }, { k: 'notes', label: tk('Notes'), w: 140 },
  ],
  'martialArts.techniques': [{ k: 'name', label: tk('Technique'), w: 220 }, { k: 'notes', label: tk('Notes'), w: 260 }],
};
const BLANK_SUB: Record<string, AnyItem> = {
  accessories: { name: tk('Nouvel accessoire'), mount: 'Top', cost: 0, effects: {} },
  mods: { name: tk('Nouvelle modification'), capacity: 0, slots: 0, cost: 0 },
  qualities: { name: tk('Nouvelle option'), category: 'Positive', cost: 0, multiplier: 0 },
  techniques: { name: tk('Nouvelle technique') },
};

/** Short effect text of a nested item ("Préc. +1 · RC +2 · smartgun", "+20 %", "+250 ¥"…). */
export function subEffect(sub: string, x: AnyItem): string {
  const e = x.effects || {};
  const bits: string[] = [];
  if (sub === 'accessories') {
    if (e.accuracy) bits.push(t('Préc. {v}', { v: signed(e.accuracy) }));
    if (e.rc) bits.push(t('RC {v}', { v: signed(e.rc) }));
    if (e.dicePool) bits.push(t('{v} dés', { v: signed(e.dicePool) }));
    if (e.smartgun) bits.push(t('smartgun'));
  } else if (sub === 'mods') {
    if (e.armor) bits.push(t('Armure {v}', { v: signed(e.armor) }));
    if (x.capacity) bits.push(`[${fmtNum(x.capacity)}]`);
    if (x.slots) bits.push(tn2(x.slots));
  } else if (sub === 'qualities') {
    if (x.multiplier) bits.push(`${signed(x.multiplier)} %`);
    if (x.cost) bits.push(`${x.cost > 0 ? '+' : '−'}${fmtNuyen(Math.abs(x.cost))}`);
  }
  return bits.join(' · ');
}
const tn2 = (n: number): string => t('{n} empl.', { n: fmtNum(n) });

/** Read-only chips of a nested list. */
export function SubChips({ sub, items, empty }: { sub: string; items: AnyItem[] | null | undefined; empty?: ReactNode }) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return empty ? <span className="faint small">{empty}</span> : null;
  return <span className="sh-subchips">
    {list.map((x) => {
    const fx = subEffect(sub, x);
    const title = [x.rating ? t('Indice {n}', { n: x.rating }) : '', x.mount !== undefined && sub === 'accessories' ? mountLabel(x.mount) : '', x.included ? t('intégré') : '', x.notes || ''].filter(Boolean).join(' · ');
    return <span className={'sh-subchip' + (x.included ? ' incl' : '') + (x.equipped === false ? ' off' : '')} key={x.id} title={title}>
      {itemName(x)}{x.rating ? ` ${x.rating}` : ''}{fx ? <>{' '}<i>{fx}</i></> : null}
      <ItemRef item={x} />
    </span>;
  })}
  </span>;
}

function SubField({ f, x, onChange }: { f: FieldDef; x: AnyItem; onChange: (v: any) => void }) { // v: the field's type
  const value = f.fx ? x.effects?.[f.k] : x[f.k];
  if (f.type === 'num') return <NumberInput small value={Number(value) || 0} step={f.step || 1} min={-999999} max={999999} onChange={onChange} />;
  if (f.type === 'bool') return <Toggle value={!!value} onChange={onChange} />;
  if (f.type === 'select') return <Select value={value || ''} options={typeof f.options === 'function' ? f.options() : f.options || []} onChange={onChange} />;
  return <TextInput value={value ?? ''} onChange={onChange} style={{ minWidth: (f.w || 90) + 'px' }} />;
}

/** Technique picker: the techniques listed by the martial art's catalog entry. */
/** A technique listed by a martial art catalog entry. */
interface CatalogTechnique {
  id?: string;
  name: string;
  nameFr?: string;
  source?: string;
  page?: number;
}
function TechniquePicker({ actor, art, onClose }: { actor: Actor; art: AnyItem; onClose: () => void }) {
  const [data, setData] = useState<CatalogItem[] | null>(null);
  useEffect(() => {
    let alive = true;
    loadCatalog<CatalogItem>('martialarts').then((d) => alive && setData(Array.isArray(d) ? d : [])).catch(() => alive && setData([]));
    return () => {
      alive = false;
    };
  }, []);
  const entry = useMemo(() => (data || []).find((e) => e.id === art.catalogId) || (data || []).find((e) => e.name === art.name || e.nameFr === art.name), [data, art]);
  const techniques: CatalogTechnique[] = entry ? (entry.stats as { techniques?: CatalogTechnique[] } | undefined)?.techniques || (entry as { techniques?: CatalogTechnique[] }).techniques || [] : [];
  const have = new Set((art.techniques || []).map((x: AnyItem) => x.catalogId || x.name));
  const add = async (tq: CatalogTechnique) => {
    try {
      await send('actor/addSubItem', { actorId: actor.id, list: 'martialArts', itemId: art.id, sub: 'techniques', item: { name: tq.name, ...(tq.nameFr ? { nameFr: tq.nameFr } : {}), ...(tq.id ? { catalogId: tq.id } : {}), ...(tq.source ? { source: tq.source, ...(tq.page ? { page: tq.page } : {}) } : {}) } });
      toast(t('{item} ajouté à {name}', { item: itemName(tq), name: actor.name }), 'success');
    } catch {}
  };
  return <Overlay title={t('Techniques — {art}', { art: art.name })} onClose={onClose} width={520}>
    {data === null
      ? <div className="muted">{t('Chargement du catalogue…')}</div>
      : !techniques.length
        ? <div className="muted small">{t('Aucune technique connue pour cet art martial dans le catalogue — ajoute-la à la main.')}</div>
        : <div className="sh-cat-list">
          {techniques.map((tq) => <div className="sh-cat-row" key={tq.id || tq.name}>
            <div className="grow">
              <b>{itemName(tq)}</b>
              {getLang() === 'fr' && tq.nameFr && tq.name !== tq.nameFr ? <>{' '}<span className="faint small">{tq.name}</span></> : null}{tq.source ? <div className="muted small"><BookRef source={tq.source} page={tq.page} /></div> : null}
            </div>
            <Button small variant="primary" disabled={have.has(tq.id || tq.name)} onClick={() => add(tq)}>{t('Ajouter')}</Button>
          </div>)}
        </div>}
  </Overlay>;
}

/** GM editor of one item's nested list. */
export function SubEditor({ actor, list, item }: { actor: Actor; list: string; item: AnyItem }) {
  const sub: string = (SUB_LISTS as Record<string, string>)[list];
  const key = `${list}.${sub}`;
  const fields = SUB_FIELDS[key] || [];
  const [picker, setPicker] = useState(false);
  const items: AnyItem[] = Array.isArray(item[sub]) ? item[sub] : [];
  const base = { actorId: actor.id, list, itemId: item.id, sub };
  const up = (x: AnyItem, f: FieldDef, v: unknown) => send('actor/updateSubItem', { ...base, subId: x.id, patch: f.fx ? { effects: { ...(x.effects || {}), [f.k]: v } } : { [f.k]: v } }).catch(() => {});
  const remove = async (x: AnyItem) => {
    if (!(await confirmAction(t('Retirer « {name} » ?', { name: itemName(x) })))) return;
    send('actor/removeSubItem', { ...base, subId: x.id }).catch(() => {});
  };
  const addBlank = () => {
    const b = BLANK_SUB[sub];
    send('actor/addSubItem', { ...base, item: { ...b, name: t(b.name) } }).catch(() => {});
  };
  const catalog = SUB_CATALOGS[key];
  return <div className="sh-subeditor">
    <div className="sh-sub-title">{t((SUB_LABELS as Record<string, string>)[sub])} — {item.name}</div>
    {items.length
      ? <table className="sr sh-edit-table">
        <thead><tr>{fields.map((f) => <th key={f.k}>{t(f.label)}</th>)}<th /></tr></thead>
        <tbody>
          {items.map((x) => <tr key={x.id}>
            {fields.map((f) => <td key={f.k}>
              {f.k === 'name' && x.nameFr && getLang() === 'fr' ? <div className="faint small">{x.nameFr}</div> : null}
              <SubField f={f} x={x} onChange={(v) => up(x, f, v)} />
            </td>)}
            <td><IconButton icon="✕" title={t('Retirer')} onClick={() => remove(x)} /></td>
          </tr>)}
        </tbody>
      </table>
      : <div className="muted small">{t('Aucun élément.')}</div>}
    <div className="row wrap">
      <Button small onClick={addBlank}>{t('+ Ajouter (vierge)')}</Button>
      {(catalog || sub === 'techniques') && <Button small variant="primary" onClick={() => setPicker(true)}>{t('+ Depuis le catalogue')}</Button>}
    </div>
    {picker && sub === 'techniques' && <TechniquePicker actor={actor} art={item} onClose={() => setPicker(false)} />}
    {picker && catalog && <CatalogPicker actor={actor} list={list} catalogs={[catalog]} onClose={() => setPicker(false)} onPick={async (conv: CatalogConversion, entry: CatalogItem) => {
        if (!conv?.sub) return;
        try {
          const subItem = await withParentValues(catalog, conv.item, entry, list, item);
          await send('actor/addSubItem', { ...base, item: subItem });
          toast(t('{item} ajouté à {name}', { item: itemName(conv.item), name: item.name }), 'success');
        } catch {}
      }} />}
  </div>;
}

/** Accuracy / RC of a weapon with its accessories: { accuracy (number|null), rc, mods }. */
export function weaponWithMods(actor: Actor, w: Weapon, accuracyLimit: (actor: Actor, accuracy: Weapon['accuracy']) => number | null) {
  const mods = weaponMods(w);
  const base = accuracyLimit(actor, w.accuracy);
  return { mods, accuracy: base === null || base === undefined ? null : base + mods.accuracy, baseAccuracy: base, rc: (Number(w.rc) || 0) + mods.rc };
}

/** « Capacité 6/12 » line of an armor. */
export function armorCapacityText(ar: Armor): string {
  const m = armorMods(ar);
  if (!m.total && !m.used) return '';
  return t('Capacité {used}/{total}', { used: fmtNum(m.used), total: fmtNum(m.total) });
}

/** « 9 emplacements utilisés (Protection 6 · Carrosserie 3) » — R5: each category has its own pool on vehicles (Body + model bonus). */
export function vehicleSlotsText(v: Vehicle): string {
  const n = vehicleSlots(v);
  if (!n) return '';
  const cats = Object.entries(vehicleSlotsByCategory(v));
  if (!cats.length) return t('{n} emplacements utilisés', { n: fmtNum(n) });
  return t('{n} emplacements utilisés ({list})', { n: fmtNum(n), list: cats.map(([c, k]) => `${t((VEHICLE_MOD_CATEGORIES as Record<string, string>)[c])} ${fmtNum(k as number)}`).join(' · ') });
}

/** Lifestyle cost breakdown text: « 5 000 ¥ +20 % +2 583 ¥ ». */
export function lifestyleBreakdown(l: Lifestyle): string {
  const b = costBreakdown(l);
  const parts = [fmtNuyen(b.base)];
  if (b.multiplier) parts.push(`${signed(b.multiplier)} %`);
  if (b.flat) parts.push(`${b.flat > 0 ? '+' : '−'}${fmtNuyen(Math.abs(b.flat))}`);
  if (b.points) parts.push(`+${fmtNuyen(b.points)}`);
  return parts.join(' ');
}
