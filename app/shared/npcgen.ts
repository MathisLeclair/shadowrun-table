// Quick tiered enemy generator (SR5 Professional Rating 0-6, grunt rules core p.381-385).
// Pure ES module shared by the server (15-chargen.js: npcgen/preview, npcgen/create) and tests. No Node / DOM APIs.
// Deterministic: the same { archetype, tier, metatype, seed, lieutenant } always gives the same template.
// Catalog access is injected: ctx = { find(file, name) -> catalog item | null, rules: { quote, evalFormula } }.
// Output = a bestiary Template (ARCHITECTURE.md: Actor schema minus runtime fields + folder/description),
// accepted as-is by sanitizeTemplate() in server/modules/30-combat.js.
import { METATYPES, SKILL_BY_ID, attr } from './sr5.ts';
import { METATYPE_MIN } from './chargen.ts';
import { bonusFromEffects } from './modifiers.ts';
import type { ChargenRules } from './chargen.ts';
import type {
  ActorVision, AdeptPower, Armor, AttrKey, Attributes, Augmentation, CatalogBonus, CatalogFile, CatalogItem, CatalogWeaponProfile, Disposition, Formula,
  Gear, ItemBonus, Skill, SpellStats, Template, VehicleStats, Weapon, WareGrade, WareKind,
} from './types.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
/** Picks one element of an array with the generator's RNG. */
export type Picker = <T>(arr: T[]) => T;
/** Kit 'ware row: [catalog file, name, rating]. */
export type KitWare = [file: 'cyberware' | 'bioware', name: string, rating: number | null];
/** Kit gear row: [name, rating, qty]. */
export type KitGear = [name: string, rating: number | null, qty: number];
/** Equipment of an archetype at a tier (exact data/catalog names). */
export interface Kit {
  weapons?: Array<string | null>;
  armor?: string[];
  ware?: KitWare[];
  gear?: Array<KitGear | null>;
  vehicles?: string[];
}
interface ArchetypeBase {
  id: string;
  label: string;
  icon: string;
  concept: string;
  color: string;
  grunt: boolean;
  blurb: string;
  disposition?: Exclude<Disposition, 'pc'>;
  spirit?: boolean;
  toxic?: boolean;
  group: (pick: Picker) => string;
  tactics: string;
}
export interface MetahumanArchetype extends ArchetypeBase {
  kind: 'metahuman';
  magic?: 'magician';
  matrix?: 'deck' | 'rcc';
  /** Offsets on the tier baseline. */
  attrs: Partial<Record<AttrKey, number>>;
  /** [primary ids], [secondary], [tertiary]. */
  skills: [string[], string[], string[]];
  spells?: string[];
  kit: (t: number, pick: Picker) => Kit;
}
/** SR5 critter baseline (the tier makes juveniles or pack alphas). */
export interface CritterDef {
  attributes: Record<string, number>;
  initDice: number;
  /** [skill id, rating, displayed name?]. */
  skills: Array<[id: string, rating: number, name?: string]>;
  weapons: Array<Pick<Weapon, 'name' | 'kind' | 'skill' | 'accuracy' | 'damage' | 'ap'> & { reach?: number; notes?: string }>;
  powers: string[];
  weaknesses: string[];
  armor: number;
  vision: ActorVision;
}
export interface CritterArchetype extends ArchetypeBase {
  kind: 'critter';
  /** Keeps the frame of the chosen metatype (ghouls). */
  metaFrom?: boolean;
  critter: CritterDef;
}
export type Archetype = MetahumanArchetype | CritterArchetype;

/** generate() options. */
export interface GenerateOptions {
  archetype?: string;
  /** Professional Rating 0-6. */
  tier?: number | string;
  /** 'random' or a metatype name. */
  metatype?: string;
  seed?: number | string;
  lieutenant?: boolean;
  grunt?: boolean | null;
  name?: string;
}
/** Catalog access and pricing (ctx.find(file, name), shop rules quote / evalFormula). */
export interface NpcgenCtx {
  find?: (file: CatalogFile, name: string) => CatalogItem | null;
  rules?: Pick<ChargenRules, 'quote' | 'evalFormula'>;
}
/** A generated bestiary template (not stored: the server adds id / type and sanitizes it). */
export interface GeneratedTemplate extends Omit<Template, 'id' | 'type' | 'description' | 'augmented' | 'concept'> {
  concept: string;
  augmented: Partial<Record<AttrKey, number>>;
  /** Filled at the end of generate(). */
  description?: string;
  genArchetype: string;
  genTier: number;
  genSeed: number;
  genLieutenant: boolean;
}
type Finder = (file: CatalogFile, name: string) => CatalogItem | null;
type CoreKey = 'BOD' | 'AGI' | 'REA' | 'STR' | 'WIL' | 'LOG' | 'INT' | 'CHA';

// i18n: tier/archetype labels and texts are English dictionary keys (French in client/i18n/fr/chargen.json), shown with t().
// Generated templates (names, descriptions, tactics, gear) are stored data and stay in French.
const tk = (s: string): string => s;

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------
export const TIERS = [
  { pr: 0, label: tk('Civilian'), text: tk('No combat training: flees, hides or surrenders at the first gunshot.') },
  { pr: 1, label: tk('Riffraff'), text: tk('Small-time thugs and low-level gangers: brave in a group, scattered as soon as things go wrong.') },
  { pr: 2, label: tk('Organized thug'), text: tk('Organized gang, mob muscle: they hold as long as a leader drives them and the odds favor them.') },
  { pr: 3, label: tk('Street pro / corp security'), text: tk('Corp guards, patrol cops, seasoned gangers: basic tactics, take cover and call for backup.') },
  { pr: 4, label: tk('Seasoned professional'), text: tk('Knight Errant, mercenaries, elite security: coordinated, well equipped, fall back methodically.') },
  { pr: 5, label: tk('Elite'), text: tk('Response teams, Mafia hitters: augmented, cover their angles, never panic.') },
  { pr: 6, label: tk('Special forces / prime runner'), text: tk('Red Samurai, Tir Ghosts, legendary runners: they never give in, every runner mistake costs dearly.') },
];
/** Bestiary folder of generated templates and metatype values: stored data, French for save compatibility (shown with tIfKnown / metatypeLabel). */
export const GENERATED_FOLDER = 'Générés';
export const METATYPE_CHOICES: string[] = ['random', 'Humain', 'Elfe', 'Nain', 'Ork', 'Troll'];
export const GRUNT_RULES = tk(
  'Grunts (SR5 rules p.381): a single condition monitor per grunt (Stun damage goes on it too), no Edge. The lieutenant (Professional Rating +1) has both monitors and Edge. Morale: the group scatters or surrenders once it has lost half its members or its lieutenant (the GM may call for a Composure test, threshold 7 − PR).'
);

// SR5 metatype adjustments applied to a human baseline (then clamped to the metatype limits).
const META_ADJ: Record<string, Partial<Record<CoreKey, number>>> = {
  Humain: {},
  Elfe: { AGI: 1, CHA: 2 },
  Nain: { BOD: 2, REA: -1, STR: 2, WIL: 1 },
  Ork: { BOD: 3, STR: 2, LOG: -1, CHA: -1 },
  Troll: { BOD: 4, AGI: -1, STR: 4, LOG: -1, INT: -1, CHA: -2 },
};
const META_WEIGHTS: Array<[string, number]> = [['Humain', 58], ['Ork', 20], ['Elfe', 9], ['Nain', 8], ['Troll', 5]];
const CORE: CoreKey[] = ['BOD', 'AGI', 'REA', 'STR', 'WIL', 'LOG', 'INT', 'CHA'];
const BASE_ATTR = [2, 3, 3, 3, 4, 4, 5]; // by tier, human baseline
const SKILL_TOP = [1, 3, 3, 4, 5, 6, 7]; // primary skill rating by tier (SR5 sample grunts)
const GRADE_BY_TIER = (t: number): WareGrade => (t >= 6 ? 'beta' : t >= 5 ? 'alpha' : 'standard');

const GANGS = ['Halloweeners', 'Ancients', 'Cutters', 'Red Hot Nukes', 'Spikes', 'Crimson Crush', 'Rusted Stilettos', 'Desolation Angels', 'First Nation'];
const CORPS = ['Ares', 'Renraku', 'Aztechnology', 'Saeder-Krupp', 'Shiawase', 'Mitsuhama', 'NeoNET', 'Horizon', 'Wuxing', 'Evo', 'AG Chemie'];
const MERCS = ['MET2000', 'Tsunami', 'Combat Inc.', 'les Loups de Tacoma', 'Black Star'];
const CULTS = ['Culte de la Rouille', 'Enfants du Smog', 'Fraternité de la Boue noire', 'Église de la Marée toxique'];
const DISTRICTS = ['de Puyallup', 'de Redmond', 'des Barrens', 'de Tacoma', 'de Touristville', 'de Renton', 'de Snohomish', 'd’Everett', 'de Bellevue', 'de l’Underground', 'd’Auburn', 'de Fort Lewis'];
const FIRST = ['Lucas', 'Inès', 'Mathis', 'Léa', 'Karim', 'Yasmine', 'Hugo', 'Chloé', 'Malik', 'Sofia', 'Théo', 'Nadia', 'Bastien', 'Amina', 'Jules', 'Clara', 'Jake', 'Maria', 'Kenji', 'Aiko', 'Dmitri', 'Olga', 'Carlos', 'Rosa', 'Sean', 'Mei', 'Tariq', 'Ingrid', 'Marcus', 'Keisha', 'Viktor', 'Anya', 'Diego', 'Hana', 'Ray', 'Lena'];
const LAST = ['Martin', 'Kowalski', 'Nakamura', 'Okafor', 'Dubois', 'Rossi', 'García', 'Lefebvre', 'Chen', 'Ivanov', 'Sato', 'Moreau', 'Novak', 'Smith', 'Haddad', 'Kim', 'O’Brien', 'Fontaine', 'Reyes', 'Lindqvist', 'Tremblay', 'Whitehorse', 'Yazzie', 'Blackfeather'];
const NICKS = ['Rouille', 'Chrome', 'Vipère', 'Le Grec', 'Fusible', 'Tox', 'Crocs', 'Mamba', 'Néon', 'Sulfure', 'Ratchet', 'Clou', 'Grinder', 'Ghost', 'Jinx', 'Nox', 'Scalpel', 'Diesel', 'Mouette', 'Tank', 'Spike', 'Brindille', 'Taupe', 'Lynx', 'Rasoir', 'Quartz', 'Hex', 'Pixel', 'Torque', 'Blitz', 'Sumo', 'Corbeau', 'Glitch', 'Patch', 'Mojo', 'Cendre', 'Bourbon', 'Vandale', 'Sushi', 'Kraken'];

// ---------------------------------------------------------------------------
// Archetypes. skills: [primary ids], [secondary], [tertiary]. attrs: offsets on the tier baseline.
// kit(t, pick) -> { weapons: [name], armor: [name], ware: [[file, name, rating]], gear: [[name, rating, qty]], vehicles: [name] }
// Every name is an exact data/catalog name (tools/test-npcgen.ts checks it).
// ---------------------------------------------------------------------------
const holdout = (t: number, pick: Picker): string => (t <= 1 ? pick(['Streetline Special', 'Yamaha Pulsar']) : t <= 2 ? pick(['Colt America L36', 'Ares Light Fire 70']) : pick(['Ares Predator V', 'Browning Ultra-Power']));
const heavyPistol = (t: number, pick: Picker): string => (t <= 1 ? pick(['Streetline Special', 'Colt America L36']) : t <= 2 ? pick(['Browning Ultra-Power', 'Ruger Super Warhawk', 'Colt America L36']) : t <= 5 ? 'Ares Predator V' : pick(['Ares Predator V', 'HK Urban Fighter']));
const melee = (t: number, pick: Picker): string => (t <= 1 ? pick(['Knife', 'Club']) : t <= 2 ? pick(['Survival Knife', 'Extendable Baton', 'Club']) : t <= 3 ? pick(['Combat Knife', 'Stun Baton']) : pick(['Katana', 'Combat Knife', 'Stun Baton']));
const smg = (t: number, pick: Picker): string => (t <= 2 ? pick(['Ceska Black Scorpion', 'Uzi IV']) : t <= 3 ? pick(['Colt Cobra TZ-120', 'Ingram Smartgun X']) : pick(['HK 227', 'Ingram Smartgun X']));
const rifle = (t: number, pick: Picker): string => (t <= 2 ? pick(['AK-97', 'Colt M23']) : t <= 4 ? pick(['AK-97', 'FN HAR']) : t <= 5 ? pick(['Ares Alpha', 'FN HAR']) : pick(['Ares Alpha', 'HK G12A4']));
const bodyArmor = (t: number, pick: Picker, heavy = false): string[] => {
  if (t <= 0) return [];
  if (t === 1) return ['Armor Clothing'];
  if (t === 2) return [pick(['Armor Vest', 'Lined Coat'])];
  if (t === 3) return heavy ? ['Armor Jacket'] : [pick(['Lined Coat', 'Armor Jacket'])];
  if (t === 4) return heavy ? ['Armor Jacket', 'Helmet'] : ['Armor Jacket'];
  return heavy ? ['Full Body Armor', 'Helmet'] : ['Armor Jacket', 'Helmet'];
};
const commlink = (t: number): string => ['Meta Link', 'Meta Link', 'Sony Emperor', 'Renraku Sensei', 'Erika Elite', 'Hermes Ikon', 'Transys Avalon'][t];
const samuraiWare = (t: number): KitWare[] => {
  if (t <= 2) return [];
  if (t === 3) return [['cyberware', 'Cybereyes Basic System', 1], ['cyberware', 'Smartlink', null]];
  if (t === 4) return [['cyberware', 'Wired Reflexes', 1], ['cyberware', 'Cybereyes Basic System', 1], ['cyberware', 'Smartlink', null], ['cyberware', 'Dermal Plating', 1]];
  if (t === 5) return [['cyberware', 'Wired Reflexes', 2], ['cyberware', 'Cybereyes Basic System', 2], ['cyberware', 'Smartlink', null], ['cyberware', 'Dermal Plating', 2], ['cyberware', 'Muscle Replacement', 1]];
  return [['cyberware', 'Wired Reflexes', 2], ['cyberware', 'Cybereyes Basic System', 2], ['cyberware', 'Smartlink', null], ['cyberware', 'Dermal Plating', 2], ['cyberware', 'Muscle Replacement', 2], ['cyberware', 'Hand Blade', null]];
};

export const ARCHETYPES: Archetype[] = [
  {
    id: 'ganger', label: tk('Ganger / thug'), icon: '✊', kind: 'metahuman', concept: 'Ganger', color: '#e0a63f', grunt: true,
    blurb: tk('Barrens gangers, small-time thugs, neighborhood muscle.'),
    attrs: { BOD: 1, STR: 1, LOG: -1 },
    skills: [['clubs', 'unarmed_combat'], ['pistols', 'blades', 'intimidation'], ['running', 'sneaking', 'perception']],
    kit: (t, pick) => ({
      weapons: [melee(t, pick), t >= 1 ? (t >= 3 ? smg(t - 1, pick) : holdout(t, pick)) : null],
      armor: t >= 1 ? (t >= 4 ? ['Lined Coat'] : ['Armor Clothing']) : [],
      ware: t >= 4 ? [['cyberware', 'Dermal Plating', 1]] : [],
      gear: [[commlink(Math.min(t, 2)), null, 1], t >= 2 ? ['Grenade: Molotov Cocktail', null, 1] : null],
    }),
    group: (pick) => `Ganger des ${pick(GANGS)}`,
    tactics: 'Encerclent, insultent, frappent à plusieurs sur le plus faible. Fuient si le chef tombe ou si la riposte est trop forte.',
  },
  {
    id: 'corpsec', label: tk('Corporate security'), icon: '⛨', kind: 'metahuman', concept: 'Garde de sécurité', color: '#5c9be0', grunt: true,
    blurb: tk('Corp guards and patrols, uniformed and in pairs.'),
    attrs: { BOD: 1, REA: 1 },
    skills: [['pistols', 'automatics'], ['clubs', 'perception', 'unarmed_combat'], ['etiquette', 'first_aid', 'running']],
    kit: (t, pick) => ({
      weapons: [t <= 2 ? 'Fichetti Security 600' : heavyPistol(t, pick), t >= 2 ? 'Stun Baton' : 'Extendable Baton', t >= 3 ? smg(t, pick) : null],
      armor: t <= 1 ? ['Armor Vest'] : bodyArmor(t, pick, true),
      ware: t >= 5 ? [['cyberware', 'Wired Reflexes', 1], ['cyberware', 'Smartlink', null], ['cyberware', 'Cybereyes Basic System', 1]] : t >= 3 ? [['cyberware', 'Cybereyes Basic System', 1], ['cyberware', 'Smartlink', null]] : [],
      gear: [[commlink(Math.max(2, t)), null, 1], ['Restraint, Plastic', null, 2], t >= 3 ? ['Grenade: Flash-Bang', null, 2] : null],
    }),
    group: (pick) => `Garde ${pick(CORPS)}`,
    tactics: 'Restent en binôme, donnent l’alerte (le spider du site arrive en 1D3 tours), tirent pour neutraliser, gagnent du temps jusqu’aux renforts.',
  },
  {
    id: 'police', label: tk('Police / Knight Errant'), icon: '★', kind: 'metahuman', concept: 'Officier de police', color: '#3fd6d0', grunt: true,
    blurb: tk('Knight Errant patrols, response units (HTR at high ratings).'),
    attrs: { BOD: 1, REA: 1, WIL: 1 },
    skills: [['pistols', 'automatics'], ['clubs', 'perception', 'unarmed_combat'], ['intimidation', 'first_aid', 'pilot_ground_craft']],
    kit: (t, pick) => ({
      weapons: [heavyPistol(Math.max(2, t), pick), 'Stun Baton', t >= 4 ? (t >= 5 ? rifle(t, pick) : 'HK 227') : t >= 3 ? 'Defiance T-250' : 'Yamaha Pulsar'],
      armor: t <= 2 ? ['Armor Vest'] : bodyArmor(t, pick, true),
      ware: t >= 4 ? (t >= 6 ? samuraiWare(5) : [['cyberware', 'Smartlink', null], ['cyberware', 'Cybereyes Basic System', 1], ...(t >= 5 ? [['cyberware', 'Wired Reflexes', 1] as KitWare] : [])]) : [],
      gear: [[commlink(Math.max(3, t)), null, 1], ['Restraint, Metal', null, 2], ['Grenade: Flash-Bang', null, t >= 4 ? 3 : 1]],
    }),
    group: (pick) => (pick([0, 1, 2]) ? 'Agent Knight Errant' : 'Agent Lone Star'),
    tactics: 'Sommations d’abord, puis tir pour neutraliser (balles gel/électriques à bas indice). Bouclent la zone ; drone d’appui et renforts HTR à haut indice.',
  },
  {
    id: 'merc', label: tk('Mercenary / street samurai'), icon: '⚔', kind: 'metahuman', concept: 'Samouraï des rues', color: '#e05c5c', grunt: false,
    blurb: tk('Augmented muscle, heavy weapons, chrome everywhere.'),
    attrs: { BOD: 1, AGI: 1, REA: 1, STR: 1, LOG: -1 },
    skills: [['automatics', 'pistols'], ['blades', 'unarmed_combat', 'perception'], ['sneaking', 'longarms', 'throwing_weapons']],
    kit: (t, pick) => ({
      weapons: [rifle(Math.max(2, t), pick), heavyPistol(Math.max(2, t), pick), melee(t, pick)],
      armor: bodyArmor(t, pick, t >= 4),
      ware: samuraiWare(t),
      gear: [[commlink(Math.max(2, t)), null, 1], t >= 2 ? ['Grenade: Fragmentation', null, t >= 4 ? 2 : 1] : null],
    }),
    group: (pick) => `Mercenaire (${pick(MERCS)})`,
    tactics: 'Feu de suppression, tir en rafales, flanquement. Visent d’abord le mage et le decker. Négocient s’ils sont payés pour ça, pas pour mourir.',
  },
  {
    id: 'mage', label: tk('Combat mage'), icon: '✶', kind: 'metahuman', concept: 'Mage de combat', color: '#9d7ce0', grunt: false, magic: 'magician',
    blurb: tk('Combat and protection spells, a team’s magical support.'),
    attrs: { WIL: 1, LOG: 1, CHA: 1, STR: -1 },
    skills: [['spellcasting'], ['counterspelling', 'assensing', 'perception'], ['summoning', 'pistols', 'arcana']],
    spells: ['Stunbolt', 'Manabolt', 'Armor', 'Powerbolt', 'Fireball', 'Physical Barrier', 'Stunball', 'Increase Reflexes', 'Heal', 'Manaball', 'Improved Invisibility', 'Lightning Bolt', 'Mana Barrier'],
    kit: (t, pick) => ({ weapons: [holdout(t, pick)], armor: t >= 2 ? ['Lined Coat'] : ['Armor Clothing'], ware: [], gear: [[commlink(Math.max(2, t)), null, 1], t >= 4 ? ['Power Focus', t >= 6 ? 3 : t >= 5 ? 2 : 1, 1] : null] }),
    group: (pick) => `Mage de combat ${pick(CORPS)}`,
    tactics: 'Reste à couvert, Éclair étourdissant sur la cible la plus dangereuse, Armure ou Barrière sur l’équipe. Contresort pour protéger ses alliés. Fuit si le Drain le met à genoux.',
  },
  {
    id: 'shaman', label: tk('Shaman / summoner'), icon: '☾', kind: 'metahuman', concept: 'Chaman', color: '#4fd17a', grunt: false, magic: 'magician',
    blurb: tk('Summons spirits of nature and man, heals and confounds.'),
    attrs: { WIL: 1, CHA: 2, INT: 1 },
    skills: [['summoning'], ['spellcasting', 'binding', 'assensing'], ['banishing', 'counterspelling', 'perception']],
    spells: ['Heal', 'Stunbolt', 'Detect Enemies', 'Physical Barrier', 'Confusion', 'Armor', 'Stunball', 'Mob Mind', 'Increase Reflexes', 'Manaball'],
    kit: (t, pick) => ({ weapons: [t >= 2 ? holdout(t, pick) : 'Knife'], armor: t >= 2 ? ['Lined Coat'] : ['Armor Clothing'], ware: [], gear: [[commlink(Math.max(1, t - 1)), null, 1], t >= 3 ? ['Summoning Focus', Math.min(4, t - 2), 1] : null] }),
    group: () => 'Chaman',
    spirit: true,
    tactics: 'Invoque un esprit dès le premier tour, puis l’envoie au contact (pouvoir Peur, Confusion, Accident). Garde ses distances et soigne ses alliés.',
  },
  {
    id: 'decker', label: tk('Decker'), icon: '⌨', kind: 'metahuman', concept: 'Decker', color: '#3fd6d0', grunt: false, matrix: 'deck',
    blurb: tk('Combat hacker or site spider, with cyberdeck and programs.'),
    attrs: { LOG: 2, INT: 1, STR: -1, BOD: -1 },
    skills: [['hacking', 'cybercombat'], ['electronic_warfare', 'computer'], ['software', 'pistols', 'perception']],
    kit: (t, pick) => ({ weapons: [holdout(t, pick)], armor: t >= 2 ? ['Armor Clothing'] : [], ware: t >= 2 ? [['cyberware', 'Datajack', null]] : [], gear: [] }),
    group: (pick) => `Spider ${pick(CORPS)}`,
    tactics: 'Reste en VR (hot sim à haut indice) : Brute force sur les smartguns et les commlinks, Data spike sur le persona du decker adverse, verrouille les portes et les caméras.',
  },
  {
    id: 'rigger', label: tk('Rigger'), icon: '⛟', kind: 'metahuman', concept: 'Rigger', color: '#5c9be0', grunt: false, matrix: 'rcc',
    blurb: tk('Drone pilot, fire support and surveillance.'),
    attrs: { REA: 2, LOG: 1, INT: 1 },
    skills: [['pilot_ground_craft', 'gunnery'], ['pilot_aircraft', 'perception'], ['automotive_mechanic', 'pistols', 'electronic_warfare']],
    kit: (t, pick) => ({
      weapons: [holdout(t, pick)],
      armor: t >= 2 ? ['Armor Clothing'] : [],
      ware: t >= 3 ? [['cyberware', 'Control Rig', t >= 6 ? 3 : t >= 5 ? 2 : 1]] : [['cyberware', 'Datajack', null]],
      gear: [],
      vehicles: t <= 1 ? ['MCT Fly-Spy (Minidrone)'] : t <= 2 ? ['MCT Fly-Spy (Minidrone)', 'Aztechnology Crawler (Small)'] : t <= 3 ? ['MCT Fly-Spy (Minidrone)', 'GM-Nissan Doberman (Medium)'] : t <= 4 ? ['GM-Nissan Doberman (Medium)', 'GM-Nissan Doberman (Medium)', 'Lockheed Optic-X2 (Small)'] : t <= 5 ? ['Steel Lynx Combat Drone (Large)', 'GM-Nissan Doberman (Medium)', 'Lockheed Optic-X2 (Small)'] : ['Steel Lynx Combat Drone (Large)', 'Steel Lynx Combat Drone (Large)', 'Cyberspace Designs Dalmatian (Large)'],
    }),
    group: (pick) => `Rigger ${pick(CORPS)}`,
    tactics: 'Reste en retrait dans un véhicule ou derrière un mur, les drones engagent (réserve d’attaque = Artillerie + Logique s’il est connecté, sinon Autopilote + autosoft). Le cramer = couper ses drones.',
  },
  {
    id: 'sniper', label: tk('Sniper'), icon: '⌖', kind: 'metahuman', concept: 'Tireur d’élite', color: '#e0468f', grunt: false,
    blurb: tk('Sniper rifle, patience and camouflage.'),
    attrs: { AGI: 2, INT: 1, WIL: 1 },
    skills: [['longarms'], ['perception', 'sneaking'], ['pistols', 'survival', 'gymnastics']],
    kit: (t, pick) => ({
      weapons: [t <= 2 ? 'Remington 990' : t <= 4 ? pick(['Ruger 101', 'Remington 990']) : t === 5 ? 'Ares Desert Strike' : 'Ranger Arms SM-5', heavyPistol(Math.max(2, t), pick)],
      armor: t >= 5 ? ['Chameleon Suit'] : t >= 3 ? ['Urban Explorer Jumpsuit'] : ['Armor Clothing'],
      ware: t >= 3 ? [['cyberware', 'Cybereyes Basic System', Math.min(4, t - 1)], ['cyberware', 'Smartlink', null], ...(t >= 5 ? [['cyberware', 'Reaction Enhancers', t - 4] as KitWare] : [])] : [],
      gear: [[commlink(Math.max(2, t)), null, 1], ['Binoculars', 3, 1]],
    }),
    group: () => 'Tireur d’élite',
    tactics: 'Position en hauteur à 200-500 m, vise d’abord le leader et le mage. Change de position après deux tirs. Se retire si on le repère.',
  },
  {
    id: 'face', label: tk('Face / negotiator'), icon: '☺', kind: 'metahuman', concept: 'Négociateur', color: '#e0468f', grunt: false,
    blurb: tk('Johnson, fixer, negotiator or manipulator.'),
    attrs: { CHA: 2, INT: 1, WIL: 1, BOD: -1 },
    skills: [['negotiation', 'con'], ['etiquette', 'intimidation', 'perception'], ['leadership', 'pistols', 'impersonation']],
    kit: (t, pick) => ({
      weapons: [t >= 2 ? holdout(t, pick) : 'Yamaha Pulsar'],
      armor: t >= 3 ? ['Actioneer Business Clothes'] : ['Armor Clothing'],
      ware: t >= 5 ? [['bioware', 'Tailored Pheromones', t - 4]] : [],
      gear: [[commlink(Math.max(3, t)), null, 1]],
    }),
    group: () => 'Négociateur',
    tactics: 'Ne se bat pas : parle, menace, achète. Toujours un garde du corps à portée et une sortie prévue.',
  },
  {
    id: 'bodyguard', label: tk('Bodyguard'), icon: '⛉', kind: 'metahuman', concept: 'Garde du corps', color: '#7c8b96', grunt: false,
    blurb: tk('Close protection, sticks to their principal.'),
    attrs: { BOD: 2, REA: 1, STR: 1, INT: 1 },
    skills: [['pistols', 'unarmed_combat'], ['perception', 'clubs'], ['pilot_ground_craft', 'first_aid', 'etiquette']],
    kit: (t, pick) => ({
      weapons: [heavyPistol(Math.max(2, t), pick), t >= 3 ? 'Stun Baton' : 'Extendable Baton', t >= 4 ? smg(t, pick) : null],
      armor: t >= 3 ? (t >= 5 ? ['Armor Jacket', 'Ballistic Shield'] : ['Armor Jacket']) : ['Armor Vest'],
      ware: t >= 5 ? [['bioware', 'Synaptic Booster', t - 4], ['cyberware', 'Dermal Plating', 2]] : t >= 3 ? [['cyberware', 'Smartlink', null], ['cyberware', 'Cybereyes Basic System', 1]] : [],
      gear: [[commlink(Math.max(2, t)), null, 1], ['Medkit', Math.min(6, Math.max(1, t)), 1]],
    }),
    group: () => 'Garde du corps',
    tactics: 'S’interpose, couvre le principal et l’évacue. Ne poursuit jamais : sa priorité est la survie du client.',
  },
  {
    id: 'cultist', label: tk('Toxic cultist'), icon: '☣', kind: 'metahuman', concept: 'Cultiste toxique', color: '#7cc04a', grunt: true, magic: 'magician',
    blurb: tk('Fanatic of a toxic mentor spirit, corrosive spells and polluted spirits.'),
    attrs: { WIL: 2, CHA: 1, LOG: -1 },
    skills: [['spellcasting', 'summoning'], ['clubs', 'intimidation'], ['assensing', 'sneaking', 'perception']],
    spells: ['Acid Stream', 'Stunbolt', 'Agony', 'Toxic Wave', 'Confusion', 'Manabolt', 'Physical Barrier'],
    kit: (t, pick) => ({ weapons: [melee(t, pick)], armor: t >= 2 ? ['Lined Coat'] : ['Armor Clothing'], ware: [], gear: [['Respirator', 2, 1]] }),
    group: (pick) => `Cultiste (${pick(CULTS)})`,
    spirit: true,
    toxic: true,
    tactics: 'Fanatiques : ne se rendent pas. Flot acide et Vague toxique sans souci des innocents, esprit toxique en appui.',
  },
  {
    id: 'civilian', label: tk('Civilian NPC'), icon: '☻', kind: 'metahuman', concept: 'Civil', color: '#a0aab4', grunt: true, disposition: 'neutral',
    blurb: tk('Passers-by, employees, witnesses: to populate a scene.'),
    attrs: { BOD: -1, AGI: -1, REA: -1 },
    skills: [['perception', 'etiquette'], ['computer', 'negotiation'], ['running', 'first_aid']],
    kit: (t, pick) => ({ weapons: [t >= 3 ? 'Colt America L36' : t >= 1 ? 'Yamaha Pulsar' : null], armor: t >= 2 ? ['Armor Clothing'] : [], ware: [], gear: [[commlink(Math.min(t + 1, 3)), null, 1]] }),
    group: (pick) => `Passant ${pick(DISTRICTS)}`,
    tactics: 'Se jette au sol, fuit, appelle Knight Errant (DocWagon s’il est blessé et abonné).',
  },
  // ---- Critters (SR5 core p.400-410 baselines; the tier makes juveniles (−) or pack alphas (+)).
  {
    id: 'hellhound', label: tk('Hell hound'), icon: '♨', kind: 'critter', concept: 'Créature éveillée (chien de l’enfer)', color: '#e05c5c', grunt: false,
    blurb: tk('Fire-breathing awakened dog, hunts in packs.'),
    critter: {
      attributes: { BOD: 6, AGI: 4, REA: 5, STR: 5, WIL: 3, LOG: 2, INT: 4, CHA: 3, EDG: 3, MAG: 5, ESS: 6 },
      initDice: 2,
      skills: [['unarmed_combat', 4], ['perception', 4], ['intimidation', 4], ['running', 4], ['tracking', 4], ['exotic_weapon', 4, 'Arme exotique (Souffle)']],
      weapons: [{ name: 'Morsure', kind: 'melee', skill: 'unarmed_combat', accuracy: 'Physical', damage: '(STR+2)P', ap: -1, reach: 0 }, { name: 'Souffle de feu', kind: 'ranged', skill: 'exotic_weapon', accuracy: 6, damage: '(MAG)P', ap: -1, notes: 'Attaque élémentaire (feu), portée MAG×5 m' }],
      powers: ['Double nature', 'Sens améliorés (ouïe, odorat, vision nocturne)', 'Aura énergétique (feu)', 'Peur', 'Attaque élémentaire (feu)', 'Arme naturelle (morsure)', 'Immunité (feu)'],
      weaknesses: ['Allergie (eau, légère)'],
      armor: 0,
      vision: { lowLight: true },
    },
    group: () => 'Molosse infernal',
    tactics: 'Chassent en meute : deux fixent la proie avec Peur, les autres crachent le feu. Fuient l’eau et les esprits de l’eau.',
  },
  {
    id: 'devilrat', label: tk('Devil rat'), icon: '🐀', kind: 'critter', concept: 'Créature éveillée (rat du diable)', color: '#8a6d4a', grunt: true,
    blurb: tk('Awakened sewer rats, swarming, disease carriers.'),
    critter: {
      attributes: { BOD: 1, AGI: 4, REA: 4, STR: 0, WIL: 2, LOG: 1, INT: 4, CHA: 2, EDG: 2, MAG: 2, ESS: 6 },
      initDice: 1,
      skills: [['unarmed_combat', 3], ['perception', 4], ['sneaking', 5], ['gymnastics', 3]],
      weapons: [{ name: 'Morsure', kind: 'melee', skill: 'unarmed_combat', accuracy: 'Physical', damage: '2P', ap: 0, reach: -1, notes: 'Risque de maladie (Résistance aux pathogènes)' }],
      powers: ['Contrôle animal (rats)', 'Dissimulation (soi)', 'Sens améliorés (odorat, vision nocturne)', 'Immunité (pathogènes, toxines)', 'Arme naturelle (morsure)'],
      weaknesses: ['Allergie (lumière du soleil, légère)'],
      armor: 0,
      vision: { lowLight: true },
    },
    group: () => 'Rat du diable',
    tactics: 'Surgissent de partout en essaim, harcèlent et mordent, appellent les rats ordinaires. Se dispersent à la lumière vive.',
  },
  {
    id: 'ghoul', label: tk('Ghoul'), icon: '☠', kind: 'critter', concept: 'Métahumain infecté (goule)', color: '#6b8e7a', grunt: true, metaFrom: true,
    blurb: tk('Metahumans infected with HMHVV, blind but fearsome.'),
    critter: {
      attributes: { BOD: 7, AGI: 4, REA: 4, STR: 6, WIL: 3, LOG: 2, INT: 4, CHA: 1, EDG: 2, MAG: 2, ESS: 5 },
      initDice: 1,
      skills: [['unarmed_combat', 4], ['perception', 3], ['sneaking', 4], ['assensing', 3], ['clubs', 2]],
      weapons: [{ name: 'Griffes', kind: 'melee', skill: 'unarmed_combat', accuracy: 'Physical', damage: '(STR+1)P', ap: -1, reach: 0 }],
      powers: ['Double nature', 'Sens améliorés (ouïe, odorat)', 'Arme naturelle (griffes)', 'Sapience', 'Armure 1'],
      weaknesses: ['Allergie (lumière du soleil, légère)', 'Besoin alimentaire (chair métahumaine)', 'Sens réduits (aveugle)'],
      armor: 1,
      vision: {},
    },
    group: () => 'Goule',
    tactics: 'Embuscades dans le noir, attaquent les blessés et les isolés. Certaines goules sapientes négocient (Ghoul Rights).',
  },
];
export const ARCHETYPE_BY_ID: Record<string, Archetype> = Object.fromEntries(ARCHETYPES.map((a) => [a.id, a]));

// ---------------------------------------------------------------------------
// RNG (mulberry32) — deterministic per seed
// ---------------------------------------------------------------------------
export function rng(seed: unknown): () => number {
  let a = (Number(seed) >>> 0) || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const picker = (r: () => number): Picker => (arr) => arr[Math.floor(r() * arr.length) % arr.length];
export function randomSeed(): number {
  return Math.floor(Math.random() * 2 ** 31);
}

/** Street name for an archetype (French / international, Seattle flavour). */
export function makeName(archetypeId: string, seed: unknown, { lieutenant = false }: { lieutenant?: boolean } = {}): string {
  const r = rng((Number(seed) || 0) ^ 0x51ed);
  const pick = picker(r);
  const nick = pick(NICKS);
  const first = pick(FIRST);
  const last = pick(LAST);
  const district = pick(DISTRICTS);
  switch (archetypeId) {
    case 'corpsec':
      return `${lieutenant ? 'Chef d’équipe' : pick(['Agent', 'Garde'])} ${last}`;
    case 'police':
      return `${lieutenant ? 'Sergent' : pick(['Officier', 'Agent'])} ${last}`;
    case 'civilian':
      return `${first} ${last}`;
    case 'face':
      return pick([`M. ${last}`, `Mme ${last}`, `${first} « ${nick} » ${last}`]);
    case 'hellhound':
    case 'devilrat':
    case 'ghoul': {
      const a = ARCHETYPE_BY_ID[archetypeId];
      return lieutenant ? `${a.label} alpha` : `${a.label} ${district}`;
    }
    default:
      return pick([nick, `${nick} ${district}`, `${first} « ${nick} » ${last}`]);
  }
}

// ---------------------------------------------------------------------------
// Generator
// ---------------------------------------------------------------------------
const clampN = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
const round3 = (n: number): number => Math.round(n * 1000) / 1000;

function catalogWeapon(item: CatalogItem, id: string, extra: Partial<Weapon> = {}): Weapon {
  const st = (item.stats || {}) as Partial<CatalogWeaponProfile> & { weapon?: CatalogWeaponProfile };
  const w = st.weapon && !st.type ? st.weapon : st;
  return {
    id,
    name: item.nameFr || item.name,
    category: item.categoryFr || item.category || '',
    kind: w.type === 'melee' ? 'melee' : 'ranged',
    skill: w.skill || (w.type === 'melee' ? 'clubs' : 'pistols'),
    accuracy: w.accuracy === 'Physical' ? '' : w.accuracy ?? '', // '' = physical limit (stat block)
    damage: w.damage || '',
    ap: w.ap ?? 0,
    mode: w.mode || '',
    rc: w.rc ?? 0,
    ammo: w.ammo || '',
    reach: w.reach || 0,
    catalogId: item.id,
    ...extra,
  };
}

function evalAt(rules: NonNullable<NpcgenCtx['rules']>, f: Formula | null | undefined, rating?: number | null): number {
  if (typeof f === 'number') return f;
  try {
    // A missing evalFormula throws here: 0, like an unparsable formula.
    return Math.round(rules.evalFormula!(f as string, { Rating: rating ?? 1 }));
  } catch {
    return 0;
  }
}

/**
 * Generate one template. opts: { archetype, tier (0-6), metatype ('random'|name), seed, lieutenant?, grunt?, name? }
 * ctx: { find(file, name), rules: { quote, evalFormula } }. Returns a Template object (not stored).
 */
export function generate(opts: GenerateOptions = {}, ctx: NpcgenCtx = {}): GeneratedTemplate {
  const a = ARCHETYPE_BY_ID[opts.archetype as string] || ARCHETYPES[0];
  const lieutenant = !!opts.lieutenant;
  const prTier = clampN(Math.round(Number(opts.tier) || 0), 0, 6);
  const t = lieutenant ? Math.min(6, prTier + 1) : prTier; // stats tier
  const pr = lieutenant ? Math.min(7, prTier + 1) : prTier;
  const seed = (Number(opts.seed) >>> 0) || 1;
  const r = rng(seed * 7 + (lieutenant ? 101 : 0));
  const pick = picker(r);
  const find: Finder = ctx.find || (() => null);
  const rules = ctx.rules || {};
  const isGrunt = !!(opts.grunt ?? a.grunt) && !lieutenant;
  let n = 0;
  const id = (p: string) => `${p}${++n}`;

  // Metatype (stays as given — even undefined — for a ghoul without one)
  let metatype = opts.metatype as string;
  if (a.kind === 'critter' && !a.metaFrom) metatype = 'Créature';
  else if (!METATYPES[metatype]) {
    let roll = r() * 100;
    metatype = 'Humain';
    for (const [m, w] of META_WEIGHTS) {
      if ((roll -= w) < 0) {
        metatype = m;
        break;
      }
    }
  }
  const tpl: GeneratedTemplate = {
    name: opts.name ? String(opts.name).slice(0, 120) : makeName(a.id, seed, { lieutenant }),
    folder: GENERATED_FOLDER,
    metatype,
    concept: `${a.concept}${lieutenant ? ' (lieutenant)' : ''}`,
    color: a.color,
    disposition: a.disposition || 'hostile',
    attributes: {} as Attributes, // filled by buildMetahuman / buildCritter
    augmented: {},
    initiative: { dice: 1, bonus: 0 },
    skills: [],
    knowledge: [],
    qualities: [],
    powers: [],
    spells: [],
    weapons: [],
    armor: [],
    augmentations: [],
    gear: [],
    vehicles: [],
    vision: {},
    npc: { professionalRating: pr, grunt: isGrunt, kind: a.kind === 'critter' ? 'critter' : 'metahuman', initMode: 'physical', tactics: '', loot: '' },
    tags: ['généré', a.id, `PR ${pr}`],
    genArchetype: a.id,
    genTier: prTier,
    genSeed: seed,
    genLieutenant: lieutenant,
  };

  if (a.kind === 'critter') buildCritter(tpl, a, t, metatype, id, r);
  else buildMetahuman(tpl, a, t, metatype, id, pick, r, find, rules, lieutenant);

  // Grunt single condition monitor / lieutenant Edge
  const bod = attr(tpl, 'BOD');
  if (isGrunt) {
    tpl.monitors = { physical: 8 + Math.ceil(bod / 2), stun: 0 };
  }
  if (lieutenant) tpl.attributes.EDG = Math.max(tpl.attributes.EDG || 1, Math.min(7, 2 + Math.ceil(pr / 2)));

  // Texts
  const desc: string[] = [];
  desc.push(`**PR ${pr} — ${TIERS[Math.min(6, pr)].label}.** ${TIERS[Math.min(6, pr)].text}`);
  if (a.blurb) desc.push(a.blurb);
  if (isGrunt) desc.push(GRUNT_RULES);
  if (lieutenant) desc.push(`Lieutenant d’un groupe de sbires PR ${prTier} : stats d’un PR ${t}, Chance ${tpl.attributes.EDG}, moniteurs complets.`);
  if (a.spirit) {
    const force = Math.max(1, tpl.attributes.MAG || 1);
    desc.push(a.toxic
      ? `Peut invoquer un **esprit toxique** de Force ${force} (esprit des boues ou de la peste) : Invocation ${skillRating(tpl, 'summoning')} + Magie contre Force.`
      : `Peut invoquer un **esprit** de Force ${force} (esprit de l’homme, de la bête ou des éléments selon la tradition) : Invocation ${skillRating(tpl, 'summoning')} + Magie contre Force ; services ≈ succès nets.`);
  }
  tpl.description = desc.join('\n\n');
  tpl.npc.tactics = a.tactics || '';
  tpl.npc.loot = a.kind === 'critter'
    ? (a.id === 'hellhound' ? 'Peau et glandes ignifuges (réactifs, ~500¥ chez le bon alchimiste).' : '—')
    : `Créditube : ${Math.max(1, t)}D6 × ${[5, 10, 20, 50, 100, 200, 500][t]}¥. ${tpl.gear.length ? 'Équipement porté.' : ''}`.trim();
  tpl.unitName = a.group ? a.group(pick) : a.label;
  return tpl;
}

function skillRating(tpl: GeneratedTemplate, sid: string): number {
  return tpl.skills.find((s) => s.id === sid)?.rating || 0;
}

function addSkill(tpl: GeneratedTemplate, sid: string, rating: number, extra: Partial<Skill> = {}): void {
  const def = SKILL_BY_ID[sid];
  if (!def || rating < 1) return;
  const have = tpl.skills.find((s) => s.id === sid);
  if (have) {
    have.rating = Math.max(have.rating, rating);
    return;
  }
  const s: Skill = { id: sid, name: def.fr, attr: def.attr, rating };
  if (def.group) s.group = def.group;
  Object.assign(s, extra);
  tpl.skills.push(s);
}

function buildMetahuman(
  tpl: GeneratedTemplate,
  a: MetahumanArchetype,
  t: number,
  metatype: string,
  id: (p: string) => string,
  pick: Picker,
  r: () => number,
  find: Finder,
  rules: NonNullable<NpcgenCtx['rules']>,
  lieutenant: boolean,
): void {
  const max = METATYPES[metatype].max;
  const min = METATYPE_MIN[metatype];
  const adj = META_ADJ[metatype] || {};
  for (const k of CORE) {
    const jitter = r() < 0.25 ? (r() < 0.5 ? -1 : 1) : 0;
    const v = BASE_ATTR[t] + (a.attrs[k] || 0) + (adj[k] || 0) + jitter;
    tpl.attributes[k] = clampN(v, min[k], max[k]);
  }
  tpl.attributes.EDG = clampN(1 + Math.floor(t / 3) + (lieutenant ? 1 : 0), min.EDG, max.EDG);
  tpl.attributes.ESS = 6;
  if (a.magic) tpl.attributes.MAG = clampN([1, 2, 3, 4, 5, 6, 6][t] + (t >= 6 ? 1 : 0), 1, 7);
  const vis = METATYPES[metatype].vision || {};
  if (vis.lowLight) tpl.vision.lowLight = true;
  if (vis.thermo) tpl.vision.thermo = true;

  // Skills (SR5 sample grunts: primary ≈ tier table, secondary −1, tertiary −2)
  const top = SKILL_TOP[t];
  const [prim, sec, ter] = a.skills;
  for (const s of prim) addSkill(tpl, s, top);
  for (const s of sec) addSkill(tpl, s, top - 1);
  for (const s of ter) addSkill(tpl, s, top - 2);
  if (t >= 4 && prim[0]) {
    const spec = ({ pistols: 'Semi-automatiques', automatics: 'Fusils d’assaut', longarms: 'Fusils de précision', spellcasting: 'Combat', summoning: 'Esprits de l’homme', hacking: 'Appareils', negotiation: 'Marchandage', clubs: 'Matraques', pilot_ground_craft: 'Drones à roues', unarmed_combat: 'Arts martiaux' } as Record<string, string>)[prim[0]];
    const sk = tpl.skills.find((s) => s.id === prim[0]);
    if (sk && spec) sk.spec = spec;
  }

  // Kit
  const kit: Kit = a.kit(t, pick) || {};
  const ess = { total: 0 };
  for (const wname of (kit.weapons || []).filter((w): w is string => !!w)) {
    const item = find('weapons', wname);
    if (!item) continue;
    const w = catalogWeapon(item, id('w'));
    tpl.weapons.push(w);
    if (!tpl.skills.some((s) => s.id === w.skill)) addSkill(tpl, w.skill, Math.max(1, top - 2));
  }
  for (const aname of kit.armor || []) {
    const item = find('armor', aname);
    if (!item) continue;
    const st = (item.stats || {}) as { armor?: Formula; stack?: boolean };
    const row: Armor = { id: id('a'), name: item.nameFr || item.name, rating: evalAt(rules, st.armor ?? 0, 1), equipped: true, catalogId: item.id };
    if (st.stack) row.stack = true;
    tpl.armor.push(row);
  }
  const grade = GRADE_BY_TIER(t);
  for (const [file, wname, rating] of kit.ware || []) {
    const item = find(file, wname);
    if (!item) continue;
    const allowed = Array.isArray(item.grades) ? item.grades : null;
    const g = allowed && !allowed.includes(grade) ? 'standard' : grade;
    const q: { rating: number | null; grade: WareGrade | null; essence?: number } = rules.quote ? rules.quote(item, { rating, grade: g }) : { rating, grade: g, essence: Number(item.essence) || 0 };
    // 'ware stats; `bonus.armor` = Dermal Plating's armor (data/catalog/cyberware.json).
    const st = (item.stats || {}) as { kind?: WareKind; bonus?: CatalogBonus & { armor?: Formula }; weapon?: CatalogWeaponProfile };
    const aug: Augmentation = { id: id('x'), name: item.nameFr || item.name, kind: st.kind || (file === 'bioware' ? 'bioware' : 'cyberware'), grade: q.grade || g, essence: q.essence || 0, catalogId: item.id };
    if (q.rating) aug.rating = q.rating;
    ess.total += aug.essence;
    // Catalog effects (initiative score of Move-by-Wire…) else stats.bonus; recorded on aug.bonus (shared/modifiers.js « baked »).
    const eff = Array.isArray(item.effects) ? bonusFromEffects(item.effects, aug) : null;
    const bonus: (CatalogBonus & { armor?: Formula }) | undefined = eff ? { ...eff, ...(st.bonus?.armor ? { armor: st.bonus.armor } : {}) } : st.bonus;
    if (bonus) {
      const applied: ItemBonus = {};
      for (const [key, f] of Object.entries(bonus.attributes || {})) {
        const k = key as AttrKey;
        const v = evalAt(rules, f, q.rating);
        if (!v) continue;
        tpl.augmented[k] = (tpl.augmented[k] || 0) + v;
        (applied.attributes = applied.attributes || {})[k] = v;
      }
      if (bonus.initiativeDice) {
        const v = evalAt(rules, bonus.initiativeDice, q.rating);
        if (v) {
          tpl.initiative.dice = clampN(tpl.initiative.dice + v, 1, 5);
          applied.initiativeDice = v;
        }
      }
      if (bonus.initiative) {
        const v = evalAt(rules, bonus.initiative, q.rating);
        if (v) {
          tpl.initiative.bonus = (Number(tpl.initiative.bonus) || 0) + v;
          applied.initiative = v;
        }
      }
      if (Object.keys(applied).length) aug.bonus = applied;
      if (bonus.armor) aug.notes = `Armure +${bonus.armor}`;
    }
    if (st.weapon) tpl.weapons.push(catalogWeapon({ ...item, stats: { weapon: st.weapon } }, id('w'), { augId: aug.id }));
    if (/Dermal Plating/.test(item.name) && q.rating) tpl.armor.push({ id: id('a'), name: `${item.nameFr || item.name} ${q.rating}`, rating: q.rating, equipped: true, stack: true, notes: 'Implant' });
    if (/Smartlink/.test(item.name)) aug.notes = 'Précision +2 avec une arme smart';
    tpl.augmentations.push(aug);
  }
  for (const k of Object.keys(tpl.augmented) as AttrKey[]) tpl.augmented[k] = Math.min(4, tpl.augmented[k] as number);
  tpl.attributes.ESS = round3(Math.max(0.1, 6 - ess.total));
  if (tpl.attributes.MAG) tpl.attributes.MAG = Math.max(1, tpl.attributes.MAG - Math.ceil(6 - tpl.attributes.ESS - 1e-9));
  if ((kit.ware || []).some(([, nm]) => nm === 'Cybereyes Basic System')) {
    tpl.vision.lowLight = true;
    if (t >= 4) tpl.vision.thermo = true;
  }

  // Gear
  for (const g of (kit.gear || []).filter((x): x is KitGear => !!x)) {
    const [gname, rating, qty] = g;
    const item = find('gear', gname);
    if (!item) continue;
    const st = (item.stats || {}) as { weapon?: CatalogWeaponProfile };
    if (st.weapon) {
      const w = catalogWeapon(item, id('w'), { notes: `×${qty || 1}` });
      tpl.weapons.push(w);
      if (!tpl.skills.some((s) => s.id === w.skill)) addSkill(tpl, w.skill, Math.max(1, top - 2));
      continue;
    }
    const row: Gear = { id: id('g'), name: item.nameFr || item.name, category: item.categoryFr || item.category || '', qty: qty || 1, catalogId: item.id };
    if (rating) row.rating = rating;
    tpl.gear.push(row);
  }

  // Magic
  if (a.spells && tpl.attributes.MAG) {
    const count = Math.min(a.spells.length, [1, 2, 3, 4, 6, 8, 10][t]);
    for (const sname of a.spells.slice(0, count)) {
      const item = find('spells', sname);
      if (!item) continue;
      const st = (item.stats || {}) as Partial<SpellStats>;
      tpl.spells.push({ id: id('s'), name: item.nameFr || item.name, category: item.categoryFr || item.category || '', type: st.type || '', range: st.range || '', duration: st.duration || '', drain: st.dv || '', catalogId: item.id });
    }
    tpl.qualities.push({ id: id('q'), name: 'Magicien', karma: 0, positive: true, notes: a.toxic ? 'Tradition toxique' : a.id === 'shaman' ? 'Tradition chamanique' : 'Tradition hermétique' });
    if (a.toxic) tpl.qualities.push({ id: id('q'), name: 'Mentor toxique', karma: 0, positive: false, notes: 'Fanatisme : ne se rend jamais' });
    tpl.npc.initMode = 'physical';
  }

  // Matrix
  if (a.matrix === 'deck') {
    const deck = ['Erika MCD-1', 'Erika MCD-1', 'Microdeck Summit', 'Hermes Chariot', 'Novatech Navigator', 'Sony CIY-720', 'Shiawase Cyber-5'][t];
    const item = find('gear', deck);
    const st = (item?.stats || {}) as { attributeArray?: number[]; deviceRating?: Formula };
    const arr = Array.isArray(st.attributeArray) ? [...st.attributeArray] : [4, 3, 2, 1];
    const progs = ['Navigateur', 'Configurateur', 'Édition', 'Gommage de bruit', 'Boîte à outils', 'Armure', 'Filtre de biofeedback', 'Exploitation', 'Furtivité', 'Marteau', 'Verrouillage', 'Fork', 'Décryptage', 'Biofeedback'].slice(0, 2 + t * 2);
    tpl.matrix = { device: item ? item.nameFr || item.name : deck, rating: Number(st.deviceRating) || 1, attack: arr[0], sleaze: arr[1], dataProcessing: arr[2], firewall: arr[3], programs: progs };
    if (item) tpl.gear.push({ id: id('g'), name: item.nameFr || item.name, category: item.categoryFr || item.category || '', qty: 1, catalogId: item.id });
    tpl.npc.initMode = t >= 4 ? 'hot' : 'cold';
  } else if (a.matrix === 'rcc') {
    const rcc = ['Scratch-Built Junk', 'Scratch-Built Junk', 'Radio Shack Remote Controller', 'Essy Motors DroneMaster', 'Maersk Spider', 'Vulcan Liegelord', 'Proteus Poseidon'][t];
    const item = find('gear', rcc);
    const st = (item?.stats || {}) as { deviceRating?: Formula; dataProcessing?: number; firewall?: number };
    tpl.matrix = { device: item ? item.nameFr || item.name : rcc, rating: Number(st.deviceRating) || 1, attack: 0, sleaze: 0, dataProcessing: Number(st.dataProcessing) || 1, firewall: Number(st.firewall) || 1, programs: ['Autosoft Ciblage (arme)', 'Autosoft Manœuvre', 'Autosoft Évasion'].slice(0, 1 + Math.floor(t / 2)) };
    if (item) tpl.gear.push({ id: id('g'), name: item.nameFr || item.name, category: item.categoryFr || item.category || '', qty: 1, catalogId: item.id });
  }
  for (const vname of kit.vehicles || []) {
    const item = find('vehicles', vname);
    if (!item) continue;
    const st = (item.stats || {}) as Partial<VehicleStats>;
    tpl.vehicles.push({ id: id('v'), name: item.nameFr || item.name, handling: st.handling ?? 0, speed: st.speed ?? 0, accel: st.accel ?? 0, body: st.body ?? 0, armor: st.armor ?? 0, pilot: st.pilot ?? 0, sensor: st.sensor ?? 0, notes: item.categoryFr || item.category || '', catalogId: item.id });
  }

  // Knowledge
  const k = ({ ganger: 'Territoire du gang', corpsec: 'Procédures de sécurité', police: 'Procédures policières', merc: 'Tactiques militaires', mage: 'Théorie magique', shaman: 'Esprits', decker: 'Sécurité matricielle', rigger: 'Modèles de drones', sniper: 'Balistique', face: 'Politique corporatiste', bodyguard: 'Protocoles de protection', cultist: 'Doctrine du culte', civilian: 'Métier' } as Record<string, string>)[a.id];
  if (k) tpl.knowledge.push({ id: id('k'), name: k, rating: Math.max(1, top - 1), type: 'professional' });
  tpl.knowledge.push({ id: id('k'), name: 'Seattle (rue)', rating: Math.max(1, Math.ceil(t / 2) + 1), type: 'street' });
  tpl.knowledge.push({ id: id('k'), name: pick(['Anglais', 'Français', 'Espagnol', 'Japonais', 'Sperethiel', 'Or’zet', 'Salish']), rating: 0, type: 'language', native: true });
}

function buildCritter(tpl: GeneratedTemplate, a: CritterArchetype, t: number, metatype: string, id: (p: string) => string, r: () => number): void {
  const c = a.critter;
  const delta = t <= 1 ? -1 : t <= 3 ? 0 : t <= 5 ? 1 : 2;
  for (const [k, v] of Object.entries(c.attributes)) {
    if (k === 'ESS') tpl.attributes.ESS = v;
    else if (['BOD', 'AGI', 'REA', 'STR'].includes(k)) tpl.attributes[k as AttrKey] = Math.max(k === 'STR' ? 0 : 1, v + delta);
    else if (k === 'MAG') tpl.attributes.MAG = Math.max(1, v + Math.max(0, delta));
    else tpl.attributes[k as AttrKey] = v;
  }
  if (a.metaFrom && METATYPES[metatype]) {
    // Ghouls keep their metatype's frame (clamped to the metatype limits).
    const max = METATYPES[metatype].max;
    const min = METATYPE_MIN[metatype];
    const adj = META_ADJ[metatype] || {};
    for (const k of CORE) tpl.attributes[k] = clampN((tpl.attributes[k] || 1) + (adj[k] || 0), min[k], max[k]);
    tpl.attributes.EDG = clampN(tpl.attributes.EDG || 1, min.EDG, max.EDG);
  }
  tpl.initiative.dice = c.initDice + (delta >= 2 ? 1 : 0);
  for (const [sid, rating, name] of c.skills) addSkill(tpl, sid, Math.max(1, rating + delta), name ? { name } : {});
  for (const w of c.weapons) tpl.weapons.push({ id: id('w'), category: 'Arme naturelle', mode: '', rc: 0, ammo: '', reach: 0, ...w });
  // Critter powers have no Power Point cost.
  for (const p of c.powers) tpl.powers.push({ id: id('p'), name: p } as AdeptPower);
  for (const w of c.weaknesses) tpl.qualities.push({ id: id('q'), name: w, karma: 0, positive: false, notes: 'Faiblesse' });
  if (c.armor) tpl.armor.push({ id: id('a'), name: 'Armure naturelle', rating: c.armor, equipped: true, stack: true });
  Object.assign(tpl.vision, c.vision || {});
  if (t >= 5) tpl.concept += t >= 6 ? ' — alpha de meute' : ' — adulte robuste';
  else if (t <= 1) tpl.concept += ' — jeune';
  void r;
}

/**
 * A full encounter: { main, lieutenant } (lieutenant only when asked and the group is a grunt group).
 * opts as generate() plus { lieutenant: bool }.
 */
export function generateEncounter(opts: GenerateOptions = {}, ctx: NpcgenCtx = {}): { main: GeneratedTemplate; lieutenant: GeneratedTemplate | null } {
  const main = generate({ ...opts, lieutenant: false }, ctx);
  const lieutenant = opts.lieutenant ? generate({ ...opts, lieutenant: true, name: undefined }, ctx) : null;
  return { main, lieutenant };
}

/** Every catalog reference the generator may use: [{ file, name }] (for tests and diagnostics). */
export function catalogRefs(): Array<{ file: CatalogFile; name: string }> {
  const out = new Map<string, { file: CatalogFile; name: string }>();
  const add = (file: CatalogFile, name: string | null) => name && out.set(`${file}:${name}`, { file, name });
  for (const a of ARCHETYPES) {
    if (a.kind === 'critter') continue;
    for (let t = 0; t <= 6; t++) {
      for (let s = 0; s < 12; s++) {
        const r = rng(s * 31 + t + 1);
        const kit: Kit = a.kit(t, picker(r)) || {};

        for (const w of kit.weapons || []) add('weapons', w);
        for (const x of kit.armor || []) add('armor', x);
        for (const [file, n] of kit.ware || []) add(file, n);
        for (const g of kit.gear || []) if (g) add('gear', g[0]);
        for (const v of kit.vehicles || []) add('vehicles', v);
      }
    }
    for (const s of a.spells || []) add('spells', s);
  }
  for (const d of ['Erika MCD-1', 'Microdeck Summit', 'Hermes Chariot', 'Novatech Navigator', 'Sony CIY-720', 'Shiawase Cyber-5', 'Scratch-Built Junk', 'Radio Shack Remote Controller', 'Essy Motors DroneMaster', 'Maersk Spider', 'Vulcan Liegelord', 'Proteus Poseidon']) add('gear', d);
  return [...out.values()];
}
