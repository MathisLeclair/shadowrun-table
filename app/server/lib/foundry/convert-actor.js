// Foundry shadowrun5e actors → app Actor / bestiary Template / vehicle items (see ARCHITECTURE.md "Actors").
// Pure functions: assets are not copied here, ctx.asset(src, kind) only returns the future URL and records the copy.
import { SKILL_BY_ID, METATYPES } from '../../../shared/sr5.js';
import { findCatalog, norm } from './catalog.js';
import { htmlToMarkdown } from './html2md.js';
import { monthlyCost } from '../../../shared/lifestyle.js';
import { chummerEval } from '../chummer/parse.js';
import { guessContainerKind } from '../../../client/modules/sheet/inventory.js';

export const ATTR_KEYS = { body: 'BOD', agility: 'AGI', reaction: 'REA', strength: 'STR', willpower: 'WIL', logic: 'LOG', intuition: 'INT', charisma: 'CHA', edge: 'EDG', magic: 'MAG', resonance: 'RES', essence: 'ESS' };
const CORE = ['BOD', 'AGI', 'REA', 'STR', 'WIL', 'LOG', 'INT', 'CHA'];
export const METATYPE_FR = { human: 'Humain', elf: 'Elfe', dwarf: 'Nain', ork: 'Ork', orc: 'Ork', troll: 'Troll' };
const KNOW_TYPES = { street: 'street', academic: 'academic', professional: 'professional', interests: 'interest', interest: 'interest' };
const LIFESTYLE_BASE = { street: 'Street', squatter: 'Squatter', low: 'Low', medium: 'Medium', middle: 'Medium', high: 'High', luxury: 'Luxury', commercial: 'Commercial', traveler: 'Traveler', bolt_hole: 'Bolt Hole', hospitalized: 'Hospitalized' };
const LIFESTYLE_COST = { street: 0, squatter: 500, low: 2000, medium: 5000, middle: 5000, high: 10000, luxury: 100000, commercial: 8000, traveler: 3000, bolt_hole: 1000, hospitalized: 500 };
const MOUNTS = { top: 'Top', under: 'Under', barrel: 'Barrel', stock: 'Stock', side: 'Side', internal: 'Internal' };
const SPELL_CAT = { combat: 'Combat', detection: 'Détection', health: 'Santé', illusion: 'Illusion', manipulation: 'Manipulation', enchantment: 'Enchantement', ritual: 'Rituel' };
const SPELL_RANGE = { los: 'LDV', los_a: 'LDV (Z)', touch: 'Contact', self: 'Personnel', self_a: 'Personnel (Z)', special: 'Spécial' };
const SPELL_DUR = { instant: 'I', sustained: 'M', permanent: 'P', always: 'Toujours', special: 'Spécial' };
const CLIP = { removable_clip: 'c', internal_magazin: 'm', internal_magazine: 'm', break_action: 'b', belt_fed: 'ceinture', cylinder: 'cy', muzzle_loader: 'ml', drum: 'tambour', heavy_weapon: 'lourd', bow: '' };
const SKILL_ALIASES = { exotic_melee_weapon: 'exotic_weapon', exotic_ranged_weapon: 'exotic_weapon', exotic_ranged: 'exotic_weapon', exotic_melee: 'exotic_weapon', pilot_ground_vehicle: 'pilot_ground_craft' };
const CUSTOM_SKILL_FR = { pilot_exotic_vehicle: 'Pilotage (véhicule exotique)' };

const num = (v, d = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
const r2 = (v) => Math.round(v * 100) / 100;
const snake = (s) =>
  String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
const tech = (it) => it.system?.technology || {};
const fid = (it) => `fvtt_${it._id}`;
const src = (it) => String(it.system?.description?.source || '').trim();
const md = (html, ctx) => htmlToMarkdown(html || '', { links: ctx?.links });

/** Foundry skill (name or action.skill id) → app skill id. */
export function skillId(nameOrId) {
  const s = snake(nameOrId);
  if (SKILL_BY_ID[s]) return s;
  if (SKILL_ALIASES[s]) return SKILL_ALIASES[s];
  return s;
}

function sheetSkill(id, rating, { attr, spec, name } = {}) {
  const def = SKILL_BY_ID[id];
  const out = { id, name: def?.fr || CUSTOM_SKILL_FR[id] || name || id, attr: def?.attr || attr || 'AGI', rating };
  if (spec) out.spec = spec;
  if (def?.group) out.group = def.group;
  return out;
}

/** Is this Foundry actor an empty stat block (all physical/mental attributes at 0)? */
export function hasStats(fa) {
  const at = fa.system?.attributes || {};
  return CORE.reduce((s, k) => s + num(at[Object.keys(ATTR_KEYS).find((x) => ATTR_KEYS[x] === k)]?.base), 0) > 0;
}

/** Attribute changes from active effects (actor effects + transferred effects of equipped items). */
function effectBonuses(fa) {
  const out = {};
  const apply = (eff) => {
    if (!eff || eff.disabled) return;
    for (const ch of eff.system?.changes || eff.changes || []) {
      const m = /^system\.attributes\.([a-z_]+)(?:\.value|\.base)?$/.exec(String(ch.key || ''));
      if (!m || !ATTR_KEYS[m[1]]) continue;
      const v = num(ch.value, 0);
      if (!v) continue;
      const k = ATTR_KEYS[m[1]];
      out[k] = (out[k] || 0) + v;
    }
  };
  for (const e of fa.effects || []) apply(e);
  for (const it of fa.items || []) {
    if (it.system?.technology && it.system.technology.equipped === false) continue;
    for (const e of it.effects || []) if (e.transfer !== false) apply(e);
  }
  return out;
}

/** Augmentation bonuses implied by well-known powers/ware ({ REA: n, initDice: n }). */
function knownBoosts(items) {
  let rea = 0;
  let dice = 0;
  for (const it of items) {
    const n = norm(it.name);
    const lvl = it.type === 'adept_power' ? num(it.system?.level, 0) : num(tech(it).rating, 0);
    if (it.type === 'adept_power' && /improved reflexes/.test(n)) {
      rea = Math.max(rea, lvl);
      dice = Math.max(dice, lvl);
    } else if ((it.type === 'cyberware' || it.type === 'bioware') && /(wired reflexes|synaptic booster|move by wire)/.test(n)) {
      rea = Math.max(rea, lvl);
      dice = Math.max(dice, lvl);
    }
  }
  return { rea, dice };
}

function weaponOf(it, physical = null) {
  const s = it.system || {};
  const a = s.action || {};
  const cat = String(s.category || '');
  const melee = cat === 'melee';
  const hit = findCatalog(it.name, 'weapons');
  const cs = hit?.entry?.stats || {};
  let skill = skillId(a.skill || '') || cs.skill || 'exotic_weapon';
  if (!SKILL_BY_ID[skill]) skill = cs.skill && SKILL_BY_ID[cs.skill] ? cs.skill : skill;
  const dmg = a.damage || {};
  const typeLetter = /stun/i.test(dmg.type?.base || dmg.type?.value || '') ? 'S' : 'P';
  const base = num(dmg.base, 0);
  let damage;
  const isUnarmedDmg = /^unarmed attack$/i.test(it.name) && !dmg.attribute;
  if (isUnarmedDmg) damage = '(STR)S'; // Foundry keeps a placeholder base; SR5 unarmed = STR stun
  else if (dmg.attribute === 'strength') damage = `(STR${base ? (base > 0 ? '+' : '') + base : ''})${typeLetter}`;
  else if (base > 0) damage = `${base}${typeLetter}`;
  else if (cs.damage) damage = String(cs.damage);
  else damage = melee ? `(STR)${typeLetter}` : 'Spécial'; // launchers, flash-paks: damage comes from the ammo
  const elem = dmg.element?.base || dmg.element?.value;
  const modes = s.range?.modes || {};
  const mode = [modes.single_shot && 'CC', modes.semi_auto && 'SA', modes.burst_fire && 'TR', modes.full_auto && 'TA'].filter(Boolean).join('/');
  const ammoMax = num(s.ammo?.current?.max, 0);
  const clip = CLIP[s.ammo?.clip_type] ?? '';
  const isUnarmed = /^unarmed attack$/i.test(it.name);
  const notes = [];
  if (elem) notes.push(`Élément : ${elem}`);
  const blast = s.thrown?.blast || {};
  if (num(blast.radius)) notes.push(`Zone : ${blast.radius} m${num(blast.dropoff) ? `, ${blast.dropoff}/m` : ''}`);
  if (src(it)) notes.push(`${it.name} (${src(it)})`);
  const out = {
    id: fid(it),
    _en: it.name,
    name: isUnarmed ? 'Mains nues' : hit?.entry?.nameFr || it.name,
    category: s.subcategory ? hit?.entry?.categoryFr || s.subcategory : hit?.entry?.categoryFr || (melee ? 'Corps à corps' : cat === 'thrown' ? 'Arme de jet' : 'Arme à distance'),
    kind: melee ? 'melee' : 'ranged',
    skill: isUnarmed ? 'unarmed_combat' : skill,
    accuracy: '', // below
    damage,
    ap: num(dmg.ap?.base, 0),
    mode: melee ? '' : mode || cs.mode || '',
    rc: num(s.range?.rc?.base, 0),
    ammo: melee || cat === 'thrown' ? '' : ammoMax ? `${ammoMax}${clip ? `(${clip})` : ''}` : cs.ammo || '',
    reach: num(s.melee?.reach, 0),
  };
  if (tech(it).equipped) out.equipped = true;
  // Inventory (client/modules/sheet/inventory.js): rounds in the weapon, units of a thrown weapon (grenades).
  if (out.ammo && ammoMax) out.ammoLoaded = Math.max(0, Math.min(ammoMax, Math.round(num(s.ammo?.current?.value, ammoMax))));
  if (cat === 'thrown') out.qty = Math.max(1, Math.round(num(tech(it).quantity, 1)));
  if (hit) out.catalogId = hit.entry.id;
  const accessories = embedded(it, 'weapon').map(accessoryOf);
  if (accessories.length) out.accessories = accessories;
  // Accuracy = the BASE value (accessories add theirs: shared/modifiers.js weaponAccuracy). Unarmed / thrown weapons and grenades use
  // the physical limit, which Foundry stores as a number: kept as « Physical » (± the difference) so it follows STR / BOD / REA and
  // the physical-limit modifiers. limit.value (accessories included) only when no accessory carries an Accuracy bonus.
  const limBase = num(a.limit?.base, 0);
  if (isUnarmed || cat === 'thrown' || /phys/i.test(String(cs.accuracy ?? ''))) {
    // Unarmed: Foundry keeps a placeholder (5 on most NPCs) → plain « Physical »; thrown weapons keep a small difference (Boomerang −1).
    const diff = physical && limBase && !isUnarmed ? limBase - physical : 0;
    out.accuracy = /phys/i.test(String(cs.accuracy ?? '')) ? String(cs.accuracy) : diff && Math.abs(diff) <= 2 ? `Physical${diff > 0 ? '+' : ''}${diff}` : 'Physical';
  } else {
    const accBonus = accessories.some((x) => Number(x.effects?.accuracy));
    out.accuracy = limBase || (accBonus ? 0 : num(a.limit?.value, 0)) || (cs.accuracy ?? '');
  }
  const mounts = hit?.entry?.stats?.mounts || hit?.entry?.mounts;
  if (Array.isArray(mounts) && mounts.length) out.mounts = mounts.filter((m) => Object.values(MOUNTS).includes(m));
  if (notes.length) out.notes = notes.join(' · ');
  return out;
}

/** Modifications embedded in a Foundry item (flags.shadowrun5e.embeddedItems, type 'modification'). */
function embedded(it, kind) {
  const list = it.flags?.shadowrun5e?.embeddedItems;
  return (Array.isArray(list) ? list : []).filter((e) => e && typeof e === 'object' && e.type === 'modification' && (!kind || !e.system?.type || e.system.type === kind));
}

/** Common fields of an embedded modification: { id, name, nameFr?, catalogId?, rating?, cost, avail, notes? }. */
function modHead(e, file, i) {
  const hit = findCatalog(e.name, file);
  const t = e.system?.technology || {};
  const rating = Math.round(num(t.rating, 0));
  const out = { id: `fvtt_${e._id || `m${i}`}`, name: e.name };
  if (hit?.entry?.nameFr) out.nameFr = hit.entry.nameFr;
  if (hit) out.catalogId = hit.entry.id;
  if (rating > 0) out.rating = rating;
  out.cost = num(t.cost, 0) || num(hit?.entry?.cost, 0);
  out.avail = String(t.availability ?? hit?.entry?.avail ?? '');
  if (src(e)) out.notes = src(e);
  return { out, hit };
}

/** Foundry weapon modification → weapon.accessories[] item. */
function accessoryOf(e, i) {
  const { out, hit } = modHead(e, 'accessories', i);
  const m = e.system?.mod_weapon || {};
  const cs = hit?.entry?.stats || {};
  const effects = {};
  if (/smartgun/i.test(e.name)) effects.smartgun = true;
  else if (num(m.accuracy, 0) || num(cs.accuracy, 0)) effects.accuracy = num(m.accuracy, 0) || num(cs.accuracy, 0);
  if (num(m.rc, 0) || num(cs.rc, 0)) effects.rc = num(m.rc, 0) || num(cs.rc, 0);
  if (num(m.dice_pool, 0)) effects.dicePool = num(m.dice_pool, 0);
  const mount = MOUNTS[String(m.mount_point || '').toLowerCase()] || String(cs.mount || '').split('/')[0] || '';
  return { ...out, mount: Object.values(MOUNTS).includes(mount) ? mount : '', effects };
}

/** Foundry armor modification → armor.mods[] item. */
function armorModOf(e, i, armorCapacity = 0) {
  const { out, hit } = modHead(e, 'armormods', i);
  const armor = num(e.system?.mod_armor?.value, 0);
  const capRaw = hit?.entry?.stats?.capacity ?? hit?.entry?.capacity;
  const cap = typeof capRaw === 'number' ? capRaw : chummerEval(capRaw, { Rating: out.rating || 1, Capacity: armorCapacity }) ?? 0;
  return { ...out, capacity: cap, ...(armor ? { effects: { armor } } : {}) };
}

function deviceAtts(it) {
  const atts = Object.values(it.system?.atts || {});
  const names = atts.map((a) => a.att);
  const vals = atts.map((a) => num(a.value, 0));
  const out = { attack: 0, sleaze: 0, dataProcessing: 0, firewall: 0 };
  if (new Set(names).size === names.length && names.length === 4) {
    for (let i = 0; i < 4; i++) {
      const k = names[i] === 'data_processing' ? 'dataProcessing' : names[i];
      if (k in out) out[k] = vals[i];
    }
  } else {
    [out.attack, out.sleaze, out.dataProcessing, out.firewall] = [vals[0] || 0, vals[1] || 0, vals[2] || 0, vals[3] || 0];
  }
  if (it.system?.category === 'commlink' && !out.dataProcessing && !out.firewall) {
    out.dataProcessing = num(tech(it).rating, 0);
    out.firewall = num(tech(it).rating, 0);
  }
  return out;
}

/**
 * Convert the "sheet" part shared by PCs and NPCs.
 * ctx: { links, asset(src, kind) → url|'' }
 */
export function convertSheet(fa, ctx = {}) {
  const s = fa.system || {};
  const at = s.attributes || {};
  const items = Array.isArray(fa.items) ? fa.items.filter((x) => x && typeof x === 'object') : [];
  const metatype = METATYPE_FR[String(s.metatype || '').toLowerCase()] || (s.metatype ? String(s.metatype)[0].toUpperCase() + String(s.metatype).slice(1) : 'Humain');
  const stats = hasStats(fa);
  const notesGm = [];

  // --- Attributes & augmentations
  const attributes = {};
  for (const [fk, k] of Object.entries(ATTR_KEYS)) {
    if (k === 'ESS') continue;
    const v = num(at[fk]?.base, 0);
    if (k === 'MAG' || k === 'RES') {
      if (v > 0) attributes[k] = v;
    } else attributes[k] = stats ? Math.max(k === 'EDG' ? 0 : 1, v) : k === 'EDG' ? 1 : 3;
  }
  const augmented = {};
  const eff = effectBonuses(fa);
  for (const [k, v] of Object.entries(eff)) if (k !== 'ESS' && v) augmented[k] = v;
  const boosts = knownBoosts(items);
  if (boosts.rea && !augmented.REA) {
    // Foundry sheets often carry the boosted value in the base (no active effect): undo it when the
    // base exceeds the metatype maximum, so the app does not count the bonus twice.
    const max = METATYPES[metatype]?.max?.REA ?? 6;
    if (attributes.REA - boosts.rea >= 1 && attributes.REA > max) {
      attributes.REA -= boosts.rea;
      augmented.REA = boosts.rea;
      notesGm.push(`Réaction Foundry ${attributes.REA + boosts.rea} = ${attributes.REA} naturelle + ${boosts.rea} (augmentation).`);
    } else if (attributes.REA <= max) augmented.REA = boosts.rea;
  }
  // Essence: Foundry keeps the base at 6 and derives the value from 'ware.
  const ware = items.filter((it) => (it.type === 'cyberware' || it.type === 'bioware') && tech(it).equipped !== false);
  const wareEss = ware.reduce((sum, it) => sum + num(it.system?.essence, 0), 0);
  const essBase = num(at.essence?.base, 6);
  attributes.ESS = r2(Math.max(0, Math.min(essBase > 0 ? essBase : 6, 6 - wareEss)));

  // --- Initiative
  let dice = Math.round(num(s.initiative?.meatspace?.dice?.base, 1));
  if (dice <= 1 && boosts.dice) dice = 1 + boosts.dice;
  const initiative = { dice: Math.max(1, Math.min(5, dice || 1)), bonus: Math.round(num(s.initiative?.meatspace?.constant?.base, 0)) };

  // --- Skills & knowledge
  const skills = [];
  const knowledge = [];
  const usedSkillIds = new Set();
  for (const it of items.filter((x) => x.type === 'skill')) {
    const k = it.system?.skill || {};
    const rating = Math.round(num(k.rating, 0));
    const specs = (k.specializations || []).map((x) => (typeof x === 'string' ? x : x?.name)).filter(Boolean);
    if (k.category === 'active') {
      if (rating <= 0) continue;
      let id = skillId(it.name);
      if (!id) continue;
      if (usedSkillIds.has(id)) id = `${id}_${it._id.slice(0, 4).toLowerCase()}`;
      usedSkillIds.add(id);
      skills.push(sheetSkill(id, rating, { attr: ATTR_KEYS[k.attribute] || 'AGI', spec: specs.join(', '), name: it.name }));
    } else if (k.category === 'language') {
      const native = !!k.language?.isNative || rating === 0 || rating > 12;
      knowledge.push({ id: fid(it), name: it.name, rating: native ? 0 : rating, type: 'language', ...(native ? { native: true } : {}), ...(specs.length ? { spec: specs.join(', ') } : {}) });
    } else if (k.category === 'knowledge') {
      if (rating <= 0) continue;
      knowledge.push({ id: fid(it), name: it.name, rating, type: KNOW_TYPES[k.knowledgeType] || 'street', ...(specs.length ? { spec: specs.join(', ') } : {}) });
    }
  }
  skills.sort((a, b) => b.rating - a.rating || a.name.localeCompare(b.name, 'fr'));

  // --- Qualities, powers, spells
  const qualities = items
    .filter((x) => x.type === 'quality')
    .map((it) => {
      const hit = findCatalog(it.name, 'qualities');
      const positive = it.system?.type !== 'negative';
      const karma = Math.abs(num(it.system?.karma, 0)) || Math.abs(num(hit?.entry?.stats?.karma, 0));
      return { id: fid(it), name: hit?.entry?.nameFr || it.name, karma: positive ? karma : -karma, positive, notes: [it.name, src(it)].filter(Boolean).join(' · '), ...(hit ? { catalogId: hit.entry.id } : {}) };
    });
  const powers = items
    .filter((x) => x.type === 'adept_power')
    .map((it) => {
      const hit = findCatalog(it.name, 'powers');
      const lvl = Math.round(num(it.system?.level, 0));
      return { id: fid(it), name: hit?.entry?.nameFr || it.name, ...(lvl > 0 ? { level: lvl } : {}), pp: num(it.system?.pp, 0), notes: [it.name, src(it)].filter(Boolean).join(' · '), ...(hit ? { catalogId: hit.entry.id } : {}) };
    });
  const spells = items
    .filter((x) => x.type === 'spell')
    .map((it) => {
      const sp = it.system || {};
      const hit = findCatalog(it.name, 'spells');
      const drain = num(sp.drain, 0);
      return {
        id: fid(it),
        name: hit?.entry?.nameFr || it.name,
        category: SPELL_CAT[sp.category] || sp.category || '',
        type: sp.type === 'mana' ? 'M' : 'P',
        range: SPELL_RANGE[sp.range] || sp.range || '',
        duration: SPELL_DUR[sp.duration] || sp.duration || '',
        drain: `F${drain >= 0 ? '+' : ''}${drain}`,
        notes: [it.name, src(it)].filter(Boolean).join(' · '),
        ...(hit ? { catalogId: hit.entry.id } : {}),
      };
    });

  // --- Inventories (system.inventories: { 'Duffel Bag': { name, itemIds } }, « All » = the whole list) → containers + item locations
  const { containers, locationOf } = inventoriesOf(fa);

  // --- Weapons, armor, augmentations
  // Physical limit (SR5 p. 46) with the augmented attributes (+4 max), for the thrown weapons' « Physical » accuracy.
  const effAttr = (k) => (attributes[k] || 1) + Math.min(4, augmented[k] || 0);
  const physicalLimit = Math.ceil((effAttr('STR') * 2 + effAttr('BOD') + effAttr('REA')) / 3);
  const weapons = items.filter((x) => x.type === 'weapon').map((x) => weaponOf(x, physicalLimit));
  const armor = [];
  const gear = [];
  for (const it of items.filter((x) => x.type === 'armor')) {
    const a = it.system?.armor || {};
    const rating = num(a.base, 0) || num(a.value, 0);
    const hit = findCatalog(it.name, 'armor');
    const name = hit?.entry?.nameFr || it.name;
    if (rating <= 0) {
      gear.push({ id: fid(it), name, category: 'Vêtements', qty: Math.max(1, num(tech(it).quantity, 1)), ...(hit ? { catalogId: hit.entry.id } : {}), notes: it.name !== name ? it.name : undefined });
      continue;
    }
    const capacity = num(hit?.entry?.stats?.capacity, 0);
    const mods = embedded(it, 'armor').map((e, i) => armorModOf(e, i, capacity));
    // shared/sr5.js armorTotal adds mods[].effects.armor to the rating: only when the rating is Foundry's base value
    // (armor.value is the total, mods included — no second count).
    if (!num(a.base, 0)) {
      for (const m of mods) {
        if (!m.effects) continue;
        delete m.effects.armor;
        if (!Object.keys(m.effects).length) delete m.effects;
      }
    }
    armor.push({
      id: fid(it), _en: it.name, name, rating, equipped: !!tech(it).equipped, stack: !!a.accessory, ...(capacity ? { capacity } : {}), ...(mods.length ? { mods } : {}),
      ...(it.name !== name ? { notes: it.name } : {}), ...(hit ? { catalogId: hit.entry.id } : {}),
    });
  }
  const augmentations = ware.concat(items.filter((it) => (it.type === 'cyberware' || it.type === 'bioware') && tech(it).equipped === false)).map((it) => {
    const hit = findCatalog(it.name, ['cyberware', 'bioware']);
    const rating = Math.round(num(tech(it).rating, 0));
    return {
      id: fid(it),
      name: hit?.entry?.nameFr || it.name,
      kind: it.type === 'bioware' ? 'bioware' : 'cyberware',
      grade: ['standard', 'alpha', 'beta', 'delta', 'used', 'gamma', 'omega'].includes(it.system?.grade) ? it.system.grade : 'standard',
      ...(rating > 0 ? { rating } : {}),
      essence: r2(num(it.system?.essence, 0)),
      ...(tech(it).equipped === false ? { notes: 'Non installé (Foundry)' } : it.name !== (hit?.entry?.nameFr || it.name) ? { notes: it.name } : {}),
      ...(hit ? { catalogId: hit.entry.id } : {}),
    };
  });

  // --- Matrix: main device (equipped cyberdeck first, else best equipped commlink)
  const devices = items.filter((x) => x.type === 'device');
  const programs = items.filter((x) => x.type === 'program');
  const pick = [...devices].sort((a, b) => {
    const sa = (a.system?.category === 'cyberdeck' ? 100 : 0) + (tech(a).equipped ? 50 : 0) + num(tech(a).rating, 0);
    const sb = (b.system?.category === 'cyberdeck' ? 100 : 0) + (tech(b).equipped ? 50 : 0) + num(tech(b).rating, 0);
    return sb - sa;
  })[0];
  let matrix;
  if (pick) {
    const atts = deviceAtts(pick);
    matrix = {
      device: `${pick.name}${pick.system?.category === 'cyberdeck' ? '' : ' (commlink)'}`,
      rating: Math.round(num(tech(pick).rating, 0)),
      ...atts,
      programs: programs.map((p) => (num(tech(p).rating, 0) > 0 ? `${p.name} (${tech(p).rating})` : p.name)),
    };
  }
  for (const d of devices) {
    if (d === pick) continue;
    gear.push({ id: fid(d), name: d.name, category: d.system?.category === 'cyberdeck' ? 'Cyberdeck' : 'Commlink', rating: Math.round(num(tech(d).rating, 0)) || undefined, qty: Math.max(1, num(tech(d).quantity, 1)) });
  }

  // --- Gear (equipment + ammo)
  for (const it of items.filter((x) => x.type === 'equipment' || x.type === 'ammo')) {
    const hit = findCatalog(it.name, it.type === 'ammo' ? ['gear', 'weapons'] : ['gear', 'weapons', 'armor']);
    const rating = Math.round(num(tech(it).rating, 0));
    const g = {
      id: fid(it),
      name: hit?.entry?.nameFr || it.name,
      category: hit?.entry?.categoryFr || (it.type === 'ammo' ? 'Munitions' : 'Équipement'),
      ...(rating > 0 ? { rating } : {}),
      qty: Math.max(0, Math.round(num(tech(it).quantity, 1))),
    };
    if (hit) g.catalogId = hit.entry.id;
    if (g.name !== it.name) g.notes = it.name;
    gear.push(g);
  }
  for (const g of gear) if (g.rating === undefined) delete g.rating;
  for (const g of gear) if (g.notes === undefined) delete g.notes;
  // A weapon / armor Foundry marks equipped stays « Sur soi » (ready / worn) even when an inventory lists it.
  for (const list of [weapons, armor, gear]) {
    for (const x of list) {
      const loc = locationOf.get(String(x.id).replace(/^fvtt_/, ''));
      if (loc && !(list !== gear && x.equipped)) x.location = loc;
    }
  }

  // --- Contacts, SINs, lifestyle
  const contacts = items
    .filter((x) => x.type === 'contact')
    .map((it) => {
      const c = it.system || {};
      const notes = [c.type, md(c.description?.value, ctx)].filter(Boolean).join(' — ');
      return { id: fid(it), name: it.name, connection: Math.round(num(c.connection, 1)), loyalty: Math.round(num(c.loyalty, 1)), ...(notes ? { notes } : {}) };
    });
  const sins = items
    .filter((x) => x.type === 'sin')
    .map((it) => {
      const m = /^fake sin\s*\((.*)\)\s*$/i.exec(it.name.trim());
      return {
        id: fid(it),
        name: m ? `Faux SIN — ${m[1].trim()}` : it.name,
        rating: Math.round(num(tech(it).rating, 0)),
        licenses: (it.system?.licenses || []).filter((l) => l && String(l.name || '').trim()).map((l) => `${String(l.name).trim()}${num(l.rtg) ? ` (${l.rtg})` : ''}`),
      };
    });
  // Lifestyles (Foundry: type, cost = total per month when set, comforts/security/neighborhood points, mods = upgrades)
  const lifestyles = items.filter((x) => x.type === 'lifestyle').map((ls, i) => {
    const sy = ls.system || {};
    const t = String(sy.type || '').toLowerCase().replace(/\s+/g, '_');
    const base = LIFESTYLE_BASE[t] || 'Medium';
    const hit = findCatalog(base, 'lifestyles');
    const points = Object.fromEntries(['comforts', 'security', 'neighborhood'].filter((k) => num(sy[k], 0) > 0).map((k) => [k, Math.round(num(sy[k], 0))]));
    const qualities = (Array.isArray(sy.mods) ? sy.mods : []).map((m, j) => {
      const nm = typeof m === 'string' ? m : String(m?.name || '');
      if (!nm.trim()) return null;
      const q = findCatalog(nm, 'lifestylequalities');
      const st = q?.entry?.stats || {};
      return {
        id: `fvtt_${ls._id}_q${j}`, name: q?.entry?.name || nm.trim(), ...(q?.entry?.nameFr ? { nameFr: q.entry.nameFr } : {}), ...(q ? { catalogId: q.entry.id } : {}),
        category: q?.entry?.category || '', cost: num(typeof m === 'object' ? m.cost : undefined, num(q?.entry?.cost, 0)), multiplier: num(st.multiplier, 0),
        ...(st.baseOnly ? { baseOnly: true } : {}), ...(st.lp !== undefined ? { lp: num(st.lp, 0) } : {}),
      };
    }).filter(Boolean);
    // Foundry `cost` is the TOTAL per month (options included): the base is the level's fixed cost (shared/lifestyle.js)
    // and the options are added back by monthlyCost(); the Foundry total is kept in the notes.
    const total = num(sy.cost, 0);
    const catalogBase = num(hit?.entry?.cost, LIFESTYLE_COST[t] || 0);
    const l = {
      id: fid(ls), name: ls.name, base, ...(hit ? { catalogId: hit.entry.id } : {}), baseCost: catalogBase || total,
      monthsPaid: Math.max(0, Math.round(num(sy.paid, 1))), primary: i === 0, ...(Object.keys(points).length ? { points } : {}), qualities,
      notes: [
        sy.permanent ? 'Permanent' : '', num(sy.guests, 0) ? `Invités : ${sy.guests}` : '',
        total && total !== catalogBase ? `Coût mensuel Foundry : ${total} ¥ (options recalculées)` : '',
      ].filter(Boolean).join(' · '),
    };
    l.monthlyCost = Math.round(Number(monthlyCost(l)) || 0);
    return l;
  });

  // --- Vision
  const vision = {};
  if (METATYPES[metatype]?.vision?.lowLight) vision.lowLight = true;
  if (METATYPES[metatype]?.vision?.thermo) vision.thermo = true;
  for (const it of items) {
    const n = norm(it.name);
    if (/low light vision/.test(n) || /^nyctalop/.test(n)) vision.lowLight = true;
    if (/thermographic vision/.test(n)) vision.thermo = true;
    if (/^cybereyes/.test(n) && it.type === 'cyberware') {
      const r = num(tech(it).rating, 0);
      if (r >= 3) vision.lowLight = true;
      if (r >= 4) vision.thermo = true;
    }
  }

  // --- Condition & resources
  const track = s.track || {};
  const condition = { physical: Math.max(0, Math.round(num(track.physical?.value, 0))), stun: Math.max(0, Math.round(num(track.stun?.value, 0))), overflow: Math.max(0, Math.round(num(track.physical?.overflow?.value, 0))) };
  const edge = { current: Math.max(0, num(attributes.EDG, 0) - Math.max(0, Math.round(num(at.edge?.uses, 0)))) };
  const karma = Math.round(num(s.karma?.value, 0));
  const karmaTotal = Math.max(karma, Math.round(num(s.karma?.max, 0)));

  // Rulebook references (system.description.source « SR5 435 ») by app item id: applied by importer.js AFTER the merge
  // snapshot (server/lib/bookrefs.js fillActorRefs), so they never make an unchanged Foundry item look changed.
  const itemSources = {};
  for (const it of items) {
    if (src(it)) itemSources[fid(it)] = src(it);
    for (const e of embedded(it)) if (e._id && src(e)) itemSources[`fvtt_${e._id}`] = src(e);
  }

  const portraitSrc = String(fa.img || '');
  const portrait = portraitSrc && !/^icons\//.test(portraitSrc) && !/mystery-man/.test(portraitSrc) && ctx.asset ? ctx.asset(portraitSrc, 'img') : '';

  return {
    hasStats: stats,
    metatype,
    attributes,
    augmented,
    initiative,
    condition,
    edge,
    skills,
    knowledge,
    qualities,
    powers,
    spells,
    weapons,
    armor,
    augmentations,
    gear,
    vehicles: [],
    ...(matrix ? { matrix } : {}),
    contacts,
    sins,
    lifestyles,
    karma,
    karmaTotal,
    nuyen: Math.round(num(s.nuyen, 0)),
    streetCred: Math.round(num(s.street_cred, 0)),
    notoriety: Math.round(num(s.notoriety, 0)),
    publicAwareness: Math.round(num(s.public_awareness, 0)),
    vision,
    containers,
    portrait,
    description: md(s.description?.value, ctx),
    gmNotesExtra: notesGm.join('\n'),
    itemSources,
  };
}

/**
 * Foundry inventories (system.inventories, the shadowrun5e « sub-inventories ») → actor.containers + item id → container id.
 * The built-in « All » inventory (showAll) is the whole list, not a place. Ids are stable (fvtt_inv_<slug>) so a re-import
 * finds the same containers. The kind is guessed from the name (« Duffel Bag » → bag, « House » → safehouse…).
 */
export function inventoriesOf(fa) {
  const containers = [];
  const locationOf = new Map();
  const inv = fa?.system?.inventories;
  if (!inv || typeof inv !== 'object') return { containers, locationOf };
  for (const [key, v] of Object.entries(inv)) {
    if (!v || typeof v !== 'object' || v.showAll || /^all$/i.test(String(v.name || key))) continue;
    const name = String(v.name || v.label || key).trim().slice(0, 60);
    if (!name) continue;
    const id = `fvtt_inv_${snake(key) || containers.length}`;
    if (containers.some((c) => c.id === id)) continue;
    containers.push({ id, name, kind: guessContainerKind(name) });
    for (const itemId of Array.isArray(v.itemIds) ? v.itemIds : []) if (itemId && !locationOf.has(String(itemId))) locationOf.set(String(itemId), id);
  }
  return { containers, locationOf };
}

/** Foundry vehicle actor → actor.vehicles[] item. */
export function convertVehicle(va, ctx = {}) {
  const s = va.system || {};
  const vs = s.vehicle_stats || {};
  const b = (k) => Math.round(num(vs[k]?.base, 0));
  const armorObj = s.armor || {};
  const armor = Math.round(num(armorObj.rating?.base ?? armorObj.base ?? armorObj.value, 0));
  const hit = findCatalog(va.name, 'vehicles');
  const offH = b('off_road_handling');
  const desc = md(s.description?.value, ctx);
  const img = String(va.img || '');
  const out = {
    id: `fvtt_${va._id}`,
    name: va.name,
    handling: offH ? `${b('handling')}/${offH}` : String(b('handling')),
    speed: b('off_road_speed') ? `${b('speed')}/${b('off_road_speed')}` : String(b('speed')),
    accel: b('off_road_acceleration') && b('off_road_acceleration') !== b('acceleration') ? `${b('acceleration')}/${b('off_road_acceleration')}` : String(b('acceleration')),
    body: Math.round(num(s.attributes?.body?.base, 0)),
    armor,
    pilot: b('pilot'),
    sensor: b('sensor'),
    ...(b('seats') ? { seats: b('seats') } : {}),
    notes: [s.isDrone ? 'Drone' : '', s.vehicleType ? `Type : ${s.vehicleType}` : '', desc].filter(Boolean).join(' · '),
    ...(hit ? { catalogId: hit.entry.id } : {}),
  };
  if (img && !/^icons\//.test(img) && ctx.asset) out.img = ctx.asset(img, 'img');
  if (!out.notes) delete out.notes;
  return out;
}

/** Professional rating guessed from the name ("R3", "(R5)"). */
export function guessRating(name) {
  const m = /\bR\s?([1-7])\b/.exec(String(name || ''));
  return m ? Number(m[1]) : 0;
}
