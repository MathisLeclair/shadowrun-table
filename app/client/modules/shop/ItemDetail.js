// Item detail panel: stats, rating / grade / quantity pickers, price & essence impact, add to cart, GM actions.
import { useEffect, useState } from 'preact/hooks';
import { html, Button, Badge, Stat, NumberInput, Select, Toggle, Field, confirmAction } from '../../lib/ui.js';
import { send } from '../../lib/net.js';
import { toast } from '../../lib/ui-store.js';
import { SKILL_BY_ID, ATTR_SHORT } from '/shared/sr5.js';
import { GRADES, allowedGrades, evalFormula, magicLoss, DEVICE_GEAR, LEGALITY_LABEL } from './rules.js';
import { priceEntry, buyStatus, addToCart, nuyen, AvailBadge } from './common.js';

const signed = (v) => (typeof v === 'number' ? (v > 0 ? `+${v}` : String(v)) : String(v ?? '—'));
const evalAt = (f, rating) => {
  if (typeof f === 'number') return f;
  try {
    return Math.round(evalFormula(f, { Rating: rating ?? 1 }) * 100) / 100;
  } catch {
    return f;
  }
};

/** [label, value] pairs describing an item for its type. */
export function statRows(file, item, stats, q) {
  const s = stats || item?.stats || {};
  const r = q?.rating;
  const rows = [];
  const push = (label, v) => v !== undefined && v !== null && v !== '' && rows.push([label, v]);
  const weapon = (w) => {
    push('Précision', w.accuracy === 'Physical' ? 'Physique' : w.accuracy);
    push('Dégâts', w.damage);
    push('PA', w.ap === 0 ? '—' : signed(w.ap));
    push('Mode', w.mode);
    if (w.rc) push('RC', w.rc);
    push('Munitions', w.ammo);
    if (w.reach) push('Allonge', w.reach);
    push('Compétence', SKILL_BY_ID[w.skill]?.fr || w.skill);
  };
  if (file === 'weapons' && !s.accessory) {
    weapon(s);
    if (s.conceal !== undefined) push('Dissim.', signed(s.conceal));
  } else if (file === 'weapons') {
    push('Montage', s.mount);
    if (s.accuracy) push('Précision', signed(s.accuracy));
    if (s.rc) push('RC', signed(s.rc));
    if (s.conceal) push('Dissim.', signed(s.conceal));
  } else if (file === 'armor') {
    if (s.armor !== undefined) push('Armure', s.stack ? `+${evalAt(s.armor, r)}` : evalAt(s.armor, r));
    if (s.stack) push('Cumul', 'Oui');
    push('Capacité', s.capacity);
  } else if (file === 'cyberware' || file === 'bioware') {
    if (q?.essence !== undefined) push('Essence', q.essence);
    push('Capacité', s.capacity);
    for (const [k, f] of Object.entries(s.bonus?.attributes || {})) push(ATTR_SHORT[k] || k, `+${evalAt(f, r)}`);
    if (s.bonus?.initiativeDice) push('Init.', `+${evalAt(s.bonus.initiativeDice, r)}D6`);
    if (s.weapon) weapon(s.weapon);
  } else if (file === 'vehicles') {
    push('Maniabilité', s.handling);
    push('Vitesse', s.speed);
    push('Accél.', s.accel);
    push('Structure', s.body);
    push('Blindage', s.armor);
    push('Autopilote', s.pilot);
    push('Senseurs', s.sensor);
    push('Places', s.seats);
  } else if (file === 'lifestyles') {
    push('Coût', `${nuyen(item?.cost ?? q?.unitCost)}/mois`);
  } else {
    if (s.deviceRating !== undefined) push('Indice', evalAt(s.deviceRating, r));
    if (Array.isArray(s.attributeArray)) push('Attributs', s.attributeArray.join(' / '));
    if (s.attack) push('Attaque', s.attack);
    if (s.sleaze) push('Corruption', s.sleaze);
    if (s.dataProcessing !== undefined) push('Traitement', s.dataProcessing);
    if (s.firewall !== undefined) push('Firewall', s.firewall);
    if (s.programs) push('Programmes', s.programs);
    if (s.costFor) push('Lot', `×${s.costFor}`);
    if (s.capacity) push('Capacité', s.capacity);
    if (s.weapon) weapon(s.weapon);
  }
  return rows;
}

export default function ItemDetail({ entry, game, actor, compact }) {
  const shop = game.shop || {};
  const isGM = game.me.role === 'gm';
  const item = entry.item;
  const sp = entry.special;
  const ware = entry.file === 'cyberware' || entry.file === 'bioware';
  const rated = !sp && item?.rating && item.rating.max > item.rating.min;
  const grades = !sp && ware ? allowedGrades(item) : [];
  const isDevice = !!item && entry.file === 'gear' && DEVICE_GEAR.has(item.category);

  const [rating, setRating] = useState(item?.rating?.min ?? null);
  const [grade, setGrade] = useState(grades.includes('standard') ? 'standard' : grades[0] || null);
  const [qty, setQty] = useState(1);
  const [price, setPrice] = useState(item?.costRange ? item.costRange[0] : null);
  const [setMatrix, setSetMatrix] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setRating(item?.rating?.min ?? null);
    setGrade(grades.includes('standard') ? 'standard' : grades[0] || null);
    setQty(1);
    setPrice(item?.costRange ? item.costRange[0] : null);
    setSetMatrix(isDevice && !!actor && !(actor.matrix && actor.matrix.device));
  }, [entry.ref]);

  const opts = { rating: rated ? rating : item?.rating?.min, grade: ware ? grade : undefined, price: item?.costRange ? price : undefined };
  const q = priceEntry(entry, opts, shop);
  const status = buyStatus(shop, entry, q, isGM);
  const total = q.unitCost * qty;
  const rows = statRows(entry.file, item, sp?.stats || item?.stats, q);
  const stockOut = sp && sp.stock !== null && sp.stock !== undefined && sp.stock < qty;

  // Essence / Magic impact for 'ware.
  let essInfo = null;
  if (ware && actor) {
    const essBefore = Number(actor.attributes?.ESS ?? 6);
    const cost = Math.round((q.essence || 0) * qty * 1000) / 1000;
    const essAfter = Math.round((essBefore - cost) * 1000) / 1000;
    const loss = magicLoss(essBefore, essAfter);
    const awakened = Number(actor.attributes?.MAG) > 0 ? 'Magie' : Number(actor.attributes?.RES) > 0 ? 'Résonance' : null;
    essInfo = { essBefore, essAfter, cost, loss, awakened, fatal: essAfter <= 0 };
  }

  const line = () => {
    const l = { ref: entry.ref, qty, name: entry.name };
    if (!sp && item?.rating) l.rating = rated ? rating : item.rating.min;
    if (!sp && ware && grade) l.grade = grade;
    if (!sp && item?.costRange) l.price = price;
    if (isDevice && setMatrix) l.setMatrix = true;
    return l;
  };

  const add = () => {
    if (!actor) return toast('Choisis d’abord un personnage', 'warn');
    addToCart(actor.id, line());
    toast(`${entry.name} ajouté au panier`, 'success', 2000);
  };
  const strip = (l) => {
    const { name, ...rest } = l;
    return rest;
  };
  const gmSell = async () => {
    if (!actor) return toast('Choisis un PJ', 'warn');
    if (!(await confirmAction(`Vendre ${entry.name}${qty > 1 ? ` ×${qty}` : ''} à ${actor.name} pour ${nuyen(total)} ?`))) return;
    setBusy(true);
    try {
      await send('shop/buy', { actorId: actor.id, items: [strip(line())] });
      toast(`${actor.name} a payé ${nuyen(total)}`, 'success');
    } catch {}
    setBusy(false);
  };
  const gmGive = async () => {
    if (!actor) return toast('Choisis un PJ', 'warn');
    setBusy(true);
    try {
      await send('shop/give', { actorId: actor.id, items: [strip(line())] });
      toast(`${entry.name} donné à ${actor.name}`, 'success');
    } catch {}
    setBusy(false);
  };
  const gmSpecial = async () => {
    try {
      await send('shop/addSpecial', { fromRef: item.id, rating: opts.rating, grade: opts.grade });
      toast('Offre ajoutée chez Cabana — à ajuster dans « Offres de Cabana »', 'success');
    } catch {}
  };

  const legal = q.legality ? LEGALITY_LABEL[q.legality] : 'Légal';
  return html`<div class=${'shop-detail' + (compact ? ' compact' : '')}>
    <div class="shop-detail-head">
      <div class="grow">
        <h3>${entry.name}</h3>
        ${item && item.nameFr && item.name !== entry.name && html`<div class="muted small">${item.name}</div>`}
        <div class="row wrap gap-s shop-detail-tags">
          ${sp ? html`<${Badge} color="magenta">Offre de Cabana</${Badge}>` : null}
          <${Badge}>${entry.category}</${Badge}>
          <${AvailBadge} avail=${q.avail} value=${q.availValue} legality=${q.legality} max=${isGM || sp ? undefined : shop.maxAvail} />
          <span class="muted small">${legal}</span>
          ${item?.source && html`<span class="faint small mono" title="Source">${item.source} p.${item.page}</span>`}
        </div>
      </div>
    </div>

    ${sp?.notes && html`<p class="shop-notes">${sp.notes}</p>`}
    ${isGM && sp?.gmNotes && html`<p class="shop-notes gm"><strong>MJ :</strong> ${sp.gmNotes}</p>`}
    ${sp && html`<div class="row gap-s small">
      ${sp.stock === null || sp.stock === undefined ? html`<${Badge} color="cyan">Stock illimité</${Badge}>` : sp.stock > 0 ? html`<${Badge} color="cyan">${sp.stock} en stock</${Badge}>` : html`<${Badge} color="red">Épuisé</${Badge}>`}
      ${sp.rating ? html`<${Badge}>Indice ${sp.rating}</${Badge}>` : null}
      ${sp.grade && sp.grade !== 'standard' ? html`<${Badge}>${GRADES[sp.grade]?.label}</${Badge}>` : null}
      ${sp.hidden ? html`<${Badge} color="amber">Brouillon (caché)</${Badge}>` : null}
    </div>`}

    ${rows.length > 0 && html`<div class="shop-stats">${rows.map(([l, v]) => html`<${Stat} label=${l} value=${v} />`)}</div>`}

    <div class="shop-config">
      ${rated &&
      html`<${Field} label=${`Indice : ${rating}`}>
        <input type="range" class="shop-range" min=${item.rating.min} max=${item.rating.max} step="1" value=${rating} onInput=${(e) => setRating(Number(e.target.value))} />
        <div class="spread row small faint"><span>${item.rating.min}</span><span>${item.rating.max}</span></div>
      </${Field}>`}
      ${!sp && item?.rating && !rated && html`<div class="small muted">Indice ${item.rating.min}</div>`}
      ${grades.length > 1 &&
      html`<${Field} label="Grade">
        <${Select} value=${grade} onChange=${setGrade} options=${grades.map((g) => ({ value: g, label: `${GRADES[g].label} (Ess ×${GRADES[g].ess}, prix ×${GRADES[g].cost}, dispo ${GRADES[g].avail >= 0 ? '+' : ''}${GRADES[g].avail})` }))} />
      </${Field}>`}
      ${item?.costRange &&
      html`<${Field} label="Prix négocié" hint=${`Entre ${nuyen(item.costRange[0])} et ${nuyen(item.costRange[1])} — validé par le MJ`}>
        <${NumberInput} value=${price} min=${item.costRange[0]} max=${item.costRange[1]} step=${100} onChange=${setPrice} />
      </${Field}>`}
      ${entry.file !== 'lifestyles'
        ? html`<${Field} label="Quantité"><${NumberInput} value=${qty} min=${1} max=${sp && sp.stock !== null && sp.stock !== undefined ? Math.max(1, sp.stock) : 99} onChange=${setQty} /></${Field}>`
        : html`<${Field} label="Mois payés d’avance"><${NumberInput} value=${qty} min=${1} max=${24} onChange=${setQty} /></${Field}>`}
      ${isDevice && html`<${Toggle} value=${setMatrix} onChange=${setSetMatrix} label="En faire l’appareil Matriciel du personnage" />`}
    </div>

    ${essInfo &&
    html`<div class=${'shop-ess' + (essInfo.fatal ? ' fatal' : essInfo.loss && essInfo.awakened ? ' warn' : '')}>
      <div>Essence : <strong class="mono">${essInfo.essBefore}</strong> → <strong class="mono">${essInfo.essAfter}</strong> <span class="muted">(−${essInfo.cost})</span></div>
      ${essInfo.fatal && html`<div>⚠ Essence à zéro : ce serait mortel.</div>`}
      ${!essInfo.fatal && essInfo.loss > 0 && essInfo.awakened && html`<div>⚠ ${essInfo.awakened} −${essInfo.loss} : chaque point d’Essence entamé coûte un point de ${essInfo.awakened} (adeptes compris).</div>`}
      <div class="faint small">L’Essence perdue ne revient pas, même en revendant l’implant.</div>
    </div>`}

    <div class="shop-price-row">
      <div>
        ${sp?.originalCost && sp.originalCost > sp.cost ? html`<span class="shop-old-price">${nuyen(sp.originalCost)}</span>` : null}
        <span class="shop-price">${nuyen(total)}</span>
        ${qty > 1 && html`<span class="muted small"> (${nuyen(q.unitCost)} l’unité)</span>`}
        ${entry.file === 'lifestyles' && html`<span class="muted small"> (${nuyen(q.unitCost)}/mois)</span>`}
      </div>
      ${!isGM && actor && html`<div class=${'small ' + ((Number(actor.nuyen) || 0) < total ? 'red' : 'muted')}>Disponible : ${nuyen(actor.nuyen)}</div>`}
    </div>

    ${!status.ok && html`<div class="shop-blocked">${status.reason === 'Boutique fermée' ? 'Cabana n’est pas joignable pour l’instant.' : `Indisponible : ${status.reason}`}</div>`}
    ${status.ok && status.approval && html`<div class="shop-approval">Cet achat sera soumis au MJ avant livraison.</div>`}
    ${stockOut && html`<div class="shop-blocked">Stock insuffisant.</div>`}

    <div class="row wrap shop-detail-actions">
      <${Button} variant="primary" disabled=${!status.ok || stockOut || !actor} onClick=${add}>Ajouter au panier</${Button}>
      ${isGM &&
      html`
        <${Button} variant="accent" disabled=${busy || !actor || stockOut} onClick=${gmSell} title="Débite le PJ immédiatement">Vendre au PJ</${Button}>
        <${Button} disabled=${busy || !actor || stockOut} onClick=${gmGive} title="Gratuit, sans contrôle">Donner</${Button}>
        ${!sp && html`<${Button} variant="ghost" small onClick=${gmSpecial} title="Crée une offre de Cabana à partir de cet article">+ Offre Cabana</${Button}>`}
      `}
    </div>
    ${isGM && !actor && html`<div class="muted small">Choisis un PJ en haut de la page pour vendre ou donner.</div>`}
  </div>`;
}
