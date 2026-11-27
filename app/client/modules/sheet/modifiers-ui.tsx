// Sheet / roll dialog side of shared/modifiers.js: effects index loading, modifier texts in the UI language, chips with their
// rulebook reference (📖 BookRef) and tooltips listing the sources of a derived value. See ARCHITECTURE.md « Modifiers ».
import { useMemo } from 'react';
import { useCatalog } from '../../lib/net.ts';
import { lookupFromIndex, collectModifiers, derivedWithModifiers, CONDITIONS, toggleLabel, conditionLabel, signedValue, poolModifiers, limitFor, weaponAccuracy, type EffectsIndex, type ModifierLine } from '/shared/modifiers.ts';
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
  soak: tk('Encaissement'), composure: tk('Sang-froid'), memory: tk('Mémoire'), liftCarry: tk('Soulever / porter'), defense: tk('Défense'),
  reach: tk('Allonge'), unarmedDV: tk('VD à mains nues'), unarmedAP: tk('PA à mains nues'), drainResist: tk('Résistance au drain'),
  fadingResist: tk('Résistance au fading'), surprise: tk('Surprise'), spellResistance: tk('Résistance aux sorts'),
  physicalRecovery: tk('Guérison (physique)'), stunRecovery: tk('Guérison (étourdissant)'), judgeIntentionsDefense: tk('Résister à Jauger les intentions'),
  judgeIntentions: tk('Jauger les intentions'), fatigueResist: tk('Résistance à la fatigue'), throwSTR: tk('Force (lancer)'), throwRangeSTR: tk('Force (portée de lancer)'),
};
const RESIST_LABELS: Record<string, string> = {
  toxincontactresist: tk('toxines par contact'), toxiningestionresist: tk('toxines par ingestion'), toxininhalationresist: tk('toxines par inhalation'),
  toxininjectionresist: tk('toxines par injection'), pathogencontactresist: tk('pathogènes par contact'), pathogeningestionresist: tk('pathogènes par ingestion'),
  pathogeninhalationresist: tk('pathogènes par inhalation'), pathogeninjectionresist: tk('pathogènes par injection'), toxincontactimmune: tk('toxines par contact'),
  toxininhalationimmune: tk('toxines par inhalation'), pathogencontactimmune: tk('pathogènes par contact'), pathogeninhalationimmune: tk('pathogènes par inhalation'),
  firearmor: tk('feu'), coldarmor: tk('froid'), electricityarmor: tk('électricité'), acidarmor: tk('acide'), fallingarmor: tk('chutes'), radiationresist: tk('radiations'),
  sonicresist: tk('attaques soniques'), mentalmanipulationresist: tk('sorts de manipulation mentale'), manaillusionresist: tk('illusions mana'),
  physicalillusionresist: tk('illusions physiques'), detectionspellresist: tk('sorts de détection'), directmanaspellresist: tk('sorts de combat directs mana'),
  decreasebodresist: tk('baisse de Constitution'), decreaseagiresist: tk('baisse d’Agilité'), decreaserearesist: tk('baisse de Réaction'),
  decreasestrresist: tk('baisse de Force'), decreasecharesist: tk('baisse de Charisme'), decreaseintresist: tk('baisse d’Intuition'),
  decreaselogresist: tk('baisse de Logique'), decreasewilresist: tk('baisse de Volonté'),
};
const MONITOR_LABELS: Record<string, string> = {
  physical: tk('{v} case(s) au moniteur physique'), stun: tk('{v} case(s) au moniteur étourdissant'), overflow: tk('{v} case(s) de surplus'),
  threshold: tk('{v} case(s) par malus de blessure'), thresholdOffset: tk('{v} case(s) de dommages ignorée(s) pour les malus'),
  sharedThresholdOffset: tk('{v} case(s) de dommages ignorée(s) pour les malus (physique puis étourdissant)'),
};
/** Short labels of the roll-dialog switches when shown next to a value (« 11 si visible »). */
const SHORT_TOGGLES: Record<string, string> = { wireless: tk('sans fil') };

const v = (m: SheetModifier): string => signedValue(m.value);
const knowledgeLabel = (k: string): string => ((KNOWLEDGE_TYPES as Record<string, string>)[k] ? t((KNOWLEDGE_TYPES as Record<string, string>)[k]) : k);
const nameTarget = (target: string | undefined): string | null => (String(target || '').startsWith('name:') ? String(target).slice(5) : null);

/** What a modifier does, in the UI language, without its condition (« +2 Limite sociale »). */
export function effectText(m: SheetModifier): string {
  const tg = m.target ?? '';
  switch (m.type as string) { // 'weaponPool' (accessory dice) is set by shared/modifiers.js but missing from EffectType
    case 'limit':
      return m.needsChoice ? t('{v} à une limite au choix', { v: v(m) }) : t('{v} {limit}', { v: v(m), limit: limitLabel(tg) });
    case 'skill':
      if (m.needsChoice) return t('{v} dés à une compétence au choix', { v: v(m) });
      return t('{v} dés : {skill}', { v: v(m), skill: nameTarget(tg) || skillLabel(tg) });
    case 'skillCategory':
      return String(tg).startsWith('knowledge:')
        ? t('{v} dés : connaissances ({type})', { v: v(m), type: knowledgeLabel(String(tg).slice(10)) })
        : t('{v} dés : compétences {cat}', { v: v(m), cat: skillCategoryLabel(tg) });
    case 'skillGroup':
      return t('{v} dés : groupe {group}', { v: v(m), group: skillGroupLabel(tg) });
    case 'skillAttribute':
      return t('{v} dés : compétences liées à {attr}', { v: v(m), attr: attrLabel(tg) });
    case 'attribute':
      return m.needsChoice ? t('{v} à un attribut au choix', { v: v(m) }) : t('{v} {attr}', { v: v(m), attr: attrLabel(tg) });
    case 'attributeMax':
      return t('{attr} : maximum {v}', { v: v(m), attr: attrLabel(tg) });
    case 'initiativeDice':
      return t('{v}D6 d’initiative', { v: v(m) });
    case 'initiative':
      return t('{v} au score d’initiative', { v: v(m) });
    case 'matrixInitiativeDice':
      return t('{v}D6 d’initiative matricielle (RV)', { v: v(m) });
    case 'armor':
      return t('{v} armure', { v: v(m) });
    case 'monitor':
      return MONITOR_LABELS[tg] ? t(MONITOR_LABELS[tg], { v: v(m) }) : t('{v} {what}', { v: v(m), what: tg });
    case 'stat':
      return t('{v} {what}', { v: v(m), what: STAT_LABELS[tg] ? t(STAT_LABELS[tg]) : tg });
    case 'resist':
      return m.immune
        ? t('Immunité : {what}', { what: RESIST_LABELS[tg] ? t(RESIST_LABELS[tg]) : tg })
        : t('{v} dés pour résister : {what}', { v: v(m), what: RESIST_LABELS[tg] ? t(RESIST_LABELS[tg]) : tg });
    case 'flag':
      return tg === 'smartlink' ? t('Smartlink') : tg === 'unarmedPhysical' ? t('Dommages physiques à mains nues') : String(tg);
    case 'accuracy':
      if (m.needsChoice) return t('{v} Précision (compétence au choix)', { v: v(m) });
      return tg === 'all' ? t('{v} Précision (toutes les armes)', { v: v(m) }) : t('{v} Précision ({skill})', { v: v(m), skill: nameTarget(tg) || skillLabel(tg) });
    case 'matrixAction':
      return m.needsChoice ? t('{v} dés à une action matricielle au choix', { v: v(m) }) : t('{v} dés : action matricielle {action}', { v: v(m), action: tg });
    case 'weaponPool':
      return t('{v} dés (accessoire)', { v: v(m) });
    case 'info':
      return t('Arme naturelle : {name}', { name: m.note || tg || '' });
    case 'choice':
      return m.needsChoice ? t('Choix à définir (MJ, mode édition)') : t('Choix : {choice}', { choice: tg });
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
  if (m.wireless) notes.push(t('sans fil'));
  if (notes.length) s = t('{effect} ({cond})', { effect: s, cond: notes.join(', ') });
  if (m.baked) s = t('{effect} — déjà compté', { effect: s });
  else if (m.unbaked) s = t('{effect} — non compté (à reporter par le MJ)', { effect: s });
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

/** Tooltip text listing the sources of a derived value: sources = derivedWithModifiers().sources[key]. */
export function sourcesTitle(lines: SourceLine[] | null | undefined, base?: string): string {
  if (!lines?.length) return '';
  const out = base ? [base] : [];
  for (const l of lines) {
    const note = l.note === 'baked' ? t('déjà compté') : l.note === 'unbaked' ? t('non compté (à reporter par le MJ)') : l.note === 'override' ? t('ignoré : valeur forcée') : l.note === 'conditional' || l.note === 'info' ? t('selon la situation') : '';
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
  return sourcesTitle(lines, t('{limit} de base : {n}', { limit: limitLabel(name), n: (d?.limits as Record<string, number> | undefined)?.[name] ?? '—' }));
}
