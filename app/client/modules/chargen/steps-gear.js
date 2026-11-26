// Wizard step: Équipement & cyberware (shop catalog, resources budget, availability ≤ 12, Essence, lifestyle).
import { useMemo, useState } from 'preact/hooks';
import { html, Button, Select, NumberInput, Panel, IconButton, Toggle, SearchBox, Empty, Field, Stat, Badge } from '../../lib/ui.js';
import { STORE_SECTIONS, quote, allowedGrades, GRADES, clampRating, fold, targetList, upgradeAvail, MOUNT_LABELS, armorCapacity } from '../shop/rules.js';
import { AvailBadge } from '../shop/common.js';
import { statRows } from '../shop/ItemDetail.js';
import { CREATION_GRADES, CREATION_UPGRADES, LIMITS, rowId } from '/shared/chargen.js';
import { t, itemName, compare, fmtNumber } from '../../lib/i18n.js';
import { Budget, StepIssues, nuyen } from './common.js';
import { ItemRef } from '../books/BookRef.js';

// Creation sections: the shop's, with weapon accessories and armor mods (installed on a weapon / armor of the draft).
const GEAR_SECTIONS = STORE_SECTIONS.filter((s) => !['lifestyles', 'vehiclemods', 'martialarts'].includes(s.id));
const PAGE = 40;
const memo = { section: 'weapons', category: '', q: '', availOk: true };

export function StepGear({ data, update, result, issues, rc }) {
  const r = result;
  const shop = rc.shop;
  const [section, setSection] = useState(memo.section);
  const [category, setCategory] = useState(memo.category);
  const [q, setQ] = useState(memo.q);
  const [availOk, setAvailOk] = useState(memo.availOk);
  const [page, setPage] = useState(1);
  const [sel, setSel] = useState(null);
  Object.assign(memo, { section, category, q, availOk });

  const sec = GEAR_SECTIONS.find((s) => s.id === section) || GEAR_SECTIONS[0];
  const inSection = useMemo(() => (shop ? shop.entries.filter((e) => sec.match(e.file, e.item)) : []), [shop, section]);
  const categories = useMemo(() => [...new Set(inSection.map((e) => e.category))].sort(compare), [inSection]);
  const list = useMemo(() => {
    const words = fold(q.trim()).split(/\s+/).filter(Boolean);
    return inSection
      .filter((e) => (!category || e.category === category) && words.every((w) => e.search.includes(w)))
      .map((e) => {
        let qt = null;
        try {
          qt = quote(e.item, {});
        } catch {}
        return { e, qt };
      })
      .filter((x) => x.qt && (!availOk || x.qt.availValue <= LIMITS.maxAvail))
      .sort((a, b) => compare(a.e.name, b.e.name));
  }, [inSection, category, q, availOk]);
  const shown = list.slice(0, PAGE * page);
  const lifestyles = useMemo(() => (shop ? shop.entries.filter((e) => e.file === 'lifestyles').sort((a, b) => (a.item.cost || 0) - (b.item.cost || 0)) : []), [shop]);

  if (!shop) return html`<div class="cg-step"><div class="cg-loading">${t('Chargement du catalogue…')}</div></div>`;

  const setLine = (id, k, v) =>
    update((d) => {
      const x = d.gear.find((y) => y.id === id);
      if (x) x[k] = v;
    });

  return html`<div class="cg-step">
    <div class="row wrap cg-budget-row">
      <${Budget} label=${t('Nuyens')} used=${r.nuyen.spent} total=${r.nuyen.total} format=${nuyen} title=${t('Ressources + karma converti')} />
      <div class=${'cg-budget ' + (r.essence <= 0 ? 'over' : r.essence < 6 ? 'left' : 'ok')}><span class="cg-budget-label">${t('Essence')}</span><span class="cg-budget-value">${fmtNumber(r.essence)}</span></div>
      <div class="cg-budget left" title=${t('Ce qui reste après la création (5 000¥ maximum)')}><span class="cg-budget-label">${t('Conservés')}</span><span class="cg-budget-value">${nuyen(r.nuyen.kept)}</span></div>
    </div>
    <div class="cg-gear">
      <div class="cg-gear-browser">
        <div class="row wrap gap-s">
          <${Select} class="cg-gear-section" value=${section} onChange=${(v) => (setSection(v), setCategory(''), setPage(1), setSel(null))} options=${GEAR_SECTIONS.map((s) => ({ value: s.id, label: `${s.icon} ${t(s.label)}` }))} />
          <${Select} class="cg-gear-cat" value=${category} onChange=${(v) => (setCategory(v), setPage(1))} options=${[{ value: '', label: t('Toutes catégories') }, ...categories]} />
          <${SearchBox} value=${q} onChange=${(v) => (setQ(v), setPage(1))} placeholder=${t('Chercher…')} />
          <${Toggle} value=${availOk} onChange=${setAvailOk} label=${t('Dispo ≤ 12')} title=${t('Masquer ce qui n’est pas accessible à la création')} />
        </div>
        <div class="cg-gear-list">
          <table class="sr">
            <thead><tr><th>${t('Article')}</th><th>${t('Catégorie')}</th><th>${t('Dispo')}</th><th class="right">${t('Prix')}</th></tr></thead>
            <tbody>
              ${shown.map(({ e, qt }) => html`<tr key=${e.ref} class=${'cg-gear-row' + (sel === e.ref ? ' sel' : '')} onClick=${() => setSel(e.ref)}>
                <td><strong>${e.name}</strong> <${ItemRef} item=${e.item} />${e.item.rating ? html` <span class="faint small">${t('ind. {min}–{max}', { min: e.item.rating.min, max: e.item.rating.max })}</span>` : ''}</td>
                <td class="small muted">${e.category}</td>
                <td><${AvailBadge} avail=${qt.avail} value=${qt.availValue} legality=${qt.legality} max=${LIMITS.maxAvail} /></td>
                <td class="num-cell">${e.item.costRange ? t('variable') : nuyen(qt.unitCost)}</td>
              </tr>`)}
              ${!list.length && html`<tr><td colspan="4"><${Empty}>${t('Rien ne correspond.')}</${Empty}></td></tr>`}
            </tbody>
          </table>
          ${shown.length < list.length && html`<div class="center cg-pad"><${Button} small variant="ghost" onClick=${() => setPage(page + 1)}>${t('Afficher plus ({n})', { n: list.length - shown.length })}</${Button}></div>`}
        </div>
      </div>
      <div class="cg-gear-side">
        ${sel && shop.byId.get(sel) && html`<${GearDetail} key=${sel} entry=${shop.byId.get(sel)} essence=${r.essence} lines=${r.gearLines} onClose=${() => setSel(null)}
          onAdd=${(line) => update((d) => d.gear.push({ id: rowId('g'), ...line }))} />`}
        <${Panel} title=${t('Achats ({n})', { n: data.gear.length })} pad=${false}>
          <table class="sr cg-cart">
            <tbody>
              ${r.gearLines.map((l) => {
                const row = l.row;
                return html`<tr key=${row.id}>
                  <td><strong>${l.item ? itemName(l.item) : l.name}</strong> <${ItemRef} item=${l.item} />
                    <div class="small muted">${[l.quote?.rating ? t('ind. {n}', { n: l.quote.rating }) : '', l.quote?.grade && l.quote.grade !== 'standard' && GRADES[l.quote.grade] ? t(GRADES[l.quote.grade].label) : '', l.essence ? t('ess. {n}', { n: fmtNumber(l.essence) }) : '', l.quote ? l.quote.avail : '', l.target ? t('sur {target}', { target: l.target.name }) : '', l.mount && MOUNT_LABELS[l.mount] ? t(MOUNT_LABELS[l.mount]) : ''].filter(Boolean).join(' · ')}</div></td>
                  <td>${l.file === 'cyberware' || l.file === 'bioware' || l.upgrade ? '' : html`<${NumberInput} small value=${row.qty} min=${1} max=${99} onChange=${(v) => setLine(row.id, 'qty', v)} />`}</td>
                  <td class="num-cell">${l.total !== undefined ? nuyen(l.total) : '—'}</td>
                  <td><${IconButton} icon="✕" title=${t('Retirer')} onClick=${() => update((d) => (d.gear = d.gear.filter((x) => x.id !== row.id)))} /></td>
                </tr>`;
              })}
              ${!r.gearLines.length && html`<tr><td colspan="4" class="muted center">${t('Clique un article à gauche pour l’ajouter.')}</td></tr>`}
            </tbody>
          </table>
        </${Panel}>
        <${Panel} title=${t('Train de vie & finances')} class="cg-mt">
          <div class="col">
            <${Field} label=${t('Train de vie')} hint=${r.lifestyle ? (data.metatype === 'Nain' ? t('{nuyen} / mois (nain +20 %)', { nuyen: nuyen(r.lifestyle.monthly) }) : data.metatype === 'Troll' ? t('{nuyen} / mois (troll +100 %)', { nuyen: nuyen(r.lifestyle.monthly) }) : t('{nuyen} / mois', { nuyen: nuyen(r.lifestyle.monthly) })) : t('Au moins un mois payé à la création')}>
              <${Select} value=${data.lifestyle?.catalogId || ''} onChange=${(v) => update((d) => (d.lifestyle = v ? { catalogId: v, months: d.lifestyle?.months || 1 } : null))}
                options=${[{ value: '', label: t('— Choisir —') }, ...lifestyles.map((e) => ({ value: e.ref, label: t('{name} — {nuyen}/mois', { name: e.name, nuyen: nuyen(e.item.cost) }) }))]} />
            </${Field}>
            ${data.lifestyle && html`<div class="row wrap">
              <${Field} label=${t('Mois payés')}><${NumberInput} value=${data.lifestyle.months} min=${1} max=${12} onChange=${(v) => update((d) => (d.lifestyle.months = v))} /></${Field}>
              <${Field} label=${t('Nuyen de départ')} hint=${r.lifestyle?.dice ? t('{dice}D6 × {mult}¥, lancés par le MJ à la validation', { dice: r.lifestyle.dice, mult: r.lifestyle.multiplier }) : t('Pas de jet pour ce train de vie')}>
                <${Toggle} value=${data.rollStartingNuyen} onChange=${(v) => update((d) => (d.rollStartingNuyen = v))} label=${t('Lancer')} />
              </${Field}>
            </div>`}
            <${Field} label=${t('Karma converti en nuyens')} hint=${t('2 000¥ par karma, {max} maximum', { max: LIMITS.karmaToNuyenMax })}>
              <${NumberInput} value=${data.karmaToNuyen} min=${0} max=${LIMITS.karmaToNuyenMax} onChange=${(v) => update((d) => (d.karmaToNuyen = v))} />
            </${Field}>
            <div class="cg-money small">
              <div class="spread row"><span>${t('Ressources')}</span><span class="mono">${nuyen(r.nuyen.resources)}</span></div>
              ${r.nuyen.fromKarma > 0 && html`<div class="spread row"><span>${t('Karma converti')}</span><span class="mono">+${nuyen(r.nuyen.fromKarma)}</span></div>`}
              <div class="spread row"><span>${t('Équipement')}</span><span class="mono">−${nuyen(r.nuyen.gear)}</span></div>
              <div class="spread row"><span>${t('Train de vie')}</span><span class="mono">−${nuyen(r.nuyen.lifestyle)}</span></div>
              <div class=${'spread row cg-money-total ' + (r.nuyen.left < 0 ? 'red' : '')}><span>${t('Reste')}</span><span class="mono">${nuyen(r.nuyen.left)}</span></div>
            </div>
          </div>
        </${Panel}>
      </div>
    </div>
    <${StepIssues} issues=${issues} />
  </div>`;
}

function GearDetail({ entry, essence, lines = [], onAdd, onClose }) {
  const item = entry.item;
  const ware = entry.file === 'cyberware' || entry.file === 'bioware';
  // Weapon accessory / armor mod: installed on a weapon / armor already in the cart (price and fit depend on it).
  const up = CREATION_UPGRADES[entry.file] || null;
  const targets = up ? lines.filter((l) => !l.upgrade && l.file === up.file && l.item && l.quote && targetList(l.file, l.item) === up.list) : [];
  const [targetRow, setTargetRow] = useState(targets[0]?.row.id || '');
  const [mount, setMount] = useState('');
  const tl = targets.find((l) => l.row.id === targetRow) || null;
  const grades = ware ? allowedGrades(item).filter((g) => CREATION_GRADES.includes(g)) : [];
  const [rating, setRating] = useState(item.rating ? item.rating.min : null);
  const [grade, setGrade] = useState(ware ? (grades.includes('standard') ? 'standard' : grades[0] || 'standard') : null);
  const [qty, setQty] = useState(1);
  let qt = null;
  try {
    if (!up) qt = quote(item, { rating, grade: grade || undefined });
    else if (tl) {
      const tst = tl.item.stats || {};
      const vars = up.file === 'weapons' ? { WeaponCost: tl.quote.unitCost || 0 } : { ArmorCost: tl.quote.unitCost || 0, Capacity: armorCapacity({ capacity: tst.capacity, rating: Number(tst.armor) || 0 }, tl.item) };
      qt = upgradeAvail(quote(item, { rating, vars }), item, tl.quote);
    }
  } catch {}
  const rows = statRows(entry.file, item, item.stats, qt);
  const mounts = up?.file === 'weapons' && Array.isArray(item.stats?.mount) ? item.stats.mount : [];
  const over = qt && qt.availValue > LIMITS.maxAvail;
  const essAfter = ware && qt ? Math.round((essence - (qt.essence || 0) * qty) * 1000) / 1000 : null;
  return html`<${Panel} title=${entry.name} actions=${html`<${IconButton} icon="✕" title=${t('Fermer')} onClick=${onClose} />`} class="cg-mb">
    <div class="col">
      <div class="small muted">${entry.category} · ${item.source} p.${item.page}</div>
      ${rows.length > 0 && html`<div class="cg-stats">${rows.map(([label, v]) => html`<${Stat} label=${label} value=${v} />`)}</div>`}
      <div class="row wrap">
        ${item.rating && html`<${Field} label=${t('Indice')}><${NumberInput} value=${rating} min=${item.rating.min} max=${item.rating.max} onChange=${(v) => setRating(clampRating(item, v))} /></${Field}>`}
        ${ware && html`<${Field} label=${t('Grade')}><${Select} value=${grade} onChange=${setGrade} options=${grades.map((g) => ({ value: g, label: t(GRADES[g].label) }))} /></${Field}>`}
        ${!ware && !up && html`<${Field} label=${t('Quantité')}><${NumberInput} value=${qty} min=${1} max=${99} onChange=${setQty} /></${Field}>`}
        ${up && html`<${Field} label=${up.file === 'weapons' ? t('Sur l’arme') : t('Sur l’armure')}>
          <${Select} value=${targetRow} onChange=${setTargetRow} options=${targets.length ? targets.map((l) => ({ value: l.row.id, label: itemName(l.item) })) : [{ value: '', label: up.file === 'weapons' ? t('— Ajoute d’abord une arme —') : t('— Ajoute d’abord une armure —') }]} /></${Field}>`}
        ${mounts.length > 1 && html`<${Field} label=${t('Emplacement')}><${Select} value=${mount} onChange=${setMount} options=${[{ value: '', label: t('Automatique') }, ...mounts.map((m) => ({ value: m, label: MOUNT_LABELS[m] ? t(MOUNT_LABELS[m]) : m }))]} /></${Field}>`}
      </div>
      ${qt && html`<div class="spread row">
        <span><${AvailBadge} avail=${qt.avail} value=${qt.availValue} legality=${qt.legality} max=${LIMITS.maxAvail} />
          ${ware && html` <${Badge} color=${essAfter <= 0 ? 'red' : 'amber'}>${t('Essence −{cost} → {after}', { cost: fmtNumber(qt.essence), after: fmtNumber(essAfter) })}</${Badge}>`}</span>
        <strong class="mono amber">${item.costRange ? t('Prix variable') : nuyen(qt.unitCost * qty)}</strong>
      </div>`}
      ${over && html`<div class="cg-note err">${t('Disponibilité {avail} : au-dessus de {max}, interdit à la création.', { avail: qt.avail, max: LIMITS.maxAvail })}</div>`}
      <${Button} variant="primary" disabled=${!qt || over || (up && !tl)} onClick=${() => onAdd({ ref: item.id, file: entry.file, name: item.nameFr || item.name, qty: ware || up ? 1 : qty, rating: item.rating ? rating : null, grade: ware ? grade : null, ...(up ? { target: targetRow, ...(mount ? { mount } : {}) } : {}) })}>+ ${t('Ajouter')}</${Button}>
    </div>
  </${Panel}>`;
}
