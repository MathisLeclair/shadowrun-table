// Campaign module — client-side types (navigation between the GM sub-tabs, documents list).
import type { Handout } from '../../../shared/types.ts';

export type FocusKind = 'quest' | 'session' | 'handout' | 'thread';

/** Item to bring into view when a sub-tab opens (nonce: re-trigger on the same id). */
export interface Focus {
  kind: FocusKind;
  id: string;
  nonce: number;
}

/** Document shown in the Documents reader ('file.md' + optional heading). */
export interface DocTarget {
  name: string;
  anchor: string;
  nonce: number;
}

/** Navigation helpers passed down from CampaignPage. */
export interface CampaignNav {
  go: (tab: string) => void;
  openDoc: (ref: string) => void;
  open: (kind: FocusKind, id: string) => void;
}

/** One entry of GET /api/docs. */
export interface DocMeta {
  name: string;
  size: number;
  mtime: number;
}

export interface DocsState {
  list: DocMeta[];
  error: string | null;
  loading: boolean;
}

/** What HandoutCard needs: a GM handout or a handout as a player received it. */
export type HandoutLike = Pick<Handout, 'id' | 'title' | 'body' | 'image'> & { revealedAt?: number };
