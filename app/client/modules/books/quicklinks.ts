// Curated « common rules » links of the Règles tab. Pure module (no imports): also read by tools/books-setup.ts
// --check, which verifies that each printed page really contains `heading` in the indexed text.
const tk = (s: string): string => s; // marks French labels for the i18n checker; rendered with t()

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
  { group: tk('Bases'), items: [
    { label: tk('Réussites et seuils'), code: 'SR5', page: 44, heading: 'HITS & THRESHOLDS' },
    { label: tk('Complications'), code: 'SR5', page: 45, heading: 'GLITCHES' },
    { label: tk('Tests en équipe'), code: 'SR5', page: 49, heading: 'TEAMWORK' },
    { label: tk('Chance (Edge)'), code: 'SR5', page: 56, heading: 'EDGE' },
    { label: tk('Utiliser une compétence par défaut'), code: 'SR5', page: 130, heading: 'DEFAULTING' },
  ] },
  { group: tk('Combat'), items: [
    { label: tk('Combat'), code: 'SR5', page: 158, heading: 'COMBAT' },
    { label: tk('Initiative'), code: 'SR5', page: 159, heading: 'INITIATIVE' },
    { label: tk('Dommages et malus de blessure'), code: 'SR5', page: 169, heading: 'WOUND MODIFIERS' },
    { label: tk('Combat à distance'), code: 'SR5', page: 173, heading: 'RANGED COMBAT' },
    { label: tk('Soins'), code: 'SR5', page: 205, heading: 'HEALING' },
  ] },
  { group: tk('Matrice'), items: [
    { label: tk('Score de Surveillance (SS)'), code: 'SR5', page: 231, heading: 'OVERWATCH SCORE' },
    { label: tk('Actions matricielles'), code: 'SR5', page: 237, heading: 'MATRIX ACTIONS' },
  ] },
  { group: tk('Magie'), items: [
    { label: tk('Lancement de sorts'), code: 'SR5', page: 281, heading: 'SPELLCASTING' },
    { label: tk('Invocation'), code: 'SR5', page: 300, heading: 'SUMMONING' },
    { label: tk('Pouvoirs d’adepte'), code: 'SR5', page: 308, heading: 'ADEPT POWERS' },
  ] },
  { group: tk('Vie courante'), items: [
    { label: tk('Styles de vie'), code: 'SR5', page: 369, heading: 'LIFESTYLES' },
    { label: tk('Styles de vie (Run Faster)'), code: 'RF', page: 216, heading: 'BOLT HOLE' },
  ] },
];
