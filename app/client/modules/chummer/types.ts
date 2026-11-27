// Client-side types of the Chummer5a interop UI (server: server/modules/85-chummer.js, server/lib/chummer/merge.js).
import type { ChummerRequest, I18nMessage } from '../../../shared/types.ts';

/** Merge diff of a re-import (server/lib/chummer/merge.js). */
export interface ChummerDiff {
  empty?: boolean;
  scalars: { label: string; from: unknown; to: unknown }[];
  attributes: { key?: string; label?: string; from: unknown; to: unknown }[];
  skills: { id: string; name?: string; from: unknown; to: unknown }[];
  lists: { list: string; label: string; added: string[]; removed: string[]; changed: string[] }[];
}

/** POST /api/chummer/preview reply, plus the file kept for the confirmation. */
export interface ChummerPreview {
  diff: ChummerDiff;
  warnings?: string[];
  warningsI18n?: I18nMessage[];
  needsApproval?: boolean;
  linked?: boolean;
  created?: boolean;
  text: string;
  fileName: string;
}

/** `state.chummer.pending[]` with the fields shared/types.ts does not list yet. */
export interface ChummerRequestView extends Omit<ChummerRequest, 'diff' | 'summaryI18n'> {
  diff: ChummerDiff;
  summaryI18n?: I18nMessage[];
  resolvedAt?: number;
  gmNote?: string;
}
