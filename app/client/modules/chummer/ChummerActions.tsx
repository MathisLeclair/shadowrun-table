// Chummer5a interop UI: import a .chum5 (GM), export a sheet to .chum5, re-import with a diff confirmation,
// GM settings + approval of players' uploads. Server side: server/modules/85-chummer.js.
//   <ChummerImportButton />                — GM, CharactersPage: new actor from a file
//   <ChummerSheetBar game actor />         — sheet header (GM + owning player): export / update / status
//   <ChummerGmPanel game />                — CharactersPage: « autoriser les joueurs… » + pending requests
import { useRef, useState, type ComponentType, type ReactNode } from 'react';
import { Button, Badge, Toggle, Empty, confirmAction, type ButtonVariant } from '../../lib/ui.tsx';
import { send, api, getToken, type GameView } from '../../lib/net.ts';
import { openSheet, toast } from '../../lib/ui-store.ts';
import { t, tIfKnown, errorText, attrLabel, skillLabel, metatypeLabel, fmtDate } from '../../lib/i18n.ts';
import { Overlay as SheetOverlay } from '../sheet/common.tsx';
import type { ViewActor, I18nMessage } from '../../../shared/types.ts';
import type { ChummerDiff, ChummerPreview, ChummerRequestView } from './types.ts';
import './chummer.css';

// sheet/common.js is not converted yet: its Overlay's props are typed here (TS infers them all as required from the JS).
interface OverlayProps {
  title: ReactNode;
  onClose: () => void;
  width?: number;
  actions?: ReactNode;
  children?: ReactNode;
  class?: string;
  className?: string;
}
const Overlay = SheetOverlay as unknown as ComponentType<OverlayProps>;

const isGM = (game: GameView | null | undefined) => game?.me?.role === 'gm';

// fmtDate is untyped JS: its options type is inferred from its default value, hence the cast.
const WHEN_OPTS = { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' } as unknown as Parameters<typeof fmtDate>[1];
/** Short date + time ('26/11 14:05' in French). */
function fmtWhen(ts: number | null | undefined): string {
  if (!ts) return '';
  return fmtDate(ts, WHEN_OPTS);
}

/** Translatable server texts: `i18n` = [{ t, params }] when the server sent keys, else the French strings. */
const texts = (list: unknown[] | null | undefined, i18n: I18nMessage[] | null | undefined): string[] =>
  Array.isArray(i18n) && i18n.length ? i18n.map((w) => t(w.t, w.params)) : (list || []).map((w) => tIfKnown(String(w ?? '')));

/** Pending requests of the view (players see their own only). */
const requestsOf = (game: GameView): ChummerRequestView[] => (game.chummer?.pending || []) as unknown as ChummerRequestView[];

/** Hidden file input + trigger. onFile(file, text) */
function useFilePicker(onFile: (file: File, text: string) => void): [ReactNode, () => void] {
  const ref = useRef<HTMLInputElement>(null);
  const input = (
    <input
      ref={ref}
      type="file"
      accept=".chum5,.xml,.json"
      hidden
      onChange={async (e) => {
        const file = e.target.files?.[0];
        e.target.value = '';
        if (!file) return;
        if (file.size > 20e6) return toast(t('Fichier trop gros (20 Mo max)'), 'error');
        try {
          onFile(file, await file.text());
        } catch (err) {
          toast((err as Error).message || t('Lecture du fichier impossible'), 'error');
        }
      }}
    />
  );
  return [input, () => ref.current?.click()];
}

const postText = <R = any,>(url: string, text: string) =>
  api<R>(url, { method: 'POST', body: new Blob([text], { type: 'text/plain' }), headers: { 'Content-Type': 'text/plain; charset=utf-8' } });

const parseHeaderJson = (v: string | null) => {
  try {
    return JSON.parse(decodeURIComponent(v || '%5B%5D'));
  } catch {
    return [];
  }
};

interface ExportResult {
  name: string;
  warnings: string[];
  warningsI18n: I18nMessage[];
  mode: string;
}

/** Download the actor as .chum5. Resolves with the server's warnings (French + translatable copy). */
export async function downloadChum5(actor: { id: string; name?: string }): Promise<ExportResult> {
  const res = await fetch(`/api/chummer/export/${encodeURIComponent(actor.id)}`, { headers: { Authorization: `Bearer ${getToken()}` } });
  if (!res.ok) {
    let msg = res.statusText;
    try {
      const body = await res.json();
      if (body?.error || body?.errorKey) msg = errorText(body);
    } catch {}
    throw new Error(msg);
  }
  const blob = await res.blob();
  const cd = res.headers.get('content-disposition') || '';
  const star = cd.match(/filename\*=UTF-8''([^;]+)/i);
  const plain = cd.match(/filename="([^"]+)"/i);
  const name = star ? decodeURIComponent(star[1]) : plain ? plain[1] : `${actor.name || 'personnage'}.chum5`;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  const warnings = parseHeaderJson(res.headers.get('x-chummer-warnings'));
  const warningsI18n = parseHeaderJson(res.headers.get('x-chummer-warnings-i18n'));
  return { name, warnings, warningsI18n, mode: res.headers.get('x-chummer-mode') || '' };
}

// A whole translated sentence with one part in bold: the sentence is translated with MARK as that part, then split.
const MARK = '\u0001';
function withBold(sentence: string, bold: ReactNode) {
  const [before, after = ''] = sentence.split(MARK);
  return (
    <>
      {before}
      <b>{bold}</b>
      {after}
    </>
  );
}

// ---------------------------------------------------------------------------
// Diff view
// ---------------------------------------------------------------------------
// Scalar values the server stores as French words (translated when known); other values are data.
const TRANSLATED_VALUES = new Set(['Description', 'Notes']);
function scalarValue(s: { label: string }, v: unknown): string {
  const text = String(v);
  if (s.label === 'Métatype') return metatypeLabel(text);
  return TRANSLATED_VALUES.has(s.label) ? tIfKnown(text) : text;
}

export function DiffView({ diff }: { diff: ChummerDiff | null | undefined }) {
  if (!diff) return null;
  if (diff.empty) return <Empty>{t('Aucune différence avec la fiche actuelle.')}</Empty>;
  return (
    <div className="chm-diff">
      {diff.scalars.length > 0 && (
        <section>
          <h4 className="chm-diff-h">{t('Général')}</h4>
          <table className="sr chm-diff-table">
            <tbody>
              {diff.scalars.map((s) => (
                <tr key={s.label}>
                  <td>{tIfKnown(s.label)}</td>
                  <td className="chm-from">{scalarValue(s, s.from)}</td>
                  <td className="chm-arrow">→</td>
                  <td className="chm-to">{scalarValue(s, s.to)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
      {diff.attributes.length > 0 && (
        <section>
          <h4 className="chm-diff-h">{t('Attributs')}</h4>
          <table className="sr chm-diff-table">
            <tbody>
              {diff.attributes.map((s) => (
                <tr key={s.key || s.label}>
                  <td>{s.key ? attrLabel(s.key) : s.label}</td>
                  <td className="chm-from">{String(s.from)}</td>
                  <td className="chm-arrow">→</td>
                  <td className="chm-to">{String(s.to)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
      {diff.skills.length > 0 && (
        <section>
          <h4 className="chm-diff-h">{t('Compétences')}</h4>
          <table className="sr chm-diff-table">
            <tbody>
              {diff.skills.map((s) => (
                <tr key={s.id}>
                  <td>{skillLabel({ id: s.id, name: s.name })}</td>
                  <td className="chm-from">{String(s.from)}</td>
                  <td className="chm-arrow">→</td>
                  <td className="chm-to">{String(s.to)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
      {diff.lists.length > 0 && (
        <section>
          <h4 className="chm-diff-h">{t('Inventaire, qualités, contacts…')}</h4>
          {diff.lists.map((l) => (
            <div className="chm-diff-list" key={l.list}>
              <div className="chm-diff-listname">{tIfKnown(l.label)}</div>
              <ul>
                {l.added.map((n, i) => (
                  <li className="chm-add" key={'a' + i}>
                    + {n}
                  </li>
                ))}
                {l.removed.map((n, i) => (
                  <li className="chm-del" key={'r' + i}>
                    − {n}
                  </li>
                ))}
                {l.changed.map((n, i) => (
                  <li className="chm-chg" key={'c' + i}>
                    ~ {n}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}

function Warnings({ list, i18n }: { list?: unknown[] | null; i18n?: I18nMessage[] | null }) {
  const items = texts(list, i18n);
  if (!items.length) return null;
  return (
    <div className="chm-warn">
      <b>{t('Points d’attention')}</b>
      <ul>
        {items.map((w, i) => (
          <li key={i}>{w}</li>
        ))}
      </ul>
    </div>
  );
}

interface UpdateDialogProps {
  actor: { name: string };
  preview: ChummerPreview;
  busy: boolean;
  onConfirm: () => void;
  onClose: () => void;
  gm: boolean;
}

/** Confirmation dialog for a re-import. */
function UpdateDialog({ actor, preview, busy, onConfirm, onClose, gm }: UpdateDialogProps) {
  const needsApproval = preview.needsApproval;
  // `class` = what the unconverted Overlay (sheet/common.js) reads; className for when it is converted.
  return (
    <Overlay title={t('Mettre à jour {name} depuis Chummer', { name: actor.name })} onClose={onClose} width={680} class="chm-modal" className="chm-modal">
      <div className="col">
        <div className="muted small">
          {withBold(t('Fichier {file}', { file: MARK }), preview.fileName || t('(sans nom)'))}
          {preview.created === false ? (
            <>
              {' · '}
              <Badge color="amber">{t('mode création')}</Badge>
            </>
          ) : null}
          {preview.linked
            ? ` — ${t('fusion avec la dernière version synchronisée : les changements faits dans l’app depuis (récompenses, achats, dégâts…) sont conservés quand Chummer ne les a pas modifiés.')}`
            : ` — ${t('fiche non liée à Chummer jusqu’ici : les valeurs du fichier remplacent celles de la fiche (historique, notes MJ, portrait et entraînements sont conservés).')}`}
        </div>
        <Warnings list={preview.warnings} i18n={preview.warningsI18n} />
        <DiffView diff={preview.diff} />
        <div className="row spread wrap">
          <span className="muted small">{needsApproval ? t('Le MJ doit valider cette mise à jour.') : gm ? '' : t('Le MJ a autorisé les mises à jour depuis Chummer.')}</span>
          <div className="row">
            <Button variant="ghost" onClick={onClose}>
              {t('Annuler')}
            </Button>
            <Button variant="primary" disabled={busy || preview.diff?.empty} onClick={onConfirm}>
              {needsApproval ? t('Envoyer au MJ') : t('Appliquer les changements')}
            </Button>
          </div>
        </div>
      </div>
    </Overlay>
  );
}

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------
interface ImportButtonProps {
  type?: string;
  /** Already translated text (default: « Importer un .chum5 »). */
  label?: ReactNode;
  variant?: ButtonVariant;
  small?: boolean;
}

/** GM: create a new actor from a .chum5 (or an exported JSON sheet). `label` = already translated text (default: « Importer un .chum5 »). */
export function ChummerImportButton({ type = 'pc', label, variant = 'ghost', small }: ImportButtonProps) {
  const [busy, setBusy] = useState(false);
  const [input, pick] = useFilePicker(async (file, text) => {
    setBusy(true);
    try {
      const res = await postText<{ actorId: string; warnings?: string[]; warningsI18n?: I18nMessage[] }>(`/api/chummer/import?type=${type}&fileName=${encodeURIComponent(file.name)}`, text);
      toast(t('Fiche importée : {name}', { name: file.name }), 'success');
      const warnings = texts(res.warnings, res.warningsI18n);
      if (warnings.length) toast(warnings[0], 'warn', 7000);
      openSheet(res.actorId);
    } catch (err) {
      toast((err as Error).message || t('Import impossible'), 'error');
    } finally {
      setBusy(false);
    }
  });
  return (
    <>
      <Button variant={variant} small={small} disabled={busy} onClick={pick} title={t('Fiche Chummer5a (.chum5) ou export JSON d’une fiche')}>
        {busy ? t('Import…') : (label ?? t('Importer un .chum5'))}
      </Button>
      {input}
    </>
  );
}

/** Export button + warnings dialog. */
export function ChummerExportButton({ actor, small = true }: { actor: { id: string; name?: string }; small?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [warn, setWarn] = useState<ExportResult | null>(null);
  const go = async () => {
    setBusy(true);
    try {
      const r = await downloadChum5(actor);
      toast(t('{file} téléchargé', { file: r.name }), 'success');
      if (r.warnings.length || r.warningsI18n.length) setWarn(r);
    } catch (err) {
      toast((err as Error).message || t('Export impossible'), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Button small={small} variant="ghost" disabled={busy} onClick={go} title={t('Télécharger la fiche au format Chummer5a pour l’ouvrir et la modifier dans Chummer')}>
        ⇩ {busy ? t('Export…') : t('Exporter vers Chummer (.chum5)')}
      </Button>
      {warn && (
        <Overlay title={t('Export Chummer : points d’attention')} onClose={() => setWarn(null)} width={560}>
          <div className="col">
            <div className="muted small">
              {warn.mode === 'generate'
                ? t('{file} a été téléchargé. Le fichier a été généré à partir de la fiche de l’app (aucun fichier Chummer d’origine).', { file: warn.name })
                : t('{file} a été téléchargé. Le fichier Chummer d’origine a été mis à jour.', { file: warn.name })}
            </div>
            <Warnings list={warn.warnings} i18n={warn.warningsI18n} />
            <div className="muted small">
              {withBold(t('Dans Chummer, utilise {menu} pour recalculer les bonus des objets ajoutés depuis l’app.', { menu: MARK }), t('Spécial › Réappliquer les améliorations'))}
            </div>
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <Button variant="primary" onClick={() => setWarn(null)}>
                {t('OK')}
              </Button>
            </div>
          </div>
        </Overlay>
      )}
    </>
  );
}

/** Re-import a .chum5 into an existing actor, with a diff confirmation. */
export function ChummerUpdateButton({ game, actor, small = true }: { game: GameView; actor: { id: string; name: string }; small?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<ChummerPreview | null>(null);
  const gm = isGM(game);
  const [input, pick] = useFilePicker(async (file, text) => {
    setBusy(true);
    try {
      const p = await postText<Omit<ChummerPreview, 'text' | 'fileName'>>(`/api/chummer/preview?actorId=${encodeURIComponent(actor.id)}&fileName=${encodeURIComponent(file.name)}`, text);
      setPreview({ ...p, text, fileName: file.name });
    } catch (err) {
      toast((err as Error).message || t('Fichier illisible'), 'error');
    } finally {
      setBusy(false);
    }
  });
  const confirm = async () => {
    if (!preview) return;
    setBusy(true);
    try {
      const r = await postText<{ applied?: boolean }>(`/api/chummer/update?actorId=${encodeURIComponent(actor.id)}&fileName=${encodeURIComponent(preview.fileName)}`, preview.text);
      toast(r.applied ? t('{name} mis à jour depuis Chummer', { name: actor.name }) : t('Demande envoyée au MJ'), r.applied ? 'success' : 'info');
      setPreview(null);
    } catch (err) {
      toast((err as Error).message || t('Mise à jour impossible'), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Button small={small} variant="ghost" disabled={busy} onClick={pick} title={t('Recharger la fiche depuis un fichier Chummer modifié (aperçu des changements avant validation)')}>
        ⇧ {busy && !preview ? t('Lecture…') : t('Mettre à jour depuis un .chum5')}
      </Button>
      {input}
      {preview && <UpdateDialog actor={actor} preview={preview} busy={busy} gm={gm} onConfirm={confirm} onClose={() => setPreview(null)} />}
    </>
  );
}

/** Strip shown in the sheet header for the GM and the owning player. */
export function ChummerSheetBar({ game, actor }: { game: GameView; actor: ViewActor }) {
  const gm = isGM(game);
  const own = gm || (game?.me?.characterIds || []).includes(actor.id);
  if (!own || !('attributes' in actor) || !actor.attributes) return null;
  const info = actor.chummer;
  const requests = requestsOf(game);
  const pending = requests.filter((r) => r.actorId === actor.id && r.status === 'pending');
  const lastDone = !gm && requests.filter((r) => r.actorId === actor.id && r.status !== 'pending').sort((a, b) => (b.resolvedAt || 0) - (a.resolvedAt || 0))[0];
  const unlink = async () => {
    if (!(await confirmAction(t('Délier {name} de son fichier Chummer ? Le prochain export générera un nouveau fichier.', { name: actor.name })))) return;
    send('chummer/unlink', { actorId: actor.id })
      .then(() => toast(t('Fiche déliée de Chummer'), 'success'))
      .catch(() => {});
  };
  return (
    <div className="chm-bar">
      <span className="chm-logo" title="Chummer5a">
        C5
      </span>
      <span className="chm-status small">
        {info ? (
          <>
            {withBold(t('Liée à {file}', { file: MARK }), info.fileName || t('un fichier Chummer'))}
            <span className="faint"> · {t('synchro {when}', { when: fmtWhen(info.syncedAt || info.exportedAt || info.importedAt) })}</span>
            {info.created === false ? (
              <>
                {' '}
                <Badge color="amber" title={t('Le personnage n’est pas finalisé dans Chummer')}>
                  {t('création')}
                </Badge>
              </>
            ) : null}
          </>
        ) : (
          <span className="muted">{t('Pas encore lié à Chummer')}</span>
        )}
        {actor.realName && <span className="faint"> · {t('nom réel : {name}', { name: actor.realName })}</span>}
        {pending.length > 0 && (
          <>
            {' '}
            <Badge color="amber">{t('mise à jour en attente du MJ')}</Badge>
          </>
        )}
        {lastDone && (
          <>
            {' '}
            <Badge color={lastDone.status === 'approved' ? 'green' : 'red'} title={lastDone.gmNote || ''}>
              {lastDone.status === 'approved' ? t('dernière demande validée') : t('dernière demande refusée')}
            </Badge>
          </>
        )}
      </span>
      <div className="row wrap gap-s chm-actions">
        <ChummerExportButton actor={actor} />
        <ChummerUpdateButton game={game} actor={actor} />
        {!gm && pending.length > 0 && (
          <Button small variant="ghost" onClick={() => send('chummer/cancel', { requestId: pending[0].id }).catch(() => {})}>
            {t('Annuler la demande')}
          </Button>
        )}
        {gm && info && (
          <Button small variant="ghost" onClick={unlink} title={t('Oublier le fichier Chummer associé')}>
            {t('Délier')}
          </Button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// GM panel (CharactersPage)
// ---------------------------------------------------------------------------
function RequestRow({ game, r }: { game: GameView; r: ChummerRequestView }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const actor = game.actors?.[r.actorId];
  const name = actor?.name || r.actorName;
  const resolve = async (approve: boolean) => {
    setBusy(true);
    try {
      await send('chummer/resolve', { requestId: r.id, approve });
      toast(approve ? t('{name} mis à jour', { name }) : t('Demande refusée'), approve ? 'success' : 'info');
      setOpen(false);
    } catch {
    } finally {
      setBusy(false);
    }
  };
  const summary = Array.isArray(r.summaryI18n) ? r.summaryI18n.map((p) => t(p.t, p.params)).join(', ') : tIfKnown(r.summary);
  return (
    <div className="chm-req">
      <div className="chm-req-main">
        <button type="button" className="chm-req-name" onClick={() => actor && openSheet(actor.id)}>
          {name}
        </button>
        <span className="muted small">{t('par {user} · {when} · {file}', { user: r.userName, when: fmtWhen(r.ts), file: r.fileName || t('fichier .chum5') })}</span>
        <div className="small">{summary}</div>
      </div>
      <div className="row gap-s">
        <Button small variant="ghost" onClick={() => setOpen(true)}>
          {t('Voir les changements')}
        </Button>
        <Button small variant="danger" disabled={busy} onClick={() => resolve(false)}>
          {t('Refuser')}
        </Button>
        <Button small variant="primary" disabled={busy} onClick={() => resolve(true)}>
          {t('Valider')}
        </Button>
      </div>
      {open && (
        <Overlay title={t('Demande de {user} — {name}', { user: r.userName, name })} onClose={() => setOpen(false)} width={680}>
          <div className="col">
            <div className="muted small">{t('Changements calculés à l’envoi de la demande ; ils seront recalculés sur la fiche actuelle au moment de la validation.')}</div>
            <Warnings list={r.warnings} i18n={r.warningsI18n} />
            <DiffView diff={r.diff} />
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <Button variant="ghost" onClick={() => setOpen(false)}>
                {t('Fermer')}
              </Button>
              <Button variant="danger" disabled={busy} onClick={() => resolve(false)}>
                {t('Refuser')}
              </Button>
              <Button variant="primary" disabled={busy} onClick={() => resolve(true)}>
                {t('Valider')}
              </Button>
            </div>
          </div>
        </Overlay>
      )}
    </div>
  );
}

export function ChummerGmPanel({ game }: { game: GameView }) {
  if (!isGM(game)) return null;
  const s = game.chummer || { allowPlayerImport: true, pending: [] };
  const pending = requestsOf(game).filter((r) => r.status === 'pending');
  return (
    <section className="panel chm-panel">
      <header className="panel-head">
        <h3>
          <span className="chm-logo">C5</span> Chummer {pending.length > 0 && <Badge color="amber">{t('{n} demande(s)', { n: pending.length })}</Badge>}
        </h3>
        <div className="panel-actions">
          <Toggle
            value={s.allowPlayerImport !== false}
            onChange={(v) => send('chummer/settings', { allowPlayerImport: v }).catch(() => {})}
            label={t('Autoriser les joueurs à importer depuis Chummer')}
            title={t('Activé : les joueurs mettent à jour leur fiche eux-mêmes. Désactivé : chaque envoi crée une demande à valider ici.')}
          />
        </div>
      </header>
      <div className="panel-body">
        {pending.length ? (
          <div className="chm-reqs">
            {pending.map((r) => (
              <RequestRow key={r.id} game={game} r={r} />
            ))}
          </div>
        ) : (
          <div className="muted small">
            {s.allowPlayerImport !== false
              ? t('Les joueurs peuvent exporter leur fiche (.chum5), la modifier dans Chummer puis la recharger eux-mêmes depuis leur fiche.')
              : t('Les mises à jour envoyées par les joueurs apparaîtront ici pour validation.')}
          </div>
        )}
      </div>
    </section>
  );
}
