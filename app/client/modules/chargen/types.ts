// Local types of the chargen folder.
import type { ChargenCtx, ChargenIssue, ChargenResult } from '/shared/chargen.ts';
import type { CatalogFile, CatalogItem, DraftData, GameView } from '../../../shared/types.ts';
export type { ChargenIssue, ChargenResult };


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
  file: CatalogFile;
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
  ctx: ChargenCtx;
  ready: boolean;
  shop: ShopCatalog | null;
  qualities: LooseCatalogItem[];
  spells: LooseCatalogItem[];
  powers: LooseCatalogItem[];
  lookup: (id: string) => { item: LooseCatalogItem; file: CatalogFile } | null;
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
