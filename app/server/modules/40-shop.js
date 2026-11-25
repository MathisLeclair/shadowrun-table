// Shop module: gear catalog price authority, player purchases/sales, GM approval queue, fixer specials, lifestyle rent.
// State slice: state.shop (see ARCHITECTURE.md > Shop). Pricing rules are shared with the client (client/modules/shop/rules.js).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nuyen } from '../../shared/util.js';
import {
  SHOP_FILES, FILE_LABELS, GRADES, DEVICE_GEAR, quote, targetList, parseAvailString, itemName, evalFormula,
  magicLoss, allowedGrades, fold,
} from '../../client/modules/shop/rules.js';
import { applyBonus, removeBonus, weaponFromStats } from '../lib/augment.js';

const CATALOG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'catalog');
const LISTS = ['weapons', 'armor', 'augmentations', 'gear', 'vehicles'];
const MAX_ORDERS = 400;
const APPROVAL_MODES = ['never', 'restricted', 'always'];

// ---------------------------------------------------------------------------
// Catalog index (server-side price authority)
// ---------------------------------------------------------------------------
const INDEX = new Map(); // catalog id -> { item, file }
const BY_NAME = new Map(); // folded English/French name -> { item, file } (to price legacy items without catalogId)

function loadCatalogs() {
  INDEX.clear();
  BY_NAME.clear();
  for (const file of SHOP_FILES) {
    const p = path.join(CATALOG_DIR, `${file}.json`);
    let list = [];
    try {
      list = JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (err) {
      console.warn(`[shop] catalog ${file}.json missing or invalid (run npm run build:catalog)`);
      continue;
    }
    for (const item of list) {
      const entry = { item, file };
      INDEX.set(item.id, entry);
      for (const n of [item.name, item.nameFr]) {
        const k = fold(n);
        if (k && !BY_NAME.has(k)) BY_NAME.set(k, entry);
      }
    }
  }
}
loadCatalogs();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function defaults() {
  return {
    open: true,
    markup: 0,
    sellRate: 50,
    maxAvail: 12,
    allowRestricted: true,
    allowForbidden: false,
    approval: 'restricted',
    categories: Object.fromEntries(SHOP_FILES.map((f) => [f, true])),
    specials: [],
    orders: [],
  };
}

const int = (v, d = 0) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? n : d;
};
const clampInt = (v, lo, hi, d) => Math.max(lo, Math.min(hi, int(v, d)));
const str = (v, max = 200) => String(v ?? '').trim().slice(0, max);
const round3 = (n) => Math.round(n * 1000) / 1000;

function ownersOf(state, actorId) {
  return Object.values(state.users || {})
    .filter((u) => (u.characterIds || []).includes(actorId))
    .map((u) => u.id);
}

function getActor(ctx, actorId) {
  const actor = ctx.state.actors?.[actorId];
  if (!actor) ctx.fail('Personnage introuvable');
  if (!ctx.owns(actorId)) ctx.fail("Ce n'est pas ton personnage");
  return actor;
}

function notifyOwners(ctx, actorId, event, data) {
  const targets = [...new Set([...ownersOf(ctx.state, actorId), 'gm'])];
  ctx.emitTo(targets, event, data);
}

function shopLog(ctx, actorId, text) {
  ctx.log({ kind: 'shop', userId: ctx.user.id, author: 'Boutique', text, to: [...new Set([...ownersOf(ctx.state, actorId), 'gm'])] });
}

function history(actor, text, delta) {
  actor.history = Array.isArray(actor.history) ? actor.history : [];
  const h = { ts: Date.now(), text };
  if (delta) h.nuyen = delta;
  actor.history.push(h);
  if (actor.history.length > 500) actor.history.splice(0, actor.history.length - 500);
}

function pushOrder(shop, order) {
  shop.orders.push(order);
  if (shop.orders.length > MAX_ORDERS) {
    // Drop the oldest resolved orders first; never drop pending ones.
    let excess = shop.orders.length - MAX_ORDERS;
    shop.orders = shop.orders.filter((o) => {
      if (excess > 0 && o.status !== 'pending') {
        excess--;
        return false;
      }
      return true;
    });
  }
}

const summary = (items) => items.map((l) => `${l.name}${l.rating ? ` (ind. ${l.rating})` : ''}${l.grade && l.grade !== 'standard' ? ` [${GRADES[l.grade]?.label || l.grade}]` : ''}${l.qty > 1 ? ` ×${l.qty}` : ''}`).join(', ');

// ---------------------------------------------------------------------------
// Purchase lines
// ---------------------------------------------------------------------------
/** Normalize one cart line into a priced, validated line. */
function resolveLine(ctx, raw, actorId) {
  const shop = ctx.state.shop;
  const ref = str(raw?.ref, 120);
  if (!ref) ctx.fail('Article manquant');
  const qty = int(raw?.qty, 1);
  if (qty < 1) ctx.fail('Quantité invalide');
  if (qty > 999) ctx.fail('Quantité trop élevée');

  if (ref.startsWith('special:')) {
    const sp = shop.specials.find((s) => s.id === ref.slice(8));
    if (!sp || (!ctx.isGM && sp.hidden)) ctx.fail('Cette offre n’existe plus');
    if (!ctx.isGM && sp.forActorIds?.length && !sp.forActorIds.includes(actorId)) ctx.fail('Cette offre est réservée à un autre runner');
    const cat = sp.catalogRef ? INDEX.get(sp.catalogRef) : null;
    const file = SHOP_FILES.includes(sp.file) ? sp.file : cat?.file || 'gear';
    const av = parseAvailString(sp.avail);
    const ware = file === 'cyberware' || file === 'bioware';
    let essence;
    if (ware) {
      if (Number.isFinite(Number(sp.essence)) && sp.essence !== null && sp.essence !== '') essence = round3(Number(sp.essence));
      else if (cat) essence = quote(cat.item, { rating: sp.rating, grade: sp.grade }).essence ?? 0;
      else essence = 0;
    }
    return {
      ref, specialId: sp.id, catalogId: cat?.item.id, file, name: sp.name, category: sp.category || cat?.item.categoryFr || cat?.item.category || '',
      qty, rating: sp.rating ?? null, grade: ware ? sp.grade || 'standard' : null, unitCost: Math.max(0, int(sp.cost)), availValue: av.value,
      legality: av.legality, essence, stats: sp.stats || cat?.item.stats || undefined,
    };
  }

  const entry = INDEX.get(ref);
  if (!entry) ctx.fail('Article inconnu du catalogue');
  const { item, file } = entry;
  const ware = file === 'cyberware' || file === 'bioware';
  if (ware && raw.grade && !allowedGrades(item).includes(raw.grade)) ctx.fail(`Grade « ${GRADES[raw.grade]?.label || raw.grade} » indisponible pour ${itemName(item)}`);
  const q = quote(item, { rating: raw.rating, grade: raw.grade, markup: file === 'lifestyles' ? 0 : shop.markup, price: raw.price });
  return {
    ref, catalogId: item.id, file, name: itemName(item), category: item.categoryFr || item.category, qty, rating: q.rating, grade: ware ? q.grade || 'standard' : null,
    unitCost: q.unitCost, availValue: q.availValue, legality: q.legality, essence: ware ? q.essence ?? 0 : undefined,
    variablePrice: item.costRange ? true : undefined,
  };
}

function lineFlags(shop, l) {
  const f = [];
  if (l.legality === 'R') f.push('restricted');
  if (l.legality === 'F') f.push('forbidden');
  if (l.availValue > shop.maxAvail) f.push('avail');
  if (l.variablePrice) f.push('price');
  return f;
}

/** Player-side shop rules (the GM bypasses them). */
function checkRules(ctx, lines) {
  const shop = ctx.state.shop;
  if (!shop.open) ctx.fail('Cabana n’est pas joignable pour l’instant');
  for (const l of lines) {
    if (l.specialId) continue; // fixer deals are GM-curated
    if (shop.categories[l.file] === false) ctx.fail(`${FILE_LABELS[l.file] || l.file} : rayon fermé pour l’instant`);
    if (l.availValue > shop.maxAvail) ctx.fail(`${l.name} : disponibilité ${l.availValue} au-dessus de la limite (${shop.maxAvail}) — vois avec le MJ`);
    if (l.legality === 'F' && !shop.allowForbidden) ctx.fail(`${l.name} est interdit : Cabana ne prend pas ce risque`);
    if (l.legality === 'R' && !shop.allowRestricted) ctx.fail(`${l.name} est restreint : pas de vente sans licence pour l’instant`);
  }
}

function checkStock(ctx, lines) {
  const need = {};
  for (const l of lines) if (l.specialId) need[l.specialId] = (need[l.specialId] || 0) + l.qty;
  for (const [id, n] of Object.entries(need)) {
    const sp = ctx.state.shop.specials.find((s) => s.id === id);
    if (!sp) ctx.fail('Une offre de la commande n’existe plus');
    if (sp.stock !== null && sp.stock !== undefined && Number(sp.stock) < n) ctx.fail(`${sp.name} : stock insuffisant (${sp.stock} restant${sp.stock > 1 ? 's' : ''})`);
  }
}

const essenceCost = (lines) => round3(lines.reduce((s, l) => s + (l.essence ? l.essence * l.qty : 0), 0));

function checkEssence(ctx, actor, lines) {
  const cost = essenceCost(lines);
  if (cost <= 0) return;
  const ess = Number(actor.attributes?.ESS ?? 6);
  if (ess - cost <= 0) ctx.fail(`Essence insuffisante : ${ess} − ${cost} tuerait ${actor.name}`);
}

function checkFunds(ctx, actor, total) {
  const have = Number(actor.nuyen) || 0;
  if (have < total) ctx.fail(`Fonds insuffisants : ${nuyen(total)} requis, ${nuyen(have)} disponibles`);
}

// ---------------------------------------------------------------------------
// Applying purchases to the actor
// ---------------------------------------------------------------------------
// applyBonus / removeBonus / weaponFromStats live in server/lib/augment.js (shared with the sheet editor).

const evalStat = (v, rating) => {
  if (typeof v === 'number') return v;
  try {
    return Math.round(evalFormula(v, { Rating: rating ?? 1 }));
  } catch {
    return 0;
  }
};

/** Add one priced line to the actor. paid = unit price actually paid (undefined for GM gifts). Returns a short note. */
function addLine(ctx, actor, line, { paid }) {
  const entry = line.catalogId ? INDEX.get(line.catalogId) : null;
  const item = entry?.item || { stats: line.stats || {} };
  const st = line.stats || item.stats || {};
  const list = targetList(line.file, { stats: st });
  const notes = [];
  const base = { catalogId: line.catalogId || undefined };
  if (paid !== undefined) base.paid = paid;

  if (list === 'lifestyle') {
    const monthlyCost = line.unitCost || Number(item.cost) || 0;
    if (actor.lifestyle && actor.lifestyle.name === line.name) actor.lifestyle.monthsPaid = (Number(actor.lifestyle.monthsPaid) || 0) + line.qty;
    else actor.lifestyle = { name: line.name, monthlyCost, monthsPaid: line.qty };
    return notes;
  }
  for (const key of ['weapons', 'armor', 'augmentations', 'gear', 'vehicles']) if (!Array.isArray(actor[key])) actor[key] = [];

  if (list === 'weapons') {
    for (let i = 0; i < line.qty; i++) actor.weapons.push(weaponFromStats(ctx, line.name, line.category, st, base));
  } else if (list === 'armor') {
    for (let i = 0; i < line.qty; i++) {
      actor.armor.push({ id: ctx.uid('arm'), name: line.name, rating: evalStat(st.armor ?? 0, line.rating), equipped: false, stack: !!st.stack || undefined, ...base });
    }
  } else if (list === 'augmentations') {
    for (let i = 0; i < line.qty; i++) {
      const aug = {
        id: ctx.uid('aug'),
        name: line.name,
        kind: st.kind || (line.file === 'bioware' ? 'bioware' : 'cyberware'),
        grade: line.grade || 'standard',
        essence: line.essence || 0,
        ...base,
      };
      if (line.rating) aug.rating = line.rating;
      // Essence loss (and Magic/Resonance loss for awakened/emerged characters).
      if (aug.essence > 0) {
        actor.attributes = actor.attributes || {};
        const before = Number(actor.attributes.ESS ?? 6);
        const after = round3(before - aug.essence);
        actor.attributes.ESS = after;
        const loss = magicLoss(before, after);
        for (const k of ['MAG', 'RES']) {
          if (loss && Number(actor.attributes[k]) > 0) {
            actor.attributes[k] = Math.max(0, Number(actor.attributes[k]) - loss);
            notes.push(`${k === 'MAG' ? 'Magie' : 'Résonance'} −${loss}`);
          }
        }
      }
      aug.bonus = applyBonus(actor, st.bonus, line.rating, 1);
      if (!aug.bonus) delete aug.bonus;
      if (st.weapon) actor.weapons.push(weaponFromStats(ctx, line.name, line.category, st.weapon, { augId: aug.id, catalogId: line.catalogId || undefined }));
      actor.augmentations.push(aug);
    }
  } else if (list === 'vehicles') {
    for (let i = 0; i < line.qty; i++) {
      actor.vehicles.push({
        id: ctx.uid('veh'), name: line.name, handling: st.handling ?? 0, speed: st.speed ?? 0, accel: st.accel ?? 0, body: st.body ?? 0,
        armor: st.armor ?? 0, pilot: st.pilot ?? 0, sensor: st.sensor ?? 0, seats: st.seats ?? undefined, notes: line.category || undefined, ...base,
      });
    }
  } else {
    // Gear (stackable). Ammunition and similar are sold per pack of `costFor` units.
    const per = Number(st.costFor) || 1;
    const units = line.qty * per;
    const unitPaid = paid !== undefined ? Math.round((paid / per) * 100) / 100 : undefined;
    const isDevice = DEVICE_GEAR.has(item.category) || line.setMatrix;
    const same = !isDevice && actor.gear.find((g) => (line.catalogId ? g.catalogId === line.catalogId : !g.catalogId && g.name === line.name) && (g.rating ?? null) === (line.rating ?? null));
    let gearItem;
    if (same) {
      const oldQty = Number(same.qty) || 0;
      if (unitPaid !== undefined && same.paid !== undefined) same.paid = Math.round(((same.paid * oldQty + unitPaid * units) / (oldQty + units)) * 100) / 100;
      else if (unitPaid !== undefined && !oldQty) same.paid = unitPaid;
      same.qty = oldQty + units;
      gearItem = same;
    } else {
      gearItem = { id: ctx.uid('gear'), name: line.name, category: line.category || '', qty: units, ...base };
      if (unitPaid !== undefined) gearItem.paid = unitPaid;
      if (line.rating) gearItem.rating = line.rating;
      actor.gear.push(gearItem);
    }
    if (line.file === 'programs' && actor.matrix) {
      actor.matrix.programs = Array.isArray(actor.matrix.programs) ? actor.matrix.programs : [];
      if (!actor.matrix.programs.includes(line.name)) actor.matrix.programs.push(line.name);
    }
    if (line.setMatrix && (st.deviceRating !== undefined || st.attributeArray || st.dataProcessing !== undefined)) {
      const arr = Array.isArray(st.attributeArray) ? st.attributeArray : null;
      actor.matrix = {
        device: line.name,
        rating: evalStat(st.deviceRating ?? 0, line.rating),
        attack: arr ? arr[0] : st.attack ?? 0,
        sleaze: arr ? arr[1] : st.sleaze ?? 0,
        dataProcessing: arr ? arr[2] : st.dataProcessing ?? evalStat(st.deviceRating ?? 0, line.rating),
        firewall: arr ? arr[3] : st.firewall ?? evalStat(st.deviceRating ?? 0, line.rating),
        programs: Array.isArray(actor.matrix?.programs) ? actor.matrix.programs : [],
        gearId: gearItem.id,
      };
      notes.push(`${line.name} devient l’appareil Matriciel`);
    }
  }
  return notes;
}

/** Apply a buy/give order to its actor (nuyen, items, stock). */
function applyOrder(ctx, actor, order, { free = false } = {}) {
  const notes = [];
  for (const line of order.items) {
    notes.push(...addLine(ctx, actor, line, { paid: free ? undefined : line.unitCost }));
    if (line.specialId) {
      const sp = ctx.state.shop.specials.find((s) => s.id === line.specialId);
      if (sp && sp.stock !== null && sp.stock !== undefined) sp.stock = Math.max(0, Number(sp.stock) - line.qty);
    }
  }
  if (!free) actor.nuyen = (Number(actor.nuyen) || 0) - order.total;
  const what = summary(order.items);
  history(actor, `${free ? 'Reçu du MJ' : 'Achat'} : ${what}${notes.length ? ` (${notes.join(', ')})` : ''}`, free ? 0 : -order.total);
  shopLog(ctx, actor.id, free ? `${actor.name} reçoit : ${what}` : `${actor.name} achète : ${what} — ${nuyen(order.total)}${notes.length ? ` · ${notes.join(', ')}` : ''}`);
  notifyOwners(ctx, actor.id, 'sfx', { id: 'cash' });
  return notes;
}

// ---------------------------------------------------------------------------
// Selling
// ---------------------------------------------------------------------------
/** Full (100%) unit value of an owned item, or null if unknown. */
function itemValue(list, it) {
  if (Number.isFinite(Number(it.paid)) && it.paid !== null && it.paid !== '') return Number(it.paid);
  const entry = (it.catalogId && INDEX.get(it.catalogId)) || BY_NAME.get(fold(it.name));
  if (!entry) return null;
  try {
    const q = quote(entry.item, { rating: it.rating, grade: it.grade });
    const per = list === 'gear' ? Number(entry.item.stats?.costFor) || 1 : 1;
    return Math.round((q.unitCost / per) * 100) / 100;
  } catch {
    return null;
  }
}

function findOwned(ctx, actor, list, itemId) {
  if (!LISTS.includes(list)) ctx.fail('Liste invalide');
  const arr = Array.isArray(actor[list]) ? actor[list] : [];
  const it = arr.find((x) => x.id === itemId);
  if (!it) ctx.fail('Objet introuvable dans l’inventaire');
  return it;
}

function applySell(ctx, actor, order) {
  const line = order.items[0];
  const it = findOwned(ctx, actor, line.list, line.itemId);
  const list = line.list;
  if (list === 'weapons' && it.augId) ctx.fail('Arme intégrée à un implant : revends l’implant lui-même');
  if (list === 'gear') {
    const have = Math.max(0, Number(it.qty ?? 1) || 0);
    if (have < 1) ctx.fail(`Plus aucun exemplaire de ${it.name} à revendre`);
    if (line.qty > have) ctx.fail(`Il ne reste que ${have} ${it.name}`);
    if (line.qty < have) it.qty = have - line.qty;
    else actor.gear = actor.gear.filter((g) => g.id !== it.id);
  } else {
    actor[list] = actor[list].filter((x) => x.id !== it.id);
  }
  if (list === 'augmentations') {
    removeBonus(actor, it.bonus);
    if (Array.isArray(actor.weapons)) actor.weapons = actor.weapons.filter((w) => w.augId !== it.id);
  }
  if (list === 'gear' && actor.matrix?.gearId === it.id && !actor.gear.some((g) => g.id === it.id)) {
    actor.matrix = { ...actor.matrix, device: '', rating: 0, attack: 0, sleaze: 0, dataProcessing: 0, firewall: 0 };
    delete actor.matrix.gearId;
  }
  actor.nuyen = (Number(actor.nuyen) || 0) + order.total;
  const what = `${line.name}${line.qty > 1 ? ` ×${line.qty}` : ''}`;
  history(actor, `Revente : ${what}`, order.total);
  shopLog(ctx, actor.id, `${actor.name} revend ${what} — ${nuyen(order.total)}`);
  notifyOwners(ctx, actor.id, 'sfx', { id: 'cash' });
}

// ---------------------------------------------------------------------------
// Specials (fixer deals)
// ---------------------------------------------------------------------------
function sanitizeSpecial(ctx, src, prev = {}) {
  const out = { ...prev };
  if (src.name !== undefined) out.name = str(src.name, 120) || prev.name || 'Offre sans nom';
  if (src.category !== undefined) out.category = str(src.category, 60);
  if (src.file !== undefined) out.file = SHOP_FILES.includes(src.file) ? src.file : 'gear';
  if (src.cost !== undefined) out.cost = Math.max(0, int(src.cost));
  if (src.avail !== undefined) {
    const a = parseAvailString(src.avail);
    out.avail = `${a.value}${a.legality}`;
  }
  if (src.stock !== undefined) out.stock = src.stock === null || src.stock === '' ? null : Math.max(0, int(src.stock));
  if (src.notes !== undefined) out.notes = str(src.notes, 2000);
  if (src.gmNotes !== undefined) out.gmNotes = str(src.gmNotes, 2000);
  if (src.hidden !== undefined) out.hidden = !!src.hidden;
  if (src.forActorIds !== undefined) out.forActorIds = Array.isArray(src.forActorIds) ? src.forActorIds.filter((id) => typeof id === 'string').slice(0, 20) : [];
  if (src.rating !== undefined) out.rating = src.rating === null || src.rating === '' ? null : Math.max(0, int(src.rating));
  if (src.grade !== undefined) out.grade = GRADES[src.grade] ? src.grade : 'standard';
  if (src.essence !== undefined) out.essence = src.essence === null || src.essence === '' ? null : Math.max(0, round3(Number(src.essence) || 0));
  if (src.catalogRef !== undefined) out.catalogRef = src.catalogRef && INDEX.has(src.catalogRef) ? src.catalogRef : null;
  if (src.stats !== undefined && src.stats && typeof src.stats === 'object') out.stats = JSON.parse(JSON.stringify(src.stats));
  if (src.originalCost !== undefined) out.originalCost = src.originalCost === null ? null : Math.max(0, int(src.originalCost));
  if (!out.file) out.file = out.catalogRef ? INDEX.get(out.catalogRef)?.file || 'gear' : 'gear';
  if (out.stock === undefined) out.stock = null;
  if (!out.avail) out.avail = '0';
  if (out.cost === undefined) out.cost = 0;
  return out;
}

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------
export default {
  name: 'shop',

  init(state, { readSeed }) {
    const d = defaults();
    state.shop = state.shop && typeof state.shop === 'object' ? state.shop : {};
    const shop = state.shop;
    for (const [k, v] of Object.entries(d)) if (shop[k] === undefined) shop[k] = v;
    shop.categories = { ...d.categories, ...(shop.categories || {}) };
    if (!Array.isArray(shop.specials)) shop.specials = [];
    if (!Array.isArray(shop.orders)) shop.orders = [];
    if (!Array.isArray(shop.removedSeedIds)) shop.removedSeedIds = [];
    const seed = readSeed('shop.json', { specials: [] }) || {};
    for (const sp of seed.specials || []) {
      if (!sp?.id || shop.specials.some((s) => s.id === sp.id) || shop.removedSeedIds.includes(sp.id)) continue;
      shop.specials.push({ stock: null, ...JSON.parse(JSON.stringify(sp)) });
    }
  },

  actions: {
    // Buy: { actorId, items: [{ ref: catalogId | 'special:<id>', qty, rating?, grade?, price? (variable-cost items), setMatrix? }] }
    // Player: own actor only, shop rules apply, may create a pending order. GM: immediate ("Vendre au PJ").
    'shop/buy': {
      role: 'any',
      handler(ctx, { actorId, items }) {
        const actor = getActor(ctx, actorId);
        if (!Array.isArray(items) || !items.length) ctx.fail('Panier vide');
        if (items.length > 50) ctx.fail('Panier trop chargé (50 lignes max)');
        const shop = ctx.state.shop;
        const lines = items.map((raw) => {
          const l = resolveLine(ctx, raw || {}, actorId);
          if (raw?.setMatrix) l.setMatrix = true;
          return l;
        });
        if (!ctx.isGM) checkRules(ctx, lines);
        checkStock(ctx, lines);
        checkEssence(ctx, actor, lines);
        const total = lines.reduce((s, l) => s + l.unitCost * l.qty, 0);
        checkFunds(ctx, actor, total);
        const flags = [...new Set(lines.flatMap((l) => lineFlags(shop, l)))];
        const needsApproval =
          !ctx.isGM && (shop.approval === 'always' || (shop.approval === 'restricted' && lines.some((l) => !l.specialId && (l.legality || l.variablePrice))));
        const order = {
          id: ctx.uid('ord'), ts: ctx.now, actorId, userId: ctx.user.id, by: ctx.isGM ? 'MJ' : ctx.user.name, kind: 'buy',
          items: lines, total, status: needsApproval ? 'pending' : 'done', flags,
        };
        if (needsApproval) {
          pushOrder(shop, order);
          shopLog(ctx, actorId, `${actor.name} passe commande : ${summary(lines)} — ${nuyen(total)} (en attente du MJ)`);
          ctx.emitTo('gm', 'sfx', { id: 'notify' });
          return { status: 'pending', orderId: order.id, total };
        }
        const notes = applyOrder(ctx, actor, order);
        pushOrder(shop, order);
        return { status: 'done', orderId: order.id, total, notes };
      },
    },

    // GM gift (no cost, no rules): { actorId, ref, qty?, rating?, grade?, setMatrix? } or { actorId, items: [...] }
    'shop/give': {
      role: 'gm',
      handler(ctx, { actorId, items, ...single }) {
        const actor = getActor(ctx, actorId);
        const raws = Array.isArray(items) && items.length ? items : [single];
        const lines = raws.map((raw) => {
          const l = resolveLine(ctx, raw || {}, actorId);
          if (raw?.setMatrix) l.setMatrix = true;
          return l;
        });
        checkStock(ctx, lines);
        checkEssence(ctx, actor, lines);
        const order = { id: ctx.uid('ord'), ts: ctx.now, actorId, userId: ctx.user.id, by: 'MJ', kind: 'give', items: lines, total: 0, status: 'done', flags: [] };
        const notes = applyOrder(ctx, actor, order, { free: true });
        pushOrder(ctx.state.shop, order);
        return { status: 'done', orderId: order.id, notes };
      },
    },

    // Sell: { actorId, list: 'weapons'|'armor'|'augmentations'|'gear'|'vehicles', itemId, qty?, price? (GM: total override) }
    'shop/sell': {
      role: 'any',
      handler(ctx, { actorId, list, itemId, qty, price }) {
        const actor = getActor(ctx, actorId);
        const shop = ctx.state.shop;
        if (!ctx.isGM && !shop.open) ctx.fail('Cabana n’est pas joignable pour l’instant');
        const it = findOwned(ctx, actor, list, itemId);
        if (list === 'weapons' && it.augId) ctx.fail('Arme intégrée à un implant : revends l’implant lui-même');
        const have = list === 'gear' ? Math.max(0, int(it.qty ?? 1, 0)) : 1;
        if (have < 1) ctx.fail('Plus aucun exemplaire à revendre');
        const n = list === 'gear' ? clampInt(qty ?? have, 1, have, 1) : 1;
        if (ctx.state.shop.orders.some((o) => o.status === 'pending' && o.kind === 'sell' && o.items[0]?.itemId === itemId)) ctx.fail('Une revente de cet objet attend déjà le MJ');
        const value = itemValue(list, it);
        let total = value === null ? null : Math.round(value * n * (Number(shop.sellRate) || 0) / 100);
        if (ctx.isGM && price !== undefined && price !== null && price !== '') total = Math.max(0, int(price));
        if (ctx.isGM && total === null) ctx.fail('Prix inconnu : indique un montant de revente');
        const order = {
          id: ctx.uid('ord'), ts: ctx.now, actorId, userId: ctx.user.id, by: ctx.isGM ? 'MJ' : ctx.user.name, kind: 'sell',
          items: [{ list, itemId, name: it.name, qty: n, rating: it.rating ?? null, unitCost: value === null ? null : Math.round(value * (Number(shop.sellRate) || 0) / 100) }],
          total, status: 'pending', flags: total === null ? ['price'] : [],
        };
        if (!ctx.isGM && (shop.approval === 'always' || total === null)) {
          pushOrder(shop, order);
          shopLog(ctx, actorId, `${actor.name} propose de revendre ${it.name}${n > 1 ? ` ×${n}` : ''}${total !== null ? ` — ${nuyen(total)}` : ' (prix à fixer)'} (en attente du MJ)`);
          ctx.emitTo('gm', 'sfx', { id: 'notify' });
          return { status: 'pending', orderId: order.id, total };
        }
        order.status = 'done';
        applySell(ctx, actor, order);
        pushOrder(shop, order);
        return { status: 'done', orderId: order.id, total };
      },
    },

    // GM: approve or deny a pending order. { orderId, approve: bool, note?, total? (override, e.g. negotiated price) }
    'shop/resolve': {
      role: 'gm',
      handler(ctx, { orderId, approve, note, total }) {
        const shop = ctx.state.shop;
        const order = shop.orders.find((o) => o.id === orderId);
        if (!order) ctx.fail('Commande introuvable');
        if (order.status !== 'pending') ctx.fail('Cette commande a déjà été traitée');
        const actor = ctx.state.actors?.[order.actorId];
        if (note !== undefined) order.gmNote = str(note, 500) || undefined;
        if (!approve) {
          order.status = 'denied';
          order.resolvedTs = ctx.now;
          if (actor) shopLog(ctx, actor.id, `Commande refusée pour ${actor.name} : ${order.kind === 'sell' ? 'revente de ' : ''}${summary(order.items)}${order.gmNote ? ` — « ${order.gmNote} »` : ''}`);
          notifyOwners(ctx, order.actorId, 'shop:resolved', { orderId, status: 'denied', note: order.gmNote || '' });
          return { status: 'denied' };
        }
        if (!actor) ctx.fail('Le personnage de cette commande n’existe plus');
        if (total !== undefined && total !== null && total !== '') order.total = Math.max(0, int(total));
        if (order.kind === 'sell') {
          if (order.total === null || order.total === undefined) ctx.fail('Indique le montant de la revente');
          applySell(ctx, actor, order);
        } else {
          checkStock(ctx, order.items);
          checkEssence(ctx, actor, order.items);
          checkFunds(ctx, actor, order.total);
          applyOrder(ctx, actor, order);
        }
        order.status = 'approved';
        order.resolvedTs = ctx.now;
        notifyOwners(ctx, order.actorId, 'shop:resolved', { orderId, status: 'approved', note: order.gmNote || '' });
        return { status: 'approved' };
      },
    },

    // Owner (or GM) cancels a pending order: { orderId }
    'shop/cancel': {
      role: 'any',
      handler(ctx, { orderId }) {
        const order = ctx.state.shop.orders.find((o) => o.id === orderId);
        if (!order) ctx.fail('Commande introuvable');
        if (!ctx.isGM && order.userId !== ctx.user.id && !ctx.owns(order.actorId)) ctx.fail('Ce n’est pas ta commande');
        if (order.status !== 'pending') ctx.fail('Cette commande n’est plus en attente');
        order.status = 'cancelled';
        order.resolvedTs = ctx.now;
        return { status: 'cancelled' };
      },
    },

    // GM: { open?, markup?, sellRate?, maxAvail?, allowRestricted?, allowForbidden?, approval?, categories?: { file: bool } }
    'shop/updateSettings': {
      role: 'gm',
      handler(ctx, p) {
        const shop = ctx.state.shop;
        if (p.open !== undefined) shop.open = !!p.open;
        if (p.markup !== undefined) shop.markup = clampInt(p.markup, -90, 500, 0);
        if (p.sellRate !== undefined) shop.sellRate = clampInt(p.sellRate, 0, 100, 50);
        if (p.maxAvail !== undefined) shop.maxAvail = clampInt(p.maxAvail, 0, 40, 12);
        if (p.allowRestricted !== undefined) shop.allowRestricted = !!p.allowRestricted;
        if (p.allowForbidden !== undefined) shop.allowForbidden = !!p.allowForbidden;
        if (p.approval !== undefined) {
          if (!APPROVAL_MODES.includes(p.approval)) ctx.fail('Mode de validation inconnu');
          shop.approval = p.approval;
        }
        if (p.categories && typeof p.categories === 'object') {
          for (const [k, v] of Object.entries(p.categories)) if (SHOP_FILES.includes(k)) shop.categories[k] = !!v;
        }
        return { ok: true };
      },
    },

    // GM: { special: {...fields} } or { fromRef: catalogId, rating?, grade?, cost?, stock?, notes? }. Returns { id }.
    'shop/addSpecial': {
      role: 'gm',
      handler(ctx, { special, fromRef, ...rest }) {
        let src = special && typeof special === 'object' ? { ...special } : {};
        if (fromRef) {
          const entry = INDEX.get(fromRef);
          if (!entry) ctx.fail('Article inconnu du catalogue');
          const q = quote(entry.item, { rating: rest.rating, grade: rest.grade });
          src = {
            name: itemName(entry.item) + (q.rating ? ` (ind. ${q.rating})` : ''),
            category: entry.item.categoryFr || entry.item.category,
            file: entry.file,
            cost: q.unitCost,
            originalCost: q.unitCost,
            avail: q.avail,
            stock: 1,
            notes: '',
            rating: q.rating,
            grade: q.grade || undefined,
            essence: q.essence,
            catalogRef: entry.item.id,
            ...rest,
            ...src,
          };
          delete src.fromRef;
        }
        if (!src.name) src.name = 'Nouvelle offre';
        const sp = sanitizeSpecial(ctx, src, { id: ctx.uid('spc') });
        ctx.state.shop.specials.push(sp);
        return { id: sp.id };
      },
    },

    // GM: { id, patch: {...fields} }
    'shop/updateSpecial': {
      role: 'gm',
      handler(ctx, { id, patch }) {
        const shop = ctx.state.shop;
        const i = shop.specials.findIndex((s) => s.id === id);
        if (i < 0) ctx.fail('Offre introuvable');
        shop.specials[i] = sanitizeSpecial(ctx, patch || {}, shop.specials[i]);
        return { ok: true };
      },
    },

    // GM: { id }
    'shop/removeSpecial': {
      role: 'gm',
      handler(ctx, { id }) {
        const shop = ctx.state.shop;
        if (!shop.specials.some((s) => s.id === id)) ctx.fail('Offre introuvable');
        shop.specials = shop.specials.filter((s) => s.id !== id);
        if (!shop.removedSeedIds.includes(id)) shop.removedSeedIds.push(id);
        return { ok: true };
      },
    },

    // Pay rent in advance: { actorId, months } (uses actor.lifestyle.monthlyCost)
    'shop/payLifestyle': {
      role: 'any',
      handler(ctx, { actorId, months }) {
        const actor = getActor(ctx, actorId);
        const lf = actor.lifestyle;
        if (!lf || !(Number(lf.monthlyCost) > 0)) ctx.fail('Aucun train de vie défini pour ce personnage');
        const m = int(months, 1);
        if (m < 1 || m > 24) ctx.fail('Nombre de mois invalide (1 à 24)');
        const total = Math.round(Number(lf.monthlyCost) * m);
        checkFunds(ctx, actor, total);
        actor.nuyen = (Number(actor.nuyen) || 0) - total;
        lf.monthsPaid = (Number(lf.monthsPaid) || 0) + m;
        history(actor, `Loyer : ${lf.name} — ${m} mois`, -total);
        shopLog(ctx, actorId, `${actor.name} paie ${m} mois de train de vie (${lf.name}) — ${nuyen(total)}`);
        notifyOwners(ctx, actorId, 'sfx', { id: 'cash' });
        return { monthsPaid: lf.monthsPaid, total };
      },
    },

    // GM: remove resolved orders from the history (pending ones are kept).
    'shop/clearOrders': {
      role: 'gm',
      handler(ctx) {
        ctx.state.shop.orders = ctx.state.shop.orders.filter((o) => o.status === 'pending');
        return { ok: true };
      },
    },
  },

  filter(view, user) {
    if (!view.shop) return;
    const mine = new Set(user.characterIds || []);
    view.shop.orders = (view.shop.orders || []).filter((o) => o.userId === user.id || mine.has(o.actorId));
    view.shop.specials = (view.shop.specials || [])
      .filter((s) => !s.hidden && (!s.forActorIds?.length || s.forActorIds.some((id) => mine.has(id))))
      .map(({ gmNotes, ...s }) => s);
    delete view.shop.removedSeedIds;
  },
};
