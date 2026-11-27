// TRANSITIONAL (React migration): typed views of the components the combat and chargen folders use from folders that are
// still JavaScript (books, sheet, shop). TypeScript infers every destructured prop of a .js component as required; these
// casts declare the real optional props. Delete this file (and import the components directly) once those folders are .tsx.
import type { ComponentType, ReactNode } from 'react';
import * as bookRef from '../books/BookRef.js';
import * as sheetCommon from '../sheet/common.js';
import * as shopCommon from '../shop/common.js';
import type { RollRecord } from '../../../shared/types.ts';

type RefProps = { className?: string; class?: string };
/** Anything with a `source` / `page` reference (actor item, catalog entry). */
type Referenced = { source?: string | null; page?: number | string | null } | null | undefined;

export const BookRef = bookRef.BookRef as ComponentType<RefProps & { source?: string | null; page?: number | string | null; label?: string; title?: string }>;
export const ItemRef = bookRef.ItemRef as ComponentType<RefProps & { item: Referenced }>;
export const RuleRef = bookRef.RuleRef as ComponentType<RefProps & { rule: string }>;
export const SkillRef = bookRef.SkillRef as ComponentType<RefProps & { id: string }>;

export const Overlay = sheetCommon.Overlay as ComponentType<{ title?: ReactNode; onClose?: () => void; width?: number; children?: ReactNode; actions?: ReactNode; class?: string }>;
export const DiceFaces = sheetCommon.DiceFaces as ComponentType<{ roll: RollRecord; small?: boolean }>;
export const RollBadges = sheetCommon.RollBadges as ComponentType<{ roll: RollRecord }>;

export const AvailBadge = shopCommon.AvailBadge as ComponentType<{ avail: string; value: number; legality?: string; max?: number }>;
