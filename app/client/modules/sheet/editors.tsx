// GM editing helpers: generic item-list editor and catalog picker (adds items at no cost).
import { Fragment, useEffect, useMemo, useState } from 'react';
import { Button, NumberInput, TextInput, Select, Toggle, SearchBox, Empty, IconButton, confirmAction } from '../../lib/ui.tsx';
import { send, loadCatalog } from '../../lib/net.ts';
import { toast } from '../../lib/ui-store.ts';
import { SKILLS } from '/shared/sr5.js';
import { t, tk, getLang, itemName, skillLabel, fmtNuyen, compare } from '../../lib/i18n.js';
import { Overlay, tRich } from './common.tsx';
import { catalogToItem, LIST_LABELS, KNOWLEDGE_TYPES, SUB_LISTS, SUB_LABELS, LIFESTYLE_BASES } from './sheet-data.js';
import { SubEditor } from './sublists.tsx';
import { ItemRef } from './ext.ts';
import type { Actor, CatalogItem } from '../../../shared/types.ts';
import type { AnyItem, CatalogConversion, FieldDef } from './types.ts';

// Options are built at render time (labels in the UI language).
const combatSkillOptions = () => SKILLS.filter((s) => s.cat === 'combat' || s.id === 'gunnery').map((s) => ({ value: s.id, label: skillLabel(s.id) }));
const knowledgeTypeOptions = () => Object.entries(KNOWLEDGE_TYPES).map(([value, label]) => ({ value, label: t(label) }));
const lifestyleBaseOptions = () => Object.entries(LIFESTYLE_BASES).map(([value, b]) => ({ value, label: t(b.label) }));

/** Field schemas of each item list, for the GM editor. Labels / option labels are French keys (rendered with t()). */
export const LIST_FIELDS: Record<string, FieldDef[]> = {
  weapons: [
    { k: 'name', label: tk('Nom'), w: 170 }, { k: 'kind', label: tk('Type'), type: 'select', options: [{ value: 'melee', label: tk('Mêlée') }, { value: 'ranged', label: tk('Distance') }] },
    { k: 'skill', label: tk('Compétence'), type: 'select', options: combatSkillOptions }, { k: 'accuracy', label: tk('Préc.'), w: 70 }, { k: 'damage', label: tk('VD'), w: 90 },
    { k: 'ap', label: tk('PA'), w: 50 }, { k: 'mode', label: tk('Mode'), w: 80 }, { k: 'rc', label: tk('RC'), type: 'num' }, { k: 'ammo', label: tk('Munitions'), w: 80 },
    { k: 'reach', label: tk('Allonge'), type: 'num' }, { k: 'qty', label: tk('Qté'), type: 'num' }, { k: 'category', label: tk('Catégorie'), w: 110 }, { k: 'notes', label: tk('Notes'), w: 180 },
  ],
  armor: [
    { k: 'name', label: tk('Nom'), w: 200 }, { k: 'rating', label: tk('Indice'), type: 'num' }, { k: 'equipped', label: tk('armure::Portée'), type: 'bool' },
    { k: 'stack', label: tk('Cumulable'), type: 'bool' }, { k: 'itemRating', label: tk('Indice (objet)'), type: 'num' }, { k: 'choice', label: tk('Choix (effet)'), w: 110 },
    { k: 'notes', label: tk('Notes'), w: 220 },
  ],
  augmentations: [
    { k: 'name', label: tk('Nom'), w: 200 }, { k: 'kind', label: tk('Type'), type: 'select', options: [{ value: 'cyberware', label: tk('Cyberware') }, { value: 'bioware', label: tk('Bioware') }] },
    { k: 'grade', label: tk('Grade'), type: 'select', options: [{ value: 'standard', label: tk('Standard') }, { value: 'used', label: tk('Occasion') }, { value: 'alpha', label: tk('Alpha') }, { value: 'beta', label: tk('Bêta') }, { value: 'delta', label: tk('Delta') }] },
    { k: 'rating', label: tk('Indice'), type: 'num' }, { k: 'essence', label: tk('Essence'), type: 'num', step: 0.05 }, { k: 'choice', label: tk('Choix (effet)'), w: 110 },
    { k: 'notes', label: tk('Notes'), w: 220 },
  ],
  gear: [
    { k: 'name', label: tk('Nom'), w: 200 }, { k: 'category', label: tk('Catégorie'), w: 120 }, { k: 'rating', label: tk('Indice'), type: 'num' }, { k: 'qty', label: tk('Qté'), type: 'num' },
    { k: 'active', label: tk('Actif'), type: 'bool' }, { k: 'choice', label: tk('Choix (effet)'), w: 110 }, { k: 'notes', label: tk('Notes'), w: 200 },
  ],
  vehicles: [
    { k: 'name', label: tk('Nom'), w: 180 }, { k: 'handling', label: tk('Maniab.'), w: 60 }, { k: 'speed', label: tk('Vitesse'), w: 60 }, { k: 'accel', label: tk('Accél.'), w: 60 },
    { k: 'body', label: tk('Struct.'), type: 'num' }, { k: 'armor', label: tk('Blind.'), type: 'num' }, { k: 'pilot', label: tk('Autopilote'), type: 'num' }, { k: 'sensor', label: tk('Senseurs'), type: 'num' },
    { k: 'seats', label: tk('Places'), type: 'num' }, { k: 'notes', label: tk('Notes'), w: 180 },
  ],
  contacts: [{ k: 'name', label: tk('Nom'), w: 180 }, { k: 'role', label: tk('Rôle'), w: 140 }, { k: 'connection', label: tk('contact::Connexion'), type: 'num' }, { k: 'loyalty', label: tk('Loyauté'), type: 'num' }, { k: 'notes', label: tk('Notes'), w: 220 }],
  sins: [{ k: 'name', label: tk('Identité'), w: 200 }, { k: 'rating', label: tk('Indice'), type: 'num' }, { k: 'licenses', label: tk('Licences (séparées par des virgules)'), type: 'tags', w: 240 }, { k: 'real', label: tk('Vrai SIN'), type: 'bool' }, { k: 'burned', label: tk('Grillé'), type: 'bool' }, { k: 'notes', label: tk('Notes'), w: 160 }],
  qualities: [
    { k: 'name', label: tk('Nom'), w: 200 }, { k: 'karma', label: tk('Karma'), type: 'num' }, { k: 'positive', label: tk('Positive'), type: 'bool' },
    { k: 'choice', label: tk('Choix (effet)'), w: 110 }, { k: 'notes', label: tk('Notes'), w: 260 },
  ],
  powers: [
    { k: 'name', label: tk('Pouvoir'), w: 200 }, { k: 'level', label: tk('Niveau'), type: 'num' }, { k: 'pp', label: tk('PP'), type: 'num', step: 0.25 },
    { k: 'choice', label: tk('Choix (effet)'), w: 110 }, { k: 'notes', label: tk('Notes'), w: 260 },
  ],
  spells: [
    { k: 'name', label: tk('Sort'), w: 160 }, { k: 'category', label: tk('Catégorie'), w: 100 }, { k: 'type', label: tk('Type'), w: 50 }, { k: 'range', label: tk('Portée'), w: 70 },
    { k: 'duration', label: tk('Durée'), w: 60 }, { k: 'drain', label: tk('Drain'), w: 70 }, { k: 'notes', label: tk('Notes'), w: 180 },
  ],
  knowledge: [
    { k: 'name', label: tk('Connaissance'), w: 200 }, { k: 'type', label: tk('Type'), type: 'select', options: knowledgeTypeOptions },
    { k: 'rating', label: tk('Indice'), type: 'num' }, { k: 'native', label: tk('Langue maternelle'), type: 'bool' },
  ],
  lifestyles: [
    { k: 'name', label: tk('Nom'), w: 170 }, { k: 'base', label: tk('Niveau'), type: 'select', options: lifestyleBaseOptions }, { k: 'baseCost', label: tk('Coût de base (¥)'), type: 'ro' },
    { k: 'monthsPaid', label: tk('Mois payés'), type: 'num' }, { k: 'primary', label: tk('Principal'), type: 'bool' }, { k: 'monthlyCost', label: tk('Total / mois'), type: 'ro' }, { k: 'notes', label: tk('Notes'), w: 160 },
  ],
  martialArts: [{ k: 'name', label: tk('Art martial'), w: 200 }, { k: 'rating', label: tk('Indice'), type: 'num' }, { k: 'notes', label: tk('Notes'), w: 260 }],
};

/** Which catalogs can feed a list. */
export const LIST_CATALOGS: Record<string, string[]> = {
  weapons: ['weapons'], armor: ['armor'], augmentations: ['cyberware', 'bioware'], gear: ['gear'], vehicles: ['vehicles'],
  qualities: ['qualities'], powers: ['powers'], spells: ['spells'], lifestyles: ['lifestyles'], martialArts: ['martialarts'],
};
const CATALOG_LABELS: Record<string, string> = {
  weapons: tk('Armes'), armor: tk('Armures'), gear: tk('Équipement'), cyberware: tk('Cyberware'), bioware: tk('Bioware'), vehicles: tk('Véhicules'), qualities: tk('Qualités'), powers: tk('Pouvoirs'),
  spells: tk('Sorts'), programs: tk('Programmes'), lifestyles: tk('Modes de vie'), lifestylequalities: tk('Options de mode de vie'), accessories: tk('Accessoires d’arme'),
  armormods: tk('Modifications d’armure'), vehiclemods: tk('Modifications de véhicule'), martialarts: tk('Arts martiaux'),
};
const catalogLabel = (c: string): string => (CATALOG_LABELS[c] ? t(CATALOG_LABELS[c]) : c);

// Default names are French keys: the new item is stored with the name in the GM's language.
const BLANK: Record<string, AnyItem> = {
  weapons: { name: tk('Nouvelle arme'), kind: 'ranged', skill: 'pistols', accuracy: '5', damage: '7P', ap: 0, mode: 'SA', rc: 0, ammo: '' },
  armor: { name: tk('Nouvelle armure'), rating: 6, equipped: false },
  augmentations: { name: tk('Nouvel implant'), kind: 'cyberware', grade: 'standard', essence: 0.1 },
  gear: { name: tk('Nouvel objet'), qty: 1 },
  vehicles: { name: tk('Nouveau véhicule'), handling: '3/3', speed: '3', accel: '2', body: 8, armor: 4, pilot: 1, sensor: 1, seats: 2 },
  contacts: { name: tk('Nouveau contact'), role: '', connection: 1, loyalty: 1 },
  sins: { name: tk('Nouvelle identité'), rating: 3, licenses: [] },
  qualities: { name: tk('Nouvelle qualité'), karma: 5, positive: true },
  powers: { name: tk('Nouveau pouvoir'), pp: 0.5 },
  spells: { name: tk('Nouveau sort'), category: 'Combat', type: 'M', range: 'LdV', duration: 'I', drain: 'F−3' },
  knowledge: { name: tk('Nouvelle connaissance'), type: 'street', rating: 1 },
  lifestyles: { name: tk('Nouveau mode de vie'), base: 'Medium', baseCost: 5000, monthsPaid: 0 },
  martialArts: { name: tk('Nouvel art martial'), rating: 1 },
};
const BLANK_OTHER = tk('Nouvel élément');

function fieldOptions(f: FieldDef): Array<{ value: string; label: string }> {
  if (typeof f.options === 'function') return f.options();
  return (f.options || []).map((o) => ({ value: o.value, label: t(o.label) }));
}

function FieldInput({ f, value, onChange }: { f: FieldDef; value: any; onChange: (v: any) => void }) { // value / onChange: the field's type (number, boolean, string, string[])
  if (f.type === 'ro') return <span className="mono">{typeof value === 'number' ? fmtNuyen(value) : value ?? '—'}</span>;
  if (f.type === 'num') return <NumberInput small value={Number(value) || 0} step={f.step || 1} min={f.k === 'essence' || f.k === 'pp' ? 0 : -99} onChange={onChange} />;
  if (f.type === 'bool') return <Toggle value={!!value} onChange={onChange} />;
  if (f.type === 'select') return <Select value={value || ''} options={[{ value: '', label: '—' }, ...fieldOptions(f)]} onChange={onChange} />;
  if (f.type === 'tags') return <TextInput value={(value || []).join(', ')} onChange={(v) => onChange(v.split(',').map((x) => x.trim()).filter(Boolean))} />;
  return <TextInput value={value ?? ''} onChange={onChange} style={{ minWidth: (f.w || 90) + 'px' }} />;
}

/** Inline editor for one item list (GM). */
export function ListEditor({ actor, list, fields = LIST_FIELDS[list] }: { actor: Actor; list: string; fields?: FieldDef[] }) {
  const [picker, setPicker] = useState(false);
  const [open, setOpen] = useState<string | null>(null); // item whose nested list (accessories, mods…) is expanded
  const sub: string | undefined = (SUB_LISTS as Record<string, string>)[list];
  const items: AnyItem[] = (actor as unknown as Record<string, AnyItem[] | undefined>)[list] || [];
  const up = (it: AnyItem, i: number, k: string, v: unknown) => send('actor/updateItem', { actorId: actor.id, list, itemId: it.id, index: i, patch: { [k]: v } }).catch(() => {});
  const remove = async (it: AnyItem, i: number) => {
    if (!(await confirmAction(t('Retirer « {name} » ?', { name: it.name })))) return;
    const essence = list === 'augmentations' && it.essence ? await confirmAction(t('Rendre {n} point(s) d’Essence à {name} ?', { n: it.essence, name: actor.name })) : false;
    send('actor/removeItem', { actorId: actor.id, list, itemId: it.id, index: i, adjustEssence: essence }).catch(() => {});
  };
  const addBlank = () => {
    const blank = BLANK[list] || { name: BLANK_OTHER };
    send('actor/addItem', { actorId: actor.id, list, item: { ...blank, name: t(blank.name) } }).catch(() => {});
  };
  return <div className="sh-editor">
    <div className="sh-table-wrap">
      <table className="sr sh-edit-table">
        <thead><tr>{fields.map((f) => <th key={f.k}>{t(f.label)}</th>)}<th /></tr></thead>
        <tbody>
          {items.map(
            (it, i) => <Fragment key={it.id || i}>
              <tr>
                {fields.map((f) => <td key={f.k}><FieldInput f={f} value={it[f.k]} onChange={(v) => up(it, i, f.k, v)} /></td>)}
                <td className="nowrap">
                  {sub && <Button small variant={open === it.id ? 'accent' : 'ghost'} onClick={() => setOpen(open === it.id ? null : it.id)}>
                  {t((SUB_LABELS as Record<string, string>)[sub])} ({(it[sub] || []).length})
                </Button>}
                  <IconButton icon="✕" title={t('Retirer')} onClick={() => remove(it, i)} />
                </td>
              </tr>
              {sub && open === it.id && <tr className="sh-sub-row">
                <td colSpan={fields.length + 1}><SubEditor actor={actor} list={list} item={it} /></td>
              </tr>}
            </Fragment>
          )}
          {!items.length && <tr><td colSpan={fields.length + 1} className="muted small">{t('Aucun élément.')}</td></tr>}
        </tbody>
      </table>
    </div>
    <div className="row wrap">
      <Button small onClick={addBlank}>{t('+ Ajouter (vierge)')}</Button>
      {LIST_CATALOGS[list] && <Button small variant="primary" onClick={() => setPicker(true)}>{t('+ Depuis le catalogue')}</Button>}
    </div>
    {picker && <CatalogPicker actor={actor} list={list} catalogs={LIST_CATALOGS[list]} onClose={() => setPicker(false)} />}
  </div>;
}

const statLine = (catalog: string, e: CatalogItem): string => {
  const s: Record<string, any> = e.stats || {}; // stats of any catalog file
  if (catalog === 'weapons') return [s.accuracy && t('Préc. {v}', { v: s.accuracy }), s.damage && t('VD {v}', { v: s.damage }), s.ap !== undefined && t('PA {v}', { v: s.ap }), s.mode && s.mode !== '0' && s.mode, s.ammo && s.ammo !== '0' && s.ammo].filter(Boolean).join(' · ');
  if (catalog === 'armor') return t('Armure {v}', { v: s.armor ?? s.rating ?? '?' });
  if (catalog === 'cyberware' || catalog === 'bioware') return t('Essence {v}', { v: e.essence ?? s.essence ?? '?' });
  if (catalog === 'vehicles') return [s.handling && t('Man. {v}', { v: s.handling }), s.speed && t('Vit. {v}', { v: s.speed }), s.body && t('Struct. {v}', { v: s.body }), s.armor && t('Blind. {v}', { v: s.armor })].filter(Boolean).join(' · ');
  if (catalog === 'qualities') return t('{v} karma', { v: s.karma ?? (e as { karma?: number }).karma ?? '?' });
  if (catalog === 'powers') return t('{v} PP', { v: s.points ?? s.pp ?? '?' });
  if (catalog === 'spells') return [s.type, s.range, s.duration, (s.drain || s.dv) && t('Drain {v}', { v: s.drain || s.dv })].filter(Boolean).join(' · ');
  if (catalog === 'lifestylequalities') return [s.multiplier && `${s.multiplier > 0 ? '+' : ''}${s.multiplier} %`, s.lp != null && t('{v} PS', { v: s.lp }), Array.isArray(s.allowed) && s.allowed.length && s.allowed.join('/')].filter(Boolean).join(' · ');
  if (catalog === 'accessories') return [Array.isArray(s.mount) ? s.mount.join('/') : s.mount, s.accuracy && t('Préc. +{v}', { v: s.accuracy }), s.rc && t('RC +{v}', { v: s.rc }), s.smartgun && t('smartgun')].filter(Boolean).join(' · ');
  if (catalog === 'armormods') return [s.capacity != null && t('Capacité {v}', { v: s.capacity }), s.armor && t('Armure +{v}', { v: s.armor })].filter(Boolean).join(' · ');
  if (catalog === 'vehiclemods') return s.slots != null ? t('Emplacements {v}', { v: s.slots }) : '';
  if (catalog === 'martialarts') return (s.techniques || []).length ? t('{n} techniques', { n: s.techniques.length }) : '';
  return '';
};

/** Catalog category label: French categoryFr in French, the catalog's English category otherwise. */
const categoryName = (e: CatalogItem): string => (getLang() === 'fr' ? e.categoryFr || e.category : e.category || e.categoryFr || '');
/** The item name in the other language (shown small next to the main name), or ''. */
const altName = (e: CatalogItem): string => {
  const other = getLang() === 'fr' ? e.name : e.nameFr;
  return other && other !== itemName(e) ? other : '';
};

/** Catalog browser: adds the chosen entry to `list` of the actor for free (GM). */
interface CatalogPickerProps {
  actor: Actor;
  list: string;
  catalogs: string[];
  onClose: () => void;
  /** Instead of adding to the actor: gets the conversion and the entry (nested lists). */
  onPick?: (conv: CatalogConversion, entry: CatalogItem) => unknown;
}
export function CatalogPicker({ actor, list, catalogs, onClose, onPick }: CatalogPickerProps) {
  const [cat, setCat] = useState(catalogs[0]);
  const [data, setData] = useState<CatalogItem[] | null>(null);
  const [q, setQ] = useState('');
  const [category, setCategory] = useState('');
  const [ratings, setRatings] = useState<Record<string, number>>({});
  const [essence, setEssence] = useState(true);
  useEffect(() => {
    let alive = true;
    setData(null);
    setCategory('');
    loadCatalog<CatalogItem>(cat)
      .then((d) => alive && setData(Array.isArray(d) ? d : []))
      .catch(() => alive && setData([]));
    return () => {
      alive = false;
    };
  }, [cat]);
  const categories = useMemo(() => {
    const m = new Map<string, string>();
    for (const e of data || []) if (e.category && !m.has(e.category)) m.set(e.category, categoryName(e));
    return [...m].map(([value, label]) => ({ value, label })).sort((a, b) => compare(a.label, b.label));
  }, [data]);
  const results = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (data || []).filter((e) => (!category || e.category === category) && (!needle || `${e.name} ${e.nameFr || ''} ${e.category || ''}`.toLowerCase().includes(needle)));
  }, [data, q, category]);
  const add = async (e: CatalogItem) => {
    const r = e.rating && e.rating.max ? ratings[e.id] || e.rating.min || 1 : undefined;
    const conv = catalogToItem(cat, e, r) as CatalogConversion | null;
    if (!conv) return;
    // Stored name in the GM's language (French: unchanged, nameFr).
    if (getLang() !== 'fr' && conv.item && itemName(e)) conv.item.name = itemName(e);
    if (onPick) return onPick(conv, e);
    try {
      await send('actor/addItem', { actorId: actor.id, list: conv.list, item: conv.item, adjustEssence: conv.list === 'augmentations' && essence });
      toast(t('{item} ajouté à {name}', { item: conv.item.name, name: actor.name }), 'success');
    } catch {}
  };
  const listLabel = (LIST_LABELS as Record<string, string>)[list] ? t((LIST_LABELS as Record<string, string>)[list]) : '';
  return <Overlay title={t('Catalogue — {list}', { list: listLabel })} onClose={onClose} width={760}>
    <div className="col">
      <div className="row wrap">
        {catalogs.length > 1 && <Select value={cat} options={catalogs.map((c) => ({ value: c, label: catalogLabel(c) }))} onChange={setCat} style={{ width: 'auto' }} />}
        <SearchBox value={q} onChange={setQ} />
        {categories.length > 1 && <Select value={category} options={[{ value: '', label: t('Toutes catégories') }, ...categories]} onChange={setCategory} style={{ width: 'auto', maxWidth: '220px' }} />}{list === 'augmentations' && <Toggle value={essence} onChange={setEssence} label={t('Déduire l’Essence')} />}
      </div>
      {data === null
        ? <div className="muted">{t('Chargement du catalogue…')}</div>
        : !data.length
          ? <Empty>
            {t('Catalogue « {name} » indisponible.', { name: catalogLabel(cat) })}{' '}{tRich(t('Lance {cmd} sur le PC du MJ, ou ajoute un élément vierge.'), { cmd: <code>npm run build:catalog</code> })}
          </Empty>
          : <div className="sh-cat-list">
            {results.slice(0, 150).map(
                (e) => <div className="sh-cat-row" key={e.id}>
                  <div className="grow">
                    <div>
                      <b>{itemName(e)}</b>
                      {altName(e) ? <>{' '}<span className="faint small">{altName(e)}</span></> : null}{' '}
                      <ItemRef item={e} />
                    </div>
                    <div className="muted small">
                      {[categoryName(e), statLine(cat, e), e.avail && t('Dispo {v}', { v: e.avail }), e.cost != null && fmtNuyen(e.cost)].filter(Boolean).join(' · ')}
                    </div>
                  </div>
                  {e.rating && e.rating.max ? <NumberInput small value={ratings[e.id] || e.rating.min || 1} min={e.rating.min || 1} max={e.rating.max} onChange={(v) => setRatings({ ...ratings, [e.id]: v })} /> : null}
                  <Button small variant="primary" onClick={() => add(e)}>{t('Ajouter')}</Button>
                </div>
              )}
            {results.length > 150 && <div className="muted small center">{t('{n} résultats de plus — affine la recherche.', { n: results.length - 150 })}</div>}{!results.length && <div className="muted small center">{t('Aucun résultat.')}</div>}
          </div>}
      <div className="muted small">{t('Ajout gratuit (édition MJ). Pour un achat avec nuyens, passe par la Boutique.')}</div>
    </div>
  </Overlay>;
}
