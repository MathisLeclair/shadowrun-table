// Types local to the sheet module.
import type { derive, SkillDef } from '/shared/sr5.ts';
import type { DerivedWithModifiers, ModifierLookup } from '/shared/modifiers.ts';
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
/** derivedWithModifiers(actor, mods) of shared/modifiers.ts. */
export type DerivedMods = DerivedWithModifiers;

/**
 * A modifier as the sheet reads it: shared/types.ts Modifier plus fields shared/modifiers.js also sets
 * (unbaked: not counted, to report by the GM; note: natural weapon name of an 'info' modifier).
 */
export type SheetModifier = Modifier & { unbaked?: boolean; note?: string };

/** lookup(file, catalogId, name) over the effects index (shared/modifiers.js lookupFromIndex). */
export type EffectsLookup = ModifierLookup;

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

/** An entry of shared/sr5.ts SKILLS. */
export type { SkillDef };

/** An item of any actor list, as the generic GM editors handle it (fields depend on the list). */
export type AnyItem = Record<string, any>; // generic editor over every item list: fields vary per list

/** A field of the GM list / nested list editors (editors.tsx LIST_FIELDS, sublists.tsx SUB_FIELDS). */
export interface FieldDef {
  k: string;
  /** UI key (rendered with t()). */
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
