// Storefront: section sidebar, search/filters/sort, paginated results, item detail (side panel or modal).
import { useEffect, useMemo, useState, type MouseEvent } from 'react';
import { Button, IconButton, Badge, Empty, SearchBox, Select, Toggle, Modal } from '../../lib/ui.tsx';
import { toast } from '../../lib/ui-store.ts';
import { t, tn, tk, compare, skillLabel, getLang } from '../../lib/i18n.ts';
import { STORE_SECTIONS, UPGRADE_FILES, fold } from './rules.ts';
import { specialEntry, priceEntry, buyStatus, addToCart, nuyen, AvailBadge, useMedia, useMartialCatalog } from './common.tsx';
import { skillIndex, entrySkills, actorSkillRatings, skillOptions, matchSkill, NO_SKILL } from './skills.ts';
import ItemDetail from './ItemDetail.tsx';
import MartialArts from './MartialArts.tsx';
import { ItemRef } from './bookrefs.ts';
import type { Actor, CatalogEntry, GameView, ShopState } from '../../../shared/types.ts';
import type { BuyStatus, CartLine, PriceQuote, ShopCatalog, ShopEntry } from './types.ts';

const PAGE = 40;

interface Filters {
  hideUnavailable: boolean;
  showR: boolean;
  showF: boolean;
  /** '' = no bound (raw text of the number field). */
  minPrice: string;
  maxPrice: string;
}
// Remember the view between tab switches (module-level, per browser tab).
const memo: { section: string | null; category: string; sort: string; search: string } & Filters = {
  section: null,
  category: '',
  sort: 'name',
  search: '',
  hideUnavailable: true,
  showR: true,
  showF: true,
  minPrice: '',
  maxPrice: '',
};

/** « Compétence » filter of a section. */
interface SkillPref {
  skill: string;
  mine: boolean;
}
// « Compétence » filter per section ({ [section]: { skill, mine } }), kept in localStorage (guarded: private mode, quota).
const SKILL_KEY = 'sr.shop.skillFilter';
let skillMemo: Record<string, Partial<SkillPref>> = {};
try {
  const v = JSON.parse(localStorage.getItem(SKILL_KEY) || '{}');
  if (v && typeof v === 'object' && !Array.isArray(v)) skillMemo = v;
} catch {}
function saveSkillMemo(section: string, value: SkillPref) {
  skillMemo = { ...skillMemo, [section]: value };
  try {
    localStorage.setItem(SKILL_KEY, JSON.stringify(skillMemo));
  } catch {}
}
const skillPref = (section: string): SkillPref => {
  const v = skillMemo[section];
  return { skill: typeof v?.skill === 'string' ? v.skill : '', mine: !!v?.mine };
};

const SORTS = [
  { value: 'name', label: tk('Nom') },
  { value: 'price', label: tk('Prix croissant') },
  { value: '-price', label: tk('Prix décroissant') },
  { value: 'avail', label: tk('Disponibilité') },
];

/** A sidebar section (rules.js STORE_SECTIONS, plus « Offres de Cabana » and « Tout le catalogue »). */
interface Section {
  id: string;
  /** French key. */
  label: string;
  icon: string;
  files: string[];
}
/** One result row: entry, price sheet, buy status. */
interface Result {
  e: ShopEntry;
  q: PriceQuote;
  st: BuyStatus;
}
/** « Compétence » options of the section (skills.js skillOptions). */
interface SkillOpts {
  options: Array<{ id: string; label: string; rating: number }>;
  none: number;
}

interface StorefrontProps {
  game: GameView;
  actor: Actor | null;
  catalog: ShopCatalog | null;
}

export default function Storefront({ game, actor, catalog }: StorefrontProps) {
  const shop: Partial<ShopState> = game.shop || {};
  const isGM = game.me.role === 'gm';
  const narrow = useMedia('(max-width: 760px)');
  const wide = useMedia('(min-width: 1180px)');
  const specials = shop.specials || [];
  const martial = useMartialCatalog<CatalogEntry<'martialarts'>>();

  const sections = useMemo(() => {
    const list: Section[] = [];
    if (specials.length || isGM) list.push({ id: 'specials', label: tk('Offres de Cabana'), icon: '★', files: [] });
    for (const s of STORE_SECTIONS as Section[]) {
      if (!isGM && s.files.length && s.files.every((f) => shop.categories?.[f as keyof ShopState['categories']] === false)) continue;
      list.push(s);
    }
    list.push({ id: 'all', label: tk('Tout le catalogue'), icon: '⌕', files: [] });
    return list;
  }, [specials.length, isGM, shop.categories]);

  const [section, setSectionRaw] = useState<string>(memo.section && sections.some((s) => s.id === memo.section) ? memo.section : sections[0]?.id || 'weapons');
  const [categoryRaw, setCategoryRaw] = useState(memo.category);
  const [sort, setSortRaw] = useState(memo.sort);
  const [search, setSearchRaw] = useState(memo.search);
  const [filters, setFiltersRaw] = useState<Filters>({ hideUnavailable: memo.hideUnavailable, showR: memo.showR, showF: memo.showF, minPrice: memo.minPrice, maxPrice: memo.maxPrice });
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [showFilters, setShowFilters] = useState(false);
  const [skillPrefRaw, setSkillPrefRaw] = useState(() => skillPref(section));

  const setSection = (s: string) => {
    memo.section = s;
    memo.category = '';
    setSectionRaw(s);
    setCategoryRaw('');
    setSkillPrefRaw(skillPref(s));
    setPage(0);
  };
  const setCategory = (c: string) => {
    memo.category = c;
    setCategoryRaw(c);
    setPage(0);
  };
  const setSort = (s: string) => {
    memo.sort = s;
    setSortRaw(s);
    setPage(0);
  };
  const setSearch = (s: string) => {
    memo.search = s;
    setSearchRaw(s);
    setPage(0);
  };
  const setSkillPref = (patch: Partial<SkillPref>) => {
    const next = { ...skillPrefRaw, ...patch };
    saveSkillMemo(section, next);
    setSkillPrefRaw(next);
    setPage(0);
  };
  const setFilter = <K extends keyof Filters>(k: K, v: Filters[K]) => {
    memo[k] = v as (typeof memo)[K];
    setFiltersRaw((f) => ({ ...f, [k]: v }));
    setPage(0);
  };

  // Section removed (e.g. GM disabled a category): fall back to the first one.
  useEffect(() => {
    if (!sections.some((s) => s.id === section)) setSection(sections[0]?.id || 'weapons');
  }, [sections]);

  // Entries of the current section (before category / search filters).
  const base = useMemo(() => {
    if (!catalog) return [];
    if (section === 'specials') return specials.map((sp) => specialEntry(sp, catalog));
    const enabled = (e: ShopEntry) => isGM || shop.categories?.[e.file] !== false;
    if (section === 'all') return catalog.entries.filter(enabled);
    return catalog.entries.filter((e) => e.section === section && enabled(e));
  }, [catalog, section, specials, isGM, shop.categories]);

  const categories = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of base) m.set(e.category, (m.get(e.category) || 0) + 1);
    return [...m.entries()].sort((a, b) => compare(a[0], b[0])).map(([name, count]) => ({ name, count }));
  }, [base]);
  // A remembered category may not exist any more (other section, or other UI language): show everything then.
  const category = categoryRaw && categories.some((c) => c.name === categoryRaw) ? categoryRaw : '';

  // « Compétence » filter: skills linked to the section's items (weapon skill, pilot skill, focus…), see skills.js.
  const skillIdx = useMemo(() => (catalog ? skillIndex(catalog) : null), [catalog]);
  const skillsOf = (e: ShopEntry): string[] => entrySkills(e, skillIdx);
  const ratings = useMemo(() => actorSkillRatings(actor), [actor?.skills]);
  const skillOpts: SkillOpts = useMemo(() => skillOptions(base, skillsOf, ratings, skillLabel, compare), [base, skillIdx, ratings, getLang()]);
  const hasSkillFilter = skillOpts.options.length > 0;
  const mine = hasSkillFilter && !!actor && skillPrefRaw.mine;
  const visibleSkillOpts = mine ? skillOpts.options.filter((o) => o.rating > 0) : skillOpts.options;
  const showNoSkill = !mine && skillOpts.none > 0 && section !== 'accessories';
  // A remembered skill absent from this list (other character, catalog change): any skill then.
  const skill = !hasSkillFilter
    ? ''
    : skillPrefRaw.skill === NO_SKILL
      ? showNoSkill
        ? NO_SKILL
        : ''
      : visibleSkillOpts.some((o) => o.id === skillPrefRaw.skill)
        ? skillPrefRaw.skill
        : '';

  const results = useMemo(() => {
    const words = fold(search).split(/\s+/).filter(Boolean);
    const minP = filters.minPrice === '' ? null : Number(filters.minPrice);
    const maxP = filters.maxPrice === '' ? null : Number(filters.maxPrice);
    const out: Result[] = [];
    for (const e of base) {
      if (category && e.category !== category) continue;
      if (words.length && !words.every((w: string) => e.search.includes(w))) continue;
      if ((skill || mine) && !matchSkill(skillsOf(e), skill, mine, ratings)) continue;
      const q = priceEntry(e, {}, shop);
      if (!filters.showR && q.legality === 'R') continue;
      if (!filters.showF && q.legality === 'F') continue;
      const st = buyStatus(shop, e, q, isGM);
      if (!isGM && filters.hideUnavailable && !st.ok && !st.closed) continue;
      if (minP !== null && Number.isFinite(minP) && q.unitCost < minP) continue;
      if (maxP !== null && Number.isFinite(maxP) && q.unitCost > maxP) continue;
      out.push({ e, q, st });
    }
    const byName = (a: Result, b: Result) => compare(a.e.name, b.e.name);
    if (sort === 'price') out.sort((a, b) => a.q.unitCost - b.q.unitCost || byName(a, b));
    else if (sort === '-price') out.sort((a, b) => b.q.unitCost - a.q.unitCost || byName(a, b));
    else if (sort === 'avail') out.sort((a, b) => a.q.availValue - b.q.availValue || byName(a, b));
    else out.sort(byName);
    return out;
  }, [base, category, search, sort, filters, shop, isGM, skill, mine, ratings, skillIdx]);

  const pages = Math.max(1, Math.ceil(results.length / PAGE));
  const curPage = Math.min(page, pages - 1);
  const shown = results.slice(curPage * PAGE, curPage * PAGE + PAGE);

  // Keep the selection fresh (specials change live) and resolvable.
  const selEntry = useMemo(() => {
    if (!selected || !catalog) return null;
    if (selected.startsWith('special:')) {
      const sp = specials.find((s) => `special:${s.id}` === selected);
      return sp ? specialEntry(sp, catalog) : null;
    }
    return catalog.byId.get(selected) || null;
  }, [selected, catalog, specials]);

  const quickAdd = (ev: MouseEvent, r: Result) => {
    ev.stopPropagation();
    if (!actor) return toast(t('Choisis d’abord un personnage'), 'warn');
    // Upgrades need a target (weapon, armor, vehicle, lifestyle): open the detail panel instead.
    if (!r.e.special && UPGRADE_FILES[r.e.file as keyof typeof UPGRADE_FILES]) return setSelected(r.e.ref);
    const l: CartLine = { ref: r.e.ref, qty: 1, name: r.e.name };
    if (!r.e.special && r.e.item?.rating) l.rating = r.e.item.rating.min;
    if (!r.e.special && r.q.grade) l.grade = r.q.grade;
    if (!r.e.special && r.e.item?.costRange) l.price = r.e.item.costRange[0];
    addToCart(actor.id, l);
    toast(t('{name} ajouté au panier', { name: r.e.name }), 'success', 1800);
  };

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const e of catalog?.entries || []) if (isGM || shop.categories?.[e.file] !== false) c[e.section] = (c[e.section] || 0) + 1;
    return c;
  }, [catalog, isGM, shop.categories]);
  const sectionCount = (s: Section) => (s.id === 'specials' ? specials.length : s.id === 'martialarts' ? (martial ? martial.length : null) : s.id === 'all' ? null : counts[s.id] || 0);

  if (!catalog) return <div className="shop-loading">{t('Connexion au catalogue de Cabana…')}</div>;

  const sidebar = (
    <nav className={'shop-sidebar' + (narrow ? ' narrow' : '')}>
      {sections.map((s) => (
        <div key={s.id} className="shop-sec-wrap">
          <button className={'shop-sec' + (s.id === section ? ' active' : '') + (s.id === 'specials' ? ' special' : '')} onClick={() => setSection(s.id)}>
            <span className="shop-sec-icon">{s.icon}</span>
            <span className="grow">{t(s.label)}</span>
            {!narrow && sectionCount(s) !== null ? <span className="shop-sec-count">{sectionCount(s)}</span> : null}
          </button>
          {!narrow && s.id === section && categories.length > 1 && (
            <div className="shop-cats">
              <button className={'shop-cat' + (!category ? ' active' : '')} onClick={() => setCategory('')}>
                {t('Toutes')} <span className="faint">{base.length}</span>
              </button>
              {categories.map((c) => (
                <button key={c.name} className={'shop-cat' + (category === c.name ? ' active' : '')} onClick={() => setCategory(c.name)} title={c.name}>
                  {c.name} <span className="faint">{c.count}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      ))}
    </nav>
  );

  const toolbar = (
    <div className="shop-toolbar">
      <div className="row wrap">
        <SearchBox value={search} onChange={setSearch} placeholder={t('Rechercher (FR ou EN)…')} />
        {narrow && categories.length > 1 && (
          <Select
            className="shop-cat-select"
            value={category}
            onChange={setCategory}
            options={[{ value: '', label: t('Toutes catégories ({n})', { n: base.length }) }, ...categories.map((c) => ({ value: c.name, label: `${c.name} (${c.count})` }))]}
          />
        )}
        {hasSkillFilter && (
          <span className="row gap-s shop-skill-filter">
            <Select
              className={'shop-skill-select' + (skill ? ' active' : '')}
              value={skill}
              onChange={(v) => setSkillPref({ skill: v })}
              title={section === 'accessories' ? t('Compétence des armes compatibles') : t('Compétence liée')}
              aria-label={section === 'accessories' ? t('Compétence des armes compatibles') : t('Compétence liée')}
              options={[
                { value: '', label: section === 'accessories' ? t('Toutes armes') : t('Toutes compétences') },
                ...visibleSkillOpts.map((o) => ({ value: o.id, label: o.rating > 0 ? `${o.label} (${o.rating})` : o.label })),
                ...(showNoSkill ? [{ value: NO_SKILL, label: t('Sans compétence liée') }] : []),
              ]}
            />
            <Button
              small
              variant={mine ? 'primary' : 'ghost'}
              disabled={!actor}
              aria-pressed={mine ? 'true' : 'false'}
              title={actor ? t('Seulement les articles liés aux compétences de {name}', { name: actor.name }) : t('Choisis d’abord un personnage')}
              onClick={() => setSkillPref({ mine: !skillPrefRaw.mine })}
            >
              {t('Mes compétences')}
            </Button>
          </span>
        )}
        <Select className="shop-sort" value={sort} onChange={setSort} options={SORTS.map((s) => ({ value: s.value, label: t(s.label) }))} />
        <Button small variant={showFilters ? 'primary' : 'ghost'} onClick={() => setShowFilters(!showFilters)}>
          {t('Filtres')}
        </Button>
        <span className="muted small grow right">{tn(results.length, '{n} article', '{n} articles')}</span>
      </div>
      {showFilters && (
        <div className="shop-filters row wrap">
          {!isGM && (
            <Toggle value={filters.hideUnavailable} onChange={(v) => setFilter('hideUnavailable', v)} label={t('Masquer l’inaccessible (dispo > {max})', { max: shop.maxAvail })} />
          )}
          <Toggle value={filters.showR} onChange={(v) => setFilter('showR', v)} label={t('Restreint (R)')} />
          <Toggle value={filters.showF} onChange={(v) => setFilter('showF', v)} label={t('Interdit (F)')} />
          <label className="row gap-s small">
            {t('Prix')}
            <input className="input shop-price-input" type="number" min="0" placeholder="min" value={filters.minPrice} onChange={(e) => setFilter('minPrice', e.target.value)} />
            –
            <input className="input shop-price-input" type="number" min="0" placeholder="max" value={filters.maxPrice} onChange={(e) => setFilter('maxPrice', e.target.value)} />
          </label>
        </div>
      )}
    </div>
  );

  const list =
    section === 'specials' ? (
      <div className="shop-specials">
        {!shown.length && (
          <Empty>{isGM ? t('Aucune offre. Crée-en depuis un article (« + Offre Cabana ») ou dans l’onglet « Offres de Cabana ».') : t('Cabana n’a rien de spécial pour toi en ce moment.')}</Empty>
        )}
        {shown.map((r) => {
          const sp = r.e.special!;
          return (
            <div key={r.e.ref} className={'card clickable shop-special' + (selected === r.e.ref ? ' selected' : '') + (sp.hidden ? ' draft' : '')} onClick={() => setSelected(r.e.ref)}>
              <div className="spread row">
                <h4>{r.e.name}</h4>
                {sp.hidden && <Badge color="amber">{t('Caché')}</Badge>}
              </div>
              <div className="row wrap gap-s small">
                <Badge>{r.e.category}</Badge>
                <AvailBadge avail={r.q.avail} value={r.q.availValue} legality={r.q.legality} />
                {sp.stock === null || sp.stock === undefined ? null : sp.stock > 0 ? (
                  <span className="muted">{t('{n} en stock', { n: sp.stock })}</span>
                ) : (
                  <Badge color="red">{t('Épuisé')}</Badge>
                )}
              </div>
              {sp.notes && <p className="shop-special-notes">{sp.notes}</p>}
              <div className="spread row">
                <div>
                  {(sp.originalCost || 0) > sp.cost ? <span className="shop-old-price">{nuyen(sp.originalCost)}</span> : null}
                  <span className="shop-price">{nuyen(r.q.unitCost)}</span>
                </div>
                <Button small variant="primary" disabled={!r.st.ok || !actor} onClick={(ev) => quickAdd(ev, r)}>
                  {t('+ Panier')}
                </Button>
              </div>
            </div>
          );
        })}
      </div>
    ) : (
      <div className="shop-results">
        {!shown.length ? (
          <Empty>
            {catalog.error && !catalog.entries.length
              ? t('Catalogue introuvable — le MJ doit lancer « npm run build:catalog ».')
              : mine && !visibleSkillOpts.length && actor
                ? t('{name} n’a aucune compétence liée à ces articles.', { name: actor.name })
                : t('Rien ne correspond à ta recherche.')}
          </Empty>
        ) : (
          <table className="sr shop-table">
            <thead>
              <tr>
                <th>{t('Article')}</th>
                {!narrow && <th>{t('Catégorie')}</th>}
                <th>{t('Dispo')}</th>
                <th className="right">{t('Prix')}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.e.ref} className={'shop-row' + (selected === r.e.ref ? ' selected' : '') + (!r.st.ok ? ' blocked' : '')} onClick={() => setSelected(r.e.ref)}>
                  <td>
                    <div className="shop-row-name">
                      {r.e.name} <ItemRef item={r.e.item} />
                    </div>
                    {r.e.item?.nameFr && r.e.item.name !== r.e.item.nameFr ? <div className="faint small">{r.e.name === r.e.item.name ? r.e.item.nameFr : r.e.item.name}</div> : null}
                    {narrow && <div className="faint small">{r.e.category}</div>}
                  </td>
                  {!narrow && <td className="muted small">{r.e.category}</td>}
                  <td>
                    <AvailBadge avail={r.q.avail} value={r.q.availValue} legality={r.q.legality} max={isGM ? undefined : shop.maxAvail} />
                  </td>
                  <td className="num-cell">
                    {(r.e.item?.rating && r.e.item.rating.max > r.e.item.rating.min) || r.e.item?.costRange ? <span className="faint small">{t('dès')} </span> : null}
                    {nuyen(r.q.unitCost)}
                  </td>
                  <td className="right">
                    <IconButton icon="+" title={r.st.ok ? t('Ajouter au panier') : r.st.reason} disabled={!r.st.ok || !actor} onClick={(ev) => quickAdd(ev, r)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    );

  const pager = pages > 1 && (
    <div className="shop-pager row">
      <Button small variant="ghost" disabled={curPage === 0} onClick={() => setPage(curPage - 1)}>
        ‹ {t('Précédent')}
      </Button>
      <span className="muted small">{t('Page {n} / {total}', { n: curPage + 1, total: pages })}</span>
      <Button small variant="ghost" disabled={curPage >= pages - 1} onClick={() => setPage(curPage + 1)}>
        {t('Suivant')} ›
      </Button>
    </div>
  );

  if (section === 'martialarts') {
    return (
      <div className={'shop-store' + (narrow ? ' narrow' : '')}>
        {sidebar}
        <div className="shop-main">
          <MartialArts game={game} actor={actor} styles={martial} wide={wide} />
        </div>
      </div>
    );
  }

  return (
    <div className={'shop-store' + (wide ? ' wide' : '') + (narrow ? ' narrow' : '')}>
      {sidebar}
      <div className="shop-main">
        {toolbar}
        {!shop.open && !isGM && <div className="shop-closed">{t('Cabana n’est pas joignable pour l’instant. Tu peux parcourir le catalogue, mais pas commander.')}</div>}
        {list}
        {pager}
      </div>
      {wide && (
        <aside className="shop-side">
          {selEntry ? <ItemDetail key={selEntry.ref} entry={selEntry} game={game} actor={actor} catalog={catalog} /> : <Empty>{t('Sélectionne un article pour voir ses caractéristiques.')}</Empty>}
        </aside>
      )}
      {!wide && selEntry && (
        <Modal title={selEntry.name} width={560} onClose={() => setSelected(null)}>
          <ItemDetail key={selEntry.ref} entry={selEntry} game={game} actor={actor} catalog={catalog} compact />
        </Modal>
      )}
    </div>
  );
}
