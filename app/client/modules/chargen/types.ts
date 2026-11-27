// Local types of the chargen folder (gaps of shared/types.ts are listed in the migration report).
import type { compute } from '/shared/chargen.ts';
import type { CatalogItem, DraftData, GameView } from '../../../shared/types.ts';

/** shared/chargen.js compute() result (inferred from the JS module). */
export type ChargenResult = ReturnType<typeof compute>;

/** A validation issue of compute(): { step, key, params, text… }. */
export interface ChargenIssue {
  step: string;
  key?: string;
  text?: string;
  params?: Record<string, unknown>;
}
/** Errors / warnings of one wizard step (issuesByStep). */
export interface StepIssueList {
  errors: ChargenIssue[];
  warnings: ChargenIssue[];
}

/** Catalog entry read loosely: the creator reads stats of every catalog file. */
// Catalog stats differ per file: read as dynamic data.
export type LooseCatalogItem = CatalogItem<Record<string, any>>;

/** Shop catalog of shop/common.js useShopCatalog(): every sold item with its file. */
export interface ShopEntry {
  ref: string;
  file: string;
  item: LooseCatalogItem;
  section: string;
  name: string;
  category: string;
  search: string;
}
export interface ShopCatalog {
  entries: ShopEntry[];
  byId: Map<string, ShopEntry>;
  error: boolean;
}

/** Catalog context for compute() / buildActor() (see common.tsx useRulesCtx). */
export interface RulesCtx {
  ctx: { rules: unknown; settings: object; lookup?: (id: string) => { item: LooseCatalogItem; file: string } | null };
  ready: boolean;
  shop: ShopCatalog | null;
  qualities: LooseCatalogItem[];
  spells: LooseCatalogItem[];
  powers: LooseCatalogItem[];
  lookup: (id: string) => { item: LooseCatalogItem; file: string } | null;
}

/** Draft mutation: update(d => { d.x = 1 }) on a copy of the draft. */
export type DraftUpdate = (fn: (d: DraftData) => unknown) => void;

/** Props every wizard step receives. */
export interface StepProps {
  data: DraftData;
  update: DraftUpdate;
  result: ChargenResult;
  issues: StepIssueList | undefined;
  rc: RulesCtx;
  game: GameView;
  isGM: boolean;
}
