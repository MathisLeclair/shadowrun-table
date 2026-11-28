// Hand-written effects of catalog entries whose Chummer data has no <bonus> (their effect is in the rulebook text only) or a
// bonus the normalizer cannot read. Merged by tools/build-catalog.ts into the entry's `effects` (tag 'hand'), so they reach
// data/catalog/effects.json like Chummer's. Keyed by catalog file, then by the entry's English name (Chummer <name>).
// Every rule here is the entry's own book and page (the catalog entry's `source` / `page`, shown with the 📖 chip); write an
// effect only when the rule is clear, and follow Chummer when it has data (see docs/rules/modifiers-stacking.md).
// Conditions used here (`q-…`) are defined in shared/modifiers.ts CONDITIONS (label + roll-dialog switch).
//
// EffectOverride:
//   effects  hand-written effects (same shape as tools/lib/bonus-effects.ts output, without `tag`)
//   replace  drop Chummer's own effects (they are wrong or unreadable) and keep only `effects`
//   partial  part of the rule stays with the GM even with these effects (« partly automated » on the sheet); the text says what
//   gm       nothing to automate: the effect is narrative, changes other people's tests, glitches, time or Edge (« not automated »
//            on the sheet); the text says why (coverage report only, English)
//   handled  the app applies it somewhere else than effects (the text says where): counted as automated
import type { Effect } from '../../shared/types.ts';

type HandEffect = Omit<Effect, 'tag'>;
export interface EffectOverride {
  effects?: HandEffect[];
  replace?: boolean;
  partial?: string;
  gm?: string;
  handled?: string;
}

const VEHICLE: HandEffect = { type: 'skillCategory', target: 'vehicle', exclude: ['gunnery'] };
const PHYSICAL_ATTRS = ['BOD', 'AGI', 'REA', 'STR'];
/** Allergy (SR5 p. 78): Mild / Moderate = Physical tests −2 / −4, Severe / Extreme = every test −4 / −6; −1 die per step to resist the allergen. */
function allergy(step: 1 | 2 | 3 | 4): EffectOverride {
  const pen = [2, 4, 4, 6][step - 1];
  const tests: HandEffect[] = step <= 2
    ? PHYSICAL_ATTRS.map((a) => ({ type: 'skillAttribute', target: a, value: -pen, condition: 'q-allergen' }))
    : [{ type: 'allTests', value: -pen, condition: 'q-allergen' }];
  return {
    effects: [...tests, { type: 'stat', target: 'toxinResist', value: -step, condition: 'q-allergen' }],
    partial: step >= 3 ? 'damage boxes while exposed; penalties on Physical attribute-only tests' : 'penalties on Physical attribute-only tests',
  };
}
/** Prejudiced (SR5 p. 82): −2 / −4 / −6 dice on Social tests with the target group. */
const prejudiced = (pen: number): EffectOverride => ({
  effects: [{ type: 'skillCategory', target: 'social', value: -pen, condition: 'q-target-group' }],
  partial: 'the target group gets the same bonus in negotiations',
});
/** Vision granted by the entry: read by shared/vision.ts tokenVision() (map fog, light modifiers of attacks). */
const LOW_LIGHT: HandEffect = { type: 'flag', target: 'lowLightVision', value: 1 };
const THERMO: HandEffect = { type: 'flag', target: 'thermographicVision', value: 1 };
const WITHDRAWAL = 'withdrawal penalties on Mental or Physical tests (depends on the dependency)';

export const EFFECT_OVERRIDES: Record<string, Record<string, EffectOverride>> = {
  qualities: {
    // Core rulebook (SR5)
    Guts: { effects: [{ type: 'stat', target: 'composure', value: 2, condition: 'q-fear' }, { type: 'stat', target: 'spellResistance', value: 2, condition: 'q-fear' }] },
    'Natural Hardening': { effects: [{ type: 'stat', target: 'biofeedback', value: 1 }] },
    'Unsteady Hands': { effects: [{ type: 'skillAttribute', target: 'AGI', value: -2, condition: 'q-symptoms' }], partial: 'AGI + BOD (4) test after each stressful encounter' },
    'Simsense Vertigo': { effects: [{ type: 'allTests', value: -2, condition: 'q-simsense' }] },
    Juryrigger: {
      effects: ['aeronautics_mechanic', 'automotive_mechanic', 'industrial_mechanic', 'nautical_mechanic'].map((s) => ({ type: 'skill', target: s, value: 2, condition: 'q-juryrigging' })),
      partial: 'threshold −1 and the temporary results of the jury-rig',
    },
    Gearhead: { effects: [{ ...VEHICLE, value: 2, condition: 'q-gearhead' }], partial: 'Speed +20% or Handling +1, duration and stress damage' },
    Uncouth: { effects: [{ type: 'skillCategory', target: 'social', value: -2, condition: 'q-impulsive' }], partial: 'unaware in Social skills it does not have (no defaulting)' },
    'Addiction (Mild)': { partial: WITHDRAWAL },
    'Addiction (Moderate)': { partial: WITHDRAWAL },
    'Addiction (Severe)': { effects: [{ type: 'skillCategory', target: 'social', value: -2 }], partial: WITHDRAWAL },
    'Addiction (Burnout)': { partial: WITHDRAWAL },
    'Allergy (Common, Mild)': allergy(1),
    'Allergy (Uncommon, Mild)': allergy(1),
    'Allergy (Common, Moderate)': allergy(2),
    'Allergy (Uncommon, Moderate)': allergy(2),
    'Allergy (Common, Severe)': allergy(3),
    'Allergy (Uncommon, Severe)': allergy(3),
    'Allergy (Common, Extreme)': allergy(4),
    'Allergy (Uncommon, Extreme)': allergy(4),
    'Prejudiced (Common, Biased)': prejudiced(2),
    'Prejudiced (Specific, Biased)': prejudiced(2),
    'Prejudiced (Common, Outspoken)': prejudiced(4),
    'Prejudiced (Specific, Outspoken)': prejudiced(4),
    'Prejudiced (Common, Radical)': prejudiced(6),
    'Prejudiced (Specific, Radical)': prejudiced(6),
    Scorched: { effects: [{ type: 'stat', target: 'biofeedback', value: -2, condition: 'q-black-ic' }], partial: 'BOD + WIL (4) test entering VR or using BTLs, and the symptom table' },
    'Spirit Bane': {
      effects: [{ type: 'skill', target: 'summoning', value: -2, condition: 'q-spirit-type' }, { type: 'skill', target: 'binding', value: -2, condition: 'q-spirit-type' }],
      partial: 'those spirits resist banishing better and attack the character first',
    },
    'Spirit Affinity': { effects: [{ type: 'skill', target: 'binding', value: 1, condition: 'q-spirit-type' }], partial: 'one more service per spirit' },
    'Focused Concentration': { gm: 'no sustaining penalty to cancel in the app' },
    'Astral Chameleon': { gm: 'changes other characters’ assensing tests' },
    'Astral Beacon': { gm: 'changes other characters’ assensing tests' },
    'Human-Looking': { gm: 'NPC attitudes' },
    'Insomnia (Basic)': { gm: 'Stun recovery time and Edge refresh' },
    'Insomnia (Full)': { gm: 'Stun recovery time and Edge refresh' },
    Gremlins: { gm: 'glitches with fewer 1s on gear tests' },
    'Distinctive Style': { gm: 'helps others identify or locate the character' },
    Blandness: { gm: 'hinders others identifying or locating the character' },
    'Weak Immune System': { gm: 'raises the Power of diseases' },
    'Bad Luck': { gm: 'Edge may backfire once per session' },
    'Bad Rep': { gm: 'reputation (starting Notoriety 3)' },
    'Elf Poser': { gm: 'NPC attitudes' },
    'Ork Poser': { gm: 'NPC attitudes' },
    // Metatype senses (p. 66), hidden in Chummer: index entry only (tools/build-catalog.ts METATYPE_SENSES)
    'Low-Light Vision': { effects: [LOW_LIGHT] },
    'Thermographic Vision': { effects: [THERMO] },
    // Run & Gun: full defense options of shared/combat.ts (Agility / Charisma instead of Willpower)
    'Agile Defender': { handled: 'full defense option « Agility » (shared/combat.ts)' },
    'Too Pretty To Hit': { handled: 'full defense option « Charisma » (shared/combat.ts)' },
    'Combat Junkie': { gm: 'Composure / INT + LOG tests the GM calls' },
    // Bullets & Bandages
    'Dead SIN': { gm: 'the SIN of a dead person: who notices, and when, is the GM’s call' },
    // Rigger 5.0
    'Accident Prone': { effects: [{ ...VEHICLE, value: -2 }] },
    // Run Faster
    'Did You Just Call Me Dumb?': { gm: 'glitches on Social tests become critical glitches' },
    'Striking Skin Pigmentation': { gm: 'helps others identify or locate the character' },
    'Low-Light Vision (Changeling)': { effects: [LOW_LIGHT] },
    'Low-Light Vision (Feline)': { effects: [LOW_LIGHT], partial: 'social modifiers of the reflective slit eyes (Freaks sidebar, p. 123)' },
    'Thermographic Vision (SURGE)': { effects: [THERMO] },
    'Night Vision': { effects: [LOW_LIGHT], partial: 'sun glare (Blinding on a clear day, Moderate when overcast) unless the character wears sunglasses' },
    // Infected: Chummer grants the Enhanced Senses critter power (unread tag); the sense is its only play effect
    'Infected Optional Power: Enhanced Sense (Low-Light Vision)': { effects: [LOW_LIGHT], replace: true },
    'Infected Optional Power: Enhanced Sense (Thermographic Vision)': { effects: [THERMO], replace: true },
    'Thermal Sensitivity': { gm: 'non-visual heat sense within 10 m (Perception tests); in combat it lowers Visibility and Light / Glare by one level' },
    // Chrome Flesh
    Lightweight: { gm: 'Addiction Ratings +2' },
    'Lack of Focus': { gm: 'Composure tests during long extended tests, cumulative penalty' },
    'Revels in Murder': { gm: 'Edge refund' },
    // Data Trails: metahuman qualities (p. 44-49). Cockpit rules: shared/matrix.ts MATRIX_QUALITIES.
    'I C U': { effects: [{ type: 'matrixAction', target: 'matrixPerception', value: 2, condition: 'q-icu' }] },
    'Online Fame': {
      effects: [{ type: 'skillCategory', target: 'social', value: 2, condition: 'q-online-fame' }, { type: 'limit', target: 'social', value: 2, condition: 'q-online-fame' }],
      partial: 'meeting a fan in person (1D6: +3 or −4)',
    },
    'Go Big or Go Home': { handled: 'Brute Force / Hack on the Fly: 3 marks at −6 (shared/matrix.ts markPenalty)' },
    'Wanted by GOD': { handled: 'convergence at Overwatch Score 30 (shared/matrix.ts convergenceAt)' },
    'Faraday Himself': { handled: '+2 Noise on the character’s own Matrix tests (shared/matrix.ts deckStats); others within 10 m: GM', partial: 'the Noise on other people within 10 m' },
    'Electronic Witness': { effects: [{ type: 'allTests', value: -1, condition: 'q-not-recording' }] },
    'Decaying Dissonance': { effects: [{ type: 'skillCategory', target: 'social', value: -1, condition: 'q-out-of-combat' }], partial: 'gibberish under stress, Memory glitches, scrambling data in hosts' },
    Nerdrage: { effects: [{ type: 'skillCategory', target: 'social', value: -2, condition: 'q-nerdrage' }], partial: 'the revenge that ends it' },
    'Data Anomaly': { gm: '+2 dice to defend against Matrix Perception while running silent (defense tests are rolled by the GM)' },
    'Fade to Black': { gm: 'free Hide after an Erase Mark that removes every mark' },
    'Ninja Vanish': { gm: 'spend 1 Edge: one opponent loses its marks (the GM removes them)' },
    'Golden Screwdriver': { gm: 'Matrix damage repair (done by the GM)' },
    'Pain is Gain': { gm: '+2 Initiative Score in a turn with biofeedback damage' },
    Profiler: { gm: 'bonus from a dossier on one person (net hits of a Matrix Search, max 3)' },
    'Quick Config': { gm: 'two swaps per Free Action when reconfiguring' },
    'Code of Honor: Like a Boss': { gm: 'never deals Matrix damage; Karma loss' },
    'Data Liberator': { gm: 'leaks paydata' },
    'Latest and Greatest': { gm: 'spends earnings on upgrades' },
    'Leeeeeeeroy Jenkins': { gm: 'Composure (3) or charges in; +1 die on the first attack when shouting' },
    'Prank Warrior': { gm: 'rival hacker' },
    // Data Trails: AI qualities (p. 146-152)
    Sapper: { effects: [{ type: 'matrixAction', target: 'formatDevice', value: 2 }] },
    Snooper: { effects: [{ type: 'matrixAction', target: 'snoop', value: 2 }, { type: 'matrixAction', target: 'jamSignals', value: 2 }] },
    'Hello World!': { effects: [{ type: 'stat', target: 'essenceLossResist', value: 'Rating' }] },
    'Virtual Stability': { handled: 'no extra box from Virtual Machine (server/modules/45-matrix.ts damageDeck)' },
    Designer: { gm: 'bonuses on the AI’s home device' },
    'Improved Restoration': { gm: 'Core healing' },
    'Low Profile': { gm: 'half Overwatch Score for actions made through devices' },
    Munge: { gm: 'eats data to regain Essence' },
    Multiprocessing: { gm: 'action economy' },
    'Pilot Origins': { gm: 'jumps into one vehicle class like a control rig' },
    'Sensor Upgrade': { gm: '+1 Sensor to slaved devices' },
    Corrupter: { gm: 'Gremlins level 2' },
    'Easily Exploitable': { gm: 'lower mark penalties against the AI' },
    'Real World Naiveté': { gm: 'GM-set penalties in the physical world' },
    Fragmentation: { partial: 'mental defects chosen by the GM' },
    'Inherent Program': { gm: 'one program always running (load it in the cockpit)' },
  },
  cyberware: {
    // Core rulebook (SR5 p. 453): eye implants (stand-alone, or a cybereye enhancement)
    'Low-Light Vision': { effects: [LOW_LIGHT] },
    'Thermographic Vision': { effects: [THERMO] },
  },
};

/** Override of a catalog entry (file + English name), or null. */
export function effectOverride(file: string, name: string): EffectOverride | null {
  return EFFECT_OVERRIDES[file]?.[name] || null;
}
