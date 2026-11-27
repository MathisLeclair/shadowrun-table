// TRANSITIONAL: typed views of the unconverted JS components the Matrix screens use (books/BookRef.js,
// sheet/common.js). Their inferred props are all required; drop this file once those folders are converted.
import type { ComponentType } from 'react';
import * as Books from '../books/BookRef.js';
import * as Sheet from '../sheet/common.js';
import type { RollResult } from '../../../shared/types.ts';

export const BookRef = Books.BookRef as unknown as ComponentType<{ source?: string; page?: number | string; label?: string; title?: string }>;
export const RuleRef = Books.RuleRef as unknown as ComponentType<{ rule: string }>;
export const SkillRef = Books.SkillRef as unknown as ComponentType<{ id: string }>;
export const DiceFaces = Sheet.DiceFaces as unknown as ComponentType<{ roll: Partial<RollResult>; small?: boolean }>;
export const fmtTime = Sheet.fmtTime as (ts: number | null | undefined) => string;
