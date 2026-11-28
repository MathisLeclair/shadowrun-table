// Sheet / roll dialog side of shared/modifiers.js: effects index loading, modifier texts in the UI language, chips with their
// rulebook reference (📖 BookRef) and tooltips listing the sources of a derived value. See ARCHITECTURE.md « Modifiers ».
import { useMemo } from 'react';
import { useCatalog } from '../../lib/net.ts';
import { lookupFromIndex, collectModifiers, derivedWithModifiers, qualityAutomation, CONDITIONS, toggleLabel, conditionLabel, signedValue, poolModifiers, limitFor, weaponAccuracy, type EffectsIndex, type ModifierLine } from '/shared/modifiers.ts';
import { t, tk, limitLabel, skillLabel, skillGroupLabel, skillCategoryLabel, attrLabel } from '../../lib/i18n.ts';
import { KNOWLEDGE_TYPES } from './sheet-data.ts';
import type { Actor, ConditionState, Weapon } from '../../../shared/types.ts';
import type { Derived, DerivedMods, EffectsLookup, SheetModifier, SourceLine } from './types.ts';
import { BookRef } from '../books/BookRef.tsx';

export type { SourceLine };

/** A modifier line of poolModifiers() / limitFor() / weaponAccuracy() (shared/modifiers.js). */
/** A modifier line of a test (shared/modifiers.ts poolModifiers / limitFor / weaponAccuracy). */
export type ModLine = ModifierLine;
export const poolModsOf = poolModifiers;
export const limitOf = limitFor;
export const accuracyOf = weaponAccuracy;

// Switches turned on, remembered per actor in this browser (« Tenue visible » stays on for Jane). Storage may be blocked.
const togglesKey = (id: string) => `sr.rollToggles.${id}`;
export function loadRollToggles(id: string): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(togglesKey(id)) || '[]');
    return Array.isArray(v) ? v.filter((x: unknown): x is string => typeof x === 'string').slice(0, 40) : [];
  } catch {
    return [];
  }
}
export function saveRollToggles(id: string, list: string[]) {
  try {
    localStorage.setItem(togglesKey(id), JSON.stringify(list));
  } catch {
    /* storage blocked: the switches only live in this dialog */
  }
}

const noLookup: EffectsLookup = () => null;

/** lookup(file, catalogId, name) over /catalog/effects.json (no effect while it loads). */
export function useEffectsLookup(): EffectsLookup {
  // The effects index is one object (not an array): useCatalog types it as a list.
  const ix = useCatalog('effects') as unknown as EffectsIndex | unknown[];
  return useMemo(() => (ix && !Array.isArray(ix) && ix.files ? lookupFromIndex(ix) : noLookup), [ix]);
}

/** Modifiers of an actor (memoized on the actor object). opts.weaponId adds that weapon's accessories. */
export function useModifiers(actor: Actor | null | undefined, opts: { weaponId?: string | null } = {}): SheetModifier[] {
  const lookup = useEffectsLookup();
  const wid = opts.weaponId || null;
  return useMemo<SheetModifier[]>(() => (actor && actor.attributes ? collectModifiers(actor, lookup, wid ? { weaponId: wid } : {}) : []), [actor, lookup, wid]);
}

/** derive() + modifiers, and the modifiers themselves: { mods, dm }. */
export function useDerivedModifiers(actor: Actor | null | undefined): { mods: SheetModifier[]; dm: DerivedMods | null } {
  const mods = useModifiers(actor);
  const dm = useMemo(() => (actor && actor.attributes ? (derivedWithModifiers(actor, mods) as DerivedMods) : null), [actor, mods]);
  return { mods, dm };
}

const STAT_LABELS: Record<string, string> = {
  soak: tk('Soak'), composure: tk('Composure'), memory: tk('Memory'), liftCarry: tk('Lift / Carry'), defense: tk('Defense'),
  reach: tk('Reach'), unarmedDV: tk('Unarmed DV'), unarmedAP: tk('Unarmed AP'), drainResist: tk('Drain Resistance'),
  fadingResist: tk('Fading resistance'), surprise: tk('Surprise'), spellResistance: tk('Spell resistance'),
  physicalRecovery: tk('Healing (physical)'), stunRecovery: tk('Healing (stun)'), judgeIntentionsDefense: tk('Resisting Judge Intentions'),
  judgeIntentions: tk('Judge Intentions'), fatigueResist: tk('Fatigue resistance'), throwSTR: tk('Strength (throwing)'), throwRangeSTR: tk('Strength (throwing range)'),
  biofeedback: tk('dice to resist biofeedback'), toxinResist: tk('dice to resist toxins'), notoriety: tk('Notoriety'), publicAwareness: tk('Public Awareness'),
  streetCred: tk('Street Cred'), lifestyleCost: tk('% lifestyle cost'), essenceLossResist: tk('dice to resist Essence loss'),
};
const RESIST_LABELS: Record<string, string> = {
  toxincontactresist: tk('contact toxins'), toxiningestionresist: tk('ingested toxins'), toxininhalationresist: tk('inhaled toxins'),
  toxininjectionresist: tk('injected toxins'), pathogencontactresist: tk('contact pathogens'), pathogeningestionresist: tk('ingested pathogens'),
  pathogeninhalationresist: tk('inhaled pathogens'), pathogeninjectionresist: tk('injected pathogens'), toxincontactimmune: tk('contact toxins'),
  toxininhalationimmune: tk('inhaled toxins'), pathogencontactimmune: tk('contact pathogens'), pathogeninhalationimmune: tk('inhaled pathogens'),
  firearmor: tk('fire'), coldarmor: tk('cold'), electricityarmor: tk('electricity'), acidarmor: tk('acid'), fallingarmor: tk('falling'), radiationresist: tk('radiation'),
  sonicresist: tk('sonic attacks'), mentalmanipulationresist: tk('mental manipulation spells'), manaillusionresist: tk('mana illusions'),
  physicalillusionresist: tk('physical illusions'), detectionspellresist: tk('detection spells'), directmanaspellresist: tk('direct mana combat spells'),
  decreasebodresist: tk('Body decrease'), decreaseagiresist: tk('Agility decrease'), decreaserearesist: tk('Reaction decrease'),
  decreasestrresist: tk('Strength decrease'), decreasecharesist: tk('Charisma decrease'), decreaseintresist: tk('Intuition decrease'),
  decreaselogresist: tk('Logic decrease'), decreasewilresist: tk('Willpower decrease'),
};
const MONITOR_LABELS: Record<string, string> = {
  physical: tk('{v} Physical Condition Monitor box(es)'), stun: tk('{v} Stun Condition Monitor box(es)'), overflow: tk('{v} overflow box(es)'),
  threshold: tk('{v} box(es) per wound modifier'), thresholdOffset: tk('{v} damage box(es) ignored for wound modifiers'),
  sharedThresholdOffset: tk('{v} damage box(es) ignored for wound modifiers (Physical first, then Stun)'),
};
const MATRIX_ATTR_LABELS: Record<string, string> = { attack: tk('Attack'), sleaze: tk('Sleaze'), dataProcessing: tk('Data Processing'), firewall: tk('Firewall'), deviceRating: tk('Device Rating') };
/** Short labels of the roll-dialog switches when shown next to a value (« 11 si visible »). */
const SHORT_TOGGLES: Record<string, string> = { wireless: tk('wireless') };

const v = (m: SheetModifier): string => signedValue(m.value);
const knowledgeLabel = (k: string): string => ((KNOWLEDGE_TYPES as Record<string, string>)[k] ? t((KNOWLEDGE_TYPES as Record<string, string>)[k]) : k);
const nameTarget = (target: string | undefined): string | null => (String(target || '').startsWith('name:') ? String(target).slice(5) : null);

/** What a modifier does, in the UI language, without its condition (« +2 Limite sociale »). */
export function effectText(m: SheetModifier): string {
  const tg = m.target ?? '';
  switch (m.type as string) { // 'weaponPool' (accessory dice) is set by shared/modifiers.js but missing from EffectType
    case 'limit':
      return m.needsChoice ? t('{v} to a chosen limit', { v: v(m) }) : t('{v} {limit}', { v: v(m), limit: limitLabel(tg) });
    case 'skill':
      if (m.needsChoice) return t('{v} dice to a chosen skill', { v: v(m) });
      return t('{v} dice: {skill}', { v: v(m), skill: nameTarget(tg) || skillLabel(tg) });
    case 'skillCategory':
      return String(tg).startsWith('knowledge:')
        ? t('{v} dice: knowledge skills ({type})', { v: v(m), type: knowledgeLabel(String(tg).slice(10)) })
        : t('{v} dice: {cat} skills', { v: v(m), cat: skillCategoryLabel(tg) });
    case 'skillGroup':
      return t('{v} dice: {group} group', { v: v(m), group: skillGroupLabel(tg) });
    case 'skillAttribute':
      return t('{v} dice: skills linked to {attr}', { v: v(m), attr: attrLabel(tg) });
    case 'attribute':
      return m.needsChoice ? t('{v} to a chosen attribute', { v: v(m) }) : t('{v} {attr}', { v: v(m), attr: attrLabel(tg) });
    case 'attributeMax':
      return t('{attr}: maximum {v}', { v: v(m), attr: attrLabel(tg) });
    case 'initiativeDice':
      return t('{v}D6 Initiative', { v: v(m) });
    case 'initiative':
      return t('{v} Initiative Score', { v: v(m) });
    case 'matrixInitiativeDice':
      return t('{v}D6 Matrix Initiative (VR)', { v: v(m) });
    case 'armor':
      return t('{v} Armor', { v: v(m) });
    case 'monitor':
      return MONITOR_LABELS[tg] ? t(MONITOR_LABELS[tg], { v: v(m) }) : t('{v} {what}', { v: v(m), what: tg });
    case 'stat':
      return t('{v} {what}', { v: v(m), what: STAT_LABELS[tg] ? t(STAT_LABELS[tg]) : tg });
    case 'resist':
      return m.immune
        ? t('Immunity: {what}', { what: RESIST_LABELS[tg] ? t(RESIST_LABELS[tg]) : tg })
        : t('{v} dice to resist: {what}', { v: v(m), what: RESIST_LABELS[tg] ? t(RESIST_LABELS[tg]) : tg });
    case 'flag':
      return tg === 'smartlink' ? t('Smartlink') : tg === 'unarmedPhysical' ? t('Unarmed attacks deal Physical damage') : tg === 'ambidextrous' ? t('No off-hand penalty') : tg === 'controlRig' ? t('Works as a control rig') : tg === 'painEditor' ? t('Works as a pain editor') : String(tg);
    case 'allTests':
      return t('{v} dice: every test', { v: v(m) });
    case 'personaAttribute':
      return t('{v} {attr} (living persona)', { v: v(m), attr: MATRIX_ATTR_LABELS[tg] ? t(MATRIX_ATTR_LABELS[tg]) : tg });
    case 'accuracy':
      if (m.needsChoice) return t('{v} Accuracy (chosen skill)', { v: v(m) });
      return tg === 'all' ? t('{v} Accuracy (all weapons)', { v: v(m) }) : t('{v} Accuracy ({skill})', { v: v(m), skill: nameTarget(tg) || skillLabel(tg) });
    case 'matrixAction':
      return m.needsChoice ? t('{v} dice to a chosen Matrix action', { v: v(m) }) : t('{v} dice: Matrix action {action}', { v: v(m), action: tg });
    case 'weaponPool':
      return t('{v} dice (accessory)', { v: v(m) });
    case 'info':
      return t('Natural weapon: {name}', { name: m.note || tg || '' });
    case 'choice':
      return m.needsChoice ? t('Choice to set (GM, edit mode)') : t('Choice: {choice}', { choice: tg });
    default:
      return `${m.type} ${tg ?? ''} ${m.value ?? ''}`.trim();
  }
}

/** Label of a condition (« si visible ») in the UI language. */
export function conditionText(key: string): string {
  return (CONDITIONS as Record<string, unknown>)[key] ? t(conditionLabel(key)) : SHORT_TOGGLES[key] ? t(SHORT_TOGGLES[key]) : t(toggleLabel(key));
}

/** Label of a roll-dialog switch (« Tenue visible ») in the UI language. */
export const toggleText = (key: string): string => t(toggleLabel(key));

/** Effect + condition + wireless + « already counted » note (« +2 Limite sociale (si visible) »). */
export function modText(m: SheetModifier): string {
  let s = effectText(m);
  const notes: string[] = [];
  if (m.condition) notes.push(conditionText(m.condition));
  if (m.wireless) notes.push(t('wireless'));
  if (notes.length) s = t('{effect} ({cond})', { effect: s, cond: notes.join(', ') });
  if (m.baked) s = t('{effect} — already counted', { effect: s });
  else if (m.unbaked) s = t('{effect} — not counted (the GM must add it)', { effect: s });
  return s;
}

/** Source name of a modifier (« Zoé : Heritage 12 », an accessory « Smartgun (Ares Predator) »). */
export function sourceName(src: SheetModifier['source'] | null | undefined): string {
  if (!src) return '';
  const n = src.nameFr && src.subId ? src.nameFr : src.name;
  return src.parentName ? t('{name} ({parent})', { name: n, parent: src.parentName }) : n;
}

/** One modifier: source, effect and its 📖 reference (book = false: the item row already shows its own chip). */
interface ModChipProps {
  m: SheetModifier;
  showSource?: boolean;
  state?: ConditionState | 'applied' | 'ignored' | string;
  book?: boolean;
}
export function ModChip({ m, showSource = true, state, book = true }: ModChipProps) {
  const cls = 'sh-mod' + (m.baked || m.unbaked || m.info ? ' info' : '') + (m.unbaked ? ' unbaked' : '') + (state === 'off' ? ' off' : '') + (state === 'ignored' ? ' ignored' : '') + ((m.value ?? 0) < 0 ? ' bad' : '');
  return <span className={cls}>
    {showSource ? <><b>{sourceName(m.source)}</b>{' '}</> : null}
    <span>{modText(m)}</span>
    {book && m.source?.book ? <>{' '}<BookRef source={m.source.book} page={m.source.page} /></> : null}
  </span>;
}

/** Effects of one item of the sheet (armor, implant, quality, power, gear), as chips. */
export function ItemEffects({ mods, list, itemId }: { mods: SheetModifier[] | null | undefined; list: string; itemId: string }) {
  const mine = (mods || []).filter((m) => m.source?.list === list && m.source?.itemId === itemId && m.type !== 'choice');
  const choice = (mods || []).find((m) => m.source?.list === list && m.source?.itemId === itemId && m.needsChoice);
  if (!mine.length && !choice) return null;
  // The item row shows its own 📖 chip (ItemRef): only sub-items' effects (armor mods, accessories) repeat theirs.
  return <div className="sh-mods">
    {mine.map((m) => <ModChip key={m.id} m={m} showSource={!!m.source.subId} book={!!m.source.subId} />)}{choice && !mine.includes(choice) ? <ModChip m={choice} showSource={false} book={false} /> : null}
  </div>;
}

/**
 * « not automated » / « partly automated » marker of a quality (data/catalog/effects.json `manual`, home-made qualities): the GM
 * knows which qualities to apply by hand. Nothing while the effects index loads, nothing for fully automated qualities.
 */
export function AutomationMark({ item, lookup }: { item: { catalogId?: string; name?: string; nameFr?: string }; lookup: EffectsLookup }) {
  if (lookup === noLookup) return null;
  const a = qualityAutomation(item, lookup);
  if (a === 'auto') return null;
  const title = a === 'some'
    ? t('Some effects of this quality are applied automatically; the GM applies the rest by hand.')
    : a === 'custom'
      ? t('Home-made quality (not in the catalog): the GM applies its effects by hand.')
      : t('The app does not apply this quality: the GM handles it by hand.');
  return <span className={'badge sh-manual' + (a === 'some' ? ' some' : '')} title={title}>{a === 'some' ? t('partly automated') : t('not automated')}</span>;
}

/** Tooltip text listing the sources of a derived value: sources = derivedWithModifiers().sources[key]. */
export function sourcesTitle(lines: SourceLine[] | null | undefined, base?: string): string {
  if (!lines?.length) return '';
  const out = base ? [base] : [];
  for (const l of lines) {
    const note = l.note === 'baked' ? t('already counted') : l.note === 'unbaked' ? t('not counted (the GM must add it)') : l.note === 'override' ? t('ignored: value overridden') : l.note === 'conditional' || l.note === 'info' ? t('depends on the situation') : '';
    out.push(`${sourceName(l.mod.source)} : ${modText({ ...l.mod, baked: false, unbaked: false })}${note ? ` — ${note}` : ''}${l.mod.source.book ? ` (${l.mod.source.book} ${l.mod.source.page ?? ''})`.replace(' )', ')') : ''}`);
  }
  return out.join('\n');
}

/** « 9 (11 si visible) » for a limit of derivedWithModifiers(). */
export function limitValueText(dm: DerivedMods | null | undefined, name: string): string {
  const total = (dm?.limits as Record<string, number | null> | undefined)?.[name];
  if (total === null || total === undefined) return '—';
  const alt = (dm?.limitsAlt as Record<string, number | null> | undefined)?.[name];
  if (alt === undefined || alt === null || alt === total) return String(total);
  const conds = ((dm?.limitsAltConditions as Record<string, string[]> | undefined)?.[name] || []).map(conditionText).join(', ');
  return t('{n} ({alt} {cond})', { n: total, alt, cond: conds });
}

/** Tooltip of a limit: base formula value, then each modifier with its source. */
export function limitTitle(d: Derived | null | undefined, dm: DerivedMods | null | undefined, name: string): string {
  const lines = (dm?.sources as Record<string, SourceLine[]> | undefined)?.[`limit.${name}`];
  if (!lines?.length) return '';
  return sourcesTitle(lines, t('Base {limit}: {n}', { limit: limitLabel(name), n: (d?.limits as Record<string, number> | undefined)?.[name] ?? '—' }));
}
