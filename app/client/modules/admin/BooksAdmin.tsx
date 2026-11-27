// « Livres de règles » panel of the /admin page: the server-wide rulebook library (see ARCHITECTURE.md « Rulebooks »).
// List (code, name, pages, offset, indexing state), upload a PDF (streamed), edit offset(s) / names / allowed tables,
// detect the offset again, re-index, delete.
import { useEffect, useRef, useState } from 'react';
import { Button, Field, Toggle, Badge, Empty, Modal, promptText } from '../../lib/ui.tsx';
import { uploadWithProgress } from '../../lib/net.ts';
import { toast } from '../../lib/ui-store.ts';
import { t, tn, tIfKnown, fmtDate } from '../../lib/i18n.ts';
import { fmtBytes, Progress, type UploadProgress } from './common.tsx';
import type { AdminApi, AdminPanelProps } from './types.ts';
import type { OffsetRange } from '../books/types.ts';

/** A book as GET /api/admin/books lists it (server/lib/books/admin-routes.js). */
interface AdminBook {
  code: string;
  name: string;
  nameFr: string;
  pages?: number;
  offset: number;
  offsets?: OffsetRange[];
  confidence?: number;
  manual?: boolean;
  verified?: boolean;
  indexed?: boolean;
  indexedAt?: number;
  present?: boolean;
  size?: number;
  tables: 'all' | string[];
}
interface IndexJob {
  code: string;
  state: 'queued' | 'running' | 'done' | 'error';
  done?: number;
  total?: number;
  error?: string;
  errorParams?: Record<string, unknown>;
}
interface BookTable {
  id: string;
  name: string;
  archived?: boolean;
}
interface BooksReply {
  books: AdminBook[];
  jobs: IndexJob[];
  tables: BookTable[];
  known: { code: string; name: string }[];
  maxBytes: number;
}

const pct = (x: unknown) => `${Math.round((Number(x) || 0) * 100)} %`;
const offsetText = (b: Pick<AdminBook, 'offset' | 'offsets'>) =>
  [`${b.offset >= 0 ? '+' : ''}${b.offset}`, ...(b.offsets || []).map((r) => t('from p. {from}: {off}', { from: r.fromPrinted, off: `${r.offset >= 0 ? '+' : ''}${r.offset}` }))].join(' · ');
const rangesToText = (list: OffsetRange[] | undefined) => (list || []).map((r) => `${r.fromPrinted}:${r.offset}`).join(', ');
function textToRanges(s: string): OffsetRange[] | null {
  const out: OffsetRange[] = [];
  for (const part of String(s || '')
    .split(/[,;\s]+/)
    .filter(Boolean)) {
    const m = part.match(/^(\d+)[:=](-?\d+)$/);
    if (!m) return null;
    out.push({ fromPrinted: Number(m[1]), offset: Number(m[2]) });
  }
  return out;
}

interface EditForm {
  name: string;
  nameFr: string;
  offset: string;
  ranges: string;
  all: boolean;
  tables: string[];
}

function EditBook({ book, tables, adminApi, onClose, onSaved }: { book: AdminBook; tables: BookTable[]; adminApi: AdminApi; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState<EditForm>({
    name: book.name,
    nameFr: book.nameFr,
    offset: String(book.offset),
    ranges: rangesToText(book.offsets),
    all: book.tables === 'all',
    tables: Array.isArray(book.tables) ? book.tables : [],
  });
  const [busy, setBusy] = useState(false);
  const [detected, setDetected] = useState<{ offset: number; ranges: string } | null>(null); // previewed by « Détecter » (saved only with the dialog)
  const set = (p: Partial<EditForm>) => setF((cur) => ({ ...cur, ...p }));
  const save = async () => {
    const offsets = textToRanges(f.ranges);
    if (offsets === null) return toast(t('Invalid ranges: write “page:offset”, e.g. 120:4, 250:6'), 'error');
    if (!/^-?\d+$/.test(f.offset.trim())) return toast(t('Invalid offset'), 'error');
    setBusy(true);
    try {
      const body: Record<string, unknown> = { name: f.name, nameFr: f.nameFr, tables: f.all ? 'all' : f.tables };
      const changed = Number(f.offset) !== book.offset || rangesToText(offsets) !== rangesToText(book.offsets);
      // Kept exactly as detected: apply the detection (offset no longer « manuel », confidence updated).
      const useDetected = detected && Number(f.offset) === detected.offset && rangesToText(offsets) === detected.ranges;
      if (changed && !useDetected) Object.assign(body, { offset: Number(f.offset), offsets });
      await adminApi(`/api/admin/books/${book.code}`, { method: 'PATCH', body });
      if (useDetected) await adminApi(`/api/admin/books/${book.code}/detect`, { method: 'POST' });
      toast(t('Book {code} saved', { code: book.code }), 'success');
      onSaved();
      onClose();
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const detect = async () => {
    setBusy(true);
    try {
      const r = await adminApi<{ book: AdminBook }>(`/api/admin/books/${book.code}/detect?apply=0`, { method: 'POST' });
      set({ offset: String(r.book.offset), ranges: rangesToText(r.book.offsets) });
      setDetected({ offset: r.book.offset, ranges: rangesToText(r.book.offsets) });
      toast(t('Detected offset: {off} (confidence {conf}) — “Save” to apply it', { off: offsetText(r.book), conf: pct(r.book.confidence) }), 'success');
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={t('Book {code}', { code: book.code })} width={620} onClose={onClose}>
      <div className="admin-form">
        <Field label={t('Name (English)')}>
          <input className="input" value={f.name} maxLength={120} onChange={(e) => set({ name: e.target.value })} />
        </Field>
        <Field label={t('Name (French)')}>
          <input className="input" value={f.nameFr} maxLength={120} onChange={(e) => set({ nameFr: e.target.value })} />
        </Field>
        <Field label={t('Offset')} hint={t('PDF page = printed page + offset.')}>
          <div className="row gap-s">
            <input className="input mono" style={{ width: 90 }} value={f.offset} onChange={(e) => set({ offset: e.target.value })} />
            <Button small onClick={detect} disabled={busy || !book.indexed} title={t('Reads the page numbers of the indexed PDF again')}>
              {t('Detect')}
            </Button>
          </div>
        </Field>
        <Field label={t('Offset changes (optional)')} hint={t('“page:offset” separated by commas, e.g. 120:4 — for books with unnumbered colour pages.')}>
          <input className="input mono" value={f.ranges} onChange={(e) => set({ ranges: e.target.value })} placeholder="120:4, 250:6" />
        </Field>
      </div>
      <div className="col" style={{ marginTop: 12 }}>
        <Toggle value={f.all} onChange={(v) => set({ all: v })} label={t('Readable by every table')} />
        {!f.all && (
          <div className="admin-worlds">
            {tables.map((tb) => (
              <label className="admin-world" key={tb.id}>
                <input
                  type="checkbox"
                  checked={f.tables.includes(tb.id)}
                  onChange={(e) => set({ tables: e.target.checked ? [...f.tables, tb.id] : f.tables.filter((x) => x !== tb.id) })}
                />
                <span>{tb.name}</span>
                <span className="mono">{tb.id}</span>
                {tb.archived && <Badge color="amber">{t('archived')}</Badge>}
              </label>
            ))}
            {!tables.length && <span className="muted small">{t('No table.')}</span>}
          </div>
        )}
      </div>
      <div className="row" style={{ justifyContent: 'flex-end', marginTop: 14, gap: 8 }}>
        <Button variant="ghost" onClick={onClose}>
          {t('Cancel')}
        </Button>
        <Button variant="primary" disabled={busy} onClick={save}>
          {t('Save')}
        </Button>
      </div>
    </Modal>
  );
}

function UploadBook({ known, maxBytes, token, onDone }: { known: BooksReply['known']; maxBytes: number; token: string; onDone: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [code, setCode] = useState('');
  const [replace, setReplace] = useState(false);
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const guess = (name: string) => {
    const n = name.toLowerCase().replace(/[^a-z0-9]+/g, ' ');
    if (/core ?rules|5th ?edition/.test(n)) return 'SR5';
    let best = '';
    for (const k of known) {
      const kn = k.name
        .toLowerCase()
        .replace(/&|\band\b/g, ' ')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
      if (kn && n.replace(/\band\b/g, ' ').replace(/\s+/g, ' ').includes(kn) && kn.length > best.length) best = k.code;
    }
    return best;
  };
  const submit = async () => {
    if (!file || !code) return;
    setProgress(0);
    try {
      const q = new URLSearchParams({ code: code.toUpperCase() });
      if (replace) q.set('replace', '1');
      await uploadWithProgress(`/api/admin/books/upload?${q}`, file, {
        token,
        headers: { 'X-Filename': encodeURIComponent(file.name).slice(0, 200) },
        onProgress: (p) => setProgress(p >= 1 ? 'server' : p),
      });
      toast(t('Book {code} received: indexing…', { code: code.toUpperCase() }), 'success');
      setFile(null);
      setCode('');
      setReplace(false);
      onDone();
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setProgress(null);
    }
  };
  const knownName = known.find((k) => k.code === code.toUpperCase());
  return (
    <div className="col">
      <div className="admin-file">
        <label className="btn">
          {t('Choose a PDF')}
          <input
            type="file"
            accept=".pdf,application/pdf"
            className="hidden"
            onChange={(e) => {
              const fl = e.target.files?.[0] || null;
              setFile(fl);
              if (fl && !code) setCode(guess(fl.name));
              e.target.value = '';
            }}
          />
        </label>
        {file ? (
          <span className="mono small">
            {file.name} ({fmtBytes(file.size)})
          </span>
        ) : (
          <span className="muted small">{t('No file chosen')}</span>
        )}
      </div>
      <div className="admin-form">
        <Field label={t('Book code')} hint={knownName ? knownName.name : t('Chummer code: SR5, RG, RF, SG, CF, DT, R5…')}>
          <input className="input mono" value={code} maxLength={12} list="admin-book-codes" onChange={(e) => setCode(e.target.value.toUpperCase())} />
          <datalist id="admin-book-codes">
            {known.map((k) => (
              <option key={k.code} value={k.code}>
                {k.name}
              </option>
            ))}
          </datalist>
        </Field>
        <Field label={t('If the code already exists')}>
          <Toggle value={replace} onChange={setReplace} label={t('Replace the PDF')} />
        </Field>
      </div>
      <span className="field-hint">{t('Max size: {size}. The text is extracted and the page offset detected automatically after the upload.', { size: fmtBytes(maxBytes) })}</span>
      {progress !== null && <Progress value={progress} serverLabel={t('Saving on the server…')} />}
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <Button variant="primary" disabled={!file || !code || progress !== null} onClick={submit}>
          {t('Send')}
        </Button>
      </div>
    </div>
  );
}

export default function BooksAdmin({ adminApi, token, run }: AdminPanelProps) {
  const [data, setData] = useState<BooksReply | null>(null);
  const [editing, setEditing] = useState<AdminBook | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const reload = () => run(async () => setData(await adminApi<BooksReply>('/api/admin/books')));
  useEffect(() => {
    reload();
    return () => clearTimeout(timer.current);
  }, []);
  // Poll while something is being indexed.
  const busy = (data?.jobs || []).some((j) => j.state === 'running' || j.state === 'queued');
  useEffect(() => {
    clearTimeout(timer.current);
    if (busy)
      timer.current = setTimeout(
        () =>
          adminApi<BooksReply>('/api/admin/books')
            .then(setData)
            .catch(() => {}),
        1500
      );
  }, [data]);

  if (!data) return <Empty>{t('Loading…')}</Empty>;
  const jobOf = (code: string) => data.jobs.find((j) => j.code === code);
  const reindex = (b: AdminBook) =>
    run(async () => {
      await adminApi(`/api/admin/books/${b.code}/reindex`, { method: 'POST', body: { detect: !b.manual } });
      reload();
    });
  const remove = async (b: AdminBook) => {
    const typed = await promptText(t('Delete book {code} ({name}) from the server? The PDF and its index will be erased. Type “{code}” to confirm:', { code: b.code, name: b.name }));
    if (typed === null) return;
    if (typed.trim().toUpperCase() !== b.code) return toast(t('Wrong code: nothing was deleted'), 'warn');
    run(async () => {
      await adminApi(`/api/admin/books/${b.code}`, { method: 'DELETE', body: { confirm: b.code } });
      toast(t('Book {code} deleted', { code: b.code }), 'success');
      reload();
    });
  };
  const tableNames = (b: AdminBook) => (b.tables === 'all' ? t('fem::all') : b.tables.map((id) => data.tables.find((x) => x.id === id)?.name || id).join(', ') || t('none'));

  return (
    <div className="col">
      {data.books.length ? (
        <div style={{ overflowX: 'auto' }}>
          <table className="sr admin-tables">
            <thead>
              <tr>
                <th>{t('Code')}</th>
                <th>{t('Book')}</th>
                <th className="right">{t('Pages')}</th>
                <th>{t('Offset')}</th>
                <th>{t('Index')}</th>
                <th>{t('Tables')}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {data.books.map((b) => {
                const j = jobOf(b.code);
                const running = !!j && (j.state === 'running' || j.state === 'queued');
                return (
                  <tr key={b.code}>
                    <td className="mono">{b.code}</td>
                    <td>
                      <div className="admin-name">{b.name}</div>
                      <div className="muted small">
                        {b.nameFr !== b.name ? b.nameFr : ''}
                        {b.size ? ` · ${fmtBytes(b.size)}` : ''}
                      </div>
                      {!b.present && <Badge color="red">{t('PDF missing')}</Badge>}
                    </td>
                    <td className="num-cell">{b.pages || '—'}</td>
                    <td className="small">
                      <span className="mono">{offsetText(b)}</span>
                      <div className="admin-badges">
                        {b.manual ? (
                          <Badge color="amber">{t('manual')}</Badge>
                        ) : (
                          b.confidence !== undefined && (
                            <Badge color={b.confidence >= 0.8 ? 'green' : 'amber'} title={t('Share of the pages whose printed number confirms the offset')}>
                              {pct(b.confidence)}
                            </Badge>
                          )
                        )}
                        {b.verified === true && (
                          <Badge color="green" title={t('Chummer’s reference sentence is on the right page')}>
                            {t('verified')}
                          </Badge>
                        )}
                      </div>
                    </td>
                    <td className="small">
                      {running && j ? (
                        <>
                          <Progress value={j.total ? (j.done || 0) / j.total : 0} serverLabel="" />
                          {j.total ? (
                            <span className="muted small">
                              {j.done}/{j.total}
                            </span>
                          ) : (
                            <span className="muted small">{t('queued…')}</span>
                          )}
                        </>
                      ) : j?.state === 'error' ? (
                        <Badge color="red" title={j.error ? tIfKnown(j.error, j.errorParams) : ''}>
                          {t('failed')}
                        </Badge>
                      ) : b.indexed ? (
                        fmtDate(b.indexedAt)
                      ) : (
                        <Badge color="amber">{t('not indexed')}</Badge>
                      )}
                    </td>
                    <td className="small">{tableNames(b)}</td>
                    <td>
                      <div className="admin-actions" style={{ minWidth: 0 }}>
                        <Button small onClick={() => setEditing(b)} disabled={running}>
                          {t('Edit')}
                        </Button>
                        <Button small variant="ghost" onClick={() => reindex(b)} disabled={running || !b.present}>
                          {t('Re-index')}
                        </Button>
                        <Button small variant="danger" onClick={() => remove(b)} disabled={running}>
                          {t('Delete')}
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty>{t('No book. Upload your PDFs below or run tools/books-setup.ts on the server.')}</Empty>
      )}
      <p className="field-hint">
        {tn(
          data.books.length,
          '{n} book shared by the allowed tables. Players read it from the “Rules” tab and the page references.',
          '{n} books shared by the allowed tables. Players read them from the “Rules” tab and the page references.'
        )}
      </p>
      <h4 className="section-title">{t('Add a book')}</h4>
      <UploadBook known={data.known} maxBytes={data.maxBytes} token={token} onDone={reload} />
      {editing && <EditBook book={editing} tables={data.tables} adminApi={adminApi} onClose={() => setEditing(null)} onSaved={reload} />}
    </div>
  );
}
