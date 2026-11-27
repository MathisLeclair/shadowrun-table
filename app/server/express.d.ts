// What the server core adds to every Express request (server/index.ts). Type-only: Node never loads this file.
import type { SessionUser } from '../shared/types.ts';
import type { Table } from './lib/tables.ts';

declare module 'express-serve-static-core' {
  interface Request {
    /** Table of the request: URL prefix /t/<slug>/, else the session token's table, else the named or default table. */
    srTable?: Table | null;
    /** Table slug the request named (URL prefix, X-SR-Table header or ?table=), '' when none. */
    srHint?: string;
    /** Set by requireUser / requireGM. */
    user?: SessionUser;
  }
}
