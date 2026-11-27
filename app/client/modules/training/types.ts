// Local types of the training UI (shared/types.ts has the stored shapes; these are the client-side drafts and quotes).
import type { AdvancementRequest, I18nEntry, TrainingKind } from '../../../shared/types.ts';

/** What shared/advancement.js quote() returns: cost, time, label, error / warnings with their i18n keys. */
export interface TrainingQuote {
  kind: TrainingKind | null;
  target: string;
  from: number;
  to: number;
  /** Label (UI key, older requests: French text). */
  label: string;
  labelI18n: I18nEntry | null;
  karmaCost: number;
  daysBase: number;
  /** 0 when training time is off. */
  days: number;
  nuyenCost: number;
  instructor: boolean;
  ppCost: number;
  warnings: string[];
  warningsI18n: I18nEntry[];
  /** French message, null when possible. */
  error: string | null;
  errorI18n: I18nEntry | null;
  manual: boolean;
  req: AdvancementRequest;
}

/**
 * A raw advancement request being prepared in the UI (normalized by shared/advancement.js normalizeRequest).
 * `existing` marks an adept power the runner already has (no « précision » field then).
 */
export interface TrainingDraft {
  kind: TrainingKind;
  target?: string;
  to?: number | null;
  name?: string;
  spec?: string;
  attr?: string;
  ktype?: string;
  karma?: number;
  pp?: number;
  levels?: boolean;
  maxLevel?: number | null;
  days?: number;
  instructor?: boolean;
  note?: string;
  catalogId?: string;
  data?: Partial<AdvancementRequest['data']>;
  options?: Partial<AdvancementRequest['options']>;
  free?: boolean;
  existing?: boolean;
}
