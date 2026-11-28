// SR5 Matrix rules shared by the server (45-matrix.js) and the cockpit UI (client/modules/matrix).
// Pure ES module — no Node or DOM APIs. References: SR5 core rulebook pp. 214-251 (Matrix), p. 49 (teamwork).
//
// Modelling choices (documented here so the server, the UI and the tests agree):
// - A persona's ASDF configuration is stored as a permutation `asdf: { attack: 'sleaze', … }` = which of the deck's
//   base values (actor.matrix[key]) currently sits in each slot. Sheet edits of the deck values stay consistent.
// - Hosts and IC use the host rating for every mental attribute: defense = rating + host attribute.
//   Devices and files inside a host defend with the host (slaved devices use the master's ratings when higher).
// - Marks on a host also count on the IC, devices and files of that host (simplification of slaving).
// - The decker's agent shares the deck: same ASDF, same loaded programs, same marks and the same Overwatch Score.
//   It uses its Rating for every skill and attribute (pool = 2 × Rating) and the deck's attributes as limits.
import { attr, derive, SKILL_BY_ID, skillEn, skillKey } from './sr5.ts';
import { poolModifiers, rollContext, derivedWithModifiers, conditionState } from './modifiers.ts';
import type { CollectedModifier, ModifierLine } from './modifiers.ts';
import type { ActorLike, AsdfKey, AttrKey, DamageType, DeviceLinkKind, I18nMessage, I18nParams, IcType, MatrixMode, Persona, Skill } from './types.ts';

// i18n: labels are English dictionary keys (French in client/i18n/fr/matrix.json). tk() marks them for tools/i18n-check.ts;
// the UI renders t(label). Dynamic texts (pool parts, reasons) carry { key, params } next to their French `label`.
const tk = (s: string): string => s;
const fill = (s: string, p?: I18nParams): string =>
  (p ? String(s).replace(/\{(\w+)\}/g, (m, k: string) => (p[k] === undefined ? m : p[k] && typeof p[k] === 'object' ? fill((p[k] as I18nMessage).t, (p[k] as I18nMessage).params) : String(p[k]))) : s);
/** Pool / limit part: French `label` + translatable `key`/`params`. */
const part = (key: string, value: number, params?: I18nParams): PoolPart => ({ label: fill(key, params), key, ...(params ? { params } : {}), value });

/** Defense of a Matrix action: [mental attribute, matrix attribute] (opposed), a fixed pool, rating × 2, or none. */
export type MatrixDefense = [AttrKey, AsdfKey] | { fixed: number } | { x2: 'protection' | 'bomb' | 'device' } | null;
export type MatrixActionCat = 'attack' | 'sleaze' | 'info' | 'control' | 'util';
export type MatrixActionType = 'complex' | 'simple' | 'free' | 'interrupt' | 'variable' | 'extended' | 'special';
export type MatrixTargetKind = 'host' | 'ic' | 'device' | 'file' | 'persona' | 'pan' | 'manual' | 'markOnMe' | 'none';
/** A Matrix action of ACTIONS. */
export interface MatrixActionDef {
  id: string;
  fr: string;
  en: string;
  cat: MatrixActionCat;
  type: MatrixActionType;
  skill?: string;
  attr?: AttrKey;
  limit?: AsdfKey;
  defense?: MatrixDefense;
  marks: number;
  placesMarks?: boolean;
  /** The marks are needed on the spoofed owner. */
  marksOnOwner?: boolean;
  noTest?: boolean;
  targets: MatrixTargetKind[];
  page: number;
  desc: string;
}
/** A program of PROGRAMS (numeric properties: what the cockpit applies by itself). */
export interface ProgramDef {
  id: string;
  en: string;
  fr: string;
  kind: 'common' | 'hacking' | 'agent';
  names?: string[];
  effect: string;
  auto?: boolean;
  limitBonus?: Record<string, number>;
  /** Extra dice on these actions (Tarball: Crash Program). */
  poolBonus?: Record<string, number>;
  /** Matrix attribute bonus when the persona defends against these actions (Swerve: Firewall vs Reboot Device). */
  defenseBonus?: Record<string, Partial<Record<AsdfKey, number>>>;
  attrBonus?: Partial<Record<AsdfKey, number>>;
  noiseReduction?: number;
  slots?: number;
  extraDamage?: number;
  resistMatrix?: number;
  resistBio?: number;
  resistBomb?: number;
  bombBonus?: number;
  osVisible?: boolean;
  showsValue?: boolean;
}
/** A pool / limit part (label, i18n key + params, value). */
export interface PoolPart {
  label: string;
  key?: string;
  params?: I18nParams;
  value: number;
  /** Official skill id (the UI shows its name). */
  skillId?: string;
  /** Attribute code. */
  attr?: string;
  mod?: { id: string; book?: string; page?: number | string };
}
/** An agent the actor owns (detectAgents()). */
export interface DetectedAgent {
  rating: number;
  source: 'programs' | 'gear';
  label: string;
  name?: string;
  gearRating?: number | null;
}
/** Persona-like input: a stored persona, a player's view of it, or a partial one (tests, previews); fields may be null. */
export type PersonaLike = { [K in keyof Persona]?: Persona[K] | null };
/** deckStats() result. */
export interface DeckStats {
  deviceRating: number;
  isDeck: boolean;
  base: Record<AsdfKey, number>;
  slotted: Record<AsdfKey, number>;
  bonus: Record<AsdfKey, number>;
  penalty: Record<AsdfKey, number>;
  eff: Record<AsdfKey, number>;
  programs: Set<string>;
  rawNoise: number;
  noise: number;
  monitor: number;
}
/** An initiative score: base + dice D6. */
export interface InitiativeScore {
  base: number;
  dice: number;
  text: string;
}
/** Options of actionPool(). */
export interface ActionPoolOptions {
  useSpec?: boolean;
  marks?: number;
  modifier?: number;
  assist?: { dice?: number; limitBonus?: number } | null;
  edge?: boolean;
  agent?: boolean;
  mods?: CollectedModifier[] | null;
  conditions?: string[];
}
/** actionPool() result. */
export interface ActionPool {
  pool: number;
  parts: PoolPart[];
  limit: number | null;
  limitParts: PoolPart[];
  impossible: boolean;
  noTest?: boolean;
  reason?: string;
  reasonKey?: string;
  reasonParams?: I18nParams;
  modLines?: ModifierLine[];
}
/** A defense pool with its parts. */
export interface DefensePool {
  pool: number;
  parts: PoolPart[];
}
/** An IC type of IC_TYPES. */
export interface IcTypeDef {
  fr: string;
  en: string;
  limit: AsdfKey;
  defense: [AttrKey, AsdfKey];
  effect: 'spot' | 'mark' | 'damage' | 'penalty' | 'crash' | 'linklock' | 'reboot' | 'trace';
  desc: string;
  attrHit?: AsdfKey;
  needsMarks?: number;
  /** Biofeedback: 'S' = always Stun, 'sim' = by sim mode. */
  bio?: 'S' | 'sim';
  linklock?: boolean;
}
/** A host as nextStepHints() reads it: the GM's Host or a player's PlayerHostView. */
export interface HintHost {
  id: string;
  name: string;
  visible?: boolean;
  alert?: string;
  spotted?: boolean | string[];
  perceived?: boolean;
  ic?: Array<{ id: string; type?: string }>;
  files?: Array<{ id: string; name: string; protected?: boolean; bomb: number; mine?: boolean }>;
  devices?: Array<{ id: string; name: string; link?: { kind?: string } | null; offline?: boolean; bricked?: boolean; formatted?: boolean }>;
}
/** A next-step hint of the cockpit. */
export interface MatrixHint {
  key: string;
  tone: 'info' | 'warn' | 'danger';
  params?: I18nParams;
  actionId?: string;
  targetId?: string;
  preset?: Record<string, string>;
}

export const OS_MAX = 40;
export const CONVERGENCE_DV = 12;
export const DUMPSHOCK_DV = 6;
export const HOT_SIM_BONUS = 2;
export const MAX_MARKS = 3;
/** Extra marks requested on Hack on the Fly / Brute Force: 1 mark → 0, 2 marks → −4, 3 marks → −10 (SR5 p. 238). */
export const MARK_PENALTY: Record<number, number> = { 1: 0, 2: -4, 3: -10 };
/** Go Big or Go Home (Data Trails p. 44): 3 marks in one Brute Force / Hack on the Fly cost −6 instead of −10. */
export const MARK_PENALTY_GO_BIG: Record<number, number> = { 1: 0, 2: -4, 3: -6 };
/** Wanted by GOD (Data Trails p. 49): convergence at Overwatch Score 30. */
export const OS_WANTED = 30;
/** Faraday Himself (Data Trails p. 48): +2 Noise around the character, on their own tests too. */
export const FARADAY_NOISE = 2;

/**
 * Data Trails qualities the cockpit applies itself (not through catalog effects): matched by catalog id, English or French
 * name (as the catalog has them; Chummer / Foundry imports keep one of them).
 */
export const MATRIX_QUALITIES = {
  goBig: { ids: ['64876d0b-bfa6-45df-b8c8-caf6385306c6'], names: ['go big or go home', 'comme un bourrin'] },
  wantedByGod: { ids: ['a82b239b-fa92-45e7-ac87-4adedf72396a'], names: ['wanted by god', 'recherche par le dieu'] },
  virtualStability: { ids: ['130f2287-6e27-4a7b-a45c-0313e8ecad73'], names: ['virtual stability', 'stabilite virtuelle'] },
  faraday: { ids: ['38a26727-a736-47a9-803f-cfa762c9b8a0'], names: ['faraday himself', 'faraday incarne'] },
} as const;
export type MatrixQualityKey = keyof typeof MATRIX_QUALITIES;
/** Does the actor have this Data Trails quality (MATRIX_QUALITIES)? */
export function hasMatrixQuality(actor: ActorLike | null | undefined, key: MatrixQualityKey): boolean {
  const def = MATRIX_QUALITIES[key];
  return (actor?.qualities || []).some((q) => {
    if (!q) return false;
    if (q.catalogId && (def.ids as readonly string[]).includes(String(q.catalogId).toLowerCase())) return true;
    const n = norm(q.name).replace(/\s*\([^)]*\)\s*$/, '');
    return (def.names as readonly string[]).includes(n);
  });
}
/** Overwatch Score at which GOD converges on the actor (40, or 30 with Wanted by GOD). */
export const convergenceAt = (actor: ActorLike | null | undefined): number => (hasMatrixQuality(actor, 'wantedByGod') ? OS_WANTED : OS_MAX);
/** Penalty for the extra marks of Brute Force / Hack on the Fly (Go Big or Go Home: 3 marks = −6). */
export const markPenalty = (actor: ActorLike | null | undefined, marks: number): number =>
  (hasMatrixQuality(actor, 'goBig') ? MARK_PENALTY_GO_BIG : MARK_PENALTY)[clampN(marks || 1, 1, 3)] || 0;

export const ASDF: AsdfKey[] = ['attack', 'sleaze', 'dataProcessing', 'firewall'];
export const ASDF_LABELS: Record<AsdfKey, string> = { attack: tk('Attack'), sleaze: tk('Sleaze'), dataProcessing: tk('Data Processing'), firewall: tk('Firewall') };
export const ASDF_SHORT: Record<AsdfKey, string> = { attack: 'A', sleaze: 'C', dataProcessing: 'T', firewall: 'F' };
export const ASDF_EN: Record<AsdfKey, string> = { attack: 'Attack', sleaze: 'Sleaze', dataProcessing: 'Data Processing', firewall: 'Firewall' };
/** One-letter slot names in English (A/S/D/F). */
export const ASDF_SHORT_EN: Record<AsdfKey, string> = { attack: 'A', sleaze: 'S', dataProcessing: 'D', firewall: 'F' };

export const MODES: MatrixMode[] = ['ar', 'cold', 'hot'];
export const MODE_LABELS: Record<MatrixMode, string> = { ar: tk('AR'), cold: tk('Cold-sim VR'), hot: tk('Hot-sim VR') };

const MENTAL_LABEL: Record<string, string> = { INT: tk('Intuition'), WIL: tk('Willpower'), LOG: tk('Logic') };

/**
 * Matrix actions. cat: attack | sleaze (illegal, raise the Overwatch Score) | info | control | util.
 * skill/attr/limit = the decker's test. defense: [mental attribute, matrix attribute] (opposed test),
 * or { fixed: n } (GOD: 6 dice), or { x2: 'protection'|'bomb'|'device' } (rating × 2), or null (no opposition).
 * marks = marks required on the target (0 = none). targets = allowed target kinds
 * ('host'|'ic'|'device'|'file'|'persona'|'manual'|'markOnMe'|'none').
 */
export const ACTIONS: MatrixActionDef[] = [
  // --- Illegal: Attack actions
  { id: 'bruteForce', fr: tk('Brute Force'), en: 'Brute Force', cat: 'attack', type: 'complex', skill: 'cybercombat', attr: 'LOG', limit: 'attack', defense: ['WIL', 'firewall'], marks: 0, placesMarks: true, targets: ['host', 'ic', 'device', 'pan', 'file', 'persona', 'manual'], page: 238,
    desc: tk('Places marks by force (1 mark, or 2 at −4, 3 at −10). Every 2 net hits also inflict 1 box of Matrix damage. Failure: you take 1 box per net hit of the defender.') },
  { id: 'dataSpike', fr: tk('Data Spike'), en: 'Data Spike', cat: 'attack', type: 'complex', skill: 'cybercombat', attr: 'LOG', limit: 'attack', defense: ['INT', 'firewall'], marks: 0, targets: ['ic', 'device', 'pan', 'persona', 'manual'], page: 240,
    desc: tk('Matrix attack: DV = Attack + net hits + 2 per mark on the target, resisted with Device Rating + Firewall.') },
  { id: 'crashProgram', fr: tk('Crash Program'), en: 'Crash Program', cat: 'attack', type: 'complex', skill: 'cybercombat', attr: 'LOG', limit: 'attack', defense: ['INT', 'firewall'], marks: 1, targets: ['persona', 'manual'], page: 239,
    desc: tk('Crashes a program running on the target (hacker’s choice).') },
  { id: 'crackFile', fr: tk('Crack File'), en: 'Crack File', cat: 'attack', type: 'complex', skill: 'hacking', attr: 'LOG', limit: 'attack', defense: { x2: 'protection' }, marks: 1, targets: ['file'], page: 239,
    desc: tk('Removes a file’s protection (defense: protection rating × 2).') },
  { id: 'eraseMark', fr: tk('Erase Mark'), en: 'Erase Mark', cat: 'attack', type: 'complex', skill: 'computer', attr: 'LOG', limit: 'attack', defense: ['WIL', 'firewall'], marks: 0, targets: ['markOnMe'], page: 240,
    desc: tk('Erases a mark another icon placed on you (defense of the icon that owns the mark).') },
  { id: 'jamSignals', fr: tk('Jam Signals'), en: 'Jam Signals', cat: 'attack', type: 'complex', skill: 'electronic_warfare', attr: 'LOG', limit: 'attack', defense: null, marks: 0, targets: ['none'], page: 241,
    desc: tk('Each hit adds 1 point of noise for everyone within 100 m (you included, except your own devices).') },
  // --- Illegal: Sleaze actions
  { id: 'hackOnTheFly', fr: tk('Hack on the Fly'), en: 'Hack on the Fly', cat: 'sleaze', type: 'complex', skill: 'hacking', attr: 'LOG', limit: 'sleaze', defense: ['INT', 'firewall'], marks: 0, placesMarks: true, targets: ['host', 'ic', 'device', 'pan', 'file', 'persona', 'manual'], page: 240,
    desc: tk('Places marks by stealth (1 mark, or 2 at −4, 3 at −10). Failure: the target marks you and the host goes on alert.') },
  { id: 'spoofCommand', fr: tk('Spoof Command'), en: 'Spoof Command', cat: 'sleaze', type: 'complex', skill: 'hacking', attr: 'INT', limit: 'sleaze', defense: ['LOG', 'firewall'], marks: 1, marksOnOwner: true, targets: ['device', 'pan', 'manual'], page: 243,
    desc: tk('Sends a device a command that seems to come from its owner (requires 1 mark on the spoofed owner).') },
  { id: 'snoop', fr: tk('Snoop'), en: 'Snoop', cat: 'sleaze', type: 'complex', skill: 'electronic_warfare', attr: 'INT', limit: 'sleaze', defense: ['LOG', 'firewall'], marks: 1, targets: ['device', 'pan', 'persona', 'manual'], page: 243,
    desc: tk('Intercepts the target’s traffic (communications, data streams).') },
  { id: 'hide', fr: tk('self::Hide'), en: 'Hide', cat: 'sleaze', type: 'complex', skill: 'electronic_warfare', attr: 'INT', limit: 'sleaze', defense: ['INT', 'dataProcessing'], marks: 0, targets: ['host', 'ic', 'persona', 'manual'], page: 241,
    desc: tk('The target loses track of you (a Patrol IC no longer sees you).') },
  { id: 'formatDevice', fr: tk('Format Device'), en: 'Format Device', cat: 'sleaze', type: 'complex', skill: 'computer', attr: 'LOG', limit: 'sleaze', defense: ['WIL', 'firewall'], marks: 3, targets: ['device', 'pan', 'persona', 'manual'], page: 240,
    desc: tk('Wipes the device’s OS: at its next reboot, it no longer works.') },
  { id: 'setDataBomb', fr: tk('Set Data Bomb'), en: 'Set Data Bomb', cat: 'sleaze', type: 'complex', skill: 'software', attr: 'LOG', limit: 'sleaze', defense: { x2: 'device' }, marks: 1, targets: ['file'], page: 243,
    desc: tk('Booby-traps a file: bomb rating = net hits.') },
  { id: 'checkOverwatch', fr: tk('Check Overwatch Score'), en: 'Check Overwatch Score', cat: 'sleaze', type: 'simple', skill: 'electronic_warfare', attr: 'LOG', limit: 'sleaze', defense: { fixed: 6 }, marks: 0, targets: ['none'], page: 238,
    desc: tk('Opposed by 6 dice (GOD). Success: you learn your current OS.') },
  // --- Legal: information
  { id: 'matrixPerception', fr: tk('Matrix Perception'), en: 'Matrix Perception', cat: 'info', type: 'complex', skill: 'computer', attr: 'INT', limit: 'dataProcessing', defense: null, marks: 0, targets: ['host', 'ic', 'device', 'pan', 'file', 'persona', 'manual', 'none'], page: 241,
    desc: tk('Each hit reveals one piece of information. On a host: rating, attributes, IC, files, devices and data bombs.') },
  { id: 'matrixSearch', fr: tk('Matrix Search'), en: 'Matrix Search', cat: 'info', type: 'special', skill: 'computer', attr: 'INT', limit: 'dataProcessing', defense: null, marks: 0, targets: ['none'], page: 241,
    desc: tk('Searches the Matrix for information on a topic: the threshold and the base time depend on how available it is; hits above the threshold divide the time. Protected or secret data: search inside its host.') },
  { id: 'traceIcon', fr: tk('Trace Icon'), en: 'Trace Icon', cat: 'info', type: 'complex', skill: 'computer', attr: 'INT', limit: 'dataProcessing', defense: ['WIL', 'sleaze'], marks: 2, targets: ['persona', 'device', 'pan', 'manual'], page: 243,
    desc: tk('Finds the physical location of the device behind the icon.') },
  // --- Legal: control & files
  { id: 'controlDevice', fr: tk('Control Device'), en: 'Control Device', cat: 'control', type: 'variable', skill: 'electronic_warfare', attr: 'LOG', limit: 'dataProcessing', defense: ['INT', 'firewall'], marks: 1, targets: ['device', 'pan', 'manual'], page: 238,
    desc: tk('Makes the device act (open a door, shut a camera off…). Marks needed: 1 to 3 depending on the command.') },
  { id: 'editFile', fr: tk('Edit File'), en: 'Edit File', cat: 'control', type: 'complex', skill: 'computer', attr: 'LOG', limit: 'dataProcessing', defense: ['INT', 'firewall'], marks: 1, targets: ['file'], page: 239,
    desc: tk('Read, copy, change or delete an (unprotected) file. A data bomb goes off unless disarmed.') },
  { id: 'disarmDataBomb', fr: tk('Disarm Data Bomb'), en: 'Disarm Data Bomb', cat: 'control', type: 'complex', skill: 'software', attr: 'LOG', limit: 'firewall', defense: { x2: 'bomb' }, marks: 0, targets: ['file'], page: 239,
    desc: tk('Success: the bomb is removed. Failure: it goes off (rating D6 Matrix damage, file destroyed).') },
  { id: 'rebootDevice', fr: tk('Reboot Device'), en: 'Reboot Device', cat: 'control', type: 'complex', skill: 'computer', attr: 'LOG', limit: 'dataProcessing', defense: ['WIL', 'firewall'], marks: 3, targets: ['device', 'pan', 'persona', 'manual'], page: 242,
    desc: tk('The device shuts down and restarts at the end of the next turn (marks and connections lost).') },
  // --- Legal: utilities (no test)
  { id: 'enterHost', fr: tk('Enter Host'), en: 'Enter Host', cat: 'util', type: 'complex', noTest: true, marks: 1, targets: ['host'], page: 240,
    desc: tk('Requires 1 mark on the host. Inside, its IC can attack you.') },
  { id: 'exitHost', fr: tk('Exit Host'), en: 'Exit Host', cat: 'util', type: 'complex', noTest: true, marks: 0, targets: ['none'], page: 240,
    desc: tk('Back to the grid.') },
  { id: 'fullMatrixDefense', fr: tk('Full Matrix Defense'), en: 'Full Matrix Defense', cat: 'util', type: 'interrupt', noTest: true, marks: 0, targets: ['none'], page: 240,
    desc: tk('Interrupt (−10 initiative): adds your Willpower to your Matrix defense tests until the end of the turn.') },
  { id: 'jackOut', fr: tk('Jack Out'), en: 'Jack Out', cat: 'util', type: 'simple', skill: 'hardware', attr: 'WIL', limit: 'firewall', defense: ['LOG', 'attack'], marks: 0, targets: ['none'], page: 241,
    desc: tk('Voluntary disconnection, without dumpshock. If a link-lock holds you: Hardware + Willpower [Firewall] vs Logic + Attack.') },
  { id: 'rebootSelf', fr: tk('Reboot own deck'), en: 'Reboot Device (own deck)', cat: 'util', type: 'complex', noTest: true, marks: 0, targets: ['none'], page: 242,
    desc: tk('Resets the Overwatch Score to 0 and erases every mark, but disconnects you (dumpshock in VR).') },
];
export const ACTION_BY_ID: Record<string, MatrixActionDef> = Object.fromEntries(ACTIONS.map((a) => [a.id, a]));
export const isIllegal = (action: Partial<MatrixActionDef> | null | undefined) => action && (action.cat === 'attack' || action.cat === 'sleaze');
export const ACTION_CATS: Record<MatrixActionCat, string> = { attack: tk('Attack'), sleaze: tk('Sleaze'), info: tk('Information'), control: tk('Control & files'), util: tk('Utilities') };
export const ACTION_TYPES: Record<MatrixActionType, string> = { complex: tk('Complex'), simple: tk('Simple'), free: tk('Unassigned'), interrupt: tk('Interrupt'), variable: tk('Variable'), extended: tk('Extended'), special: tk('Special') };
export const TARGET_KIND_LABELS: Record<MatrixTargetKind, string> = { host: tk('Host'), ic: tk('IC'), device: tk('Device'), file: tk('File'), persona: tk('Persona'), pan: tk('PAN device'), manual: tk('Other target'), markOnMe: tk('Mark on me'), none: tk('No target') };

/**
 * Programs (SR5 core p. 245-246 + Data Trails). auto = the cockpit applies the effect by itself;
 * otherwise the effect is shown to the table and arbitrated by the GM.
 * names: lower-case aliases (English, French from the catalog, French table names).
 */
export const PROGRAMS: ProgramDef[] = [
  // Common programs
  { id: 'browse', en: 'Browse', fr: 'Navigateur', kind: 'common', names: ['navigation'], effect: tk('Halves the time of Matrix Searches.') },
  { id: 'configurator', en: 'Configurator', fr: 'Configurateur', kind: 'common', effect: tk('Stores a configuration (programs + attributes) you can load with a Free Action.') },
  { id: 'edit', en: 'Edit', fr: 'Édition', kind: 'common', auto: true, limitBonus: { editFile: 2 }, effect: tk('+2 to the limit of Edit File actions.') },
  { id: 'encryption', en: 'Encryption', fr: 'Cryptage', kind: 'common', auto: true, attrBonus: { firewall: 1 }, effect: tk('+1 Firewall.') },
  { id: 'signalScrub', en: 'Signal Scrub', fr: 'Gommage de bruit', kind: 'common', auto: true, noiseReduction: 2, effect: tk('Reduces noise by 2.') },
  { id: 'toolbox', en: 'Toolbox', fr: 'Boîte à outils', kind: 'common', auto: true, attrBonus: { dataProcessing: 1 }, effect: tk('+1 Data Processing.') },
  { id: 'virtualMachine', en: 'Virtual Machine', fr: 'Machine virtuelle', kind: 'common', auto: true, slots: 2, extraDamage: 1, effect: tk('+2 program slots, but +1 box whenever you take Matrix damage (not with Virtual Stability).') },
  { id: 'bootstrap', en: 'Bootstrap', fr: 'Amorçage', kind: 'common', effect: tk('Data Trails p. 56: Format Device can plant boot commands (location beacon, forced configuration, ownership nag, action log) instead of bricking (GM’s call).') },
  { id: 'shredder', en: 'Shredder', fr: 'Déchiqueteuse', kind: 'common', effect: tk('Data Trails p. 56: +2 to the limit of Edit File when deleting a file; a shredded file can only be recovered with a week-long extended test (GM’s call).') },
  { id: 'search', en: 'Search', fr: 'Recherche', kind: 'common', effect: tk('Data Trails p. 56: +2 dice on Matrix Searches for data stored in the host you are in (GM’s call).') },
  // Hacking programs
  { id: 'armor', en: 'Armor', fr: 'Armure', kind: 'hacking', auto: true, resistMatrix: 2, effect: tk('+2 dice to resist Matrix damage.') },
  { id: 'babyMonitor', en: 'Baby Monitor', fr: 'Surveillance', kind: 'hacking', auto: true, osVisible: true, effect: tk('You always know your Overwatch Score.') },
  { id: 'biofeedback', en: 'Biofeedback', fr: 'Biofeedback', kind: 'hacking', effect: tk('Your Cybercombat attacks also deal biofeedback to living targets (S in cold-sim, P in hot-sim).') },
  { id: 'biofeedbackFilter', en: 'Biofeedback Filter', fr: 'Filtre de biofeedback', kind: 'hacking', auto: true, resistBio: 2, effect: tk('+2 dice to resist biofeedback.') },
  { id: 'blackout', en: 'Blackout', fr: 'Blackout', kind: 'hacking', effect: tk('Like Biofeedback, but always Stun damage.') },
  { id: 'decryption', en: 'Decryption', fr: 'Décryptage', kind: 'hacking', auto: true, attrBonus: { attack: 1 }, effect: tk('+1 Attack.') },
  { id: 'defuse', en: 'Defuse', fr: 'Désamorçage', kind: 'hacking', auto: true, resistBomb: 4, effect: tk('+4 dice to resist data bombs.') },
  { id: 'demolition', en: 'Demolition', fr: 'Démolition', kind: 'hacking', auto: true, bombBonus: 1, effect: tk('+1 to the rating of the data bombs you set.') },
  { id: 'exploit', en: 'Exploit', fr: 'Exploitation', kind: 'hacking', auto: true, limitBonus: { hackOnTheFly: 2 }, effect: tk('+2 to the limit of Hack on the Fly.') },
  { id: 'fork', en: 'Fork', fr: 'Fork', kind: 'hacking', effect: tk('A single Matrix action can target two icons.') },
  { id: 'guard', en: 'Guard', fr: 'Garde', kind: 'hacking', effect: tk('Reduces the extra damage from marks placed on you.') },
  { id: 'hammer', en: 'Hammer', fr: 'Marteau', kind: 'hacking', effect: tk('Boosts the damage of your Matrix attacks (GM’s call).') },
  { id: 'lockdown', en: 'Lockdown', fr: 'Verrouillage', kind: 'hacking', effect: tk('A target you damage in Cybercombat is link-locked (cannot jack out).') },
  { id: 'mugger', en: 'Mugger', fr: 'Agresseur', kind: 'hacking', effect: tk('Your marks add more damage to Data Spikes (GM’s call).') },
  { id: 'shell', en: 'Shell', fr: 'Carapace', kind: 'hacking', auto: true, resistMatrix: 1, resistBio: 1, effect: tk('+1 die to resist Matrix damage and biofeedback.') },
  { id: 'sneak', en: 'Sneak', fr: 'Discrétion', kind: 'hacking', effect: tk('Helps you go unnoticed (GM’s call).') },
  { id: 'stealth', en: 'Stealth', fr: 'Furtivité', kind: 'hacking', auto: true, attrBonus: { sleaze: 1 }, effect: tk('+1 Sleaze.') },
  { id: 'track', en: 'Track', fr: 'Pistage', kind: 'hacking', auto: true, limitBonus: { traceIcon: 2 }, effect: tk('+2 to the limit of Trace Icon.') },
  { id: 'wrapper', en: 'Wrapper', fr: 'Maquillage', kind: 'hacking', effect: tk('Disguises your icon as another one (Matrix Perception to see through it).') },
  { id: 'crash', en: 'Crash (Program)', fr: 'Crash', kind: 'hacking', names: ['crash program'], auto: true, limitBonus: { rebootDevice: 2 }, effect: tk('Data Trails p. 57: +2 to the limit of Reboot Device.') },
  { id: 'evaluate', en: 'Evaluate', fr: 'Évaluation', kind: 'hacking', auto: true, showsValue: true, effect: tk('Estimates the market value of files (shown in the host).') },
  { id: 'paintjob', en: 'Paintjob', fr: 'Spray de peinture', kind: 'hacking', auto: true, limitBonus: { eraseMark: 2 }, effect: tk('Data Trails p. 57: +2 to the limit of Erase Mark.') },
  { id: 'tarball', en: 'Tarball', fr: 'Tarball', kind: 'hacking', auto: true, limitBonus: { crashProgram: 2 }, poolBonus: { crashProgram: 1 }, effect: tk('Data Trails p. 57: Crash Program gets +1 die and +2 to its limit, but crashes a random program of the target.') },
  { id: 'cloudless', en: 'Cloudless', fr: 'Copie locale', kind: 'hacking', effect: tk('Data Trails p. 56: Edit File can move a file off the Matrix onto one device, opposed by the grid (6 public, 8 local, 10 global) (GM’s call).') },
  { id: 'detonator', en: 'Detonator', fr: 'Détonateur', kind: 'hacking', effect: tk('Data Trails p. 57: Set Data Bomb with a trigger after a number of actions; the bomb hides better the more actions remain (GM’s call).') },
  { id: 'swerve', en: 'Swerve', fr: 'Déviation', kind: 'hacking', auto: true, defenseBonus: { rebootDevice: { firewall: 1 } }, effect: tk('Data Trails p. 57: +1 Firewall when resisting Reboot Device.') },
  { id: 'smokeAndMirrors', en: 'Smoke and Mirrors', fr: 'Miroirs et fumée', kind: 'hacking', effect: tk('Data Trails p. 57: +1 to +5 Sleaze (your choice) and as much Noise on your own tests and on Trace Icon against you (GM’s call: set the Noise).') },
  { id: 'flyOnAWall', en: 'Fly on a Wall', fr: 'Mouche au mur', kind: 'hacking', effect: tk('Data Trails p. 57: after a Hide, while you only make Matrix Perception tests, your Overwatch Score rises by only 1D6 per 30 minutes (GM’s call).') },
  { id: 'tantrum', en: 'Tantrum', fr: 'Nausée', kind: 'hacking', effect: tk('Data Trails p. 57: a Data Spike that would deal damage to a VR user or technomancer nauseates them for 3 Combat Turns instead (GM’s call).') },
  { id: 'catsPaw', en: 'Cat’s Paw', fr: 'Patte de chat', kind: 'hacking', names: ["cat's paw"], effect: tk('Data Trails p. 56: a Data Spike deals no damage; the target gets −(2 + your marks on it) dice instead (GM’s call).') },
  { id: 'hitchhiker', en: 'Hitchhiker', fr: 'Routard', kind: 'hacking', effect: tk('Data Trails p. 57: brings non-hackers along into Foundations and resonance realms (hot-sim persona, mutual marks) (GM’s call).') },
  { id: 'nukeFromOrbit', en: 'Nuke-from-Orbit', fr: 'Bombardement orbital', kind: 'hacking', effect: tk('Data Trails p. 57: a file deleted with Edit File can never be recovered; the Overwatch Score of that test is doubled (GM’s call).') },
  // Agent
  { id: 'agent', en: 'Agent', fr: 'Agent', kind: 'agent', effect: tk('Autonomous program (rating 1-6): it assists you (teamwork) or acts alone with Rating × 2 dice.') },
];
export const PROGRAM_BY_ID: Record<string, ProgramDef> = Object.fromEntries(PROGRAMS.map((p) => [p.id, p]));

const norm = (s: unknown): string =>
  String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[’`]/g, "'")
    .toLowerCase()
    .trim();
const PROGRAM_ALIASES = new Map<string, string>();
for (const p of PROGRAMS) for (const n of [p.en, p.fr, ...(p.names || [])]) PROGRAM_ALIASES.set(norm(n), p.id);

/** Program id from a free name ("Agent (5)", "Crash (Program)", "Boîte à outils"…), or null when unknown. */
export function programId(name: unknown): string | null {
  const n = norm(name);
  if (!n) return null;
  if (PROGRAM_ALIASES.has(n)) return PROGRAM_ALIASES.get(n)!;
  if (/^agent\b/.test(n)) return 'agent';
  const stripped = n.replace(/\s*\([^)]*\)\s*$/, '').replace(/\s+\d+$/, '').trim();
  return PROGRAM_ALIASES.get(stripped) || null;
}

/** Agents the actor owns: "Agent (5)" in matrix.programs, gear items named Agent with a rating. */
export function detectAgents(actor: ActorLike | null | undefined): DetectedAgent[] {
  const out: DetectedAgent[] = [];
  for (const p of actor?.matrix?.programs || []) {
    const s = String(p);
    if (!/^agent\b/i.test(s.trim())) continue;
    const m = s.match(/(\d+)/);
    out.push({ rating: m ? clampN(Number(m[1]), 1, 6) : 1, source: 'programs', label: s });
  }
  for (const g of actor?.gear || []) {
    if (!/^agent\b/i.test(String(g.name || '').trim())) continue;
    const m = String(g.name).match(/(\d+)/);
    const r = Number(g.rating) || (m ? Number(m[1]) : 1);
    // label = French display; name/gearRating let the UI rebuild it translated.
    out.push({ rating: clampN(r, 1, 6), source: 'gear', label: g.name + (g.rating ? ` (indice ${g.rating})` : ''), name: g.name, gearRating: Number(g.rating) || null });
  }
  return out;
}

/** Every program the actor can load: matrix.programs + gear items whose name is a known program. Unique names. */
export function availablePrograms(actor: ActorLike | null | undefined): Array<{ name: string; id: string | null }> {
  const seen = new Set<string>();
  const out: Array<{ name: string; id: string | null }> = [];
  const add = (name: unknown) => {
    const n = String(name || '').trim();
    if (!n || seen.has(norm(n))) return;
    seen.add(norm(n));
    out.push({ name: n, id: programId(n) });
  };
  for (const p of actor?.matrix?.programs || []) add(p);
  for (const g of actor?.gear || []) if (programId(g.name)) add(g.name);
  // Echo « Resonance [Program] » (SR5 p. 258): the technomancer runs that program natively.
  for (const e of (actor as { magic?: { echoes?: unknown[] } } | null | undefined)?.magic?.echoes || []) {
    const m = String(e || '').match(/^\s*r[eé]sonance\s*[[(:]?\s*([^\])]+?)\s*[\])]?\s*$/i);
    if (m && programId(m[1])) add(m[1]);
  }
  return out;
}

function clampN(v: unknown, lo: number, hi: number): number {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : lo;
}

/** A cyberdeck has Attack/Sleaze; a commlink has only Data Processing / Firewall (no configuration swap). */
export const isCyberdeck = (actor: ActorLike | null | undefined): boolean => !!actor?.matrix && (Number(actor.matrix.attack) > 0 || Number(actor.matrix.sleaze) > 0);
export const matrixMonitor = (deviceRating: unknown): number => 8 + Math.ceil((Number(deviceRating) || 0) / 2);
export const identityAsdf = (): Record<AsdfKey, AsdfKey> => ({ attack: 'attack', sleaze: 'sleaze', dataProcessing: 'dataProcessing', firewall: 'firewall' });
export function isPermutation(map: unknown): map is Record<AsdfKey, AsdfKey> {
  if (!map || typeof map !== 'object') return false;
  const vals = ASDF.map((k) => (map as Record<string, unknown>)[k]);
  return vals.every((v) => ASDF.includes(v as AsdfKey)) && new Set(vals).size === 4;
}

/** Loaded program ids (agent excluded: it lives in persona.agent). */
export function loadedProgramIds(persona: PersonaLike | null | undefined): Set<string> {
  return new Set((persona?.loadedPrograms || []).map(programId).filter(Boolean) as string[]);
}

/** Slots used: loaded programs + the agent when loaded. Total = deck slots + Virtual Machine bonus. */
export function programSlots(persona: PersonaLike | null | undefined): { base: number; total: number; used: number; free: number } {
  const ids = loadedProgramIds(persona);
  const base = Number(persona?.programSlots) || 4;
  const total = base + (ids.has('virtualMachine') ? PROGRAM_BY_ID.virtualMachine.slots! : 0);
  const used = (persona?.loadedPrograms || []).length + (persona?.agent?.loaded ? 1 : 0);
  return { base, total, used, free: total - used };
}

/**
 * Effective deck: base values (actor.matrix), current configuration, program bonuses, IC penalties, noise.
 * Returns { deviceRating, isDeck, base, slotted, bonus, penalty, eff, programs (Set of ids), noise, rawNoise, monitor }.
 */
export function deckStats(actor: ActorLike | null | undefined, persona: PersonaLike | null | undefined): DeckStats {
  const m = (actor?.matrix || {}) as Record<string, unknown>;
  const deck = isCyberdeck(actor);
  const order = deck && isPermutation(persona?.asdf) ? persona!.asdf! : identityAsdf();
  const programs = loadedProgramIds(persona);
  const base = {} as Record<AsdfKey, number>;
  const slotted = {} as Record<AsdfKey, number>;
  const bonus = {} as Record<AsdfKey, number>;
  const penalty = {} as Record<AsdfKey, number>;
  const eff = {} as Record<AsdfKey, number>;
  for (const k of ASDF) {
    base[k] = Number(m[k]) || 0;
    slotted[k] = Number(m[order[k]]) || 0;
    bonus[k] = 0;
    for (const id of programs) bonus[k] += PROGRAM_BY_ID[id]?.attrBonus?.[k] || 0;
    // Commlinks have no Attack/Sleaze: programs cannot create them.
    if (!deck && (k === 'attack' || k === 'sleaze')) bonus[k] = 0;
    penalty[k] = Math.max(0, Number(persona?.penalties?.[k]) || 0);
    eff[k] = Math.max(0, slotted[k] + bonus[k] - penalty[k]);
  }
  // Noise: the GM's value + Faraday Himself (Data Trails p. 48), minus the programs' reduction.
  const rawNoise = Math.max(0, Number(persona?.noise) || 0) + (hasMatrixQuality(actor, 'faraday') ? FARADAY_NOISE : 0);
  let reduction = 0;
  for (const id of programs) reduction += PROGRAM_BY_ID[id]?.noiseReduction || 0;
  const deviceRating = Number(m.rating) || 0;
  return { deviceRating, isDeck: deck, base, slotted, bonus, penalty, eff, programs, rawNoise, noise: Math.max(0, rawNoise - reduction), monitor: matrixMonitor(deviceRating) };
}

/**
 * Dice the actor's modifiers add to biofeedback resistance (stat 'biofeedback': Natural Hardening, NeuroFilter…). blackIc turns
 * on the « against Black or Psychotropic IC » switch (Scorched −2, SR5 p. 83).
 */
export function biofeedbackDice(mods: CollectedModifier[] | null | undefined, blackIc = false): number {
  return poolModifiers(mods, { test: 'biofeedback' }, { conditions: blackIc ? ['q-black-ic'] : [] }).total;
}

/** Sum of a numeric program property over the loaded programs (resistMatrix, resistBio…). */
export function programSum(persona: PersonaLike | null | undefined, prop: keyof ProgramDef | (string & {})): number {
  let n = 0;
  for (const id of loadedProgramIds(persona)) n += Number((PROGRAM_BY_ID[id] as unknown as Record<string, unknown> | undefined)?.[prop]) || 0;
  return n;
}

/**
 * Matrix initiative for a mode: AR = physical initiative; VR = Data Processing + INT + 3D6 (cold) / 4D6 (hot).
 * mods (shared/modifiers.js collectModifiers) add their matrix initiative dice in VR (max 5D6).
 */
export function matrixInitiative(
  actor: ActorLike | null | undefined,
  persona: PersonaLike | null | undefined,
  mode: MatrixMode | (string & {}) | null | undefined = persona?.mode,
  mods: CollectedModifier[] | null = null,
): InitiativeScore {
  const d = derive(actor);
  if (mode === 'cold' || mode === 'hot') {
    const dp = deckStats(actor, persona).eff.dataProcessing;
    const base = dp + attr(actor, 'INT');
    // Unconditional dice, and those whose condition is this mode (Overclocking: hot-sim only).
    const extra = (mods || []).filter((m) => m.type === 'matrixInitiativeDice' && !m.info && m.value && (!m.condition || conditionState(m.condition, { mode }) === 'auto')).reduce((n, m) => n + (m.value as number), 0);
    const dice = Math.min(5, (mode === 'hot' ? 4 : 3) + extra);
    return { base, dice, text: `${base} + ${dice}D6` };
  }
  return { base: d.initiative.base, dice: d.initiative.dice, text: d.initiative.text };
}

/** Agent initiative: deck's Data Processing + Rating (in place of Intuition) + 4D6. */
export function agentInitiative(actor: ActorLike | null | undefined, persona: PersonaLike | null | undefined): InitiativeScore {
  const r = Number(persona?.agent?.rating) || 0;
  const base = deckStats(actor, persona).eff.dataProcessing + r;
  return { base, dice: 4, text: `${base} + 4D6` };
}

function skillOf(actor: ActorLike | null | undefined, skillId: string | undefined): Skill | null {
  return (actor?.skills || []).find((s) => s.id === skillId) || null;
}

/** Skill rating used to cap teamwork bonus dice (SR5: bonus dice ≤ leader's skill rating). */
export function skillRating(actor: ActorLike | null | undefined, skillId: string): number {
  return Number(skillOf(actor, skillId)?.rating) || 0;
}

/**
 * Dice pool + limit of a Matrix action for the decker (or her agent with opts.agent = true).
 * opts: { useSpec, marks (1-3, extra marks penalty), modifier, assist: { dice, limitBonus }, edge (Push the Limit),
 *         mods (shared/modifiers.js collectModifiers: skill / linked attribute / Codeslinger dice of the decker), conditions (switches on) }
 * Returns { pool, parts: [{ label, value, mod? }], limit, limitParts, impossible, reason, modLines (modifier lines, toggles included) }.
 */
export function actionPool(
  actor: ActorLike | null | undefined,
  persona: PersonaLike | null | undefined,
  action: MatrixActionDef | null | undefined,
  opts: ActionPoolOptions = {},
): ActionPool {
  const parts: PoolPart[] = [];
  let modLines: ModifierLine[] = [];
  const limitParts: PoolPart[] = [];
  if (!action || action.noTest) return { pool: 0, parts, limit: null, limitParts, impossible: false, noTest: true };
  const deck = deckStats(actor, persona);
  if (opts.agent) {
    const r = Number(persona?.agent?.rating) || 0;
    parts.push(part(tk('Agent (rating {r}): skill'), r, { r }), part(tk('Agent: attribute'), r));
  } else {
    const def = SKILL_BY_ID[action.skill as string];
    const sk = skillOf(actor, action.skill);
    const a = attr(actor, action.attr as AttrKey);
    if (!sk || !sk.rating) {
      if (def && !def.def) {
        const reasonKey = tk('{skill} cannot be used untrained');
        const reasonParams: I18nParams = { skill: { t: skillKey(def) } };
        return { pool: 0, parts, limit: null, limitParts, impossible: true, reason: fill(reasonKey, reasonParams), reasonKey, reasonParams };
      }
      parts.push(part(tk('{attr} (defaulting −1)'), Math.max(0, a - 1), { attr: action.attr as AttrKey }));
    } else {
      // skillId: the UI shows the official skill name; attr: the attribute code (the same in both languages).
      parts.push({ label: def ? skillEn(def) : sk.name || (action.skill as string), skillId: action.skill, value: Number(sk.rating) }, { label: action.attr as AttrKey, attr: action.attr, value: a });
      if (opts.useSpec && sk.spec) parts.push(part(tk('Spec. {spec}'), 2, { spec: sk.spec }));
    }
    if (opts.mods) {
      const ctx = { ...rollContext(actor, { skillId: action.skill, attr: action.attr }), actionId: action.id, actionNames: [action.en, action.fr], mode: persona?.mode || null };
      const pm = poolModifiers(opts.mods, ctx, { conditions: opts.conditions || [] });
      modLines = pm.lines;
      for (const l of pm.lines) if (l.state === 'applied') parts.push({ label: l.mod.source.name, value: l.value as number, mod: { id: l.mod.id, book: l.mod.source.book, page: l.mod.source.page } });
    }
    if (persona?.mode === 'hot') parts.push(part(tk('Hot-sim VR'), HOT_SIM_BONUS));
    const w = (opts.mods ? derivedWithModifiers(actor, opts.mods) : derive(actor)).woundModifier;
    if (w) parts.push(part(tk('Wounds'), w));
  }
  if (deck.noise) parts.push(part(tk('Noise'), -deck.noise));
  if (action.placesMarks) {
    const pen = opts.agent ? MARK_PENALTY[clampN(opts.marks || 1, 1, 3)] || 0 : markPenalty(actor, opts.marks || 1);
    if (pen) parts.push(part(tk('{n} marks'), pen, { n: clampN(opts.marks, 1, 3) }));
  }
  let pb = 0;
  for (const id of deck.programs) pb += PROGRAM_BY_ID[id]?.poolBonus?.[action.id] || 0;
  if (pb) parts.push(part(tk('Programs'), pb));
  if (opts.assist?.dice) parts.push(part(tk('Agent assist'), Number(opts.assist.dice)));
  const mod = clampN(opts.modifier || 0, -30, 30);
  if (mod) parts.push(part(tk('Edit'), mod));
  if (opts.edge && !opts.agent) parts.push(part(tk('Edge'), attr(actor, 'EDG')));
  const pool = Math.max(0, parts.reduce((s, p) => s + p.value, 0));
  let limit: number | null = null;
  if (action.limit) {
    limit = deck.eff[action.limit];
    limitParts.push(part(ASDF_LABELS[action.limit], limit));
    let lb = 0;
    for (const id of deck.programs) lb += PROGRAM_BY_ID[id]?.limitBonus?.[action.id] || 0;
    if (lb) {
      limit! += lb;
      limitParts.push(part(tk('Programs'), lb));
    }
    if (opts.assist?.limitBonus) {
      limit! += Number(opts.assist.limitBonus);
      limitParts.push(part(tk('Assist'), Number(opts.assist.limitBonus)));
    }
    if (opts.edge && !opts.agent) limit = null;
  }
  return { pool, parts, limit, limitParts, impossible: false, modLines };
}

/** Defense pool of a host (or its IC, devices and files): host rating (as mental attribute) + host attribute. */
export function hostDefensePool(
  host: ({ rating?: number } & Partial<Record<AsdfKey, number>>) | null | undefined,
  action: Pick<MatrixActionDef, 'defense'> | null | undefined,
): DefensePool | null {
  if (!host || !Array.isArray(action?.defense)) return null;
  const r = Number(host.rating) || 0;
  const defense = action!.defense as [AttrKey, AsdfKey];
  const k = defense[1];
  const mental = MENTAL_LABEL[defense[0]];
  return { pool: r + (Number(host[k]) || 0), parts: [part(tk('Host rating ({attr})'), r, { attr: mental ? { t: mental } : defense[0] }), part(ASDF_LABELS[k], Number(host[k]) || 0)] };
}

/** Defense pool of a persona (actor with a device): mental attribute + matrix attribute (+ WIL on full defense). */
export function personaDefensePool(
  actor: ActorLike | null | undefined,
  persona: PersonaLike | null | undefined,
  defense: MatrixDefense | undefined,
  actionId?: string | null,
): DefensePool | null {
  if (!actor || !Array.isArray(defense)) return null;
  const [a, k] = defense;
  const deck = deckStats(actor, persona);
  const parts: PoolPart[] = [MENTAL_LABEL[a] ? part(MENTAL_LABEL[a], attr(actor, a)) : { label: a, attr: a, value: attr(actor, a) }, part(ASDF_LABELS[k], deck.eff[k])];
  let db = 0;
  if (actionId) for (const id of deck.programs) db += PROGRAM_BY_ID[id]?.defenseBonus?.[actionId]?.[k] || 0;
  if (db) parts.push(part(tk('Programs'), db));
  if (persona?.fullDefense) parts.push(part(tk('Full defense (WIL)'), attr(actor, 'WIL')));
  const w = derive(actor).woundModifier;
  if (w) parts.push(part(tk('Wounds'), w));
  return { pool: Math.max(0, parts.reduce((s, p) => s + p.value, 0)), parts };
}

// ---------------------------------------------------------------------------
// Matrix Search (SR5 p. 241): a Simple Test against a threshold set by how available the information is. Hits above
// the threshold divide the base time; a failure costs the full base time. Inside a host the base time is 1 minute.
// Protected or secret information cannot be found from outside its host.
// ---------------------------------------------------------------------------
export type SearchLevel = 'public' | 'limited' | 'hidden';
export const SEARCH_LEVELS: Record<SearchLevel, { label: string; threshold: number; minutes: number }> = {
  public: { label: tk('General knowledge or public'), threshold: 1, minutes: 1 },
  limited: { label: tk('Limited interest or not publicized'), threshold: 3, minutes: 30 },
  hidden: { label: tk('Hidden or actively hunted and erased'), threshold: 6, minutes: 12 * 60 },
};
/** Dice pool modifiers of the Matrix Search Table. */
export const SEARCH_MODS: Array<{ id: string; label: string; value: number }> = [
  { id: 'intricate', label: tk('Intricate or specialized'), value: -1 },
  { id: 'obscure', label: tk('Obscure'), value: -2 },
  { id: 'otherGrid', label: tk('On another grid'), value: -2 },
];
export const searchLevel = (id: unknown): SearchLevel => (id === 'limited' || id === 'hidden' ? id : 'public');
/** Minutes a Matrix Search takes: base time (1 minute in a host) divided by the hits above the threshold; failure = base time. */
export function searchMinutes(level: SearchLevel, hits: number, inHost = false): number {
  const L = SEARCH_LEVELS[level];
  const base = inHost ? 1 : L.minutes;
  const net = hits - L.threshold;
  return hits >= L.threshold && net > 0 ? base / net : base;
}

// ---------------------------------------------------------------------------
// PAN (SR5 p. 233-235): a character's commlink (or deck) is subsumed by their persona and is the master of the
// wireless devices slaved to it — cyberware and firearms whose wireless is not switched off.
// ---------------------------------------------------------------------------
/** Cyberware Device Rating by grade (SR5 p. 234: basic cyberware 2, alphaware 3, betaware 4, deltaware 5; Chummer grades.xml). */
export const WARE_DEVICE_RATING: Record<string, number> = { used: 2, standard: 2, alpha: 3, beta: 4, delta: 5, gamma: 6, omega: 6 };
/** Device Rating of weapons and standard personal electronics (SR5 p. 234: « Average »). */
export const AVERAGE_DEVICE_RATING = 2;
/** Skills of the firearms that are devices (bows and thrown weapons are not). */
const FIREARM_SKILLS = new Set(['pistols', 'automatics', 'longarms', 'heavy_weapons', 'exotic_weapon']);

export type PanDeviceKind = 'cyberware' | 'weapon';
/** A device slaved to a character's PAN. */
export interface PanDevice {
  id: string;
  kind: PanDeviceKind;
  name: string;
  nameFr?: string;
  nameEn?: string;
  rating?: number;
  deviceRating: number;
}
/** The PAN master: the commlink or deck behind the persona. */
export interface PanMaster {
  name: string;
  deviceRating: number;
  dataProcessing: number;
  firewall: number;
}
/** Matrix stats of a catalog gear entry (commlinks, cyberdecks). */
export type GearMatrixStats = (catalogId: string) => { deviceRating?: number; dataProcessing?: number; firewall?: number } | null | undefined;

interface PanItem { id?: string; name?: string; nameFr?: string; nameEn?: string; rating?: number | string | null; catalogId?: string; category?: string; wirelessOff?: boolean }
const names = (it: PanItem) => ({ name: String(it.name || ''), ...(it.nameFr ? { nameFr: it.nameFr } : {}), ...(it.nameEn ? { nameEn: it.nameEn } : {}) });

/** The commlink / deck behind a character's persona: the sheet's Matrix device, else their best commlink or cyberdeck. */
export function panMaster(actor: ActorLike | null | undefined, stats?: GearMatrixStats): PanMaster | null {
  const m = actor?.matrix as Record<string, unknown> | null | undefined;
  if (m && Number(m.rating) > 0) {
    return { name: String(m.device || ''), deviceRating: Number(m.rating) || 0, dataProcessing: Number(m.dataProcessing) || 0, firewall: Number(m.firewall) || 0 };
  }
  let best: PanMaster | null = null;
  for (const g of ((actor?.gear || []) as PanItem[])) {
    if (!g || !/^(commlinks?|cyberdecks?)$/i.test(String(g.category || '').trim())) continue;
    const st = (g.catalogId && stats?.(g.catalogId)) || null;
    const dr = Number(st?.deviceRating) || Number(g.rating) || AVERAGE_DEVICE_RATING;
    const cand = { name: String(g.name || ''), deviceRating: dr, dataProcessing: Number(st?.dataProcessing) || dr, firewall: Number(st?.firewall) || dr };
    if (!best || cand.deviceRating > best.deviceRating) best = cand;
  }
  return best;
}

/** Devices of a character's PAN, in sheet order: cyberware (bioware has no wireless), then firearms (not implant weapons). */
export function panDevices(actor: ActorLike | null | undefined): PanDevice[] {
  const out: PanDevice[] = [];
  for (const a of ((actor?.augmentations || []) as Array<PanItem & { kind?: string; grade?: string }>)) {
    if (!a?.id || a.kind !== 'cyberware' || a.wirelessOff) continue;
    out.push({ id: a.id, kind: 'cyberware', ...names(a), ...(Number(a.rating) > 0 ? { rating: Number(a.rating) } : {}), deviceRating: WARE_DEVICE_RATING[a.grade || 'standard'] || AVERAGE_DEVICE_RATING });
  }
  for (const w of ((actor?.weapons || []) as Array<PanItem & { kind?: string; skill?: string; augId?: string }>)) {
    if (!w?.id || w.kind !== 'ranged' || w.augId || w.wirelessOff || !FIREARM_SKILLS.has(String(w.skill || ''))) continue;
    out.push({ id: w.id, kind: 'weapon', ...names(w), deviceRating: AVERAGE_DEVICE_RATING });
  }
  return out;
}

/** A slaved device's rating for each part of a test: its own or its master's, whichever is higher (SR5 p. 233). Devices have no Attack / Sleaze. */
export function panDeviceRating(device: { deviceRating: number }, master: PanMaster | null, k: AsdfKey | 'device'): number {
  const own = k === 'attack' || k === 'sleaze' ? 0 : device.deviceRating;
  const m = !master ? 0 : k === 'device' ? master.deviceRating : k === 'dataProcessing' ? master.dataProcessing : k === 'firewall' ? master.firewall : 0;
  return Math.max(own, m);
}

/** Defense pool of a slaved device: the owner's attribute or the Device Rating, and the device's or the master's Matrix attribute (SR5 p. 233). */
export function panDefensePool(owner: ActorLike, master: PanMaster | null, device: { deviceRating: number }, defense: MatrixDefense | undefined): DefensePool | null {
  if (!Array.isArray(defense)) return null;
  const [a, k] = defense;
  const own = owner?.attributes ? attr(owner, a) : 0;
  const first = own >= device.deviceRating
    ? (MENTAL_LABEL[a] ? part(MENTAL_LABEL[a], own) : { label: a, attr: a, value: own })
    : part(tk('Device Rating'), device.deviceRating);
  return { pool: first.value + panDeviceRating(device, master, k), parts: [first, part(ASDF_LABELS[k], panDeviceRating(device, master, k))] };
}

// ---------------------------------------------------------------------------
// Hosts & IC
// ---------------------------------------------------------------------------
/** Standard host attribute arrays: rating R → R, R+1, R+2, R+3 distributed by profile. */
export const HOST_PRESETS: Record<string, { label: string; offsets: Record<AsdfKey, number> }> = {
  shell: { label: tk('Shell company (Sleaze)'), offsets: { attack: 1, sleaze: 3, dataProcessing: 0, firewall: 2 } },
  fortress: { label: tk('Hardened (Firewall)'), offsets: { attack: 1, sleaze: 0, dataProcessing: 2, firewall: 3 } },
  aggressive: { label: tk('Aggressive (Attack)'), offsets: { attack: 3, sleaze: 1, dataProcessing: 0, firewall: 2 } },
  archive: { label: tk('Archive (Data Processing)'), offsets: { attack: 0, sleaze: 1, dataProcessing: 3, firewall: 2 } },
};

/**
 * IC (SR5 p. 248). Attack: host rating × 2 [limit] vs the decker's defense. needsMarks = marks the host must
 * have on the decker. effect = what the server applies on a hit.
 */
export const IC_TYPES: Record<IcType, IcTypeDef> = {
  patrol: { fr: tk('Patrol IC'), en: 'Patrol IC', limit: 'dataProcessing', defense: ['LOG', 'sleaze'], effect: 'spot', desc: tk('Matrix Perception every turn: spots you and triggers the alert.') },
  probe: { fr: tk('Probe IC'), en: 'Probe IC', limit: 'attack', defense: ['INT', 'firewall'], effect: 'mark', desc: tk('Places a mark on you with every successful attack.') },
  killer: { fr: tk('Killer IC'), en: 'Killer IC', limit: 'attack', defense: ['INT', 'firewall'], effect: 'damage', desc: tk('Matrix damage: host Attack + net hits.') },
  acid: { fr: tk('Acid IC'), en: 'Acid IC', limit: 'attack', defense: ['WIL', 'firewall'], effect: 'penalty', attrHit: 'firewall', desc: tk('Firewall −1 (until reboot).') },
  binder: { fr: tk('Binder IC'), en: 'Binder IC', limit: 'attack', defense: ['WIL', 'dataProcessing'], effect: 'penalty', attrHit: 'dataProcessing', desc: tk('Data Processing −1 (until reboot).') },
  jammer: { fr: tk('Jammer IC'), en: 'Jammer IC', limit: 'attack', defense: ['WIL', 'attack'], effect: 'penalty', attrHit: 'attack', desc: tk('Attack −1 (until reboot).') },
  marker: { fr: tk('Marker IC'), en: 'Marker IC', limit: 'attack', defense: ['WIL', 'sleaze'], effect: 'penalty', attrHit: 'sleaze', desc: tk('Sleaze −1 (until reboot).') },
  crash: { fr: tk('Crash IC'), en: 'Crash IC', limit: 'attack', defense: ['INT', 'firewall'], effect: 'crash', needsMarks: 1, desc: tk('Crashes one of your programs at random (requires 1 mark on you).') },
  tarbaby: { fr: tk('Tar Baby IC'), en: 'Tar Baby IC', limit: 'attack', defense: ['LOG', 'firewall'], effect: 'linklock', desc: tk('Link-lock: you can no longer jack out normally.') },
  scramble: { fr: tk('Scramble IC'), en: 'Scramble IC', limit: 'attack', defense: ['WIL', 'firewall'], effect: 'reboot', needsMarks: 3, desc: tk('Forces your deck to reboot (dumpshock in VR). Requires 3 marks on you.') },
  track: { fr: tk('Track IC'), en: 'Track IC', limit: 'attack', defense: ['WIL', 'sleaze'], effect: 'trace', needsMarks: 2, desc: tk('Reveals your physical location (requires 2 marks on you).') },
  blaster: { fr: tk('Blaster IC'), en: 'Blaster IC', limit: 'attack', defense: ['LOG', 'firewall'], effect: 'damage', bio: 'S', linklock: true, desc: tk('Matrix damage (Attack + net hits) + as much Stun biofeedback, and link-lock.') },
  black: { fr: tk('Black IC'), en: 'Black IC', limit: 'attack', defense: ['INT', 'firewall'], effect: 'damage', bio: 'sim', linklock: true, desc: tk('Matrix damage (Attack + net hits) + as much biofeedback (P in hot-sim, S in cold-sim), and link-lock.') },
  sparky: { fr: tk('Sparky IC'), en: 'Sparky IC', limit: 'attack', defense: ['INT', 'firewall'], effect: 'damage', bio: 'sim', desc: tk('Matrix damage (Attack + net hits) + as much biofeedback.') },
};
export const IC_ORDER: IcType[] = ['patrol', 'probe', 'killer', 'acid', 'binder', 'jammer', 'marker', 'crash', 'tarbaby', 'scramble', 'track', 'blaster', 'black', 'sparky'];

/** Typical IC suite by host rating (only Patrol starts active). */
export function defaultIcFor(rating: unknown): IcType[] {
  const r = Number(rating) || 1;
  if (r <= 3) return ['patrol', 'probe', 'killer'];
  if (r <= 6) return ['patrol', 'probe', 'killer', 'acid', 'tarbaby'];
  if (r <= 9) return ['patrol', 'probe', 'killer', 'blaster', 'black', 'track'];
  return ['patrol', 'probe', 'killer', 'black', 'blaster', 'sparky', 'scramble', 'track'];
}

export function hostAttributes(rating: unknown, preset = 'shell'): Record<AsdfKey, number> {
  const r = clampN(rating, 1, 12);
  const off = (HOST_PRESETS[preset] || HOST_PRESETS.shell).offsets;
  return Object.fromEntries(ASDF.map((k) => [k, r + off[k]])) as Record<AsdfKey, number>;
}

/** IC attack pool: host rating × 2. IC initiative: host rating × 2 + 4D6. */
export const icAttackPool = (host: { rating?: number } | null | undefined): number => (Number(host?.rating) || 0) * 2;
export const icInitiative = (host: { rating?: number } | null | undefined): InitiativeScore => ({ base: (Number(host?.rating) || 0) * 2, dice: 4, text: `${(Number(host?.rating) || 0) * 2} + 4D6` });

/** Overwatch Score level for the meter. */
export function osLevel(os: unknown): { id: string; label: string; color: string } {
  const n = Number(os) || 0;
  if (n >= 35) return { id: 'critical', label: tk('Convergence imminent'), color: 'red' };
  if (n >= 30) return { id: 'danger', label: tk('Danger'), color: 'red' };
  if (n >= 20) return { id: 'warn', label: tk('Watched'), color: 'amber' };
  if (n >= 10) return { id: 'notice', label: tk('Noticed'), color: 'cyan' };
  return { id: 'calm', label: tk('Low profile'), color: 'green' };
}

// ---------------------------------------------------------------------------
// Overwatch over time (SR5 p. 232): every 15 minutes after the first tally, the OS rises by 2D6 (GM, in secret).
// ---------------------------------------------------------------------------
export const OS_TICK_MS = 15 * 60 * 1000;

// ---------------------------------------------------------------------------
// Host devices linked to the map: a door (tile door or segment-wall door), a light, or a camera zone (map region).
// device.link = { mapId, kind, targetId }. Commands go through Control Device / Spoof Command (deviceCmd).
// ---------------------------------------------------------------------------
export const DEVICE_LINK_KINDS: Record<DeviceLinkKind, { label: string; icon: string; cmds: string[] }> = {
  door: { label: tk('Door'), icon: '🚪', cmds: ['open', 'close', 'unlock', 'lock'] },
  light: { label: tk('Lighting'), icon: '💡', cmds: ['off', 'on'] },
  camera: { label: tk('Cameras (zone)'), icon: '📷', cmds: ['off', 'on'] },
};
/** Command labels by link kind (UI keys). */
export const DEVICE_CMD_LABELS: Record<DeviceLinkKind, Record<string, string>> = {
  door: { open: tk('Open'), close: tk('Close'), unlock: tk('Unlock'), lock: tk('verb::Lock') },
  light: { off: tk('Switch off'), on: tk('Switch on') },
  camera: { off: tk('Cut the feed'), on: tk('Restore the feed') },
};
/** Is the device working (powered, not rebooting, not destroyed)? */
export const deviceWorks = (d: { offline?: boolean; bricked?: boolean; formatted?: boolean } | null | undefined): boolean => !!d && !d.offline && !d.bricked && !d.formatted;

// ---------------------------------------------------------------------------
// Next-step hints for the decker (cockpit « Conseils » toggle). Pure: works on the player's filtered view.
// Returns [{ key, params?, actionId?, targetId?, preset?, tone: 'info'|'warn'|'danger' }], most urgent first.
// ---------------------------------------------------------------------------
const TONE_RANK: Record<string, number> = { danger: 0, warn: 1, info: 2 };
/** Most urgent first (stable: same urgency keeps the order of the steps). */
const byUrgency = (list: MatrixHint[]): MatrixHint[] => list.sort((a, b) => (TONE_RANK[a.tone] ?? 2) - (TONE_RANK[b.tone] ?? 2));
export function nextStepHints({
  actor,
  persona,
  hosts = {},
}: {
  actor: ActorLike | null | undefined;
  persona: PersonaLike | null | undefined;
  hosts?: Record<string, HintHost>;
}): MatrixHint[] {
  const out: MatrixHint[] = [];
  if (!actor?.matrix || !persona) return out;
  const add = (key: string, extra: Partial<MatrixHint> = {}) => out.push({ key, tone: 'info', ...extra });
  const ds = deckStats(actor, persona);
  const marksOn = (key: string) => (persona.marks || []).find((m) => m.targetId === key)?.count || 0;
  if (persona.bricked) {
    add(tk('Your deck is bricked: ask the GM to repair it before you reconnect.'), { tone: 'danger' });
    return byUrgency(out);
  }
  if (!persona.online) {
    add(tk('Connect: hot sim VR = +2 dice and more initiative, but biofeedback deals Physical damage.'));
    if ((persona.overwatch || 0) > 0) add(tk('Your Overwatch Score is not zero: rebooting your deck resets it to 0.'));
    return byUrgency(out);
  }
  const os = persona.overwatchHidden ? persona.osKnown : persona.overwatch;
  if (persona.linkLocked) add(tk('Link-locked: you cannot disconnect normally. Destroy the IC holding you, or try “Jack Out”.'), { tone: 'danger', actionId: 'jackOut' });
  if (ds.monitor && (persona.matrixDamage || 0) >= ds.monitor - 3) add(tk('Your deck is almost bricked: leave the host or disconnect.'), { tone: 'danger' });
  const osMax = convergenceAt(actor);
  if (os !== null && os !== undefined && os >= osMax - 10) add(tk('Overwatch Score {os}/{max}: convergence is near. Finish fast or reboot your deck.'), { tone: 'danger', params: { os, max: osMax } });
  else if (persona.overwatchHidden && (persona.overwatch === null || persona.overwatch === undefined)) add(tk('You do not know your Overwatch Score: check it now and then (“Check Overwatch Score” action).'), { actionId: 'checkOverwatch' });
  if (persona.agent?.loaded && !persona.pendingAssist) add(tk('Your agent is loaded: have it assist your next test (+dice, +1 limit) from “Roll”.'));
  else if (persona.agent && !persona.agent.loaded) add(tk('Your agent is idle: load it (Agent panel) so it can assist you or act for you.'));
  const cur = persona.hostId ? hosts[persona.hostId] : null;
  if (!cur) {
    const list = Object.values(hosts).filter((h) => h.visible || marksOn(`host:${h.id}`));
    if (!list.length) {
      add(tk('No host spotted: the GM will reveal it once you know where to strike (or run a Matrix Search).'), { actionId: 'matrixSearch' });
      return byUrgency(out);
    }
    for (const h of list) {
      if (marksOn(`host:${h.id}`)) add(tk('You have a mark on {host}: enter the host.'), { params: { host: h.name }, actionId: 'enterHost', targetId: `host:${h.id}` });
      else add(tk('Place a mark on {host}: Hack on the Fly (quiet, Sleaze) or Brute Force (loud, Attack).'), { params: { host: h.name }, actionId: 'hackOnTheFly', targetId: `host:${h.id}` });
    }
    return byUrgency(out);
  }
  const hostId = cur.id;
  const ic = (cur.ic || []).filter((x) => x.type && x.type !== 'patrol');
  if (cur.alert === 'active' && ic.length) add(tk('The host is on alert and its IC attack: take them down (Data Spike), go to Full Matrix Defense, or finish fast and leave.'), { tone: 'warn', actionId: 'dataSpike', targetId: `ic:${hostId}:${ic[0].id}` });
  else if (cur.spotted) add(tk('The patrol spotted you: the host will launch IC. Hide or hurry up.'), { tone: 'warn', actionId: 'hide', targetId: `host:${hostId}` });
  if (!cur.perceived) {
    add(tk('Run Matrix Perception on the host: each hit lets the GM reveal its rating, an IC, a file or a device.'), { actionId: 'matrixPerception', targetId: `host:${hostId}` });
    return byUrgency(out);
  }
  const copied = new Set((persona.files || []).map((f) => f.sourceId));
  for (const f of cur.files || []) {
    const tid = `file:${hostId}:${f.id}`;
    if (f.protected) add(tk('“{file}” is protected: crack it first (Crack File).'), { params: { file: f.name }, actionId: 'crackFile', targetId: tid });
    else if (f.bomb > 0 && !f.mine) add(tk('“{file}” is booby-trapped (bomb {n}): disarm it before touching it.'), { tone: 'warn', params: { file: f.name, n: f.bomb }, actionId: 'disarmDataBomb', targetId: tid });
    else if (!copied.has(f.id)) add(tk('Copy “{file}” to your deck (Edit File).'), { params: { file: f.name }, actionId: 'editFile', targetId: tid, preset: { fileOp: 'copy' } });
  }
  for (const d of cur.devices || []) {
    if (!d.link?.kind || !deviceWorks(d)) continue;
    add(tk('{device} is linked to the map: take control of it to help the team.'), { params: { device: d.name }, actionId: 'controlDevice', targetId: `device:${hostId}:${d.id}` });
  }
  if (out.every((h) => !h.actionId || h.actionId === 'jackOut')) add(tk('Nothing obvious left here: leave the host before your Overwatch Score climbs.'), { actionId: 'exitHost' });
  return byUrgency(out);
}

/** Dumpshock: 6 DV, Physical after hot sim, Stun after cold sim, none in AR; resisted with Willpower + Firewall. */
export function dumpshock(mode: unknown): { dv: number; type: DamageType } | null {
  if (mode === 'hot') return { dv: DUMPSHOCK_DV, type: 'P' };
  if (mode === 'cold') return { dv: DUMPSHOCK_DV, type: 'S' };
  return null;
}
