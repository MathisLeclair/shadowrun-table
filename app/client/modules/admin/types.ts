// Types shared by the /admin page panels.
import type { ApiOptions } from '../../lib/net.ts';

/** api() with the admin token; throws an AuthError when the admin session expired. */
export type AdminApi = <R = any>(path: string, opts?: ApiOptions) => Promise<R>;
/** Run an admin call with a busy flag and error toasts (AdminPage). */
export type RunFn = (fn: () => Promise<unknown>) => Promise<void>;

/** Panel props given by AdminPage. */
export interface AdminPanelProps {
  adminApi: AdminApi;
  token: string;
  run: RunFn;
}

/** A table as GET /api/admin/tables lists it (server/lib/admin.js). */
export interface AdminTable {
  id: string;
  name: string;
  url: string;
  pack: string;
  lang: string;
  status: 'open' | 'broken' | string;
  error?: string;
  archived?: boolean;
  hidden?: boolean;
  legacy?: boolean;
  online: number;
  players: number | null;
  pcs: number;
  lastActivity?: number | null;
  sizeBytes?: number;
}

export interface AdminPack {
  id: string;
  label?: string;
}

/** GET /api/admin/tables */
export interface AdminTablesReply {
  tables: AdminTable[];
  packs: AdminPack[];
  langs: string[];
  maxUploadBytes: number;
  disk?: { free: number; total: number } | null;
  sharedAssetsBytes?: number;
  deleted?: { file: string; size: number }[];
}
