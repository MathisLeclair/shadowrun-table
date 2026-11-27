// Types local to the sheet module (gaps of shared/types.ts are listed in the migration report).
import type { derive, SKILLS } from '/shared/sr5.ts';
import type { derivedWithModifiers } from '/shared/modifiers.ts';
import type { Actor, GameView, KnowledgeSkill, Modifier, RollRecord, Skill } from '../../../shared/types.ts';

/** derive(actor) of shared/sr5.js. */
export type Derived = ReturnType<typeof derive>;
/** One line of derivedWithModifiers().sources[key]. */
export interface SourceLine {
  mod: SheetModifier;
  value?: number | null;
  applied?: boolean;
  note?: string;
}
/** derivedWithModifiers(actor, mods) of shared/modifiers.js (its keyed objects are inferred as {} from the JS). */
export type DerivedMods = Omit<ReturnType<typeof derivedWithModifiers>, 'limits' | 'limitsAlt' | 'limitsAltConditions' | 'sources'> & {
  limits: Derived['limits'] & Record<string, number | null>;
  limitsAlt: Record<string, number | null | undefined>;
  limitsAltConditions: Record<string, string[] | undefined>;
  sources: Record<string, SourceLine[] | undefined>;
};

/**
 * A modifier as the sheet reads it: shared/types.ts Modifier plus fields shared/modifiers.js also sets
 * (unbaked: not counted, to report by the GM; note: natural weapon name of an 'info' modifier).
 */
export type SheetModifier = Modifier & { unbaked?: boolean; note?: string };

/** lookup(file, catalogId, name) over the effects index (shared/modifiers.js lookupFromIndex). */
export type EffectsLookup = (file: string, catalogId?: string | null, name?: string) => unknown;

/** Preset of the roll dialog (see RollDialog.tsx header). */
export interface RollPreset {
  label?: string;
  skillId?: string;
  attr?: string;
  attr2?: string;
  pool?: number;
  limit?: number | null;
  bonus?: Array<{ label: string; value: number }>;
  applyWounds?: boolean;
  test?: string;
  weaponId?: string;
  matrixLimit?: string;
  actionId?: string;
  targetTokenId?: string;
  useSpec?: boolean;
  /** Remount key of the dialog. */
  _k?: number;
}

/** Patch sent with 'actor/update' (deep-merged by the server). */
export type ActorPatch = Record<string, unknown>;

/** Everything the sheet tabs need (built by SheetView). */
export interface SheetCtx {
  game: GameView;
  actor: Actor;
  gm: boolean;
  own: boolean;
  d: Derived;
  dm: DerivedMods;
  mods: SheetModifier[];
  lookup: EffectsLookup;
  edit: boolean;
  setEdit: (v: boolean) => void;
  roll: (preset: RollPreset) => void;
  update: (patch: ActorPatch) => Promise<unknown>;
}

/** A roll as the dialogs and the log show it: the log record, or a dice/roll reply (logId, blast…). */
export type ShownRoll = Partial<RollRecord> & {
  dice?: number[];
  total?: number;
  logId?: string;
  [extra: string]: any; // replies of dice/roll, attack/roll, actor/contactRoll… carry module-specific fields
};

/** An entry of shared/sr5.js SKILLS. */
export type SkillDef = (typeof SKILLS)[number];
/** Skills and knowledge skills may carry a note (Chummer / Foundry imports): missing from shared/types.ts. */
export type SheetSkill = Skill & { notes?: string };
export type SheetKnowledge = KnowledgeSkill & { notes?: string };

/** An item of any actor list, as the generic GM editors handle it (fields depend on the list). */
export type AnyItem = Record<string, any>; // generic editor over every item list: fields vary per list

/** A field of the GM list / nested list editors (editors.tsx LIST_FIELDS, sublists.tsx SUB_FIELDS). */
export interface FieldDef {
  k: string;
  /** French key (rendered with t()). */
  label: string;
  type?: 'num' | 'bool' | 'select' | 'tags' | 'ro';
  w?: number;
  step?: number;
  /** Stored inside item.effects (nested editors). */
  fx?: boolean;
  options?: Array<{ value: string; label: string }> | (() => Array<{ value: string; label: string }>);
}

/** catalogToItem() of sheet-data.js: where a catalog entry goes and the item built from it. */
export interface CatalogConversion {
  list: string;
  item: AnyItem;
  sub?: string;
}
