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
import { attr, derive, SKILL_BY_ID } from './sr5.js';

// i18n: French labels are dictionary keys (client/i18n/en/matrix.json). tk() marks them for tools/i18n-check.js;
// the UI renders t(label). Dynamic texts (pool parts, reasons) carry { key, params } next to their French `label`.
const tk = (s) => s;
const fill = (s, p) => (p ? String(s).replace(/\{(\w+)\}/g, (m, k) => (p[k] === undefined ? m : p[k] && typeof p[k] === 'object' ? fill(p[k].t, p[k].params) : String(p[k]))) : s);
/** Pool / limit part: French `label` + translatable `key`/`params`. */
const part = (key, value, params) => ({ label: fill(key, params), key, ...(params ? { params } : {}), value });

export const OS_MAX = 40;
export const CONVERGENCE_DV = 12;
export const DUMPSHOCK_DV = 6;
export const HOT_SIM_BONUS = 2;
export const MAX_MARKS = 3;
/** Extra marks requested on Hack on the Fly / Brute Force: 1 mark → 0, 2 marks → −4, 3 marks → −10 (SR5 p. 238). */
export const MARK_PENALTY = { 1: 0, 2: -4, 3: -10 };

export const ASDF = ['attack', 'sleaze', 'dataProcessing', 'firewall'];
export const ASDF_LABELS = { attack: tk('Attaque'), sleaze: tk('Corruption'), dataProcessing: tk('Traitement'), firewall: tk('Firewall') };
export const ASDF_SHORT = { attack: 'A', sleaze: 'C', dataProcessing: 'T', firewall: 'F' };
export const ASDF_EN = { attack: 'Attack', sleaze: 'Sleaze', dataProcessing: 'Data Processing', firewall: 'Firewall' };
/** One-letter slot names in English (A/S/D/F). */
export const ASDF_SHORT_EN = { attack: 'A', sleaze: 'S', dataProcessing: 'D', firewall: 'F' };

export const MODES = ['ar', 'cold', 'hot'];
export const MODE_LABELS = { ar: tk('RA'), cold: tk('RV froide'), hot: tk('RV chaude') };

const MENTAL_LABEL = { INT: tk('Intuition'), WIL: tk('Volonté'), LOG: tk('Logique') };

/**
 * Matrix actions. cat: attack | sleaze (illegal, raise the Overwatch Score) | info | control | util.
 * skill/attr/limit = the decker's test. defense: [mental attribute, matrix attribute] (opposed test),
 * or { fixed: n } (GOD: 6 dice), or { x2: 'protection'|'bomb'|'device' } (rating × 2), or null (no opposition).
 * marks = marks required on the target (0 = none). targets = allowed target kinds
 * ('host'|'ic'|'device'|'file'|'persona'|'manual'|'markOnMe'|'none').
 */
export const ACTIONS = [
  // --- Illegal: Attack actions
  { id: 'bruteForce', fr: tk('Force brute'), en: 'Brute Force', cat: 'attack', type: 'complex', skill: 'cybercombat', attr: 'LOG', limit: 'attack', defense: ['WIL', 'firewall'], marks: 0, placesMarks: true, targets: ['host', 'ic', 'device', 'file', 'persona', 'manual'], page: 238,
    desc: tk('Place des marques en force (1 marque, ou 2 à −4, 3 à −10). Chaque tranche de 2 succès nets inflige aussi 1 case de dommages matriciels. Échec : vous subissez 1 case par succès net du défenseur.') },
  { id: 'dataSpike', fr: tk('Pointe de données'), en: 'Data Spike', cat: 'attack', type: 'complex', skill: 'cybercombat', attr: 'LOG', limit: 'attack', defense: ['INT', 'firewall'], marks: 0, targets: ['ic', 'device', 'persona', 'manual'], page: 240,
    desc: tk('Attaque matricielle : VD = Attaque + succès nets + 2 par marque sur la cible, résistée par Indice + Firewall.') },
  { id: 'crashProgram', fr: tk('Planter un programme'), en: 'Crash Program', cat: 'attack', type: 'complex', skill: 'cybercombat', attr: 'LOG', limit: 'attack', defense: ['INT', 'firewall'], marks: 1, targets: ['persona', 'manual'], page: 239,
    desc: tk('Fait planter un programme chargé sur la cible (au choix du hacker).') },
  { id: 'crackFile', fr: tk('Craquer un fichier'), en: 'Crack File', cat: 'attack', type: 'complex', skill: 'hacking', attr: 'LOG', limit: 'attack', defense: { x2: 'protection' }, marks: 1, targets: ['file'], page: 239,
    desc: tk('Supprime la protection d’un fichier (défense : indice de protection × 2).') },
  { id: 'eraseMark', fr: tk('Effacer une marque'), en: 'Erase Mark', cat: 'attack', type: 'complex', skill: 'computer', attr: 'LOG', limit: 'attack', defense: ['WIL', 'firewall'], marks: 0, targets: ['markOnMe'], page: 240,
    desc: tk('Efface une marque qu’une autre icône a posée sur vous (défense de l’icône propriétaire de la marque).') },
  { id: 'jamSignals', fr: tk('Brouiller les signaux'), en: 'Jam Signals', cat: 'attack', type: 'complex', skill: 'electronic_warfare', attr: 'LOG', limit: 'attack', defense: null, marks: 0, targets: ['none'], page: 241,
    desc: tk('Chaque succès ajoute 1 point de bruit pour tout le monde dans 100 m (vous compris, sauf vos appareils).') },
  // --- Illegal: Sleaze actions
  { id: 'hackOnTheFly', fr: tk('Hacker à la volée'), en: 'Hack on the Fly', cat: 'sleaze', type: 'complex', skill: 'hacking', attr: 'LOG', limit: 'sleaze', defense: ['INT', 'firewall'], marks: 0, placesMarks: true, targets: ['host', 'ic', 'device', 'file', 'persona', 'manual'], page: 240,
    desc: tk('Place des marques en douce (1 marque, ou 2 à −4, 3 à −10). Échec : la cible vous marque et l’hôte passe en alerte.') },
  { id: 'spoofCommand', fr: tk('Usurper une commande'), en: 'Spoof Command', cat: 'sleaze', type: 'complex', skill: 'hacking', attr: 'INT', limit: 'sleaze', defense: ['LOG', 'firewall'], marks: 1, marksOnOwner: true, targets: ['device', 'manual'], page: 243,
    desc: tk('Envoie à un appareil un ordre qui semble venir de son propriétaire (il faut 1 marque sur le propriétaire usurpé).') },
  { id: 'snoop', fr: tk('Espionner'), en: 'Snoop', cat: 'sleaze', type: 'complex', skill: 'electronic_warfare', attr: 'INT', limit: 'sleaze', defense: ['LOG', 'firewall'], marks: 1, targets: ['device', 'persona', 'manual'], page: 243,
    desc: tk('Intercepte le trafic de la cible (communications, flux de données).') },
  { id: 'hide', fr: tk('Se cacher'), en: 'Hide', cat: 'sleaze', type: 'complex', skill: 'electronic_warfare', attr: 'INT', limit: 'sleaze', defense: ['INT', 'dataProcessing'], marks: 0, targets: ['host', 'ic', 'persona', 'manual'], page: 241,
    desc: tk('La cible perd votre trace (une IC de patrouille ne vous voit plus).') },
  { id: 'formatDevice', fr: tk('Formater un appareil'), en: 'Format Device', cat: 'sleaze', type: 'complex', skill: 'computer', attr: 'LOG', limit: 'sleaze', defense: ['WIL', 'firewall'], marks: 3, targets: ['device', 'persona', 'manual'], page: 240,
    desc: tk('Efface le système de l’appareil : au prochain redémarrage, il ne fonctionne plus.') },
  { id: 'setDataBomb', fr: tk('Poser une bombe de données'), en: 'Set Data Bomb', cat: 'sleaze', type: 'complex', skill: 'software', attr: 'LOG', limit: 'sleaze', defense: { x2: 'device' }, marks: 1, targets: ['file'], page: 243,
    desc: tk('Piège un fichier : indice de la bombe = succès nets.') },
  { id: 'checkOverwatch', fr: tk('Vérifier le Score d’Overwatch'), en: 'Check Overwatch Score', cat: 'sleaze', type: 'simple', skill: 'electronic_warfare', attr: 'LOG', limit: 'sleaze', defense: { fixed: 6 }, marks: 0, targets: ['none'], page: 238,
    desc: tk('Opposé à 6 dés (le GOD). Réussite : vous connaissez votre SO actuel.') },
  // --- Legal: information
  { id: 'matrixPerception', fr: tk('Perception matricielle'), en: 'Matrix Perception', cat: 'info', type: 'complex', skill: 'computer', attr: 'INT', limit: 'dataProcessing', defense: null, marks: 0, targets: ['host', 'ic', 'device', 'file', 'persona', 'manual', 'none'], page: 241,
    desc: tk('Chaque succès révèle une information. Sur un hôte : indice, attributs, IC, fichiers, appareils et bombes de données.') },
  { id: 'matrixSearch', fr: tk('Recherche matricielle'), en: 'Matrix Search', cat: 'info', type: 'extended', skill: 'computer', attr: 'INT', limit: 'dataProcessing', defense: null, marks: 0, targets: ['none'], page: 241,
    desc: tk('Recherche d’informations publiques ou cachées (seuil et durée fixés par le MJ).') },
  { id: 'traceIcon', fr: tk('Tracer une icône'), en: 'Trace Icon', cat: 'info', type: 'complex', skill: 'computer', attr: 'INT', limit: 'dataProcessing', defense: ['WIL', 'sleaze'], marks: 2, targets: ['persona', 'device', 'manual'], page: 243,
    desc: tk('Localise physiquement l’appareil derrière l’icône.') },
  // --- Legal: control & files
  { id: 'controlDevice', fr: tk('Contrôler un appareil'), en: 'Control Device', cat: 'control', type: 'variable', skill: 'electronic_warfare', attr: 'LOG', limit: 'dataProcessing', defense: ['INT', 'firewall'], marks: 1, targets: ['device', 'manual'], page: 238,
    desc: tk('Fait agir l’appareil (ouvrir une porte, couper une caméra…). Marques nécessaires : 1 à 3 selon l’ordre.') },
  { id: 'editFile', fr: tk('Éditer un fichier'), en: 'Edit File', cat: 'control', type: 'complex', skill: 'computer', attr: 'LOG', limit: 'dataProcessing', defense: ['INT', 'firewall'], marks: 1, targets: ['file'], page: 239,
    desc: tk('Lire, copier, modifier ou effacer un fichier (non protégé). Une bombe de données explose si elle n’est pas désamorcée.') },
  { id: 'disarmDataBomb', fr: tk('Désamorcer une bombe de données'), en: 'Disarm Data Bomb', cat: 'control', type: 'complex', skill: 'software', attr: 'LOG', limit: 'firewall', defense: { x2: 'bomb' }, marks: 0, targets: ['file'], page: 239,
    desc: tk('Réussite : la bombe est retirée. Échec : elle explose (indice D6 dommages matriciels, fichier détruit).') },
  { id: 'rebootDevice', fr: tk('Redémarrer un appareil'), en: 'Reboot Device', cat: 'control', type: 'complex', skill: 'computer', attr: 'LOG', limit: 'dataProcessing', defense: ['WIL', 'firewall'], marks: 3, targets: ['device', 'persona', 'manual'], page: 242,
    desc: tk('L’appareil s’éteint et redémarre à la fin du tour suivant (marques et liaisons perdues).') },
  // --- Legal: utilities (no test)
  { id: 'enterHost', fr: tk('Entrer dans un hôte'), en: 'Enter Host', cat: 'util', type: 'complex', noTest: true, marks: 1, targets: ['host'], page: 240,
    desc: tk('Il faut 1 marque sur l’hôte. À l’intérieur, ses IC peuvent vous attaquer.') },
  { id: 'exitHost', fr: tk('Sortir de l’hôte'), en: 'Exit Host', cat: 'util', type: 'complex', noTest: true, marks: 0, targets: ['none'], page: 240,
    desc: tk('Retour sur la grille.') },
  { id: 'fullMatrixDefense', fr: tk('Défense matricielle totale'), en: 'Full Matrix Defense', cat: 'util', type: 'interrupt', noTest: true, marks: 0, targets: ['none'], page: 240,
    desc: tk('Interruption (−10 initiative) : ajoute votre Volonté à vos tests de défense matricielle jusqu’à la fin du tour.') },
  { id: 'jackOut', fr: tk('Se déconnecter (Jack Out)'), en: 'Jack Out', cat: 'util', type: 'simple', skill: 'hardware', attr: 'WIL', limit: 'firewall', defense: ['LOG', 'attack'], marks: 0, targets: ['none'], page: 241,
    desc: tk('Déconnexion volontaire, sans choc d’éjection. Si un verrou de lien vous retient : Hardware + Volonté [Firewall] contre Logique + Attaque.') },
  { id: 'rebootSelf', fr: tk('Redémarrer son deck'), en: 'Reboot Device (own deck)', cat: 'util', type: 'complex', noTest: true, marks: 0, targets: ['none'], page: 242,
    desc: tk('Remet le Score d’Overwatch à 0 et efface toutes les marques, mais vous éjecte (choc d’éjection en RV).') },
];
export const ACTION_BY_ID = Object.fromEntries(ACTIONS.map((a) => [a.id, a]));
export const isIllegal = (action) => action && (action.cat === 'attack' || action.cat === 'sleaze');
export const ACTION_CATS = { attack: tk('Attaque'), sleaze: tk('Discrétion'), info: tk('Information'), control: tk('Contrôle & fichiers'), util: tk('Utilitaires') };
export const ACTION_TYPES = { complex: tk('Complexe'), simple: tk('Simple'), free: tk('Libre'), interrupt: tk('Interruption'), variable: tk('Variable'), extended: tk('Étendue') };
export const TARGET_KIND_LABELS = { host: tk('Hôte'), ic: tk('IC'), device: tk('Appareil'), file: tk('Fichier'), persona: tk('Persona'), manual: tk('Autre cible'), markOnMe: tk('Marque sur moi'), none: tk('Sans cible') };

/**
 * Programs (SR5 core p. 245-246 + Data Trails). auto = the cockpit applies the effect by itself;
 * otherwise the effect is shown to the table and arbitrated by the GM.
 * names: lower-case aliases (English, French from the catalog, French table names).
 */
export const PROGRAMS = [
  // Common programs
  { id: 'browse', en: 'Browse', fr: 'Navigateur', kind: 'common', names: ['navigation'], effect: tk('Divise par deux le temps des Recherches matricielles.') },
  { id: 'configurator', en: 'Configurator', fr: 'Configurateur', kind: 'common', effect: tk('Mémorise une configuration (programmes + attributs) chargeable d’une action libre.') },
  { id: 'edit', en: 'Edit', fr: 'Édition', kind: 'common', auto: true, limitBonus: { editFile: 2 }, effect: tk('+2 à la limite des actions Éditer un fichier.') },
  { id: 'encryption', en: 'Encryption', fr: 'Cryptage', kind: 'common', auto: true, attrBonus: { firewall: 1 }, effect: tk('+1 Firewall.') },
  { id: 'signalScrub', en: 'Signal Scrub', fr: 'Gommage de bruit', kind: 'common', auto: true, noiseReduction: 2, effect: tk('Réduit le bruit de 2.') },
  { id: 'toolbox', en: 'Toolbox', fr: 'Boîte à outils', kind: 'common', auto: true, attrBonus: { dataProcessing: 1 }, effect: tk('+1 Traitement de données.') },
  { id: 'virtualMachine', en: 'Virtual Machine', fr: 'Machine virtuelle', kind: 'common', auto: true, slots: 2, extraDamage: 1, effect: tk('+2 emplacements de programme, mais +1 case à chaque dommage matriciel subi.') },
  { id: 'bootstrap', en: 'Bootstrap', fr: 'Amorçage', kind: 'common', effect: tk('Data Trails : accélère le redémarrage / la reprise du deck (au MJ).') },
  { id: 'shredder', en: 'Shredder', fr: 'Déchiqueteuse', kind: 'common', effect: tk('Data Trails : efface définitivement les fichiers supprimés (au MJ).') },
  { id: 'search', en: 'Search', fr: 'Recherche', kind: 'common', effect: tk('Data Trails : aide aux Recherches matricielles (au MJ).') },
  // Hacking programs
  { id: 'armor', en: 'Armor', fr: 'Armure', kind: 'hacking', auto: true, resistMatrix: 2, effect: tk('+2 dés pour résister aux dommages matriciels.') },
  { id: 'babyMonitor', en: 'Baby Monitor', fr: 'Surveillance', kind: 'hacking', auto: true, osVisible: true, effect: tk('Vous connaissez toujours votre Score d’Overwatch.') },
  { id: 'biofeedback', en: 'Biofeedback', fr: 'Biofeedback', kind: 'hacking', effect: tk('Vos attaques de cybercombat infligent aussi du biofeedback aux cibles vivantes (É en RV froide, P en RV chaude).') },
  { id: 'biofeedbackFilter', en: 'Biofeedback Filter', fr: 'Filtre de biofeedback', kind: 'hacking', auto: true, resistBio: 2, effect: tk('+2 dés pour résister au biofeedback.') },
  { id: 'blackout', en: 'Blackout', fr: 'Blackout', kind: 'hacking', effect: tk('Comme Biofeedback, mais toujours en dommages étourdissants.') },
  { id: 'decryption', en: 'Decryption', fr: 'Décryptage', kind: 'hacking', auto: true, attrBonus: { attack: 1 }, effect: tk('+1 Attaque.') },
  { id: 'defuse', en: 'Defuse', fr: 'Désamorçage', kind: 'hacking', auto: true, resistBomb: 4, effect: tk('+4 dés pour résister aux bombes de données.') },
  { id: 'demolition', en: 'Demolition', fr: 'Démolition', kind: 'hacking', auto: true, bombBonus: 1, effect: tk('+1 à l’indice des bombes de données que vous posez.') },
  { id: 'exploit', en: 'Exploit', fr: 'Exploitation', kind: 'hacking', auto: true, limitBonus: { hackOnTheFly: 2 }, effect: tk('+2 à la limite de Hacker à la volée.') },
  { id: 'fork', en: 'Fork', fr: 'Fork', kind: 'hacking', effect: tk('Une même action matricielle peut viser deux cibles.') },
  { id: 'guard', en: 'Guard', fr: 'Garde', kind: 'hacking', effect: tk('Réduit les dommages supplémentaires dus aux marques posées sur vous.') },
  { id: 'hammer', en: 'Hammer', fr: 'Marteau', kind: 'hacking', effect: tk('Renforce les dommages de vos attaques matricielles (au MJ).') },
  { id: 'lockdown', en: 'Lockdown', fr: 'Verrouillage', kind: 'hacking', effect: tk('Une cible que vous endommagez en cybercombat est verrouillée (ne peut pas se déconnecter).') },
  { id: 'mugger', en: 'Mugger', fr: 'Agresseur', kind: 'hacking', effect: tk('Vos marques rapportent plus de dommages sur les Pointes de données (au MJ).') },
  { id: 'shell', en: 'Shell', fr: 'Carapace', kind: 'hacking', auto: true, resistMatrix: 1, resistBio: 1, effect: tk('+1 dé pour résister aux dommages matriciels et au biofeedback.') },
  { id: 'sneak', en: 'Sneak', fr: 'Discrétion', kind: 'hacking', effect: tk('Aide à passer inaperçu (au MJ).') },
  { id: 'stealth', en: 'Stealth', fr: 'Furtivité', kind: 'hacking', auto: true, attrBonus: { sleaze: 1 }, effect: tk('+1 Corruption.') },
  { id: 'track', en: 'Track', fr: 'Pistage', kind: 'hacking', auto: true, limitBonus: { traceIcon: 2 }, effect: tk('+2 à la limite de Tracer une icône.') },
  { id: 'wrapper', en: 'Wrapper', fr: 'Maquillage', kind: 'hacking', effect: tk('Déguise votre icône en une autre (Perception matricielle pour voir au travers).') },
  { id: 'crash', en: 'Crash (Program)', fr: 'Crash', kind: 'hacking', names: ['crash program'], effect: tk('Data Trails : aide à faire planter les programmes adverses (au MJ).') },
  { id: 'evaluate', en: 'Evaluate', fr: 'Évaluation', kind: 'hacking', auto: true, showsValue: true, effect: tk('Estime la valeur marchande des fichiers (affichée dans l’hôte).') },
  { id: 'paintjob', en: 'Paintjob', fr: 'Spray de peinture', kind: 'hacking', effect: tk('Data Trails : maquille la signature matricielle (au MJ).') },
  { id: 'tarball', en: 'Tarball', fr: 'Tarball', kind: 'hacking', effect: tk('Data Trails : plantage de programmes en chaîne (au MJ).') },
  { id: 'cloudless', en: 'Cloudless', fr: 'Copie locale', kind: 'hacking', effect: tk('Data Trails (au MJ).') },
  { id: 'detonator', en: 'Detonator', fr: 'Détonateur', kind: 'hacking', effect: tk('Data Trails : bombes de données (au MJ).') },
  { id: 'swerve', en: 'Swerve', fr: 'Déviation', kind: 'hacking', effect: tk('Data Trails (au MJ).') },
  { id: 'smokeAndMirrors', en: 'Smoke and Mirrors', fr: 'Miroirs et fumée', kind: 'hacking', effect: tk('Data Trails (au MJ).') },
  { id: 'flyOnAWall', en: 'Fly on a Wall', fr: 'Mouche au mur', kind: 'hacking', effect: tk('Data Trails (au MJ).') },
  { id: 'tantrum', en: 'Tantrum', fr: 'Nausée', kind: 'hacking', effect: tk('Data Trails (au MJ).') },
  { id: 'catsPaw', en: 'Cat’s Paw', fr: 'Patte de chat', kind: 'hacking', names: ["cat's paw"], effect: tk('Data Trails (au MJ).') },
  { id: 'hitchhiker', en: 'Hitchhiker', fr: 'Routard', kind: 'hacking', effect: tk('Data Trails (au MJ).') },
  { id: 'nukeFromOrbit', en: 'Nuke-from-Orbit', fr: 'Bombardement orbital', kind: 'hacking', effect: tk('Data Trails (au MJ).') },
  // Agent
  { id: 'agent', en: 'Agent', fr: 'Agent', kind: 'agent', effect: tk('Programme autonome (indice 1-6) : il vous assiste (travail d’équipe) ou agit seul avec Indice × 2 dés.') },
];
export const PROGRAM_BY_ID = Object.fromEntries(PROGRAMS.map((p) => [p.id, p]));

const norm = (s) =>
  String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[’`]/g, "'")
    .toLowerCase()
    .trim();
const PROGRAM_ALIASES = new Map();
for (const p of PROGRAMS) for (const n of [p.en, p.fr, ...(p.names || [])]) PROGRAM_ALIASES.set(norm(n), p.id);

/** Program id from a free name ("Agent (5)", "Crash (Program)", "Boîte à outils"…), or null when unknown. */
export function programId(name) {
  const n = norm(name);
  if (!n) return null;
  if (PROGRAM_ALIASES.has(n)) return PROGRAM_ALIASES.get(n);
  if (/^agent\b/.test(n)) return 'agent';
  const stripped = n.replace(/\s*\([^)]*\)\s*$/, '').replace(/\s+\d+$/, '').trim();
  return PROGRAM_ALIASES.get(stripped) || null;
}

/** Agents the actor owns: "Agent (5)" in matrix.programs, gear items named Agent with a rating. */
export function detectAgents(actor) {
  const out = [];
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
export function availablePrograms(actor) {
  const seen = new Set();
  const out = [];
  const add = (name) => {
    const n = String(name || '').trim();
    if (!n || seen.has(norm(n))) return;
    seen.add(norm(n));
    out.push({ name: n, id: programId(n) });
  };
  for (const p of actor?.matrix?.programs || []) add(p);
  for (const g of actor?.gear || []) if (programId(g.name)) add(g.name);
  return out;
}

function clampN(v, lo, hi) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : lo;
}

/** A cyberdeck has Attack/Sleaze; a commlink has only Data Processing / Firewall (no configuration swap). */
export const isCyberdeck = (actor) => !!actor?.matrix && (Number(actor.matrix.attack) > 0 || Number(actor.matrix.sleaze) > 0);
export const matrixMonitor = (deviceRating) => 8 + Math.ceil((Number(deviceRating) || 0) / 2);
export const identityAsdf = () => ({ attack: 'attack', sleaze: 'sleaze', dataProcessing: 'dataProcessing', firewall: 'firewall' });
export function isPermutation(map) {
  if (!map || typeof map !== 'object') return false;
  const vals = ASDF.map((k) => map[k]);
  return vals.every((v) => ASDF.includes(v)) && new Set(vals).size === 4;
}

/** Loaded program ids (agent excluded: it lives in persona.agent). */
export function loadedProgramIds(persona) {
  return new Set((persona?.loadedPrograms || []).map(programId).filter(Boolean));
}

/** Slots used: loaded programs + the agent when loaded. Total = deck slots + Virtual Machine bonus. */
export function programSlots(persona) {
  const ids = loadedProgramIds(persona);
  const base = Number(persona?.programSlots) || 4;
  const total = base + (ids.has('virtualMachine') ? PROGRAM_BY_ID.virtualMachine.slots : 0);
  const used = (persona?.loadedPrograms || []).length + (persona?.agent?.loaded ? 1 : 0);
  return { base, total, used, free: total - used };
}

/**
 * Effective deck: base values (actor.matrix), current configuration, program bonuses, IC penalties, noise.
 * Returns { deviceRating, isDeck, base, slotted, bonus, penalty, eff, programs (Set of ids), noise, rawNoise, monitor }.
 */
export function deckStats(actor, persona) {
  const m = actor?.matrix || {};
  const deck = isCyberdeck(actor);
  const order = deck && isPermutation(persona?.asdf) ? persona.asdf : identityAsdf();
  const programs = loadedProgramIds(persona);
  const base = {};
  const slotted = {};
  const bonus = {};
  const penalty = {};
  const eff = {};
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
  const rawNoise = Math.max(0, Number(persona?.noise) || 0);
  let reduction = 0;
  for (const id of programs) reduction += PROGRAM_BY_ID[id]?.noiseReduction || 0;
  const deviceRating = Number(m.rating) || 0;
  return { deviceRating, isDeck: deck, base, slotted, bonus, penalty, eff, programs, rawNoise, noise: Math.max(0, rawNoise - reduction), monitor: matrixMonitor(deviceRating) };
}

/** Sum of a numeric program property over the loaded programs (resistMatrix, resistBio…). */
export function programSum(persona, prop) {
  let n = 0;
  for (const id of loadedProgramIds(persona)) n += Number(PROGRAM_BY_ID[id]?.[prop]) || 0;
  return n;
}

/** Matrix initiative for a mode: AR = physical initiative; VR = Data Processing + INT + 3D6 (cold) / 4D6 (hot). */
export function matrixInitiative(actor, persona, mode = persona?.mode) {
  const d = derive(actor);
  if (mode === 'cold' || mode === 'hot') {
    const dp = deckStats(actor, persona).eff.dataProcessing;
    const base = dp + attr(actor, 'INT');
    const dice = mode === 'hot' ? 4 : 3;
    return { base, dice, text: `${base} + ${dice}D6` };
  }
  return { base: d.initiative.base, dice: d.initiative.dice, text: d.initiative.text };
}

/** Agent initiative: deck's Data Processing + Rating (in place of Intuition) + 4D6. */
export function agentInitiative(actor, persona) {
  const r = Number(persona?.agent?.rating) || 0;
  const base = deckStats(actor, persona).eff.dataProcessing + r;
  return { base, dice: 4, text: `${base} + 4D6` };
}

function skillOf(actor, skillId) {
  return (actor?.skills || []).find((s) => s.id === skillId) || null;
}

/** Skill rating used to cap teamwork bonus dice (SR5: bonus dice ≤ leader's skill rating). */
export function skillRating(actor, skillId) {
  return Number(skillOf(actor, skillId)?.rating) || 0;
}

/**
 * Dice pool + limit of a Matrix action for the decker (or her agent with opts.agent = true).
 * opts: { useSpec, marks (1-3, extra marks penalty), modifier, assist: { dice, limitBonus }, edge (Push the Limit) }
 * Returns { pool, parts: [{ label, value }], limit, limitParts, impossible, reason }.
 */
export function actionPool(actor, persona, action, opts = {}) {
  const parts = [];
  const limitParts = [];
  if (!action || action.noTest) return { pool: 0, parts, limit: null, limitParts, impossible: false, noTest: true };
  const deck = deckStats(actor, persona);
  if (opts.agent) {
    const r = Number(persona?.agent?.rating) || 0;
    parts.push(part(tk('Agent (indice {r}) : compétence'), r, { r }), part(tk('Agent : attribut'), r));
  } else {
    const def = SKILL_BY_ID[action.skill];
    const sk = skillOf(actor, action.skill);
    const a = attr(actor, action.attr);
    if (!sk || !sk.rating) {
      if (def && !def.def) {
        const reasonKey = tk('{skill} ne peut pas être utilisée sans formation');
        const reasonParams = { skill: { t: def.fr } };
        return { pool: 0, parts, limit: null, limitParts, impossible: true, reason: fill(reasonKey, reasonParams), reasonKey, reasonParams };
      }
      parts.push(part(tk('{attr} (par défaut −1)'), Math.max(0, a - 1), { attr: action.attr }));
    } else {
      // skillId: the UI shows the official skill name; attr: the attribute code (the same in both languages).
      parts.push({ label: sk.name || def?.fr || action.skill, skillId: action.skill, value: Number(sk.rating) }, { label: action.attr, attr: action.attr, value: a });
      if (opts.useSpec && sk.spec) parts.push(part(tk('Spé. {spec}'), 2, { spec: sk.spec }));
    }
    if (persona?.mode === 'hot') parts.push(part(tk('RV chaude'), HOT_SIM_BONUS));
    const w = derive(actor).woundModifier;
    if (w) parts.push(part(tk('Blessures'), w));
  }
  if (deck.noise) parts.push(part(tk('Bruit'), -deck.noise));
  if (action.placesMarks) {
    const pen = MARK_PENALTY[clampN(opts.marks || 1, 1, 3)] || 0;
    if (pen) parts.push(part(tk('{n} marques'), pen, { n: clampN(opts.marks, 1, 3) }));
  }
  if (opts.assist?.dice) parts.push(part(tk('Assistance de l’agent'), Number(opts.assist.dice)));
  const mod = clampN(opts.modifier || 0, -30, 30);
  if (mod) parts.push(part(tk('Modificateur'), mod));
  if (opts.edge && !opts.agent) parts.push(part(tk('Chance'), attr(actor, 'EDG')));
  const pool = Math.max(0, parts.reduce((s, p) => s + p.value, 0));
  let limit = null;
  if (action.limit) {
    limit = deck.eff[action.limit];
    limitParts.push(part(ASDF_LABELS[action.limit], limit));
    let lb = 0;
    for (const id of deck.programs) lb += PROGRAM_BY_ID[id]?.limitBonus?.[action.id] || 0;
    if (lb) {
      limit += lb;
      limitParts.push(part(tk('Programmes'), lb));
    }
    if (opts.assist?.limitBonus) {
      limit += Number(opts.assist.limitBonus);
      limitParts.push(part(tk('Assistance'), Number(opts.assist.limitBonus)));
    }
    if (opts.edge && !opts.agent) limit = null;
  }
  return { pool, parts, limit, limitParts, impossible: false };
}

/** Defense pool of a host (or its IC, devices and files): host rating (as mental attribute) + host attribute. */
export function hostDefensePool(host, action) {
  if (!host || !Array.isArray(action?.defense)) return null;
  const r = Number(host.rating) || 0;
  const k = action.defense[1];
  const mental = MENTAL_LABEL[action.defense[0]];
  return { pool: r + (Number(host[k]) || 0), parts: [part(tk('Indice de l’hôte ({attr})'), r, { attr: mental ? { t: mental } : action.defense[0] }), part(ASDF_LABELS[k], Number(host[k]) || 0)] };
}

/** Defense pool of a persona (actor with a device): mental attribute + matrix attribute (+ WIL on full defense). */
export function personaDefensePool(actor, persona, defense) {
  if (!actor || !Array.isArray(defense)) return null;
  const [a, k] = defense;
  const deck = deckStats(actor, persona);
  const parts = [MENTAL_LABEL[a] ? part(MENTAL_LABEL[a], attr(actor, a)) : { label: a, attr: a, value: attr(actor, a) }, part(ASDF_LABELS[k], deck.eff[k])];
  if (persona?.fullDefense) parts.push(part(tk('Défense totale (VOL)'), attr(actor, 'WIL')));
  const w = derive(actor).woundModifier;
  if (w) parts.push(part(tk('Blessures'), w));
  return { pool: Math.max(0, parts.reduce((s, p) => s + p.value, 0)), parts };
}

// ---------------------------------------------------------------------------
// Hosts & IC
// ---------------------------------------------------------------------------
/** Standard host attribute arrays: rating R → R, R+1, R+2, R+3 distributed by profile. */
export const HOST_PRESETS = {
  shell: { label: tk('Société-écran (Corruption)'), offsets: { attack: 1, sleaze: 3, dataProcessing: 0, firewall: 2 } },
  fortress: { label: tk('Sécurisé (Firewall)'), offsets: { attack: 1, sleaze: 0, dataProcessing: 2, firewall: 3 } },
  aggressive: { label: tk('Agressif (Attaque)'), offsets: { attack: 3, sleaze: 1, dataProcessing: 0, firewall: 2 } },
  archive: { label: tk('Archives (Traitement)'), offsets: { attack: 0, sleaze: 1, dataProcessing: 3, firewall: 2 } },
};

/**
 * IC (SR5 p. 248). Attack: host rating × 2 [limit] vs the decker's defense. needsMarks = marks the host must
 * have on the decker. effect = what the server applies on a hit.
 */
export const IC_TYPES = {
  patrol: { fr: tk('IC Patrouille'), en: 'Patrol IC', limit: 'dataProcessing', defense: ['LOG', 'sleaze'], effect: 'spot', desc: tk('Perception matricielle à chaque tour : vous repère et déclenche l’alerte.') },
  probe: { fr: tk('IC Sonde'), en: 'Probe IC', limit: 'attack', defense: ['INT', 'firewall'], effect: 'mark', desc: tk('Place une marque sur vous à chaque attaque réussie.') },
  killer: { fr: tk('IC Tueuse'), en: 'Killer IC', limit: 'attack', defense: ['INT', 'firewall'], effect: 'damage', desc: tk('Dommages matriciels : Attaque de l’hôte + succès nets.') },
  acid: { fr: tk('IC Acide'), en: 'Acid IC', limit: 'attack', defense: ['WIL', 'firewall'], effect: 'penalty', attrHit: 'firewall', desc: tk('Firewall −1 (jusqu’au redémarrage).') },
  binder: { fr: tk('IC Lieuse'), en: 'Binder IC', limit: 'attack', defense: ['WIL', 'dataProcessing'], effect: 'penalty', attrHit: 'dataProcessing', desc: tk('Traitement de données −1 (jusqu’au redémarrage).') },
  jammer: { fr: tk('IC Brouilleuse'), en: 'Jammer IC', limit: 'attack', defense: ['WIL', 'attack'], effect: 'penalty', attrHit: 'attack', desc: tk('Attaque −1 (jusqu’au redémarrage).') },
  marker: { fr: tk('IC Marqueuse'), en: 'Marker IC', limit: 'attack', defense: ['WIL', 'sleaze'], effect: 'penalty', attrHit: 'sleaze', desc: tk('Corruption −1 (jusqu’au redémarrage).') },
  crash: { fr: tk('IC Crash'), en: 'Crash IC', limit: 'attack', defense: ['INT', 'firewall'], effect: 'crash', needsMarks: 1, desc: tk('Fait planter un de vos programmes au hasard (il faut 1 marque sur vous).') },
  tarbaby: { fr: tk('IC Goudron'), en: 'Tar Baby IC', limit: 'attack', defense: ['LOG', 'firewall'], effect: 'linklock', desc: tk('Verrou de lien : vous ne pouvez plus vous déconnecter normalement.') },
  scramble: { fr: tk('IC Brouillage'), en: 'Scramble IC', limit: 'attack', defense: ['WIL', 'firewall'], effect: 'reboot', needsMarks: 3, desc: tk('Force votre deck à redémarrer (choc d’éjection en RV). Il faut 3 marques sur vous.') },
  track: { fr: tk('IC Traqueuse'), en: 'Track IC', limit: 'attack', defense: ['WIL', 'sleaze'], effect: 'trace', needsMarks: 2, desc: tk('Révèle votre position physique (il faut 2 marques sur vous).') },
  blaster: { fr: tk('IC Blaster'), en: 'Blaster IC', limit: 'attack', defense: ['LOG', 'firewall'], effect: 'damage', bio: 'S', linklock: true, desc: tk('Dommages matriciels (Attaque + succès nets) + autant de biofeedback étourdissant, et verrou de lien.') },
  black: { fr: tk('IC Noire'), en: 'Black IC', limit: 'attack', defense: ['INT', 'firewall'], effect: 'damage', bio: 'sim', linklock: true, desc: tk('Dommages matriciels (Attaque + succès nets) + autant de biofeedback (P en RV chaude, É en RV froide), et verrou de lien.') },
  sparky: { fr: tk('IC Sparky'), en: 'Sparky IC', limit: 'attack', defense: ['INT', 'firewall'], effect: 'damage', bio: 'sim', desc: tk('Dommages matriciels (Attaque + succès nets) + autant de biofeedback.') },
};
export const IC_ORDER = ['patrol', 'probe', 'killer', 'acid', 'binder', 'jammer', 'marker', 'crash', 'tarbaby', 'scramble', 'track', 'blaster', 'black', 'sparky'];

/** Typical IC suite by host rating (only Patrol starts active). */
export function defaultIcFor(rating) {
  const r = Number(rating) || 1;
  if (r <= 3) return ['patrol', 'probe', 'killer'];
  if (r <= 6) return ['patrol', 'probe', 'killer', 'acid', 'tarbaby'];
  if (r <= 9) return ['patrol', 'probe', 'killer', 'blaster', 'black', 'track'];
  return ['patrol', 'probe', 'killer', 'black', 'blaster', 'sparky', 'scramble', 'track'];
}

export function hostAttributes(rating, preset = 'shell') {
  const r = clampN(rating, 1, 12);
  const off = (HOST_PRESETS[preset] || HOST_PRESETS.shell).offsets;
  return Object.fromEntries(ASDF.map((k) => [k, r + off[k]]));
}

/** IC attack pool: host rating × 2. IC initiative: host rating × 2 + 4D6. */
export const icAttackPool = (host) => (Number(host?.rating) || 0) * 2;
export const icInitiative = (host) => ({ base: (Number(host?.rating) || 0) * 2, dice: 4, text: `${(Number(host?.rating) || 0) * 2} + 4D6` });

/** Overwatch Score level for the meter. */
export function osLevel(os) {
  const n = Number(os) || 0;
  if (n >= 35) return { id: 'critical', label: tk('Convergence imminente'), color: 'red' };
  if (n >= 30) return { id: 'danger', label: tk('Danger'), color: 'red' };
  if (n >= 20) return { id: 'warn', label: tk('Surveillé'), color: 'amber' };
  if (n >= 10) return { id: 'notice', label: tk('Remarqué'), color: 'cyan' };
  return { id: 'calm', label: tk('Discret'), color: 'green' };
}

/** Dumpshock: 6 DV, Physical after hot sim, Stun after cold sim, none in AR; resisted with Willpower + Firewall. */
export function dumpshock(mode) {
  if (mode === 'hot') return { dv: DUMPSHOCK_DV, type: 'P' };
  if (mode === 'cold') return { dv: DUMPSHOCK_DV, type: 'S' };
  return null;
}
