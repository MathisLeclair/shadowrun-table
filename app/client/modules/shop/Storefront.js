// Storefront: section sidebar, search/filters/sort, paginated results, item detail (side panel or modal).
import { useEffect, useMemo, useState } from 'preact/hooks';
import { html, Button, IconButton, Badge, Empty, SearchBox, Select, Toggle, Modal } from '../../lib/ui.js';
import { toast } from '../../lib/ui-store.js';
import { SECTIONS, fold } from './rules.js';
import { specialEntry, priceEntry, buyStatus, addToCart, nuyen, AvailBadge, useMedia } from './common.js';
import ItemDetail from './ItemDetail.js';

const PAGE = 40;
// Remember the view between tab switches (module-level, per browser tab).
const memo = { section: null, category: '', sort: 'name', search: '', hideUnavailable: true, showR: true, showF: true, minPrice: '', maxPrice: '' };

const SORTS = [
  { value: 'name', label: 'Nom' },
  { value: 'price', label: 'Prix croissant' },
  { value: '-price', label: 'Prix décroissant' },
  { value: 'avail', label: 'Disponibilité' },
];

export default function Storefront({ game, actor, catalog }) {
  const shop = game.shop || {};
  const isGM = game.me.role === 'gm';
  const narrow = useMedia('(max-width: 760px)');
  const wide = useMedia('(min-width: 1180px)');
  const specials = shop.specials || [];

  const sections = useMemo(() => {
    const list = [];
    if (specials.length || isGM) list.push({ id: 'specials', label: 'Offres de Cabana', icon: '★', files: [] });
    for (const s of SECTIONS) {
      if (!isGM && s.files.every((f) => shop.categories?.[f] === false)) continue;
      list.push(s);
    }
    list.push({ id: 'all', label: 'Tout le catalogue', icon: '⌕', files: [] });
    return list;
  }, [specials.length, isGM, shop.categories]);

  const [section, setSectionRaw] = useState(memo.section && sections.some((s) => s.id === memo.section) ? memo.section : sections[0]?.id || 'weapons');
  const [category, setCategoryRaw] = useState(memo.category);
  const [sort, setSortRaw] = useState(memo.sort);
  const [search, setSearchRaw] = useState(memo.search);
  const [filters, setFiltersRaw] = useState({ hideUnavailable: memo.hideUnavailable, showR: memo.showR, showF: memo.showF, minPrice: memo.minPrice, maxPrice: memo.maxPrice });
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState(null);
  const [showFilters, setShowFilters] = useState(false);

  const setSection = (s) => {
    memo.section = s;
    memo.category = '';
    setSectionRaw(s);
    setCategoryRaw('');
    setPage(0);
  };
  const setCategory = (c) => {
    memo.category = c;
    setCategoryRaw(c);
    setPage(0);
  };
  const setSort = (s) => {
    memo.sort = s;
    setSortRaw(s);
    setPage(0);
  };
  const setSearch = (s) => {
    memo.search = s;
    setSearchRaw(s);
    setPage(0);
  };
  const setFilter = (k, v) => {
    memo[k] = v;
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
    const enabled = (e) => isGM || shop.categories?.[e.file] !== false;
    if (section === 'all') return catalog.entries.filter(enabled);
    return catalog.entries.filter((e) => e.section === section && enabled(e));
  }, [catalog, section, specials, isGM, shop.categories]);

  const categories = useMemo(() => {
    const m = new Map();
    for (const e of base) m.set(e.category, (m.get(e.category) || 0) + 1);
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0], 'fr')).map(([name, count]) => ({ name, count }));
  }, [base]);

  const results = useMemo(() => {
    const words = fold(search).split(/\s+/).filter(Boolean);
    const minP = filters.minPrice === '' ? null : Number(filters.minPrice);
    const maxP = filters.maxPrice === '' ? null : Number(filters.maxPrice);
    const out = [];
    for (const e of base) {
      if (category && e.category !== category) continue;
      if (words.length && !words.every((w) => e.search.includes(w))) continue;
      const q = priceEntry(e, {}, shop);
      if (!filters.showR && q.legality === 'R') continue;
      if (!filters.showF && q.legality === 'F') continue;
      const st = buyStatus(shop, e, q, isGM);
      if (!isGM && filters.hideUnavailable && !st.ok && st.reason !== 'Boutique fermée') continue;
      if (minP !== null && Number.isFinite(minP) && q.unitCost < minP) continue;
      if (maxP !== null && Number.isFinite(maxP) && q.unitCost > maxP) continue;
      out.push({ e, q, st });
    }
    const byName = (a, b) => a.e.name.localeCompare(b.e.name, 'fr');
    if (sort === 'price') out.sort((a, b) => a.q.unitCost - b.q.unitCost || byName(a, b));
    else if (sort === '-price') out.sort((a, b) => b.q.unitCost - a.q.unitCost || byName(a, b));
    else if (sort === 'avail') out.sort((a, b) => a.q.availValue - b.q.availValue || byName(a, b));
    else out.sort(byName);
    return out;
  }, [base, category, search, sort, filters, shop, isGM]);

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

  const quickAdd = (ev, r) => {
    ev.stopPropagation();
    if (!actor) return toast('Choisis d’abord un personnage', 'warn');
    const l = { ref: r.e.ref, qty: 1, name: r.e.name };
    if (!r.e.special && r.e.item?.rating) l.rating = r.e.item.rating.min;
    if (!r.e.special && r.q.grade) l.grade = r.q.grade;
    if (!r.e.special && r.e.item?.costRange) l.price = r.e.item.costRange[0];
    addToCart(actor.id, l);
    toast(`${r.e.name} ajouté au panier`, 'success', 1800);
  };

  const counts = useMemo(() => {
    const c = {};
    for (const e of catalog?.entries || []) if (isGM || shop.categories?.[e.file] !== false) c[e.section] = (c[e.section] || 0) + 1;
    return c;
  }, [catalog, isGM, shop.categories]);
  const sectionCount = (s) => (s.id === 'specials' ? specials.length : s.id === 'all' ? null : counts[s.id] || 0);

  if (!catalog) return html`<div class="shop-loading">Connexion au catalogue de Cabana…</div>`;

  const sidebar = html`<nav class=${'shop-sidebar' + (narrow ? ' narrow' : '')}>
    ${sections.map(
      (s) => html`<div class="shop-sec-wrap">
        <button class=${'shop-sec' + (s.id === section ? ' active' : '') + (s.id === 'specials' ? ' special' : '')} onClick=${() => setSection(s.id)}>
          <span class="shop-sec-icon">${s.icon}</span><span class="grow">${s.label}</span>
          ${!narrow && sectionCount(s) !== null ? html`<span class="shop-sec-count">${sectionCount(s)}</span>` : null}
        </button>
        ${!narrow &&
        s.id === section &&
        categories.length > 1 &&
        html`<div class="shop-cats">
          <button class=${'shop-cat' + (!category ? ' active' : '')} onClick=${() => setCategory('')}>Toutes <span class="faint">${base.length}</span></button>
          ${categories.map((c) => html`<button class=${'shop-cat' + (category === c.name ? ' active' : '')} onClick=${() => setCategory(c.name)} title=${c.name}>${c.name} <span class="faint">${c.count}</span></button>`)}
        </div>`}
      </div>`
    )}
  </nav>`;

  const toolbar = html`<div class="shop-toolbar">
    <div class="row wrap">
      <${SearchBox} value=${search} onChange=${setSearch} placeholder="Rechercher (FR ou EN)…" />
      ${narrow && categories.length > 1 && html`<${Select} class="shop-cat-select" value=${category} onChange=${setCategory} options=${[{ value: '', label: `Toutes catégories (${base.length})` }, ...categories.map((c) => ({ value: c.name, label: `${c.name} (${c.count})` }))]} />`}
      <${Select} class="shop-sort" value=${sort} onChange=${setSort} options=${SORTS} />
      <${Button} small variant=${showFilters ? 'primary' : 'ghost'} onClick=${() => setShowFilters(!showFilters)}>Filtres</${Button}>
      <span class="muted small grow right">${results.length} article${results.length > 1 ? 's' : ''}</span>
    </div>
    ${showFilters &&
    html`<div class="shop-filters row wrap">
      ${!isGM && html`<${Toggle} value=${filters.hideUnavailable} onChange=${(v) => setFilter('hideUnavailable', v)} label=${`Masquer l’inaccessible (dispo > ${shop.maxAvail})`} />`}
      <${Toggle} value=${filters.showR} onChange=${(v) => setFilter('showR', v)} label="Restreint (R)" />
      <${Toggle} value=${filters.showF} onChange=${(v) => setFilter('showF', v)} label="Interdit (F)" />
      <label class="row gap-s small">Prix
        <input class="input shop-price-input" type="number" min="0" placeholder="min" value=${filters.minPrice} onInput=${(e) => setFilter('minPrice', e.target.value)} />
        –
        <input class="input shop-price-input" type="number" min="0" placeholder="max" value=${filters.maxPrice} onInput=${(e) => setFilter('maxPrice', e.target.value)} />
      </label>
    </div>`}
  </div>`;

  const list =
    section === 'specials'
      ? html`<div class="shop-specials">
          ${!shown.length && html`<${Empty}>${isGM ? 'Aucune offre. Crée-en depuis un article (« + Offre Cabana ») ou dans l’onglet « Offres de Cabana ».' : 'Cabana n’a rien de spécial pour toi en ce moment.'}</${Empty}>`}
          ${shown.map(
            (r) => html`<div class=${'card clickable shop-special' + (selected === r.e.ref ? ' selected' : '') + (r.e.special.hidden ? ' draft' : '')} onClick=${() => setSelected(r.e.ref)}>
              <div class="spread row"><h4>${r.e.name}</h4>${r.e.special.hidden && html`<${Badge} color="amber">Caché</${Badge}>`}</div>
              <div class="row wrap gap-s small">
                <${Badge}>${r.e.category}</${Badge}>
                <${AvailBadge} avail=${r.q.avail} value=${r.q.availValue} legality=${r.q.legality} />
                ${r.e.special.stock === null || r.e.special.stock === undefined ? null : r.e.special.stock > 0 ? html`<span class="muted">${r.e.special.stock} en stock</span>` : html`<${Badge} color="red">Épuisé</${Badge}>`}
              </div>
              ${r.e.special.notes && html`<p class="shop-special-notes">${r.e.special.notes}</p>`}
              <div class="spread row">
                <div>${r.e.special.originalCost > r.e.special.cost ? html`<span class="shop-old-price">${nuyen(r.e.special.originalCost)}</span>` : null}<span class="shop-price">${nuyen(r.q.unitCost)}</span></div>
                <${Button} small variant="primary" disabled=${!r.st.ok || !actor} onClick=${(ev) => quickAdd(ev, r)}>+ Panier</${Button}>
              </div>
            </div>`
          )}
        </div>`
      : html`<div class="shop-results">
          ${!shown.length
            ? html`<${Empty}>${catalog.error && !catalog.entries.length ? 'Catalogue introuvable — le MJ doit lancer « npm run build:catalog ».' : 'Rien ne correspond à ta recherche.'}</${Empty}>`
            : html`<table class="sr shop-table">
                <thead><tr><th>Article</th>${!narrow && html`<th>Catégorie</th>`}<th>Dispo</th><th class="right">Prix</th><th></th></tr></thead>
                <tbody>
                  ${shown.map(
                    (r) => html`<tr class=${'shop-row' + (selected === r.e.ref ? ' selected' : '') + (!r.st.ok ? ' blocked' : '')} onClick=${() => setSelected(r.e.ref)}>
                      <td>
                        <div class="shop-row-name">${r.e.name}</div>
                        ${r.e.item?.nameFr && r.e.item.name !== r.e.name ? html`<div class="faint small">${r.e.item.name}</div>` : null}
                        ${narrow && html`<div class="faint small">${r.e.category}</div>`}
                      </td>
                      ${!narrow && html`<td class="muted small">${r.e.category}</td>`}
                      <td><${AvailBadge} avail=${r.q.avail} value=${r.q.availValue} legality=${r.q.legality} max=${isGM ? undefined : shop.maxAvail} /></td>
                      <td class="num-cell">${(r.e.item?.rating && r.e.item.rating.max > r.e.item.rating.min) || r.e.item?.costRange ? html`<span class="faint small">dès </span>` : null}${nuyen(r.q.unitCost)}</td>
                      <td class="right"><${IconButton} icon="+" title=${r.st.ok ? 'Ajouter au panier' : r.st.reason} disabled=${!r.st.ok || !actor} onClick=${(ev) => quickAdd(ev, r)} /></td>
                    </tr>`
                  )}
                </tbody>
              </table>`}
        </div>`;

  const pager =
    pages > 1 &&
    html`<div class="shop-pager row">
      <${Button} small variant="ghost" disabled=${curPage === 0} onClick=${() => setPage(curPage - 1)}>‹ Précédent</${Button}>
      <span class="muted small">Page ${curPage + 1} / ${pages}</span>
      <${Button} small variant="ghost" disabled=${curPage >= pages - 1} onClick=${() => setPage(curPage + 1)}>Suivant ›</${Button}>
    </div>`;

  return html`<div class=${'shop-store' + (wide ? ' wide' : '') + (narrow ? ' narrow' : '')}>
    ${sidebar}
    <div class="shop-main">
      ${toolbar}
      ${!shop.open && !isGM && html`<div class="shop-closed">Cabana n’est pas joignable pour l’instant. Tu peux parcourir le catalogue, mais pas commander.</div>`}
      ${list}
      ${pager}
    </div>
    ${wide &&
    html`<aside class="shop-side">
      ${selEntry ? html`<${ItemDetail} key=${selEntry.ref} entry=${selEntry} game=${game} actor=${actor} />` : html`<${Empty}>Sélectionne un article pour voir ses caractéristiques.</${Empty}>`}
    </aside>`}
    ${!wide && selEntry && html`<${Modal} title=${selEntry.name} width=${560} onClose=${() => setSelected(null)}>
      <${ItemDetail} key=${selEntry.ref} entry=${selEntry} game=${game} actor=${actor} compact />
    </${Modal}>`}
  </div>`;
}
