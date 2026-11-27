// /api/admin/books/* — rulebook library management from the /admin page (server admin only):
// list, upload a PDF (streamed to disk), edit code names / offsets / allowed tables, detect offsets, re-index, delete.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Express, Request, Response, RequestHandler } from 'express';
import { receiveToFile } from '../zip.ts';
import { BOOKS_DIR } from './access.ts';
import { cleanCode, knownBooks, readLibrary, upsertBook, removeBook, pdfFile, loadIndex } from './library.ts';
import type { LibraryBook } from './library.ts';
import { computeOffsets } from './indexer.ts';
import { cleanOffsets } from './offsets.ts';
import { jobList, isBusy, startIndexJob, memoryVerdict, NO_MEMORY } from './jobs.ts';
import type { I18nParams, TableMeta } from '../../../shared/types.ts';

/** Helpers registerAdminRoutes (server/lib/admin.ts) passes to the admin route groups. */
export interface AdminRouteOptions {
  requireAdmin: RequestHandler;
  /** Error reply: `key` = French message with {placeholders}, `extra` extra body fields (code…). */
  fail: (res: Response, status: number, key: string, extra?: Record<string, unknown>, params?: I18nParams | null) => unknown;
  listMetas: () => TableMeta[];
}

// Indexing needs ≈ 6× the PDF in RAM inside the server's process (512 MB container on the VPS): 120 MB by default.
const MAX_PDF = Number(process.env.SR_MAX_BOOK_BYTES) || 120e6;
const safeDecode = (s: string): string => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/**
 * Called by registerAdminRoutes (server/lib/admin.ts) with its helpers:
 * { requireAdmin, fail(res, status, key, extra, params), listMetas() }.
 */
export function registerBookAdminRoutes(app: Express, { requireAdmin, fail, listMetas }: AdminRouteOptions): void {
  const dir = BOOKS_DIR;
  const bookOr404 = (req: Request, res: Response): LibraryBook | null | undefined => {
    const code = cleanCode(req.params.code);
    const b = code ? readLibrary(dir).books.find((x) => x.code === code) : null;
    if (!b) fail(res, 404, 'Book not found');
    return b;
  };

  app.get('/api/admin/books', requireAdmin, (req, res) => {
    const lib = readLibrary(dir);
    res.json({
      books: lib.books.map((b) => ({ ...b, indexed: !!b.indexedAt && fs.existsSync(path.join(dir, 'index', `${b.code}.json`)), present: fs.existsSync(pdfFile(dir, b.code)) })),
      jobs: jobList(),
      tables: listMetas().map((m) => ({ id: m.id, name: m.name, archived: !!m.archived })),
      known: Object.entries(knownBooks()).map(([code, b]) => ({ code, name: b.name, nameFr: b.nameFr })),
      maxBytes: MAX_PDF,
    });
  });

  // Body = the PDF (application/octet-stream), streamed to disk. ?code=SR5&name=…&replace=1
  app.post('/api/admin/books/upload', requireAdmin, async (req, res) => {
    const code = cleanCode(req.query.code);
    if (!code) {
      req.resume();
      return fail(res, 400, 'Invalid book code (capital letters and digits, e.g. SR5, RG)');
    }
    if (isBusy(code)) {
      req.resume();
      return fail(res, 409, 'This book is being indexed');
    }
    const exists = readLibrary(dir).books.some((b) => b.code === code) || fs.existsSync(pdfFile(dir, code));
    if (exists && req.query.replace !== '1') {
      req.resume();
      return fail(res, 409, 'Book {code} already exists: tick “Replace”', { code: 'exists' }, { code });
    }
    // Refuse before streaming a file the server could not index anyway (the job checks again when it starts).
    const declared = Number(req.headers['content-length']) || 0;
    const mem: { ok: boolean; need?: number; free?: number | null } = declared && declared <= MAX_PDF ? memoryVerdict(declared) : { ok: true };
    if (!mem.ok) {
      req.resume();
      return fail(res, 507, NO_MEMORY, { code: 'memory' }, { need: mem.need ?? null, free: mem.free ?? null });
    }
    const tmp = path.join(dir, `.upload-${crypto.randomBytes(6).toString('hex')}.part`);
    try {
      await receiveToFile(req, tmp, { maxBytes: MAX_PDF });
      const head = Buffer.alloc(5);
      const fd = fs.openSync(tmp, 'r');
      fs.readSync(fd, head, 0, 5, 0);
      fs.closeSync(fd);
      if (head.toString('latin1') !== '%PDF-') {
        fs.rmSync(tmp, { force: true });
        return fail(res, 400, 'This file is not a PDF');
      }
      fs.renameSync(tmp, pdfFile(dir, code));
      const known = knownBooks()[code];
      const name = String(req.query.name || '').trim().slice(0, 120);
      const book = upsertBook(dir, code, {
        name: name || known?.name || code,
        nameFr: String(req.query.nameFr || '').trim().slice(0, 120) || known?.nameFr || name || code,
        source: safeDecode(String(req.headers['x-filename'] || '')).slice(0, 200) || undefined,
        extra: !known,
        size: fs.statSync(pdfFile(dir, code)).size,
        indexedAt: null,
      });
      startIndexJob(dir, code, { detect: true });
      console.log(`[books] ${code} uploaded (${book?.size} bytes), indexing started`);
      res.json({ book, jobs: jobList() });
    } catch (err) {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {}
      const e = err as Error & { status?: number };
      if (!res.headersSent) fail(res, e.status || 500, e.message || 'Upload failed');
    }
  });

  app.patch('/api/admin/books/:code', requireAdmin, (req, res) => {
    const b = bookOr404(req, res);
    if (!b) return;
    const body = req.body || {};
    const patch: Partial<LibraryBook> = {};
    if (body.name !== undefined) patch.name = String(body.name).trim().slice(0, 120) || b.name;
    if (body.nameFr !== undefined) patch.nameFr = String(body.nameFr).trim().slice(0, 120) || b.nameFr;
    if (body.offset !== undefined || body.offsets !== undefined) {
      const off = Number(body.offset ?? b.offset);
      if (!Number.isInteger(off) || Math.abs(off) > 2000) return fail(res, 400, 'Invalid offset');
      patch.offset = off;
      patch.offsets = body.offsets !== undefined ? cleanOffsets(body.offsets) : b.offsets || null;
      patch.manual = true;
    }
    if (body.tables !== undefined) {
      if (body.tables === 'all') patch.tables = 'all';
      else if (Array.isArray(body.tables)) {
        const ids = new Set(listMetas().map((m) => m.id));
        patch.tables = body.tables.map(String).filter((id: string) => ids.has(id));
      } else return fail(res, 400, 'Invalid table list');
    }
    res.json({ book: upsertBook(dir, b.code, patch) });
  });

  // Re-run the offset detection on the stored index (no re-extraction) and apply it.
  // ?apply=0 = preview only (the edit dialog: nothing changes until the admin saves).
  app.post('/api/admin/books/:code/detect', requireAdmin, (req, res) => {
    const b = bookOr404(req, res);
    if (!b) return;
    const idx = loadIndex(dir, b.code);
    if (!idx) return fail(res, 409, 'Book not indexed yet');
    const off = computeOffsets(b.code, { pages: idx.pages, texts: idx.texts, edges: idx.edges });
    const patch: Partial<LibraryBook> = { offset: off.offset, offsets: off.offsets, confidence: off.confidence, verified: off.verified, matchPdfPage: off.matchPdfPage, manual: false };
    if (req.query.apply === '0') return res.json({ book: { ...b, ...patch, offsets: cleanOffsets(off.offsets) || undefined }, numbered: off.numbered, applied: false });
    const book = upsertBook(dir, b.code, patch);
    res.json({ book, numbered: off.numbered, applied: true });
  });

  app.post('/api/admin/books/:code/reindex', requireAdmin, (req, res) => {
    const b = bookOr404(req, res);
    if (!b) return;
    if (!fs.existsSync(pdfFile(dir, b.code))) return fail(res, 409, 'PDF file missing on the server');
    if (!startIndexJob(dir, b.code, { detect: req.body?.detect !== false })) return fail(res, 409, 'This book is being indexed');
    res.json({ jobs: jobList() });
  });

  app.delete('/api/admin/books/:code', requireAdmin, (req, res) => {
    const b = bookOr404(req, res);
    if (!b) return;
    if (String(req.body?.confirm || '') !== b.code) return fail(res, 400, 'Confirmation missing: type the code “{code}”', {}, { code: b.code });
    if (isBusy(b.code)) return fail(res, 409, 'This book is being indexed');
    removeBook(dir, b.code);
    console.log(`[books] ${b.code} deleted`);
    res.json({ ok: true });
  });
}
