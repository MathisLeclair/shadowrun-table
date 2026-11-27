// TRANSITIONAL (React migration): typed views of the components the sheet uses from folders that are not converted yet.
// TypeScript infers the props of a .js component from its destructuring, all required (class, label…). Once those
// folders are converted, the final integration imports them directly and deletes this file.
import type { ComponentType, RefObject } from 'react';
import { BookRef as BookRefJs, ItemRef as ItemRefJs, RuleRef as RuleRefJs, SkillRef as SkillRefJs } from '../books/BookRef.tsx';
import { MapCanvas as MapCanvasJs } from '../map/MapCanvas.tsx';

/** Unconverted components read `class` (not className). */
interface Legacy {
  class?: string;
}

export const BookRef = BookRefJs as unknown as ComponentType<{ source?: string | null; page?: number | string | null; label?: string; title?: string } & Legacy>;
export const ItemRef = ItemRefJs as unknown as ComponentType<{ item: object | null | undefined } & Legacy>;
export const RuleRef = RuleRefJs as unknown as ComponentType<{ rule: string } & Legacy>;
export const SkillRef = SkillRefJs as unknown as ComponentType<{ id: string | null | undefined } & Legacy>;
export const MapCanvas = MapCanvasJs as unknown as ComponentType<{
  rendererRef: RefObject<{ fit(): void } | null>;
  scene: object;
  handlers: object;
} & Legacy>;
