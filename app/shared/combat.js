// Combat helpers shared by the server (attacks module) and the browser (roll / defense dialogs, map overlays). Pure: no Node / DOM.
// - weapon range bands and the range modifier (SR5 p. 185) from the distance between two tokens,
// - grenade / launcher scatter (SR5 p. 182: 2D6 direction on the scatter diagram, (N D6 − hits) meters) and blast falloff (p. 435),
// - the special combat actions (SR5 core + Run & Gun, from Chummer's data/actions.xml: dice, DV, AP, reach, initiative / Edge cost,
//   unlocked by the martial art technique / quality of the same name — `requireunlock`),
// - the defense options (Dodge / Parry / Block / Full Defense / R&G « Defender » qualities) and the situational defense modifiers (p. 189).
// Labels are French source keys (tk); the UI renders them with t(), the server stores them as i18n params.
import { attr } from './sr5.js';

const tk = (s) => s;
const num = (v, d = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
/** Lower-case, no accents, single spaces. */
export const norm = (s) =>
  String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/[^a-z0-9']+/g, ' ')
    .trim();
const textOf = (w) => norm([w?.name, w?.nameEn, w?.nameFr, w?.category, w?.categoryEn, w?.categoryFr].filter(Boolean).join(' '));

// ---------------------------------------------------------------------------
// Ranges (SR5 p. 185)
// ---------------------------------------------------------------------------
export const RANGE_BANDS = [
  { id: 'short', mod: 0, label: tk('portée courte') },
  { id: 'medium', mod: -1, label: tk('portée moyenne') },
  { id: 'long', mod: -3, label: tk('portée longue') },
  { id: 'extreme', mod: -6, label: tk('portée extrême') },
];
/** Upper bound (meters) of each band; a function of STR for bows / thrown weapons. `min` = launcher minimum range. */
const RANGE_TABLE = {
  taser: [5, 10, 15, 20],
  holdout: [5, 15, 30, 50],
  lightPistol: [5, 15, 30, 50],
  heavyPistol: [5, 20, 40, 60],
  machinePistol: [5, 15, 30, 50],
  smg: [10, 40, 80, 150],
  assaultRifle: [25, 150, 350, 550],
  shotgunFlechette: [15, 30, 45, 60],
  shotgun: [10, 40, 80, 150],
  sniper: [50, 350, 800, 1500],
  lmg: [25, 200, 400, 800],
  hmg: [40, 250, 750, 1200],
  assaultCannon: [50, 300, 750, 1500],
  grenadeLauncher: { bands: [50, 100, 150, 500], min: 5 },
  missileLauncher: { bands: [70, 150, 450, 1500], min: 20 },
  bow: (s) => [s, s * 10, s * 30, s * 60],
  lightCrossbow: [6, 24, 60, 120],
  mediumCrossbow: [9, 36, 90, 150],
  heavyCrossbow: [15, 45, 120, 180],
  thrownKnife: (s) => [s, s * 2, s * 3, s * 5],
  shuriken: (s) => [s, s * 2, s * 5, s * 7],
  grenade: (s) => [s * 2, s * 4, s * 6, s * 10],
  grenadeAero: (s) => [s * 2, s * 4, s * 8, s * 15],
};

/** Range class of a weapon (key of RANGE_TABLE) or null (melee, unknown). French and English names / categories. */
export function rangeClass(w) {
  if (!w || w.kind === 'melee') return null;
  const s = textOf(w);
  const thrownGrenade = (!w.skill || w.skill === 'throwing_weapons') && /grenade|explosi/.test(s);
  if (thrownGrenade) return /aerodynami/.test(s) ? 'grenadeAero' : 'grenade';
  if (/grenade launcher|lance grenades?|minigrenade/.test(s)) return 'grenadeLauncher';
  if (/missile|rocket|roquette/.test(s)) return 'missileLauncher';
  if (/taser|impulsion electrique|shocker/.test(s)) return 'taser';
  if (/hold ?outs?|pistolets? de poche/.test(s)) return 'holdout';
  if (/machine pistols?|pistolets? mitrailleurs?/.test(s)) return 'machinePistol';
  if (/light pistols?|pistolets? legers?/.test(s)) return 'lightPistol';
  if (/heavy pistols?|pistolets? lourds?/.test(s)) return 'heavyPistol';
  if (/submachine|\bsmgs?\b|mitraillettes?/.test(s)) return 'smg';
  if (/assault rifles?|fusils? d'assaut/.test(s)) return 'assaultRifle';
  if (/assault cannons?|canons? d'assaut/.test(s)) return 'assaultCannon';
  if (/light machine ?guns?|mitrailleuses? legeres?/.test(s)) return 'lmg';
  if (/(medium|heavy) machine ?guns?|mitrailleuses? (moyennes?|lourdes?)/.test(s)) return 'hmg';
  if (/sniper|precision/.test(s)) return 'sniper';
  if (/shotguns?|fusils? a pompe/.test(s)) return /flechette/.test(norm(w.ammoKind?.name || '')) ? 'shotgunFlechette' : 'shotgun';
  if (/crossbows?|arbaletes?/.test(s)) return /heavy|lourde/.test(s) ? 'heavyCrossbow' : /medium|moyenne/.test(s) ? 'mediumCrossbow' : 'lightCrossbow';
  if (/\bbows?\b|\barcs?\b/.test(s) || w.skill === 'archery') return 'bow';
  if (/shuriken/.test(s)) return 'shuriken';
  if (w.skill === 'throwing_weapons') return 'thrownKnife';
  if (w.skill === 'pistols') return 'heavyPistol';
  if (w.skill === 'automatics') return 'smg';
  return null;
}

/** [short, medium, long, extreme] upper bounds in meters (+ min) for this weapon and actor, or null. */
export function weaponRanges(w, actor) {
  const cls = rangeClass(w);
  if (!cls) return null;
  const e = RANGE_TABLE[cls];
  const str = Math.max(1, actor && actor.attributes ? attr(actor, 'STR') : 3);
  if (typeof e === 'function') return { cls, bands: e(str), min: 0 };
  if (Array.isArray(e)) return { cls, bands: e, min: 0 };
  return { cls, bands: e.bands, min: e.min };
}

/** Range band of a distance: { band, mod, label, meters, beyond?, tooClose? } — null for melee / unknown weapons. */
export function rangeFor(w, actor, meters) {
  const r = weaponRanges(w, actor);
  if (!r || !Number.isFinite(meters)) return null;
  const m = Math.max(0, Math.round(meters));
  const i = r.bands.findIndex((b) => m <= b);
  if (i < 0) return { ...RANGE_BANDS[3], meters: m, beyond: true, max: r.bands[3] };
  return { ...RANGE_BANDS[i], meters: m, ...(r.min && m < r.min ? { tooClose: true, min: r.min } : {}) };
}

/** Meters between two cells (token top-left cells; centre to centre), map scale = metersPerCell. */
export function cellDistance(a, b, metersPerCell = 1) {
  if (!a || !b) return null;
  const dx = num(a.x) - num(b.x);
  const dy = num(a.y) - num(b.y);
  return Math.round(Math.hypot(dx, dy) * (num(metersPerCell, 1) || 1) * 10) / 10;
}

// ---------------------------------------------------------------------------
// Grenades, launchers: scatter and blast (SR5 p. 182 and 435)
// ---------------------------------------------------------------------------
/** Area-effect weapon: thrown grenade, grenade launcher (or its minigrenade profile), rocket / missile launcher. */
export function isAreaWeapon(w) {
  const c = rangeClass(w);
  return c === 'grenade' || c === 'grenadeAero' || c === 'grenadeLauncher' || c === 'missileLauncher';
}

/** Scatter dice (SR5 Scatter Table): standard grenade 1D6, aerodynamic 2D6, grenade launcher 3D6, missile 4D6, rocket 5D6. */
export function scatterDice(w) {
  const c = rangeClass(w);
  if (c === 'grenade') return 1;
  if (c === 'grenadeAero') return 2;
  if (c === 'grenadeLauncher') return 3;
  if (c === 'missileLauncher') return /rocket|roquette/.test(textOf(w)) ? 5 : 4;
  return 0;
}

/** Scatter diagram (2D6): 7 = straight on past the target, 2 / 12 = back toward the attacker; angle in degrees from the launch direction. */
export const SCATTER_ANGLE = { 2: -150, 3: -120, 4: -90, 5: -60, 6: -30, 7: 0, 8: 30, 9: 60, 10: 90, 11: 120, 12: 150 };

/**
 * Landing point of a grenade / projectile. from, to = cells; hits = attack hits; dice = scatter dice; rng() in [0, 1).
 * Thrown grenades: 3 hits (threshold) = no scatter. Returns { x, y, meters, dir: [d1, d2], dist: [dice…], scattered }.
 */
export function rollScatter({ from, to, hits = 0, dice = 1, threshold = null, metersPerCell = 1, rng = Math.random, width = Infinity, height = Infinity }) {
  const d6 = () => 1 + Math.floor(rng() * 6);
  if (threshold && hits >= threshold) return { x: to.x, y: to.y, meters: 0, scattered: false };
  const dir = [d6(), d6()];
  const dist = Array.from({ length: Math.max(1, dice) }, d6);
  const meters = Math.max(0, dist.reduce((s, v) => s + v, 0) - Math.max(0, hits));
  if (!meters) return { x: to.x, y: to.y, meters: 0, dir, dist, scattered: false };
  const base = from && (from.x !== to.x || from.y !== to.y) ? Math.atan2(to.y - from.y, to.x - from.x) : -Math.PI / 2;
  const ang = base + ((SCATTER_ANGLE[dir[0] + dir[1]] || 0) * Math.PI) / 180;
  const cells = meters / (num(metersPerCell, 1) || 1);
  const clampTo = (v, max) => Math.max(0, Math.min(max - 1, v));
  const x = clampTo(Math.round((to.x + Math.cos(ang) * cells) * 10) / 10, width);
  const y = clampTo(Math.round((to.y + Math.sin(ang) * cells) * 10) / 10, height);
  return { x, y, meters, dir, dist, scattered: true };
}

/**
 * Blast of an area weapon: { dv, type, ap, falloff (DV lost per meter) | radius (meters, full DV), damaging }.
 * Reads « 9P (-3/m) », « (3m Radius) », « 10m Radius » in the damage text, else the SR5 table by name (p. 435).
 */
export function blastOf(w, actor) {
  if (!w) return null;
  const raw = String(w.damage ?? '');
  const s = textOf(w);
  const dvM = raw.replace(/\(.*?\)/g, '').match(/(\d+)\s*([PS])/i);
  let dv = dvM ? Number(dvM[1]) : null;
  let type = dvM ? dvM[2].toUpperCase() : 'P';
  const ap = num(String(w.ap ?? '0').replace(/[^-+\d]/g, ''), 0);
  let falloff = null;
  let radius = null;
  const fm = raw.match(/-\s*(\d+)\s*\/\s*m/i);
  if (fm) falloff = Number(fm[1]);
  const rm = raw.match(/(\d+)\s*m\s*(radius|rayon)/i);
  if (rm) radius = Number(rm[1]);
  if (falloff === null && radius === null) {
    if (/flash ?bang|aveuglante|incapacitante/.test(s)) radius = 10;
    else if (/\bgas\b|\bgaz\b|smoke|fumee|fumigene|thermal/.test(s)) radius = 10;
    else if (/anti ?vehicle|antivehicule/.test(s)) falloff = 4;
    else if (/high explosive|explosifs?\b|\bhe\b|explosive/.test(s)) falloff = 2;
    else if (/frag/.test(s)) falloff = 1;
    else if (dv !== null) falloff = 1;
  }
  if (/flash ?bang/.test(s) && dv === null) {
    dv = 10;
    type = 'S';
  }
  return { dv, type, ap, falloff, radius, damaging: dv !== null && dv > 0 };
}

/** Damage Value of a blast at a distance in meters (0 = out of the blast). */
export function blastDvAt(blast, meters) {
  if (!blast?.damaging) return 0;
  if (blast.radius !== null && blast.radius !== undefined) return meters <= blast.radius ? blast.dv : 0;
  return Math.max(0, Math.floor(blast.dv - (blast.falloff || 0) * Math.max(0, Math.round(meters))));
}

/** Radius (meters) a blast reaches: its radius, or where the falloff brings the DV to 0. */
export function blastReach(blast) {
  if (!blast) return 0;
  if (blast.radius !== null && blast.radius !== undefined) return blast.radius;
  if (!blast.damaging || !blast.falloff) return 0;
  return Math.max(0, Math.ceil(blast.dv / blast.falloff) - 1);
}

// ---------------------------------------------------------------------------
// Special combat actions (SR5 core + Run & Gun — Chummer data/actions.xml)
// ---------------------------------------------------------------------------
/**
 * id, name (French) / en, kind: 'melee' | 'ranged' | 'any' (weapon attack), or 'test' (own pool, no weapon: Clinch…),
 * type: 'simple' | 'complex', unlock: names of the technique / quality that unlocks it (Chummer `requireunlock`),
 * dice (attack pool), defense (target's defense pool), dv, ap, reach, ini (initiative cost), edge (Edge cost),
 * fire: fire option required (rounds override `rounds`), noDamage (opposed test only), once: once per Combat Turn,
 * note: French summary of the rule, source / page.
 */
export const COMBAT_ACTIONS = [
  { id: 'called-shot', name: tk('Tir ciblé (dommages)'), en: 'Called Shot (Increase Damage)', kind: 'any', dice: -4, dv: 2, source: 'SR5', page: 195,
    note: tk('Viser une zone vulnérable : −4 dés, +2 VD (ou autre effet de tir ciblé au choix du MJ).') },
  { id: 'charge', name: tk('Attaque en charge'), en: 'Charging Attack', kind: 'melee', dice: 2, source: 'SR5', page: 187,
    note: tk('Courir au moins quelques mètres vers la cible avant de frapper : +2 dés.') },
  { id: 'double-tap', name: tk('Double frappe'), en: 'Double Tap', kind: 'ranged', fire: 'SB', rounds: 2, dv: 1, source: 'RG', page: 120,
    note: tk('Rafale semi-automatique de 2 balles au lieu de 3 : +1 VD.') },
  { id: 'aimed-burst', name: tk('Rafale visée'), en: 'Aimed Burst', kind: 'ranged', fire: 'LB', rounds: 3, dv: 1, source: 'RG', page: 119,
    note: tk('Rafale longue de 3 balles au lieu de 6 : +1 VD.') },
  { id: 'brain-blaster', name: tk('Rafale cervicale'), en: 'Brain Blaster', kind: 'ranged', fire: 'FAC', rounds: 6, dv: 2, source: 'RG', page: 119,
    note: tk('Tir automatique (complexe) de 6 balles au lieu de 10 : +2 VD.') },
  { id: 'finishing-move', name: tk('Prise de finition'), en: 'Finishing Move', kind: 'melee', type: 'complex', unlock: ['Finishing Move', 'Prise de finition'],
    dice: 2, ini: 10, edge: 1, once: true, source: 'RG', page: 120, note: tk('+2 dés, coûte 1 point de Chance et 10 d’initiative. Une fois par tour de combat.') },
  { id: 'flying-kick', name: tk('Coup de pied sauté'), en: 'Flying Kick', kind: 'melee', type: 'complex', unlock: ['Flying Kick', 'Coup de pied sauté'], dice: 1, reach: 1,
    source: 'RG', page: 121, note: tk('+1 dé, +1 allonge. En cas d’échec : −1 aux tests de défense jusqu’à sa prochaine action.') },
  { id: 'full-offense', name: tk('Attaque pure'), en: 'Full Offense', kind: 'melee', type: 'complex', unlock: ['Full Offense', 'Attaque pure'], dice: 2, ini: 5,
    source: 'RG', page: 121, note: tk('+2 dés, coûte 5 d’initiative. Ensuite, aucune action d’interruption défensive avant sa prochaine action.') },
  { id: 'ballestra', name: tk('Ballestra'), en: 'Ballestra', kind: 'melee', type: 'complex', unlock: ['Ballestra'], reach: 1, source: 'RG', page: 119,
    note: tk('+1 allonge. Ensuite −1 aux tests de défense et pas de défense active jusqu’à sa prochaine action.') },
  { id: 'half-sword', name: tk('Demi-épée'), en: 'Half Sword', kind: 'melee', type: 'complex', unlock: ['Half Sword', 'Demi-épée'], ap: -2, source: 'RG', page: 121,
    note: tk('PA −2 supplémentaire, à deux mains. En cas d’échec : −2 à la prochaine action, ni parade ni blocage.') },
  { id: 'haymaker', name: tk('Coup décisif'), en: 'Haymaker', kind: 'melee', type: 'complex', unlock: ['Haymaker', 'Coup décisif'], defense: 2, dv: 1, source: 'RG', page: 121,
    note: tk('+1 VD, mais le défenseur gagne +2 dés.') },
  { id: 'pouncing-dragon', name: tk('Poing du dragon'), en: 'Pouncing Dragon', kind: 'melee', type: 'complex', unlock: ['Pouncing Dragon', 'Poing du dragon'], dv: 2,
    source: 'RG', page: 122, note: tk('+2 VD. Exige une position supérieure, perdue après l’action.') },
  { id: 'herding', name: tk('Ruse du Berger'), en: 'Herding', kind: 'melee', type: 'complex', unlock: ['Herding', 'Ruse du Berger'], defense: 2, noDamage: true,
    source: 'RG', page: 121, note: tk('Pas de dommages : repousse l’adversaire de 1 m par succès net (le défenseur gagne +2 dés).') },
  { id: 'subduing', name: tk('Maîtrise'), en: 'Subduing', kind: 'melee', type: 'complex', noDamage: true, source: 'SR5', page: 195,
    note: tk('Pas de dommages : si FOR + succès nets dépasse la limite physique de la cible, elle est immobilisée.') },
  { id: 'push', name: tk('Repousser'), en: 'Push', kind: 'melee', type: 'simple', noDamage: true, source: 'RG', page: 123,
    note: tk('Action simple, pas de dommages : la cible est repoussée hors d’allonge.') },
  { id: 'clinch', name: tk('Accrochage'), en: 'Clinch', kind: 'test', type: 'simple', unlock: ['Clinch', 'Accrochage'], attr: 'AGI', skillId: 'gymnastics', limit: 'physical',
    noDamage: true, source: 'RG', page: 119, note: tk('AGI + Gymnastique contre RÉA + INT : position supérieure, la cible ne peut pas s’éloigner.') },
  { id: 'kip-up', name: tk('Kip-Up'), en: 'Kip-Up', kind: 'test', type: 'simple', unlock: ['Kip-Up'], attr: 'AGI', skillId: 'gymnastics', limit: 'physical', threshold: 3,
    source: 'RG', page: 122, note: tk('AGI + Gymnastique (3) : se relever et attaquer aussitôt une cible proche.') },
  { id: 'reading-defense', name: tk('Lire la défense'), en: 'Reading the Defense', kind: 'test', type: 'complex', attr: 'INT', weaponSkill: true, limit: 'mental', threshold: 3,
    source: 'RG', page: 123, note: tk('INT + compétence de l’arme (3) : +3 dés à la prochaine attaque de mêlée contre la cible (−1 en cas d’échec).') },
];
export const ACTION_BY_ID = Object.fromEntries(COMBAT_ACTIONS.map((a) => [a.id, a]));

/**
 * Defense options (interrupts and R&G « Defender » qualities), SR5 p. 190-191 / RG 127. `bonus(actor, ctx)` = dice added;
 * melee: melee attacks only; turn: lasts the rest of the Combat Turn (paid once).
 */
export const DEFENSE_OPTIONS = [
  { id: 'dodge', name: tk('Esquive'), en: 'Dodge', ini: 5, skill: 'gymnastics', source: 'SR5', page: 191 },
  { id: 'parry', name: tk('Parade'), en: 'Parry', ini: 5, melee: true, skill: 'weapon', source: 'SR5', page: 191 },
  { id: 'block', name: tk('Blocage'), en: 'Block', ini: 5, melee: true, skill: 'unarmed_combat', source: 'SR5', page: 191 },
  { id: 'full', name: tk('Défense totale'), en: 'Full Defense', ini: 10, turn: true, attr: 'WIL', source: 'SR5', page: 191 },
  { id: 'agile', name: tk('Défenseur agile'), en: 'Agile Defender', ini: 10, turn: true, attr: 'AGI', unlock: ['Agile Defender', 'Défenseur agile'], source: 'RG', page: 127 },
  { id: 'acrobatic', name: tk('Défenseur acrobatique'), en: 'Acrobatic Defender', ini: 10, turn: true, skill: 'gymnastics', unlock: ['Acrobatic Defender', 'Défenseur acrobatique'], source: 'RG', page: 127 },
  { id: 'perceptive', name: tk('Défenseur perspicace'), en: 'Perceptive Defender', ini: 10, turn: true, skill: 'perception', unlock: ['Perceptive Defender', 'Défenseur perspicace'], source: 'RG', page: 127 },
  { id: 'pretty', name: tk('Trop beau pour être touché'), en: 'Too Pretty to Hit', ini: 10, turn: true, attr: 'CHA', unlock: ['Too Pretty to Hit', 'Trop beau pour être touché'], source: 'RG', page: 127 },
];
export const DEFENSE_BY_ID = Object.fromEntries(DEFENSE_OPTIONS.map((o) => [o.id, o]));

/** Situational defense modifiers the defender chooses (SR5 p. 189). */
export const DEFENSE_SITUATIONS = [
  { id: 'cover-partial', name: tk('Couvert partiel'), value: 2 },
  { id: 'cover-good', name: tk('Bon couvert'), value: 4 },
  { id: 'running', name: tk('Défenseur en course'), value: 2 },
  { id: 'prone', name: tk('Défenseur à terre'), value: -2 },
  { id: 'in-melee', name: tk('En mêlée, visé à distance'), value: -3, ranged: true },
  { id: 'vehicle', name: tk('Dans un véhicule en mouvement'), value: 3 },
];
export const SITUATION_BY_ID = Object.fromEntries(DEFENSE_SITUATIONS.map((o) => [o.id, o]));

/** Names an actor has that may unlock an action: qualities, adept powers, martial arts and their techniques (French, English, notes « Agile Defender · RG 127 »). */
export function unlockNames(actor) {
  const out = new Set();
  const add = (v) => {
    const n = norm(v);
    if (n) out.add(n);
  };
  const addItem = (it) => {
    if (!it) return;
    add(it.name);
    add(it.nameFr);
    add(it.nameEn);
    if (it.notes) add(String(it.notes).split(/\s+[·|]\s+/)[0]);
  };
  for (const q of actor?.qualities || []) addItem(q);
  for (const p of actor?.powers || []) addItem(p);
  for (const m of actor?.martialArts || []) {
    addItem(m);
    for (const tq of m.techniques || []) addItem(tq);
  }
  return out;
}

/** Is this action / defense option available to the actor (no unlock needed, or a matching technique / quality)? */
export function isUnlocked(def, actor, names = null) {
  if (!def?.unlock?.length) return true;
  const have = names || unlockNames(actor);
  return def.unlock.some((u) => have.has(norm(u)));
}

/** Actions usable with this weapon (kind / fire mode), unlocked ones first. allowLocked: the GM sees every action. */
export function actionsForWeapon(actor, w, { allowLocked = false, fireIds = null } = {}) {
  const names = unlockNames(actor);
  const melee = w?.kind === 'melee';
  return COMBAT_ACTIONS.filter((a) => {
    if (a.kind === 'test') return false;
    if (a.kind === 'melee' && !melee) return false;
    if (a.kind === 'ranged' && melee) return false;
    if (a.fire && fireIds && !fireIds.includes(a.fire)) return false;
    return allowLocked || isUnlocked(a, actor, names);
  }).map((a) => ({ ...a, locked: !isUnlocked(a, actor, names) }));
}

/** Special actions an actor has unlocked (techniques / qualities): shown on the sheet's Combat tab. */
export function unlockedActions(actor) {
  const names = unlockNames(actor);
  return {
    actions: COMBAT_ACTIONS.filter((a) => a.unlock?.length && isUnlocked(a, actor, names)),
    defenses: DEFENSE_OPTIONS.filter((o) => o.unlock?.length && isUnlocked(o, actor, names)),
  };
}

// ---------------------------------------------------------------------------
// Defense pool (shared preview / server)
// ---------------------------------------------------------------------------
const skillRating = (actor, id) => num((actor?.skills || []).find((s) => s && s.id === id)?.rating, 0);
/** Best ready melee weapon of the defender (parry skill, reach). */
export function bestMeleeWeapon(actor) {
  let best = null;
  for (const w of actor?.weapons || []) {
    if (!w || w.kind !== 'melee' || w.equipped === false) continue;
    const r = skillRating(actor, w.skill);
    if (!best || r > best.rating || (r === best.rating && num(w.reach) > num(best.w.reach))) best = { w, rating: r };
  }
  return best?.w || null;
}
/** Natural reach: trolls +1 (SR5 p. 184). */
export const metatypeReach = (actor) => (/troll/i.test(String(actor?.metatype || '')) ? 1 : 0);

/**
 * Dice lines of a defense test besides REA + INT (the roll adds wounds and gear modifiers itself).
 * attack: { kind: 'melee'|'ranged'|'blast', defenseMod, actionDefense, reach }; opts: { options: [ids], situations: [ids], prior: n,
 * turnBoosts: [ids already paid this turn] }. Returns { lines: [{ label, value, key }], ini, paid: [ids paying initiative], unavailable }.
 */
export function defenseLines(actor, attack, opts = {}) {
  const lines = [];
  let ini = 0;
  const paid = [];
  const melee = attack?.kind === 'melee';
  const names = unlockNames(actor);
  const chosen = new Set([...(opts.options || []), ...(opts.turnBoosts || [])]);
  const boosts = new Set(opts.turnBoosts || []);
  // Only one active defense (dodge / parry / block) per attack.
  let active = false;
  for (const o of DEFENSE_OPTIONS) {
    if (!chosen.has(o.id)) continue;
    if (o.melee && !melee) continue;
    if (!isUnlocked(o, actor, names)) continue;
    if (!o.turn) {
      if (active) continue;
      active = true;
    }
    let v = 0;
    if (o.attr) v = attr(actor, o.attr);
    else if (o.skill === 'weapon') {
      const w = bestMeleeWeapon(actor);
      v = w ? skillRating(actor, w.skill) : 0;
    } else v = skillRating(actor, o.skill);
    lines.push({ label: o.name, value: v, key: o.id });
    if (!boosts.has(o.id)) {
      ini += o.ini;
      paid.push(o.id);
    }
  }
  if (num(attack?.defenseMod)) lines.push({ label: attack.defenseLabel || tk('mode de tir'), value: num(attack.defenseMod), key: 'fire' });
  if (num(attack?.actionDefense)) lines.push({ label: attack.actionName || tk('action'), value: num(attack.actionDefense), key: 'action' });
  if (attack?.kind === 'blast') lines.push({ label: tk('Attaque de zone'), value: -2, key: 'area' });
  if (melee) {
    const myW = bestMeleeWeapon(actor);
    const diff = num(myW?.reach) + metatypeReach(actor) - num(attack?.reach);
    if (diff) lines.push({ label: tk('différence d’allonge'), value: diff, key: 'reach' });
  }
  for (const id of opts.situations || []) {
    const s = SITUATION_BY_ID[id];
    if (!s || (s.ranged && melee)) continue;
    lines.push({ label: s.name, value: s.value, key: id });
  }
  if (num(opts.prior) > 0) lines.push({ label: tk('défenses précédentes ce tour'), value: -num(opts.prior), key: 'prior' });
  return { lines: lines.filter((l) => l.value), ini, paid };
}

/** Damage type after soak: Physical becomes Stun when the modified DV is lower than the modified armor (SR5 p. 168). */
export function finalDamageType(type, modifiedDv, modifiedArmor) {
  if (type === 'S') return 'S';
  return modifiedDv < modifiedArmor ? 'S' : 'P';
}
