// Item detail panel: stats, rating / grade / quantity pickers, price & essence impact, add to cart, GM actions.
import { useEffect, useState } from 'preact/hooks';
import { html, Button, Badge, Stat, NumberInput, Select, Toggle, Field, TextInput, confirmAction } from '../../lib/ui.js';
import { send } from '../../lib/net.js';
import { toast } from '../../lib/ui-store.js';
import { t, tk, attrShort, skillLabel, fmtNumber } from '../../lib/i18n.js';
import { SKILL_BY_ID } from '/shared/sr5.js';
import { GRADES, allowedGrades, evalFormula, magicLoss, DEVICE_GEAR, LEGALITY_LABEL, UPGRADE_FILES, MOUNT_LABELS } from './rules.js';
import { targetsFor, upgradePreview, msgText } from './upgrades.js';
import { priceEntry, buyStatus, addToCart, nuyen, AvailBadge, gradeLabel } from './common.js';
import { ItemRef } from '../books/BookRef.js';

// Labels of armor-mod / vehicle-mod bonuses (French keys, render with t()).
const BONUS_LABEL = { fire: tk('Feu'), cold: tk('Froid'), electricity: tk('Électricité'), acid: tk('Acide'), falling: tk('Chute'), toxin: tk('Toxines (contact)'), pathogen: tk('Pathogènes (contact)'), radiation: tk('Radiations') };
const VEHICLE_BONUS_LABEL = { handling: tk('Maniabilité'), speed: tk('Vitesse'), accel: tk('Accél.'), armor: tk('Blindage'), body: tk('Structure'), sensor: tk('Senseurs'), pilot: tk('Autopilote'), seats: tk('Places') };
// Target picker labels per upgrade file.
const UPGRADE_TARGET_LABEL = { accessories: tk('Arme'), armormods: tk('Armure'), vehiclemods: tk('Véhicule'), lifestylequalities: tk('Train de vie') };
const UPGRADE_NONE = {
  accessories: tk('Aucune arme sur laquelle l’installer.'),
  armormods: tk('Aucune armure à modifier.'),
  vehiclemods: tk('Aucun véhicule à modifier.'),
  lifestylequalities: tk('Aucun train de vie : achète d’abord un logement.'),
};

const signed = (v) => (typeof v === 'number' ? (v > 0 ? `+${v}` : String(v)) : String(v ?? '—'));
const evalAt = (f, rating) => {
  if (typeof f === 'number') return f;
  try {
    return Math.round(evalFormula(f, { Rating: rating ?? 1 }) * 100) / 100;
  } catch {
    return f;
  }
};

/** [label, value] pairs describing an item for its type (labels translated: call at render time). */
export function statRows(file, item, stats, q) {
  const s = stats || item?.stats || {};
  const r = q?.rating;
  const rows = [];
  const push = (label, v) => v !== undefined && v !== null && v !== '' && rows.push([label, v]);
  const weapon = (w) => {
    push(t('Précision'), w.accuracy === 'Physical' ? t('Physique') : w.accuracy);
    push(t('Dégâts'), w.damage);
    push(t('PA'), w.ap === 0 ? '—' : signed(w.ap));
    push(t('Mode'), w.mode);
    if (w.rc) push(t('RC'), w.rc);
    push(t('Munitions'), w.ammo);
    if (w.reach) push(t('Allonge'), w.reach);
    push(t('Compétence'), SKILL_BY_ID[w.skill] ? skillLabel(w.skill) : w.skill);
  };
  if (file === 'weapons' && !s.accessory) {
    weapon(s);
    if (s.conceal !== undefined) push(t('Dissim.'), signed(s.conceal));
  } else if (file === 'weapons') {
    push(t('Montage'), s.mount);
    if (s.accuracy) push(t('Précision'), signed(s.accuracy));
    if (s.rc) push(t('RC'), signed(s.rc));
    if (s.conceal) push(t('Dissim.'), signed(s.conceal));
  } else if (file === 'armor') {
    if (s.armor !== undefined) push(t('Armure'), s.stack ? `+${evalAt(s.armor, r)}` : evalAt(s.armor, r));
    if (s.stack) push(t('Cumul'), t('Oui'));
    push(t('Capacité'), s.capacity);
  } else if (file === 'cyberware' || file === 'bioware') {
    if (q?.essence !== undefined) push(t('Essence'), q.essence);
    push(t('Capacité'), s.capacity);
    for (const [k, f] of Object.entries(s.bonus?.attributes || {})) push(attrShort(k), `+${evalAt(f, r)}`);
    if (s.bonus?.initiativeDice) push(t('Init.'), `+${evalAt(s.bonus.initiativeDice, r)}D6`);
    if (s.weapon) weapon(s.weapon);
  } else if (file === 'vehicles') {
    push(t('Maniabilité'), s.handling);
    push(t('Vitesse'), s.speed);
    push(t('Accél.'), s.accel);
    push(t('Structure'), s.body);
    push(t('Blindage'), s.armor);
    push(t('Autopilote'), s.pilot);
    push(t('Senseurs'), s.sensor);
    push(t('Places'), s.seats);
  } else if (file === 'lifestyles') {
    push(t('Coût'), t('{cost}/mois', { cost: nuyen(item?.cost ?? q?.unitCost) }));
    if (s.lp !== undefined) push(t('Points de train de vie'), s.lp);
  } else if (file === 'accessories') {
    push(t('Montage'), (s.mount || []).length ? s.mount.map((m) => t(MOUNT_LABELS[m] || m)).join(' / ') : t(MOUNT_LABELS['']));
    if (s.accuracy) push(t('Précision'), signed(s.accuracy));
    if (s.rc) push(t('RC'), signed(s.rc));
    if (s.smartgun) push(t('Smartgun'), t('+1 dé câblé / +2 sans fil (smartlink)'));
    if (s.conceal) push(t('Dissim.'), signed(s.conceal));
    if (s.requires?.names?.length) push(t('Modèles'), s.requires.names.join(', '));
  } else if (file === 'armormods') {
    push(t('Capacité'), typeof s.capacity === 'number' ? s.capacity : evalAt(s.capacity, r));
    if (s.armor) push(t('Armure'), signed(s.armor));
    for (const [k, v] of Object.entries(s.bonus || {})) push(t(BONUS_LABEL[k] || k), typeof v === 'boolean' ? t('Oui') : signed(evalAt(v, r)));
  } else if (file === 'vehiclemods') {
    push(t('Emplacements'), typeof s.slots === 'number' ? s.slots : t('selon le véhicule'));
    for (const [k, v] of Object.entries(s.bonus || {})) push(t(VEHICLE_BONUS_LABEL[k] || k), typeof v === 'number' ? signed(v) : v);
    if (s.requires?.names?.length) push(t('Modèles'), s.requires.names.join(', '));
  } else if (file === 'lifestylequalities') {
    if (item?.cost) push(t('Coût'), t('{cost}/mois', { cost: nuyen(item.cost) }));
    if (s.multiplier) push(t('Loyer'), t('{n} % du coût de base', { n: `${s.multiplier > 0 ? '+' : ''}${s.multiplier}` }));
    if (s.lp) push(t('Points de train de vie'), signed(s.lp));
    if (s.allowed?.length) push(t('Trains de vie'), s.allowed.join(', '));
  } else {
    if (s.deviceRating !== undefined) push(t('Indice'), evalAt(s.deviceRating, r));
    if (Array.isArray(s.attributeArray)) push(t('Attributs'), s.attributeArray.join(' / '));
    if (s.attack) push(t('Attaque'), s.attack);
    if (s.sleaze) push(t('Corruption'), s.sleaze);
    if (s.dataProcessing !== undefined) push(t('Traitement'), s.dataProcessing);
    if (s.firewall !== undefined) push(t('Firewall'), s.firewall);
    if (s.programs) push(t('Programmes'), s.programs);
    if (s.costFor) push(t('Lot'), `×${s.costFor}`);
    if (s.capacity) push(t('Capacité'), s.capacity);
    if (s.weapon) weapon(s.weapon);
  }
  return rows;
}

export default function ItemDetail({ entry, game, actor, catalog, compact }) {
  const shop = game.shop || {};
  const isGM = game.me.role === 'gm';
  const item = entry.item;
  const sp = entry.special;
  const ware = entry.file === 'cyberware' || entry.file === 'bioware';
  const rated = !sp && item?.rating && item.rating.max > item.rating.min;
  const grades = !sp && ware ? allowedGrades(item) : [];
  const isDevice = !!item && entry.file === 'gear' && DEVICE_GEAR.has(item.category);
  const upgrade = !sp && !!UPGRADE_FILES[entry.file];
  const targets = upgrade ? targetsFor(entry.file, actor) : [];

  const [rating, setRating] = useState(item?.rating?.min ?? null);
  const [grade, setGrade] = useState(grades.includes('standard') ? 'standard' : grades[0] || null);
  const [qty, setQty] = useState(1);
  const [price, setPrice] = useState(item?.costRange ? item.costRange[0] : null);
  const [setMatrix, setSetMatrix] = useState(false);
  const [busy, setBusy] = useState(false);
  const [targetId, setTargetId] = useState(targets[0]?.id || '');
  const [mount, setMount] = useState(null);
  const [lsName, setLsName] = useState('');
  const [primary, setPrimary] = useState(false);

  useEffect(() => {
    setRating(item?.rating?.min ?? null);
    setGrade(grades.includes('standard') ? 'standard' : grades[0] || null);
    setQty(1);
    setPrice(item?.costRange ? item.costRange[0] : null);
    setSetMatrix(isDevice && !!actor && !(actor.matrix && actor.matrix.device));
    setMount(null);
    setLsName('');
    setPrimary(false);
  }, [entry.ref]);
  // Keep a valid target when the actor or the section changes.
  useEffect(() => {
    if (upgrade && !targets.some((x) => x.id === targetId)) setTargetId(targets[0]?.id || '');
  }, [upgrade, actor?.id, targets.length, entry.file]);

  const opts = { rating: rated ? rating : item?.rating?.min, grade: ware ? grade : undefined, price: item?.costRange ? price : undefined };
  const pv = upgrade ? upgradePreview(entry, actor, catalog, shop, { targetId, mount: mount ?? undefined, rating: opts.rating }) : null;
  const q = pv ? { ...pv.q, unitCost: pv.unitCost } : priceEntry(entry, opts, shop);
  const status = buyStatus(shop, entry, q, isGM);
  const total = q.unitCost * (upgrade ? 1 : qty);
  // Vehicle mods rated by the vehicle (Body / Seats): the slider stops at the target's value.
  const maxR = rated ? Math.max(item.rating.min, Math.min(item.rating.max, pv?.maxRating ?? item.rating.max)) : null;
  const rows = statRows(entry.file, item, sp?.stats || item?.stats, q);
  const stockOut = sp && sp.stock !== null && sp.stock !== undefined && sp.stock < qty;

  // Essence / Magic impact for 'ware.
  let essInfo = null;
  if (ware && actor) {
    const essBefore = Number(actor.attributes?.ESS ?? 6);
    const cost = Math.round((q.essence || 0) * qty * 1000) / 1000;
    const essAfter = Math.round((essBefore - cost) * 1000) / 1000;
    const loss = magicLoss(essBefore, essAfter);
    const awakened = Number(actor.attributes?.MAG) > 0 ? 'MAG' : Number(actor.attributes?.RES) > 0 ? 'RES' : null;
    essInfo = { essBefore, essAfter, cost, loss, awakened, fatal: essAfter <= 0 };
  }

  const line = () => {
    const l = { ref: entry.ref, qty, name: entry.name };
    if (!sp && item?.rating) l.rating = rated ? rating : item.rating.min;
    if (!sp && ware && grade) l.grade = grade;
    if (!sp && item?.costRange) l.price = price;
    if (isDevice && setMatrix) l.setMatrix = true;
    if (upgrade) {
      l.qty = 1;
      l.target = { itemId: targetId };
      if (entry.file === 'accessories' && pv?.mount !== undefined && pv?.mount !== null) l.mount = pv.mount;
    }
    if (entry.file === 'lifestyles') {
      if (lsName.trim()) l.lifestyleName = lsName.trim();
      if (primary) l.primary = true;
    }
    return l;
  };

  const add = () => {
    if (!actor) return toast(t('Choisis d’abord un personnage'), 'warn');
    addToCart(actor.id, line());
    toast(t('{name} ajouté au panier', { name: entry.name }), 'success', 2000);
  };
  const strip = (l) => {
    const { name, ...rest } = l;
    return rest;
  };
  const gmSell = async () => {
    if (!actor) return toast(t('Choisis un PJ'), 'warn');
    if (!(await confirmAction(t('Vendre {item} à {name} pour {cost} ?', { item: qty > 1 ? `${entry.name} ×${qty}` : entry.name, name: actor.name, cost: nuyen(total) })))) return;
    setBusy(true);
    try {
      await send('shop/buy', { actorId: actor.id, items: [strip(line())] });
      toast(t('{name} a payé {cost}', { name: actor.name, cost: nuyen(total) }), 'success');
    } catch {}
    setBusy(false);
  };
  const gmGive = async () => {
    if (!actor) return toast(t('Choisis un PJ'), 'warn');
    setBusy(true);
    try {
      await send('shop/give', { actorId: actor.id, items: [strip(line())] });
      toast(t('{item} donné à {name}', { item: entry.name, name: actor.name }), 'success');
    } catch {}
    setBusy(false);
  };
  const gmSpecial = async () => {
    try {
      await send('shop/addSpecial', { fromRef: item.id, rating: opts.rating, grade: opts.grade });
      toast(t('Offre ajoutée chez Cabana — à ajuster dans « Offres de Cabana »'), 'success');
    } catch {}
  };

  const legal = q.legality ? t(LEGALITY_LABEL[q.legality] || q.legality) : t('Légal');
  // Other-language name under the title (catalog items have both).
  const altName = item && item.nameFr && item.name !== item.nameFr ? (entry.name === item.name ? item.nameFr : item.name) : null;
  return html`<div class=${'shop-detail' + (compact ? ' compact' : '')}>
    <div class="shop-detail-head">
      <div class="grow">
        <h3>${entry.name}</h3>
        ${altName && html`<div class="muted small">${altName}</div>`}
        <div class="row wrap gap-s shop-detail-tags">
          ${sp ? html`<${Badge} color="magenta">${t('Offre de Cabana')}</${Badge}>` : null}
          <${Badge}>${entry.category}</${Badge}>
          <${AvailBadge} avail=${q.avail} value=${q.availValue} legality=${q.legality} max=${isGM || sp ? undefined : shop.maxAvail} />
          <span class="muted small">${legal}</span>
          <${ItemRef} item=${item} />
        </div>
      </div>
    </div>

    ${sp?.notes && html`<p class="shop-notes">${sp.notes}</p>`}
    ${isGM && sp?.gmNotes && html`<p class="shop-notes gm"><strong>${t('MJ :')}</strong> ${sp.gmNotes}</p>`}
    ${sp && html`<div class="row gap-s small">
      ${sp.stock === null || sp.stock === undefined ? html`<${Badge} color="cyan">${t('Stock illimité')}</${Badge}>` : sp.stock > 0 ? html`<${Badge} color="cyan">${t('{n} en stock', { n: sp.stock })}</${Badge}>` : html`<${Badge} color="red">${t('Épuisé')}</${Badge}>`}
      ${sp.rating ? html`<${Badge}>${t('Indice {n}', { n: sp.rating })}</${Badge}>` : null}
      ${sp.grade && sp.grade !== 'standard' ? html`<${Badge}>${gradeLabel(sp.grade)}</${Badge}>` : null}
      ${sp.hidden ? html`<${Badge} color="amber">${t('Brouillon (caché)')}</${Badge}>` : null}
    </div>`}

    ${rows.length > 0 && html`<div class="shop-stats">${rows.map(([l, v]) => html`<${Stat} label=${l} value=${v} />`)}</div>`}

    <div class="shop-config">
      ${rated &&
      html`<${Field} label=${t('Indice : {n}', { n: Math.min(rating, maxR) })}>
        <input type="range" class="shop-range" min=${item.rating.min} max=${maxR} step="1" value=${Math.min(rating, maxR)} onInput=${(e) => setRating(Number(e.target.value))} />
        <div class="spread row small faint"><span>${item.rating.min}</span><span>${maxR}</span></div>
      </${Field}>`}
      ${!sp && item?.rating && !rated && html`<div class="small muted">${t('Indice {n}', { n: item.rating.min })}</div>`}
      ${grades.length > 1 &&
      html`<${Field} label=${t('Grade')}>
        <${Select} value=${grade} onChange=${setGrade} options=${grades.map((g) => ({ value: g, label: t('{grade} (Ess ×{ess}, prix ×{cost}, dispo {avail})', { grade: gradeLabel(g), ess: GRADES[g].ess, cost: GRADES[g].cost, avail: `${GRADES[g].avail >= 0 ? '+' : ''}${GRADES[g].avail}` }) }))} />
      </${Field}>`}
      ${item?.costRange &&
      html`<${Field} label=${t('Prix négocié')} hint=${t('Entre {min} et {max} — validé par le MJ', { min: nuyen(item.costRange[0]), max: nuyen(item.costRange[1]) })}>
        <${NumberInput} value=${price} min=${item.costRange[0]} max=${item.costRange[1]} step=${100} onChange=${setPrice} />
      </${Field}>`}
      ${upgrade &&
      html`<${Field} label=${t(UPGRADE_TARGET_LABEL[entry.file])}>
        ${targets.length
          ? html`<${Select} value=${targetId} onChange=${(v) => (setTargetId(v), setMount(null))} options=${targets.map((x) => ({ value: x.id, label: x.name }))} />`
          : html`<div class="muted small">${actor ? t(UPGRADE_NONE[entry.file]) : t('Choisis d’abord un personnage')}</div>`}
      </${Field}>`}
      ${upgrade && entry.file === 'accessories' && pv?.mounts?.length > 1 &&
      html`<${Field} label=${t('Emplacement')}>
        <${Select} value=${pv.mount} onChange=${setMount} options=${pv.mounts.map((m) => ({ value: m, label: t(MOUNT_LABELS[m] || m) }))} />
      </${Field}>`}
      ${upgrade && pv?.target && entry.file === 'armormods' && html`<div class="small muted">${t('Capacité : {used} / {cap} utilisée(s) — cet article : {need}', { used: fmtNumber(pv.used), cap: fmtNumber(pv.cap), need: fmtNumber(pv.need ?? 0) })}</div>`}
      ${upgrade && pv?.target && entry.file === 'vehiclemods' && pv.cap !== null && pv.cap !== undefined && html`<div class="small muted">${t('Emplacements : {used} / {cap} utilisé(s) — cet article : {need}', { used: pv.used, cap: pv.cap, need: pv.need ?? 0 })}</div>`}
      ${upgrade && pv?.target && entry.file === 'lifestylequalities' && html`<div class="small muted">${t('Loyer de {name} : {cost}/mois après l’option ({delta})', { name: pv.target.name, cost: nuyen(pv.monthlyCost), delta: `${pv.monthlyDelta >= 0 ? '+' : '−'}${nuyen(Math.abs(pv.monthlyDelta))}` })}</div>`}
      ${entry.file === 'lifestyles' && html`<${Field} label=${t('Nom du logement')} hint=${t('optionnel — ex. « Planque de Redmond »')}><${TextInput} live value=${lsName} onChange=${setLsName} placeholder=${entry.name} /></${Field}>`}
      ${entry.file === 'lifestyles' && (actor?.lifestyles || []).length > 0 && html`<${Toggle} value=${primary} onChange=${setPrimary} label=${t('Train de vie principal')} />`}
      ${upgrade
        ? null
        : entry.file !== 'lifestyles'
        ? html`<${Field} label=${t('Quantité')}><${NumberInput} value=${qty} min=${1} max=${sp && sp.stock !== null && sp.stock !== undefined ? Math.max(1, sp.stock) : 99} onChange=${setQty} /></${Field}>`
        : html`<${Field} label=${t('Mois payés d’avance')}><${NumberInput} value=${qty} min=${1} max=${24} onChange=${setQty} /></${Field}>`}
      ${isDevice && html`<${Toggle} value=${setMatrix} onChange=${setSetMatrix} label=${t('En faire l’appareil Matriciel du personnage')} />`}
    </div>

    ${essInfo &&
    html`<div class=${'shop-ess' + (essInfo.fatal ? ' fatal' : essInfo.loss && essInfo.awakened ? ' warn' : '')}>
      <div>${t('Essence :')} <strong class="mono">${essInfo.essBefore}</strong> → <strong class="mono">${essInfo.essAfter}</strong> <span class="muted">(−${essInfo.cost})</span></div>
      ${essInfo.fatal && html`<div>⚠ ${t('Essence à zéro : ce serait mortel.')}</div>`}
      ${!essInfo.fatal && essInfo.loss > 0 && essInfo.awakened === 'MAG' && html`<div>⚠ ${t('Magie −{n} : chaque point d’Essence entamé coûte un point de Magie (adeptes compris).', { n: essInfo.loss })}</div>`}
      ${!essInfo.fatal && essInfo.loss > 0 && essInfo.awakened === 'RES' && html`<div>⚠ ${t('Résonance −{n} : chaque point d’Essence entamé coûte un point de Résonance (adeptes compris).', { n: essInfo.loss })}</div>`}
      <div class="faint small">${t('L’Essence perdue ne revient pas, même en revendant l’implant.')}</div>
    </div>`}

    <div class="shop-price-row">
      <div>
        ${sp?.originalCost && sp.originalCost > sp.cost ? html`<span class="shop-old-price">${nuyen(sp.originalCost)}</span>` : null}
        <span class="shop-price">${nuyen(total)}</span>
        ${qty > 1 && html`<span class="muted small"> ${t('({cost} l’unité)', { cost: nuyen(q.unitCost) })}</span>`}
        ${entry.file === 'lifestyles' && html`<span class="muted small"> (${t('{cost}/mois', { cost: nuyen(q.unitCost) })})</span>`}
        ${entry.file === 'lifestylequalities' && pv?.target && html`<span class="muted small"> ${t('maintenant (mois déjà payés), puis {delta}/mois', { delta: nuyen(pv.monthlyDelta) })}</span>`}
      </div>
      ${!isGM && actor && html`<div class=${'small ' + ((Number(actor.nuyen) || 0) < total ? 'red' : 'muted')}>${t('Disponible : {cost}', { cost: nuyen(actor.nuyen) })}</div>`}
    </div>

    ${upgrade && status.ok && pv?.problem && !pv.missingTarget && html`<div class="shop-blocked">${msgText(pv.problem)}</div>`}
    ${!status.ok && html`<div class="shop-blocked">${status.closed ? t('Cabana n’est pas joignable pour l’instant.') : t('Indisponible : {reason}', { reason: status.reason })}</div>`}
    ${status.ok && status.approval && html`<div class="shop-approval">${t('Cet achat sera soumis au MJ avant livraison.')}</div>`}
    ${stockOut && html`<div class="shop-blocked">${t('Stock insuffisant.')}</div>`}

    <div class="row wrap shop-detail-actions">
      <${Button} variant="primary" disabled=${!status.ok || stockOut || !actor || (upgrade && !!pv?.problem)} onClick=${add}>${t('Ajouter au panier')}</${Button}>
      ${isGM &&
      html`
        <${Button} variant="accent" disabled=${busy || !actor || stockOut || (upgrade && !!pv?.problem)} onClick=${gmSell} title=${t('Débite le PJ immédiatement')}>${t('Vendre au PJ')}</${Button}>
        <${Button} disabled=${busy || !actor || stockOut || (upgrade && !!pv?.problem)} onClick=${gmGive} title=${t('Gratuit, sans contrôle')}>${t('Donner')}</${Button}>
        ${!sp && !upgrade && entry.file !== 'lifestyles' && html`<${Button} variant="ghost" small onClick=${gmSpecial} title=${t('Crée une offre de Cabana à partir de cet article')}>${t('+ Offre Cabana')}</${Button}>`}
      `}
    </div>
    ${isGM && !actor && html`<div class="muted small">${t('Choisis un PJ en haut de la page pour vendre ou donner.')}</div>`}
  </div>`;
}
