// « Upload » dialog of a missing book in the Règles library. Books are server-wide, so only the server administrator
// may add one: the dialog asks for the admin password (unless this tab already holds an admin session from /admin),
// then streams the PDF to the admin route POST /api/admin/books/upload. The server indexes it in the background.
import { useState, type FormEvent } from 'react';
import { Modal, Button, Field } from '../../lib/ui.tsx';
import { api, uploadWithProgress, type ServerError } from '../../lib/net.ts';
import { readAdminToken, writeAdminToken } from '../../lib/admin-token.ts';
import { toast } from '../../lib/ui-store.ts';
import { t } from '../../lib/i18n.ts';
import { bookName } from './BookRef.tsx';
import { fmtBytes } from '../admin/common.tsx';
import { loadBooks } from './store.ts';
import type { MissingBook } from './types.ts';

/** An expired or unknown admin session (the core answers 401 { code: 'admin-auth' }). */
const isAdminAuth = (e: ServerError) => e.code === 'admin-auth' || e.status === 401;

export default function UploadBook({ book, onClose }: { book: MissingBook; onClose: () => void }) {
  const [token, setToken] = useState(readAdminToken);
  const [password, setPassword] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [progress, setProgress] = useState<number | 'server' | null>(null);
  const [error, setError] = useState('');
  const busy = progress !== null;

  const login = async (): Promise<string | null> => {
    try {
      const r = await api<{ token: string }>('/api/admin/login', { method: 'POST', body: { password } });
      writeAdminToken(r.token);
      setToken(r.token);
      setPassword('');
      return r.token;
    } catch (err) {
      setError((err as Error).message);
      return null;
    }
  };

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!file || busy) return;
    setError('');
    const tok = token || (await login());
    if (!tok) return;
    setProgress(0);
    try {
      await uploadWithProgress(`/api/admin/books/upload?${new URLSearchParams({ code: book.code })}`, file, {
        token: tok,
        headers: { 'X-Filename': encodeURIComponent(file.name).slice(0, 200) },
        onProgress: (p) => setProgress(p >= 1 ? 'server' : p),
      });
      toast(t('Book {code} received: indexing…', { code: book.code }), 'success');
      loadBooks(true);
      onClose();
    } catch (err) {
      const se = err as ServerError;
      if (isAdminAuth(se)) {
        // Session expired since /admin or the last upload: ask for the password again.
        writeAdminToken('');
        setToken('');
        setError(t('Administrator session expired: enter the password again.'));
      } else setError(se.message);
    } finally {
      setProgress(null);
    }
  };

  const pct = progress === 'server' ? 100 : Math.round((progress || 0) * 100);
  return (
    <Modal
      title={t('Upload {code} — {name}', { code: book.code, name: bookName(book) })}
      onClose={busy ? undefined : onClose}
      width={520}
      actions={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t('Cancel')}
          </Button>
          <Button variant="primary" onClick={() => submit()} disabled={!file || busy || (!token && !password)}>
            {t('Upload')}
          </Button>
        </>
      }
    >
      <form className="col" onSubmit={submit}>
        <p className="muted small">
          {t('Rulebooks are shared by every table of this server, so only the server administrator can add one. The text is extracted and the page offset detected automatically after the upload.')}
        </p>
        <div className="row gap-s wrap">
          <label className="btn">
            {t('Choose a PDF')}
            <input
              type="file"
              accept=".pdf,application/pdf"
              className="hidden"
              disabled={busy}
              onChange={(e) => {
                setFile(e.target.files?.[0] || null);
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
        {token ? (
          <span className="muted small">{t('Signed in as server administrator in this tab.')}</span>
        ) : (
          <Field label={t('Server administrator password')}>
            <input className="input" type="password" autoComplete="current-password" value={password} disabled={busy} onChange={(e) => setPassword(e.target.value)} />
          </Field>
        )}
        {busy && (
          <div className="col gap-s">
            <div className="books-progress">
              <div className="books-progress-bar" style={{ width: `${pct}%` }} />
            </div>
            <span className="muted small">{progress === 'server' ? t('Saving on the server…') : t('Uploading… {pct}%', { pct })}</span>
          </div>
        )}
        {error && <div className="error small">{error}</div>}
        {/* Enter in the password field submits */}
        <button type="submit" className="hidden" aria-hidden="true" tabIndex={-1} />
      </form>
    </Modal>
  );
}
