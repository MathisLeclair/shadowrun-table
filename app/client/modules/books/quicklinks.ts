// Curated « common rules » links of the Règles tab. Pure module (no imports): also read by tools/books-setup.ts
// --check, which verifies that each printed page really contains `heading` in the indexed text.
const tk = (s: string): string => s; // marks UI keys for the i18n checker; rendered with t()

export interface QuickLink {
  label: string;
  code: string;
  page: number;
  heading: string;
}
export interface QuickLinkGroup {
  group: string;
  items: QuickLink[];
}

export const QUICK_LINKS: QuickLinkGroup[] = [
  { group: tk('Basics'), items: [
    { label: tk('Hits & thresholds'), code: 'SR5', page: 44, heading: 'HITS & THRESHOLDS' },
    { label: tk('Glitches'), code: 'SR5', page: 45, heading: 'GLITCHES' },
    { label: tk('Teamwork tests'), code: 'SR5', page: 49, heading: 'TEAMWORK' },
    { label: tk('long::Edge'), code: 'SR5', page: 56, heading: 'EDGE' },
    { label: tk('long::Defaulting'), code: 'SR5', page: 130, heading: 'DEFAULTING' },
  ] },
  { group: tk('Combat'), items: [
    { label: tk('Combat'), code: 'SR5', page: 158, heading: 'COMBAT' },
    { label: tk('Initiative'), code: 'SR5', page: 159, heading: 'INITIATIVE' },
    { label: tk('Damage & wound modifiers'), code: 'SR5', page: 169, heading: 'WOUND MODIFIERS' },
    { label: tk('Ranged combat'), code: 'SR5', page: 173, heading: 'RANGED COMBAT' },
    { label: tk('pl::Healing'), code: 'SR5', page: 205, heading: 'HEALING' },
  ] },
  { group: tk('Matrix'), items: [
    { label: tk('Overwatch Score (OS)'), code: 'SR5', page: 231, heading: 'OVERWATCH SCORE' },
    { label: tk('Matrix actions'), code: 'SR5', page: 237, heading: 'MATRIX ACTIONS' },
  ] },
  { group: tk('Magic'), items: [
    { label: tk('pl::Spellcasting'), code: 'SR5', page: 281, heading: 'SPELLCASTING' },
    { label: tk('Summoning'), code: 'SR5', page: 300, heading: 'SUMMONING' },
    { label: tk('Adept Powers'), code: 'SR5', page: 308, heading: 'ADEPT POWERS' },
  ] },
  { group: tk('Daily life'), items: [
    { label: tk('Lifestyles'), code: 'SR5', page: 369, heading: 'LIFESTYLES' },
    { label: tk('Lifestyles (Run Faster)'), code: 'RF', page: 216, heading: 'BOLT HOLE' },
  ] },
];
