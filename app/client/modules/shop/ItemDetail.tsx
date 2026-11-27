// Item detail panel: stats, rating / grade / quantity pickers, price & essence impact, add to cart, GM actions.
import { useEffect, useState } from 'react';
import { Button, Badge, Stat, NumberInput, Select, Toggle, Field, TextInput, confirmAction } from '../../lib/ui.tsx';
import { send } from '../../lib/net.ts';
import { toast } from '../../lib/ui-store.ts';
import { t, tk, attrShort, skillLabel, fmtNumber } from '../../lib/i18n.ts';
import { SKILL_BY_ID } from '/shared/sr5.ts';
import { GRADES, allowedGrades, evalFormula, magicLoss, DEVICE_GEAR, LEGALITY_LABEL, UPGRADE_FILES, MOUNT_LABELS } from './rules.ts';
import { targetsFor, upgradePreview, msgText } from './upgrades.ts';
import { priceEntry, buyStatus, addToCart, nuyen, AvailBadge, gradeLabel } from './common.tsx';
import type { ReactNode } from 'react';
import type { Actor, GameView } from '../../../shared/types.ts';
import type { CartLine, LooseStats, PriceQuote, ShopCatalog, ShopEntry, ShopItem } from './types.ts';
import { ItemRef } from '../books/BookRef.tsx';

// Labels of armor-mod / vehicle-mod bonuses (French keys, render with t()).
const BONUS_LABEL: Record<string, string> = {
  fire: tk('Feu'),
  cold: tk('Froid'),
  electricity: tk('Électricité'),
  acid: tk('Acide'),
  falling: tk('Chute'),
  toxin: tk('Toxines (contact)'),
  pathogen: tk('Pathogènes (contact)'),
  radiation: tk('Radiations'),
};
const VEHICLE_BONUS_LABEL: Record<string, string> = {
  handling: tk('Maniabilité'),
  speed: tk('Vitesse'),
  accel: tk('Accél.'),
  armor: tk('Blindage'),
  body: tk('Structure'),
  sensor: tk('Senseurs'),
  pilot: tk('Autopilote'),
  seats: tk('Places'),
};
// Target picker labels per upgrade file.
const UPGRADE_TARGET_LABEL: Record<string, string> = { accessories: tk('Arme'), armormods: tk('Armure'), vehiclemods: tk('Véhicule'), lifestylequalities: tk('Train de vie') };
const UPGRADE_NONE: Record<string, string> = {
  accessories: tk('Aucune arme sur laquelle l’installer.'),
  armormods: tk('Aucune armure à modifier.'),
  vehiclemods: tk('Aucun véhicule à modifier.'),
  lifestylequalities: tk('Aucun train de vie : achète d’abord un logement.'),
};
const MOUNTS = MOUNT_LABELS as Record<string, string>;
const GRADE_TABLE = GRADES as Record<string, { ess: number; cost: number; avail: number }>;

const signed = (v: unknown) => (typeof v === 'number' ? (v > 0 ? `+${v}` : String(v)) : String(v ?? '—'));
const evalAt = (f: unknown, rating: number | null | undefined) => {
  if (typeof f === 'number') return f;
  try {
    return Math.round(evalFormula(f, { Rating: rating ?? 1 }) * 100) / 100;
  } catch {
    return f;
  }
};

/** [label, value] pairs describing an item for its type (labels translated: call at render time). */
export function statRows(file: string, item: ShopItem | null | undefined, stats: LooseStats | null | undefined, q?: Partial<PriceQuote> | null): Array<[string, ReactNode]> {
  const s: LooseStats = stats || item?.stats || {};
  const r = q?.rating;
  const rows: Array<[string, ReactNode]> = [];
  const push = (label: string, v: unknown) => {
    if (v !== undefined && v !== null && v !== '') rows.push([label, v as ReactNode]);
  };
  const weapon = (w: LooseStats) => {
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
    push(t('Montage'), (s.mount || []).length ? s.mount.map((m: string) => t(MOUNTS[m] || m)).join(' / ') : t(MOUNTS['']));
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

interface ItemDetailProps {
  entry: ShopEntry;
  game: GameView;
  actor: Actor | null;
  catalog: ShopCatalog;
  /** In a modal (narrow screens). */
  compact?: boolean;
}

export default function ItemDetail({ entry, game, actor, catalog, compact }: ItemDetailProps) {
  const shop = game.shop || {};
  const isGM = game.me.role === 'gm';
  const item = entry.item;
  const sp = entry.special;
  const ware = entry.file === 'cyberware' || entry.file === 'bioware';
  const rated = !sp && !!item?.rating && item.rating.max > item.rating.min;
  const grades: string[] = !sp && ware ? allowedGrades(item) : [];
  const isDevice = !!item && entry.file === 'gear' && DEVICE_GEAR.has(item.category);
  const upgrade = !sp && !!UPGRADE_FILES[entry.file as keyof typeof UPGRADE_FILES];
  const targets = upgrade ? targetsFor(entry.file, actor) : [];

  const [rating, setRating] = useState<number | null>(item?.rating?.min ?? null);
  const [grade, setGrade] = useState<string | null>(grades.includes('standard') ? 'standard' : grades[0] || null);
  const [qty, setQty] = useState(1);
  const [price, setPrice] = useState<number | null>(item?.costRange ? item.costRange[0] : null);
  const [setMatrix, setSetMatrix] = useState(false);
  const [busy, setBusy] = useState(false);
  const [targetId, setTargetId] = useState<string>(targets[0]?.id || '');
  const [mount, setMount] = useState<string | null>(null);
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
  const q: PriceQuote = pv ? { ...pv.q, unitCost: pv.unitCost } : priceEntry(entry, opts, shop);
  const status = buyStatus(shop, entry, q, isGM);
  const total = q.unitCost * (upgrade ? 1 : qty);
  // Vehicle mods rated by the vehicle (Body / Seats): the slider stops at the target's value.
  const maxR = rated && item?.rating ? Math.max(item.rating.min, Math.min(item.rating.max, pv?.maxRating ?? item.rating.max)) : 0;
  const rows = statRows(entry.file, item, sp?.stats || item?.stats, q);
  const stockOut = !!sp && sp.stock !== null && sp.stock !== undefined && sp.stock < qty;

  // Essence / Magic impact for 'ware.
  let essInfo: { essBefore: number; essAfter: number; cost: number; loss: number; awakened: 'MAG' | 'RES' | null; fatal: boolean } | null = null;
  if (ware && actor) {
    const essBefore = Number(actor.attributes?.ESS ?? 6);
    const cost = Math.round((q.essence || 0) * qty * 1000) / 1000;
    const essAfter = Math.round((essBefore - cost) * 1000) / 1000;
    const loss: number = magicLoss(essBefore, essAfter);
    const awakened = Number(actor.attributes?.MAG) > 0 ? 'MAG' : Number(actor.attributes?.RES) > 0 ? 'RES' : null;
    essInfo = { essBefore, essAfter, cost, loss, awakened, fatal: essAfter <= 0 };
  }

  const line = (): CartLine => {
    const l: CartLine = { ref: entry.ref, qty, name: entry.name };
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
  const strip = (l: CartLine) => {
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
      await send('shop/addSpecial', { fromRef: item?.id, rating: opts.rating, grade: opts.grade });
      toast(t('Offre ajoutée chez Cabana — à ajuster dans « Offres de Cabana »'), 'success');
    } catch {}
  };

  const legality = LEGALITY_LABEL as Record<string, string>;
  const legal = q.legality ? t(legality[q.legality] || q.legality) : t('Légal');
  // Other-language name under the title (catalog items have both).
  const altName = item && item.nameFr && item.name !== item.nameFr ? (entry.name === item.name ? item.nameFr : item.name) : null;
  const shownRating = Math.min(rating ?? 0, maxR);
  return (
    <div className={'shop-detail' + (compact ? ' compact' : '')}>
      <div className="shop-detail-head">
        <div className="grow">
          <h3>{entry.name}</h3>
          {altName && <div className="muted small">{altName}</div>}
          <div className="row wrap gap-s shop-detail-tags">
            {sp ? <Badge color="magenta">{t('Offre de Cabana')}</Badge> : null}
            <Badge>{entry.category}</Badge>
            <AvailBadge avail={q.avail} value={q.availValue} legality={q.legality} max={isGM || sp ? undefined : shop.maxAvail} />
            <span className="muted small">{legal}</span>
            <ItemRef item={item} />
          </div>
        </div>
      </div>

      {sp?.notes && <p className="shop-notes">{sp.notes}</p>}
      {isGM && sp?.gmNotes && (
        <p className="shop-notes gm">
          <strong>{t('MJ :')}</strong> {sp.gmNotes}
        </p>
      )}
      {sp && (
        <div className="row gap-s small">
          {sp.stock === null || sp.stock === undefined ? (
            <Badge color="cyan">{t('Stock illimité')}</Badge>
          ) : sp.stock > 0 ? (
            <Badge color="cyan">{t('{n} en stock', { n: sp.stock })}</Badge>
          ) : (
            <Badge color="red">{t('Épuisé')}</Badge>
          )}
          {sp.rating ? <Badge>{t('Indice {n}', { n: sp.rating })}</Badge> : null}
          {sp.grade && sp.grade !== 'standard' ? <Badge>{gradeLabel(sp.grade)}</Badge> : null}
          {sp.hidden ? <Badge color="amber">{t('Brouillon (caché)')}</Badge> : null}
        </div>
      )}

      {rows.length > 0 && (
        <div className="shop-stats">
          {rows.map(([l, v], i) => (
            <Stat key={i} label={l} value={v} />
          ))}
        </div>
      )}

      <div className="shop-config">
        {rated && item?.rating && (
          <Field label={t('Indice : {n}', { n: shownRating })}>
            <input type="range" className="shop-range" min={item.rating.min} max={maxR} step="1" value={shownRating} onChange={(e) => setRating(Number(e.target.value))} />
            <div className="spread row small faint">
              <span>{item.rating.min}</span>
              <span>{maxR}</span>
            </div>
          </Field>
        )}
        {!sp && item?.rating && !rated && <div className="small muted">{t('Indice {n}', { n: item.rating.min })}</div>}
        {grades.length > 1 && (
          <Field label={t('Grade')}>
            <Select
              value={grade}
              onChange={setGrade}
              options={grades.map((g) => ({
                value: g,
                label: t('{grade} (Ess ×{ess}, prix ×{cost}, dispo {avail})', {
                  grade: gradeLabel(g),
                  ess: GRADE_TABLE[g].ess,
                  cost: GRADE_TABLE[g].cost,
                  avail: `${GRADE_TABLE[g].avail >= 0 ? '+' : ''}${GRADE_TABLE[g].avail}`,
                }),
              }))}
            />
          </Field>
        )}
        {item?.costRange && (
          <Field label={t('Prix négocié')} hint={t('Entre {min} et {max} — validé par le MJ', { min: nuyen(item.costRange[0]), max: nuyen(item.costRange[1]) })}>
            <NumberInput value={price} min={item.costRange[0]} max={item.costRange[1]} step={100} onChange={setPrice} />
          </Field>
        )}
        {upgrade && (
          <Field label={t(UPGRADE_TARGET_LABEL[entry.file])}>
            {targets.length ? (
              <Select
                value={targetId}
                onChange={(v) => {
                  setTargetId(v);
                  setMount(null);
                }}
                options={targets.map((x) => ({ value: x.id, label: x.name }))}
              />
            ) : (
              <div className="muted small">{actor ? t(UPGRADE_NONE[entry.file]) : t('Choisis d’abord un personnage')}</div>
            )}
          </Field>
        )}
        {upgrade && entry.file === 'accessories' && (pv?.mounts?.length || 0) > 1 && (
          <Field label={t('Emplacement')}>
            <Select value={pv?.mount} onChange={setMount} options={(pv?.mounts || []).map((m) => ({ value: m, label: t(MOUNTS[m] || m) }))} />
          </Field>
        )}
        {upgrade && pv?.target && entry.file === 'armormods' && (
          <div className="small muted">
            {t('Capacité : {used} / {cap} utilisée(s) — cet article : {need}', { used: fmtNumber(pv.used), cap: fmtNumber(pv.cap), need: fmtNumber(pv.need ?? 0) })}
          </div>
        )}
        {upgrade && pv?.target && entry.file === 'vehiclemods' && pv.cap !== null && pv.cap !== undefined && (
          <div className="small muted">{t('Emplacements : {used} / {cap} utilisé(s) — cet article : {need}', { used: pv.used, cap: pv.cap, need: pv.need ?? 0 })}</div>
        )}
        {upgrade && pv?.target && entry.file === 'lifestylequalities' && (
          <div className="small muted">
            {t('Loyer de {name} : {cost}/mois après l’option ({delta})', {
              name: pv.target.name,
              cost: nuyen(pv.monthlyCost),
              delta: `${(pv.monthlyDelta ?? 0) >= 0 ? '+' : '−'}${nuyen(Math.abs(pv.monthlyDelta ?? 0))}`,
            })}
          </div>
        )}
        {entry.file === 'lifestyles' && (
          <Field label={t('Nom du logement')} hint={t('optionnel — ex. « Planque de Redmond »')}>
            <TextInput live value={lsName} onChange={setLsName} placeholder={entry.name} />
          </Field>
        )}
        {entry.file === 'lifestyles' && (actor?.lifestyles || []).length > 0 && <Toggle value={primary} onChange={setPrimary} label={t('Train de vie principal')} />}
        {upgrade ? null : entry.file !== 'lifestyles' ? (
          <Field label={t('Quantité')}>
            <NumberInput value={qty} min={1} max={sp && sp.stock !== null && sp.stock !== undefined ? Math.max(1, sp.stock) : 99} onChange={setQty} />
          </Field>
        ) : (
          <Field label={t('Mois payés d’avance')}>
            <NumberInput value={qty} min={1} max={24} onChange={setQty} />
          </Field>
        )}
        {isDevice && <Toggle value={setMatrix} onChange={setSetMatrix} label={t('En faire l’appareil Matriciel du personnage')} />}
      </div>

      {essInfo && (
        <div className={'shop-ess' + (essInfo.fatal ? ' fatal' : essInfo.loss && essInfo.awakened ? ' warn' : '')}>
          <div>
            {t('Essence :')} <strong className="mono">{essInfo.essBefore}</strong> → <strong className="mono">{essInfo.essAfter}</strong> <span className="muted">(−{essInfo.cost})</span>
          </div>
          {essInfo.fatal && <div>⚠ {t('Essence à zéro : ce serait mortel.')}</div>}
          {!essInfo.fatal && essInfo.loss > 0 && essInfo.awakened === 'MAG' && (
            <div>⚠ {t('Magie −{n} : chaque point d’Essence entamé coûte un point de Magie (adeptes compris).', { n: essInfo.loss })}</div>
          )}
          {!essInfo.fatal && essInfo.loss > 0 && essInfo.awakened === 'RES' && (
            <div>⚠ {t('Résonance −{n} : chaque point d’Essence entamé coûte un point de Résonance (adeptes compris).', { n: essInfo.loss })}</div>
          )}
          <div className="faint small">{t('L’Essence perdue ne revient pas, même en revendant l’implant.')}</div>
        </div>
      )}

      <div className="shop-price-row">
        <div>
          {sp?.originalCost && sp.originalCost > sp.cost ? <span className="shop-old-price">{nuyen(sp.originalCost)}</span> : null}
          <span className="shop-price">{nuyen(total)}</span>
          {qty > 1 && <span className="muted small"> {t('({cost} l’unité)', { cost: nuyen(q.unitCost) })}</span>}
          {entry.file === 'lifestyles' && <span className="muted small"> ({t('{cost}/mois', { cost: nuyen(q.unitCost) })})</span>}
          {entry.file === 'lifestylequalities' && pv?.target && <span className="muted small"> {t('maintenant (mois déjà payés), puis {delta}/mois', { delta: nuyen(pv.monthlyDelta) })}</span>}
        </div>
        {!isGM && actor && <div className={'small ' + ((Number(actor.nuyen) || 0) < total ? 'red' : 'muted')}>{t('Disponible : {cost}', { cost: nuyen(actor.nuyen) })}</div>}
      </div>

      {upgrade && status.ok && pv?.problem && !pv.missingTarget && <div className="shop-blocked">{msgText(pv.problem)}</div>}
      {!status.ok && <div className="shop-blocked">{status.closed ? t('Cabana n’est pas joignable pour l’instant.') : t('Indisponible : {reason}', { reason: status.reason })}</div>}
      {status.ok && status.approval && <div className="shop-approval">{t('Cet achat sera soumis au MJ avant livraison.')}</div>}
      {stockOut && <div className="shop-blocked">{t('Stock insuffisant.')}</div>}

      <div className="row wrap shop-detail-actions">
        <Button variant="primary" disabled={!status.ok || stockOut || !actor || (upgrade && !!pv?.problem)} onClick={add}>
          {t('Ajouter au panier')}
        </Button>
        {isGM && (
          <>
            <Button variant="accent" disabled={busy || !actor || stockOut || (upgrade && !!pv?.problem)} onClick={gmSell} title={t('Débite le PJ immédiatement')}>
              {t('Vendre au PJ')}
            </Button>
            <Button disabled={busy || !actor || stockOut || (upgrade && !!pv?.problem)} onClick={gmGive} title={t('Gratuit, sans contrôle')}>
              {t('Donner')}
            </Button>
            {!sp && !upgrade && entry.file !== 'lifestyles' && (
              <Button variant="ghost" small onClick={gmSpecial} title={t('Crée une offre de Cabana à partir de cet article')}>
                {t('+ Offre Cabana')}
              </Button>
            )}
          </>
        )}
      </div>
      {isGM && !actor && <div className="muted small">{t('Choisis un PJ en haut de la page pour vendre ou donner.')}</div>}
    </div>
  );
}
