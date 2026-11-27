// Local types of the shop UI: storefront entries, price quotes, cart lines. Stored shapes are in shared/types.ts.
import type { CatalogFile, CatalogItem, ItemBase, Legality, ShopSpecial } from '../../../shared/types.ts';

/**
 * Catalog stats differ per file (shared/types.ts CatalogStatsByFile) and the shop reads them generically
 * (statRows, upgrade checks in rules.js), so storefront items use one loose stats shape (`any`: dynamic per file).
 */
export type LooseStats = Record<string, any>;
export type ShopItem = CatalogItem<LooseStats>;

/** One storefront line: a catalog item or a fixer special. `name` / `category` follow the UI language. */
export interface ShopEntry {
  /** Catalog id, or 'special:<id>'. */
  ref: string;
  file: CatalogFile;
  /** null for a special not built from a catalog item. */
  item: ShopItem | null;
  special?: ShopSpecial;
  /** STORE_SECTIONS id, or 'specials'. */
  section: string;
  readonly name: string;
  readonly category: string;
  /** Folded search text (rules.js fold). */
  search: string;
}

/** Every shop catalog file, indexed (common.tsx useShopCatalog). */
export interface ShopCatalog {
  entries: ShopEntry[];
  byId: Map<string, ShopEntry>;
  /** A catalog file failed to load or is empty. */
  error: boolean;
}

/** Price sheet of an entry (rules.js quote / common.tsx priceEntry). */
export interface PriceQuote {
  unitCost: number;
  availValue: number;
  legality: Legality | string;
  avail: string;
  rating?: number | null;
  grade?: string | null;
  essence?: number;
  base?: number;
}

/** Can this user buy it? `reason` is already translated. */
export interface BuyStatus {
  ok: boolean;
  reason?: string;
  approval: boolean;
  closed?: boolean;
}

/** A cart line, as stored in localStorage and sent (without `name`) to 'shop/buy' / 'shop/give'. */
export interface CartLine {
  ref: string;
  qty: number;
  /** Display name when the line was added (dropped from the payload). */
  name?: string;
  rating?: number | null;
  grade?: string | null;
  price?: number | null;
  setMatrix?: boolean;
  /** Upgrades: the actor's item it goes on. */
  target?: { itemId: string };
  mount?: string | null;
  lifestyleName?: string;
  primary?: boolean;
}

/**
 * An owned item of any actor list (weapons, armor, gear…) or one of its sub-items (accessories, mods, lifestyle options),
 * read generically for resale values and inventory rows (`any`: the fields depend on the list).
 */
export type OwnedItem = ItemBase & LooseStats;

/** A rules message: French key string, or { key, params } (rules.js fit checks). */
export type RulesMessage = string | { key: string; params?: Record<string, unknown> } | null | undefined;

/** Price & fit of an upgrade on one of the actor's items (upgrades.ts upgradePreview). */
export interface UpgradePreview {
  /** The actor's item it goes on (absent when none is picked). */
  target?: OwnedItem;
  targetCat?: ShopItem | null;
  q: PriceQuote;
  unitCost: number;
  problem?: RulesMessage;
  missingTarget?: boolean;
  /** Accessories: chosen mount and the free mount points. */
  mount?: string | null;
  mounts?: string[];
  /** Armor mods: capacity; vehicle mods: slots of the pool. */
  need?: number;
  used?: number | null;
  cap?: number | null;
  pool?: string | null;
  maxRating?: number | null;
  /** Lifestyle options: rent change and new rent. */
  monthlyDelta?: number;
  monthlyCost?: number;
}

/** A cart line resolved against the catalog (Cart.tsx pricedCart). */
export interface PricedLine {
  line: CartLine;
  entry?: ShopEntry;
  q?: PriceQuote;
  st?: BuyStatus;
  pv?: UpgradePreview;
  stockOut?: boolean;
  /** Ref no longer in the catalog / specials. */
  missing?: boolean;
  total: number;
}
