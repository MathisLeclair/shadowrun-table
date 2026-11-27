// TRANSITIONAL: books/BookRef.js is not converted yet, and TypeScript infers every prop it destructures as required.
// Typed views of its chips; import them from the books folder directly once it is converted (then delete this file).
import type { ComponentType } from 'react';
import * as Refs from '../books/BookRef.tsx';

/** 📖 chip of a book page: source 'RG' + page, or 'SR5 p. 240'. */
export const BookRef = Refs.BookRef as unknown as ComponentType<{ source?: string | null; page?: number | string | null; label?: string; title?: string; class?: string }>;
/** 📖 chip of an actor item / catalog entry (item.source + item.page). */
export const ItemRef = Refs.ItemRef as unknown as ComponentType<{ item?: unknown; class?: string }>;
/** 📖 chip of a shared/bookrefs.js rule. */
export const RuleRef = Refs.RuleRef as unknown as ComponentType<{ rule: string; class?: string }>;
/** 📖 chip of an active skill. */
export const SkillRef = Refs.SkillRef as unknown as ComponentType<{ id: string; class?: string }>;
