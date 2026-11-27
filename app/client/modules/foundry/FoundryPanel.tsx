// GM panel (Réglages): import / re-sync the Foundry VTT world — PCs, NPC templates, scenes → maps, journals, playlists.
import { useEffect, useMemo, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react';
import { Button, Panel, Field, Badge, Toggle, confirmAction } from '../../lib/ui.tsx';
import { send, useServerEvent, type GameProps } from '../../lib/net.ts';
import { toast } from '../../lib/ui-store.ts';
import { t, tn, tk, tIfKnown, fmtDate, fmtNumber, fmtNuyen } from '../../lib/i18n.js';
import type { AudioJob, I18nText, ImportResult, ScanResult, ScanStatus, Selection, SetKey, WorldsReply } from './types.ts';
import './foundry.css';

const STATUS: Record<ScanStatus, { label: string; color: string }> = {
  new: { label: tk('Nouveau'), color: 'cyan' },
  update: { label: tk('Mise à jour'), color: 'amber' },
  unchanged: { label: tk('À jour'), color: 'green' },
};
const KIND_LABELS: Record<string, string> = { music: tk('Musique'), ambient: tk('Ambiance'), sfx: tk('Bruitages') };

function StatusBadge({ status }: { status: ScanStatus }) {
  const s = STATUS[status] || STATUS.new;
  return <Badge color={s.color}>{t(s.label)}</Badge>;
}

const dateText = (ts: number | undefined) => (ts ? fmtDate(ts) : '');

/** Byte size in the UI language ('12,3 Mo' / '12.3 MB'); falls back to the server's French text. */
function sizeText(bytes: number | undefined, fallback = ''): string {
  const v = Number(bytes);
  if (!Number.isFinite(v)) return fallback;
  const one = { minimumFractionDigits: 1, maximumFractionDigits: 1 };
  if (v >= 1e9) return t('{v} Go', { v: fmtNumber(v / 1e9, one) });
  if (v >= 1e6) return t('{v} Mo', { v: fmtNumber(v / 1e6, one) });
  if (v >= 1e3) return t('{v} ko', { v: fmtNumber(Math.round(v / 1e3)) });
  return t('{v} o', { v: fmtNumber(v) });
}

/** Diff line of a PC: translatable entry from the server ({ t, params }), or a plain (French) string from an older server. */
const diffText = (d: I18nText | string | null | undefined) => (d && typeof d === 'object' ? t(d.t, d.params) : tIfKnown(String(d ?? '')));

/** A whole translated sentence with one {placeholder} rendered as <code> (the sentence is never cut into fragments). */
function withCode(key: string, params: Record<string, unknown>, name: string, code: ReactNode) {
  const MARK = '\u0001';
  const [before, after = ''] = t(key, { ...params, [name]: MARK }).split(MARK);
  return (
    <>
      {before}
      <code>{code}</code>
      {after}
    </>
  );
}

/** Default selection: everything new or changed. */
function defaultSelection(scan: ScanResult): Selection {
  const pickIds = (list: Array<{ status: ScanStatus; fid: string }>) => new Set(list.filter((x) => x.status !== 'unchanged').map((x) => x.fid));
  return {
    pcs: pickIds(scan.pcs),
    npcs: pickIds(scan.npcs),
    scenes: pickIds(scan.scenes),
    journals: scan.journals.docs.some((d) => d.status !== 'unchanged'),
    playlists: scan.playlists.some((p) => p.newTracks > 0 && p.tracks > 0),
  };
}

interface SectionHeadProps {
  title: ReactNode;
  count: number;
  total: number;
  onAll?: () => void;
  onNone?: () => void;
  children?: ReactNode;
}
function SectionHead({ title, count, total, onAll, onNone, children }: SectionHeadProps) {
  return (
    <div className="foundry-section-head">
      <h4>
        {title} <span className="muted small">{tn(count, '{n}/{total} sélectionné', '{n}/{total} sélectionnés', { total })}</span>
      </h4>
      <div className="row gap-s">
        {children}
        {onAll && (
          <Button small variant="ghost" onClick={onAll}>
            {t('sélection::Tout')}
          </Button>
        )}
        {onNone && (
          <Button small variant="ghost" onClick={onNone}>
            {t('sélection::Aucun')}
          </Button>
        )}
      </div>
    </div>
  );
}

function Check({ checked, onChange, label }: { checked: boolean; onChange: (on: boolean) => void; label: string }) {
  return <input type="checkbox" className="foundry-check" aria-label={label} checked={!!checked} onChange={(e) => onChange(e.target.checked)} />;
}

interface Counts {
  pcs: number;
  npcs: number;
  scenes: number;
  journals: number;
  playlists: number;
}
/** Selected counts as a short list: '4 PJ · 2 PNJ · 3 cartes'. */
function countsText(c: Counts) {
  const parts = [
    c.pcs && tn(c.pcs, '{n} PJ', 'pluriel::{n} PJ'),
    c.npcs && tn(c.npcs, '{n} PNJ', 'pluriel::{n} PNJ'),
    c.scenes && tn(c.scenes, 'un::{n} cartes', '{n} cartes'),
    c.journals && tn(c.journals, 'un::{n} journaux', '{n} journaux'),
    c.playlists && tn(c.playlists, 'un::{n} pistes', '{n} pistes'),
  ].filter(Boolean);
  return parts.join(' · ') || t('Rien de sélectionné');
}

export default function FoundryPanel({ game }: GameProps) {
  const [worldPath, setWorldPath] = useState(game.foundry?.worldPath || '');
  const [worlds, setWorlds] = useState<NonNullable<WorldsReply['worlds']>>([]);
  const [busy, setBusy] = useState('');
  const [scan, setScan] = useState<ScanResult | null>(null);
  const [sel, setSel] = useState<Selection | null>(null);
  const [pcMode, setPcMode] = useState<'merge' | 'replace'>('merge');
  const [assignPlayers, setAssignPlayers] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [audio, setAudio] = useState<AudioJob | null>(null);
  const last = game.foundry?.lastImport || null;

  useEffect(() => {
    send<WorldsReply>('foundry/worlds', {}, { silent: true })
      .then((r) => {
        setWorlds(r.worlds || []);
        if (!worldPath) setWorldPath(r.detected || '');
      })
      .catch(() => {});
  }, []);

  useServerEvent(
    'foundry/audio',
    (p: AudioJob | null) => {
      setAudio(p);
      if (p && !p.running && !p.error && p.total) toast(t('Fichiers audio Foundry copiés'), 'success');
    },
    []
  );

  const doScan = async () => {
    setBusy('scan');
    setResult(null);
    try {
      const r = await send<ScanResult>('foundry/scan', { worldPath });
      setScan(r);
      setSel(defaultSelection(r));
      if (r.world?.path) setWorldPath(r.world.path);
      if (r.audioJob) setAudio({ ...r.audioJob, running: true });
    } catch {
      /* toast shown by send() */
    } finally {
      setBusy('');
    }
  };

  const counts = useMemo<Counts | null>(() => {
    if (!scan || !sel) return null;
    return { pcs: sel.pcs.size, npcs: sel.npcs.size, scenes: sel.scenes.size, journals: sel.journals ? scan.journals.docs.length : 0, playlists: sel.playlists ? scan.playlists.reduce((s, p) => s + p.tracks, 0) : 0 };
  }, [scan, sel]);
  const nothing = !!counts && !counts.pcs && !counts.npcs && !counts.scenes && !counts.journals && !counts.playlists;

  // Only called from the scan view, which renders once a selection exists.
  const toggleIn = (key: SetKey, id: string, on: boolean) =>
    setSel((s) => {
      const next = new Set(s![key]);
      if (on) next.add(id);
      else next.delete(id);
      return { ...s!, [key]: next };
    });
  const setAll = (key: SetKey, list: Array<{ fid: string }>) => setSel((s) => ({ ...s!, [key]: new Set(list.map((x) => x.fid)) }));
  const setNone = (key: SetKey) => setSel((s) => ({ ...s!, [key]: new Set() }));

  const doImport = async () => {
    if (!counts || !sel) return;
    const parts = [];
    if (counts.pcs) parts.push(pcMode === 'merge' ? t('{n} personnage(s) joueur(s) en mode fusion', { n: counts.pcs }) : t('{n} personnage(s) joueur(s) en mode remplacement', { n: counts.pcs }));
    if (counts.npcs) parts.push(tn(counts.npcs, '{n} PNJ', 'pluriel::{n} PNJ'));
    if (counts.scenes) parts.push(t('{n} carte(s)', { n: counts.scenes }));
    if (counts.journals) parts.push(tn(counts.journals, 'un::{n} journaux', '{n} journaux'));
    if (counts.playlists) parts.push(tn(counts.playlists, 'un::{n} pistes audio', '{n} pistes audio'));
    if (!(await confirmAction(t('Importer depuis Foundry : {parts} ?\n\nUne sauvegarde de la partie est conseillée avant (bouton « Créer une sauvegarde »).', { parts: parts.join(', ') })))) return;
    setBusy('import');
    try {
      const r = await send<ImportResult>('foundry/import', {
        worldPath,
        pcMode,
        assignPlayers,
        select: { pcs: [...sel.pcs], npcs: [...sel.npcs], scenes: [...sel.scenes], journals: sel.journals, playlists: sel.playlists },
      });
      setResult(r);
      toast(r.textI18n?.key ? t(r.textI18n.key, r.textI18n.params) : r.text ? tIfKnown(r.text) : t('Import terminé'), 'success');
      if (r.audio?.queued) setAudio({ total: r.audio.files, done: 0, bytes: r.audio.bytes, running: true });
      // Refresh statuses (fast: the world is cached server-side).
      const again = await send<ScanResult>('foundry/scan', { worldPath }, { silent: true }).catch(() => null);
      if (again) {
        setScan(again);
        setSel(defaultSelection(again));
      }
    } catch {
      /* toast shown */
    } finally {
      setBusy('');
    }
  };

  return (
    <Panel
      title={t('Foundry VTT — synchronisation')}
      className="foundry-panel"
      actions={last && <span className="small muted">{t('Dernier import : {date} ({world})', { date: dateText(last.ts), world: last.worldTitle || last.worldId })}</span>}
    >
      <div className="col">
        <p className="muted small foundry-intro">
          {t('Importe le monde Foundry du MJ : fiches des PJ, PNJ (vers le bestiaire), scènes (cartes avec leurs murs, portes et lumières), journaux (documents de campagne) et playlists.')}
          <strong> {t("Foundry reste la source de vérité pour les fiches : relance l'import avant chaque séance si tes joueurs ont modifié leur fiche dans Foundry.")}</strong>
          {' '}
          {t('Foundry peut rester ouvert : la base est lue depuis une copie.')}
        </p>
        <Field label={t('Dossier du monde Foundry')} hint={t('Détecté automatiquement depuis la configuration de Foundry (options.json → dataPath).')}>
          <div className="row">
            <input className="input grow mono" list="foundry-worlds" value={worldPath} onChange={(e) => setWorldPath(e.target.value)} placeholder={t('C:/Users/…/Foundry/Data/worlds/mon-monde')} />
            <datalist id="foundry-worlds">
              {worlds
                .filter((w) => w.system === 'shadowrun5e')
                .map((w) => (
                  <option key={w.path} value={w.path}>
                    {w.title}
                  </option>
                ))}
            </datalist>
            <Button variant="primary" disabled={!!busy || !worldPath} onClick={doScan}>
              {busy === 'scan' ? t('Analyse…') : scan ? t('Analyser à nouveau') : t('Analyser')}
            </Button>
          </div>
        </Field>

        {audio && (
          <div className="foundry-audio">
            {audio.error ? (
              <Badge color="red">{t('Audio : {error}', { error: tIfKnown(audio.error) })}</Badge>
            ) : audio.running ? (
              <>
                <span className="small">{t('Copie des fichiers audio… {done}/{total}', { done: audio.done || 0, total: audio.total || '?' })}</span>
                <div className="foundry-progress">
                  <div style={{ width: `${audio.total ? Math.round(((audio.done || 0) / audio.total) * 100) : 0}%` }}></div>
                </div>
              </>
            ) : (
              <span className="small foundry-ok">{tn(audio.total, 'Audio prêt ({n} fichier).', 'Audio prêt ({n} fichiers).')}</span>
            )}
          </div>
        )}

        {scan && sel && (
          <ScanView
            scan={scan}
            sel={sel}
            setSel={setSel}
            toggleIn={toggleIn}
            setAll={setAll}
            setNone={setNone}
            pcMode={pcMode}
            setPcMode={setPcMode}
            assignPlayers={assignPlayers}
            setAssignPlayers={setAssignPlayers}
          />
        )}

        {scan && (
          <div className="row wrap foundry-actions">
            <Button variant="accent" disabled={!!busy || nothing} onClick={doImport}>
              {busy === 'import' ? t('Import en cours…') : t('Importer la sélection')}
            </Button>
            {counts && <span className="small muted">{countsText(counts)}</span>}
          </div>
        )}

        {result && <ResultView result={result} />}
      </div>
    </Panel>
  );
}

interface ScanViewProps {
  scan: ScanResult;
  sel: Selection;
  setSel: Dispatch<SetStateAction<Selection | null>>;
  toggleIn: (key: SetKey, id: string, on: boolean) => void;
  setAll: (key: SetKey, list: Array<{ fid: string }>) => void;
  setNone: (key: SetKey) => void;
  pcMode: 'merge' | 'replace';
  setPcMode: (mode: 'merge' | 'replace') => void;
  assignPlayers: boolean;
  setAssignPlayers: (on: boolean) => void;
}
function ScanView({ scan, sel, setSel, toggleIn, setAll, setNone, pcMode, setPcMode, assignPlayers, setAssignPlayers }: ScanViewProps) {
  const w = scan.world || {};
  return (
    <div className="col foundry-scan">
      <div className="row wrap small muted">
        <Badge color="cyan">{w.title || w.id}</Badge>
        <span>{t('Système {system} {version} · Foundry {core}', { system: w.system, version: w.systemVersion || '', core: w.coreVersion || '' })}</span>
        {scan.missingAssets?.length ? <span title={scan.missingAssets.join('\n')}>· {t('{n} fichier(s) introuvable(s) dans Foundry', { n: scan.missingAssets.length })}</span> : null}
      </div>

      <section className="foundry-section">
        <SectionHead title={t('Personnages joueurs')} count={sel.pcs.size} total={scan.pcs.length} onAll={() => setAll('pcs', scan.pcs)} onNone={() => setNone('pcs')} />
        <div className="foundry-modes">
          <label className={pcMode === 'merge' ? 'on' : ''}>
            <input type="radio" name="foundry-pcmode" checked={pcMode === 'merge'} onChange={() => setPcMode('merge')} />
            <span>
              <strong>{t('Fusionner')}</strong> — {t("ne reprend que ce qui a changé dans Foundry depuis le dernier import ; les achats et entraînements faits dans l'app sont conservés.")}
            </span>
          </label>
          <label className={pcMode === 'replace' ? 'on' : ''}>
            <input type="radio" name="foundry-pcmode" checked={pcMode === 'replace'} onChange={() => setPcMode('replace')} />
            <span>
              <strong>{t('Remplacer')}</strong> — {t("la fiche Foundry fait foi (attributs, compétences, équipement, karma, nuyens). L'historique, les notes et l'attribution aux joueurs sont gardés.")}
            </span>
          </label>
        </div>
        <div className="foundry-pcs">
          {scan.pcs.map((p) => {
            const diff = p.diffI18n || p.diff;
            return (
              <div key={p.fid} className={`card foundry-pc ${sel.pcs.has(p.fid) ? 'selected' : ''}`}>
                <div className="row">
                  <Check checked={sel.pcs.has(p.fid)} onChange={(on) => toggleIn('pcs', p.fid, on)} label={p.name} />
                  {p.portrait ? <img className="foundry-avatar" src={p.portrait} alt="" /> : <div className="foundry-avatar empty-avatar">{p.name[0]}</div>}
                  <div className="grow">
                    <div className="row wrap gap-s">
                      <strong>{p.name}</strong>
                      <StatusBadge status={p.status} />
                      {p.retired && <Badge>{t('retraité')}</Badge>}
                    </div>
                    <div className="small muted">
                      {p.player ? t('Joueur Foundry : {name}', { name: p.player }) : t('Aucun joueur propriétaire')} · {t('{n} karma', { n: p.karma })} · {fmtNuyen(p.nuyen)}
                      {p.vehicles.length ? ` · ${p.vehicles.join(', ')}` : ''}
                    </div>
                  </div>
                </div>
                {diff.length ? (
                  <ul className="foundry-diff">
                    {diff.map((d, i) => (
                      <li key={i}>{diffText(d)}</li>
                    ))}
                  </ul>
                ) : (
                  p.status === 'unchanged' && <div className="small muted foundry-diff">{t('Aucun changement depuis le dernier import.')}</div>
                )}
              </div>
            );
          })}
        </div>
        <Toggle value={assignPlayers} onChange={setAssignPlayers} label={t("Attribuer chaque PJ au joueur Foundry du même nom (s'il n'est pas déjà attribué)")} />
      </section>

      <section className="foundry-section">
        <SectionHead title={t('PNJ → bestiaire')} count={sel.npcs.size} total={scan.npcs.length} onAll={() => setAll('npcs', scan.npcs)} onNone={() => setNone('npcs')} />
        <p className="small muted">{t('Les PNJ déjà présents dans le bestiaire (même nom) gardent leur description, leurs tactiques et leur dossier ; leurs statistiques sont reprises de Foundry.')}</p>
        <div className="scroll foundry-table-wrap">
          <table className="sr foundry-table">
            <thead>
              <tr>
                <th></th>
                <th>Foundry</th>
                <th>{t('Bestiaire')}</th>
                <th>{t('Dossier')}</th>
                <th>{t('État')}</th>
              </tr>
            </thead>
            <tbody>
              {scan.npcs.map((n) => (
                <tr key={n.fid} className={sel.npcs.has(n.fid) ? 'selected' : ''}>
                  <td>
                    <Check checked={sel.npcs.has(n.fid)} onChange={(on) => toggleIn('npcs', n.fid, on)} label={n.name} />
                  </td>
                  <td>
                    {n.name}
                    <div className="small faint">{n.foundryFolder}</div>
                  </td>
                  <td>
                    {n.templateName || <span className="muted">{n.templateId}</span>}
                    {!n.hasStats && (
                      <>
                        {' '}
                        <Badge title={t("Fiche vide dans Foundry : les statistiques de l'app sont conservées")}>{t('sans stats')}</Badge>
                      </>
                    )}
                  </td>
                  <td className="small">{n.folder}</td>
                  <td>
                    <StatusBadge status={n.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="foundry-section">
        <SectionHead title={t('Scènes → cartes')} count={sel.scenes.size} total={scan.scenes.length} onAll={() => setAll('scenes', scan.scenes)} onNone={() => setNone('scenes')} />
        <p className="small muted">{t('Chaque scène devient une carte « image » : le décor Foundry sert de sol, les murs, portes et lumières sont convertis. Les jetons ne sont pas copiés (ils sont listés dans la description de la carte).')}</p>
        <div className="foundry-scenes">
          {scan.scenes.map((s) => (
            <label key={s.fid} className={`card foundry-scene ${sel.scenes.has(s.fid) ? 'selected' : ''}`}>
              <div className="foundry-thumb">{s.thumb ? <img src={s.thumb} alt="" loading="lazy" /> : <span className="faint small">{t("pas d'aperçu")}</span>}</div>
              <div className="row gap-s">
                <Check checked={sel.scenes.has(s.fid)} onChange={(on) => toggleIn('scenes', s.fid, on)} label={s.name} />
                <strong className="grow foundry-ellipsis" title={s.name}>
                  {s.name}
                </strong>
                <StatusBadge status={s.status} />
              </div>
              <div className="small muted">
                {s.doors
                  ? t('{size} cases · {walls} murs · {doors} portes · {lights} lumières', { size: s.size, walls: s.walls, doors: s.doors, lights: s.lights })
                  : t('{size} cases · {walls} murs · {lights} lumières', { size: s.size, walls: s.walls, lights: s.lights })}
              </div>
              <div className="small faint foundry-ellipsis">
                {s.folder}
                {s.linkedTo ? ` · ${t('liée aux quêtes')}` : ''}
              </div>
            </label>
          ))}
        </div>
        {scan.skippedScenes?.length ? <div className="small muted">{t('Ignorées : {list}', { list: scan.skippedScenes.map((s) => `${s.name} (${tIfKnown(s.reason)})`).join(', ') })}</div> : null}
      </section>

      <div className="grid-2">
        <section className="foundry-section">
          <SectionHead title={t('Journaux')} count={sel.journals ? scan.journals.docs.length : 0} total={scan.journals.docs.length}>
            <Toggle value={sel.journals} onChange={(v) => setSel((s) => ({ ...s!, journals: v }))} label={t('Importer')} />
          </SectionHead>
          <p className="small muted">
            {withCode('Convertis en documents Markdown dans {folder} (onglet Campagne → Documents).', {}, 'folder', 'docs/foundry/')}
            {scan.journals.pdfs ? ` ${t("{n} livre(s) de règles PDF sont seulement listés dans l'index.", { n: scan.journals.pdfs })}` : ''}
          </p>
          <ul className="foundry-list">
            {scan.journals.docs.map((d) => (
              <li key={d.file}>
                <span className="grow foundry-ellipsis" title={d.file}>
                  {d.folder ? <span className="faint">{d.folder} › </span> : null}
                  {d.title}
                </span>
                <StatusBadge status={d.status} />
              </li>
            ))}
          </ul>
        </section>
        <section className="foundry-section">
          <SectionHead title={t('Playlists → audio')} count={sel.playlists ? 1 : 0} total={1}>
            <Toggle value={sel.playlists} onChange={(v) => setSel((s) => ({ ...s!, playlists: v }))} label={t('Importer')} />
          </SectionHead>
          <p className="small muted">{t("Les fichiers sont copiés dans l'app ({size} au total) en arrière-plan ; les pistes apparaissent dans l'onglet Audio.", { size: scan.audio ? sizeText(scan.audio.bytes, scan.audio.size) : '0' })}</p>
          <ul className="foundry-list">
            {scan.playlists.map((p, i) => (
              <li key={`${i}:${p.name}`}>
                <span className="grow">
                  {p.name} <span className="faint small">· {KIND_LABELS[p.kind] ? t(KIND_LABELS[p.kind]) : p.kind}</span>
                </span>
                <span className="small muted">{p.tracks ? tn(p.tracks, '{n} piste · {size}', '{n} pistes · {size}', { size: sizeText(p.bytes, p.size) }) : t('fichiers introuvables')}</span>
                {p.tracks ? <Badge color={p.newTracks ? 'cyan' : 'green'}>{p.newTracks ? tn(p.newTracks, '{n} nouvelle', '{n} nouvelles') : t('À jour')}</Badge> : null}
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}

function ResultView({ result }: { result: ImportResult }) {
  const line = (label: string, list: Array<{ status: string }> | undefined) =>
    list?.length ? (
      <li>
        <strong>{label}</strong> : {t('{created} nouveau(x), {updated} mis à jour', { created: list.filter((x) => x.status === 'new').length, updated: list.filter((x) => x.status !== 'new').length })}
      </li>
    ) : null;
  const audioSize = result.audio ? sizeText(result.audio.bytes, result.audio.size) : '';
  return (
    <div className="card foundry-result">
      <h4>{t('Import terminé')}</h4>
      <ul className="small">
        {line(t('Personnages joueurs'), result.pcs)}
        {line(t('PNJ'), result.npcs)}
        {line(t('Cartes'), result.maps)}
        {result.journals?.length ? (
          <li>
            <strong>{t('Journaux')}</strong> : {withCode('{n} document(s) dans {dir}', { n: result.journals.length }, 'dir', result.docsDir)}
          </li>
        ) : null}
        {result.tracks ? (
          <li>
            <strong>{t('Audio')}</strong> : {result.audio?.queued ? t('{n} piste(s) — copie de {size} en cours', { n: result.tracks, size: audioSize }) : t('{n} piste(s)', { n: result.tracks })}
          </li>
        ) : null}
        {result.questLinks ? (
          <li>
            <strong>{t('Quêtes')}</strong> : {t('{n} lien(s) de carte ajouté(s)', { n: result.questLinks })}
          </li>
        ) : null}
        {result.users?.length ? (
          <li>
            <strong>{t('Joueurs')}</strong> : {result.users.join(', ')}
          </li>
        ) : null}
        <li className="muted">{t('Fichiers images : {copied} copié(s), {skipped} déjà à jour ({size})', { copied: result.assets.copied, skipped: result.assets.skipped, size: sizeText(result.assets.bytes, result.assets.size) })}</li>
        {result.missing?.length ? (
          <li className="muted" title={result.missing.join('\n')}>
            {t('{n} fichier(s) référencé(s) introuvable(s) dans Foundry', { n: result.missing.length })}
          </li>
        ) : null}
      </ul>
    </div>
  );
}
