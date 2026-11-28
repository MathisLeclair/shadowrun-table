// Magic rules shared by the server (47-magic.ts) and the browser (client/modules/magic/). Pure: no Node or DOM API.
// Design and the features still to come: docs/design/magic.md. Rules: SR5 core, chapter Magic (pages cited inline);
// when a rule is ambiguous, do what Chummer5a does.
//
// Traditions (SR5 p. 279 and Street Grimoire / Forbidden Arcana): data/catalog/traditions.json, built from Chummer
// traditions.xml by tools/build-catalog.ts. An actor keeps a copy of its tradition in `actor.magic.tradition`
// (ActorTradition), so hand-made traditions and Chummer imports keep their own drain attribute and spirits.
import { attr } from './sr5.ts';
import type { ActorLike, ActorTradition, AttrKey, I18nParams, MagicState, SpellCategoryKey } from './types.ts';

// i18n: labels are English dictionary keys (French in client/i18n/fr/magic.json). tk() marks them for tools/i18n-check.ts.
const tk = (s: string): string => s;

/** One entry of data/catalog/traditions.json. */
export interface TraditionDef {
  id: string;
  name: string;
  nameFr?: string;
  /** Second drain attribute (WIL + drain). Absent: chosen per character (Custom, Toxic). */
  drain?: AttrKey;
  spirits?: Partial<Record<SpellCategoryKey, string>>;
  source?: string;
  page?: number;
}

/** Attributes a tradition may pair with Willpower to resist Drain (Chummer data: LOG, CHA, INT; Draconic MAG; Romani WIL). */
export const DRAIN_ATTRS: AttrKey[] = ['LOG', 'CHA', 'INT', 'MAG', 'WIL'];
export const SPELL_CATEGORIES: SpellCategoryKey[] = ['combat', 'detection', 'health', 'illusion', 'manipulation'];

/** Values the character creator stored before it used the Chummer list → Chummer tradition names. */
export const LEGACY_CHARGEN_TRADITIONS: Record<string, string> = {
  Hermetic: 'Hermetic', Shamanic: 'Shamanic', Chaos: 'Chaos Magic', Druid: 'Druid', Buddhist: 'Buddhism', Shinto: 'Shinto',
  Wicca: 'Wicca, Gardnerian', Voodoo: 'Vodou', Other: 'Custom',
  // French values of drafts saved before 2026-11 (client/i18n/legacy-fr-keys.json)
  Hermétique: 'Hermetic', Chamanique: 'Shamanic', Druide: 'Druid', Bouddhiste: 'Buddhism', Vaudou: 'Vodou', Autre: 'Custom',
};

const norm = (s: unknown): string => String(s ?? '').trim().toLowerCase();

/** Tradition of the list by id, Chummer name, legacy creator value or French name (null when unknown). */
export function findTradition(list: readonly TraditionDef[], ref: string | null | undefined): TraditionDef | null {
  const r = String(ref ?? '').trim();
  if (!r) return null;
  const alias = LEGACY_CHARGEN_TRADITIONS[r];
  const n = norm(alias || r);
  return list.find((t) => t.id === r) || list.find((t) => norm(t.name) === n) || list.find((t) => norm(t.nameFr) === n) || null;
}

/** The copy stored on the actor (drain: the catalog's, else the given choice). */
export function traditionFromDef(def: TraditionDef, drain?: AttrKey | null): ActorTradition {
  const out: ActorTradition = { id: def.id, name: def.name, drain: def.drain || (drain && DRAIN_ATTRS.includes(drain) ? drain : null) };
  if (def.nameFr) out.nameFr = def.nameFr;
  if (def.spirits && Object.keys(def.spirits).length) out.spirits = { ...def.spirits };
  if (def.source) out.source = def.source;
  if (def.page) out.page = def.page;
  return out;
}

/** Chummer .chum5 « WIL + CHA » (or « {WIL} + {CHA} ») → 'CHA'; null when unreadable. */
export function parseDrainText(text: unknown): AttrKey | null {
  const m = String(text ?? '').toUpperCase().match(/WIL\W*\+\W*([A-Z]{3})/);
  return m && DRAIN_ATTRS.includes(m[1] as AttrKey) ? (m[1] as AttrKey) : null;
}

/** Display name of a tradition in a UI language. */
export function traditionName(t: { name: string; nameFr?: string } | null | undefined, lang: string): string {
  if (!t) return '';
  return lang === 'fr' && t.nameFr ? t.nameFr : t.name;
}

/** Traditions for a picker: Custom first, then by name in the UI language. */
export function sortTraditions<T extends { name: string; nameFr?: string }>(list: readonly T[], lang: string): T[] {
  const custom = (t: T) => (t.name === 'Custom' ? 0 : 1);
  return [...list].sort((a, b) => custom(a) - custom(b) || traditionName(a, lang).localeCompare(traditionName(b, lang), lang));
}

// ---------------------------------------------------------------------------
// Who does what
// ---------------------------------------------------------------------------

/** Skills that use a tradition (sorcery, conjuring, enchanting: SR5 p. 142-143). Adepts use none of them. */
export const TRADITION_SKILLS = [
  'spellcasting', 'ritual_spellcasting', 'counterspelling', 'summoning', 'binding', 'banishing', 'alchemy', 'artificing', 'disenchanting',
];

type MagicActor = ActorLike;

/** Has a Magic rating above 0 (magicians, mystic adepts, aspected, adepts). */
export function isAwakened(actor: MagicActor | null | undefined): boolean {
  return Number(actor?.attributes?.MAG ?? 0) > 0;
}

/** Casts, summons or enchants (needs a tradition): knows a spell or a sorcery / conjuring / enchanting skill. */
export function usesTradition(actor: MagicActor | null | undefined): boolean {
  if (!actor || !isAwakened(actor)) return false;
  if ((actor.spells || []).length) return true;
  return (actor.skills || []).some((s) => TRADITION_SKILLS.includes(s.id) && Number(s.rating) > 0);
}

/** Second drain attribute of the actor's tradition (null: no tradition, or a custom one without a choice). */
export function drainAttr(actor: MagicActor | null | undefined): AttrKey | null {
  const d = actor?.magic?.tradition?.drain;
  return d && DRAIN_ATTRS.includes(d) ? d : null;
}

/**
 * Drain resistance pool before modifiers (SR5 p. 282: WIL + the tradition's attribute). The roll itself goes through
 * `dice/roll` with `test: 'drainResist'`, which adds the drain modifiers.
 */
export function drainPool(actor: MagicActor | null | undefined, second: AttrKey | null = drainAttr(actor)): { attrs: [AttrKey, AttrKey]; base: number } | null {
  if (!actor || !second) return null;
  return { attrs: ['WIL', second], base: attr(actor, 'WIL') + attr(actor, second) };
}

/** Spells the actor sustains itself (each one is −2 dice on every test, SR5 p. 282). */
export function sustainedBy(magic: Pick<MagicState, 'sustained'> | null | undefined, actorId: string): number {
  return Object.values(magic?.sustained || {}).filter((s) => s.casterId === actorId).length;
}
export const SUSTAIN_PENALTY = 2;

// ---------------------------------------------------------------------------
// Next-step hints of the cockpit (players), as the Matrix « Hints »
// ---------------------------------------------------------------------------

export interface MagicHint {
  key: string;
  tone: 'info' | 'warn' | 'danger';
  params?: I18nParams;
  /** Cockpit control the hint points at. */
  action?: 'tradition' | 'drain';
}

const TONE_RANK: Record<string, number> = { danger: 0, warn: 1, info: 2 };

/** Hints for one actor, most urgent first (pure: works on the player's filtered view). */
export function magicHints({ actor, magic }: { actor: MagicActor | null | undefined; magic: Pick<MagicState, 'sustained'> | null | undefined }): MagicHint[] {
  const out: MagicHint[] = [];
  if (!actor || !isAwakened(actor)) return out;
  const add = (key: string, extra: Partial<MagicHint> = {}) => out.push({ key, tone: 'info', ...extra });
  if (usesTradition(actor)) {
    const tr = actor.magic?.tradition;
    if (!tr) add(tk('Pick your tradition: it sets the attribute you resist Drain with (and your spirits).'), { tone: 'warn', action: 'tradition' });
    else if (!drainAttr(actor)) add(tk('Your tradition has no Drain attribute yet: choose the one you resist Drain with (Willpower + …).'), { tone: 'warn', action: 'tradition' });
    else {
      const pool = drainPool(actor);
      if (pool) add(tk('You resist Drain with Willpower + {attr}: {n} dice before modifiers.'), { params: { attr: pool.attrs[1], n: pool.base }, action: 'drain' });
    }
  }
  const n = actor.id ? sustainedBy(magic, actor.id) : 0;
  if (n) add(tk('You are sustaining {n} spell(s): −{p} dice on every test. Drop the ones you no longer need.'), { tone: 'warn', params: { n, p: n * SUSTAIN_PENALTY } });
  return out.sort((a, b) => (TONE_RANK[a.tone] ?? 2) - (TONE_RANK[b.tone] ?? 2));
}
