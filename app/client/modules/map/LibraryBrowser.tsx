// GM « Bibliothèque » tab of the Cartes page (server-wide map library, see ARCHITECTURE.md « Map library »):
// thumbnails with search (French / English names, tags) and filters, a preview (walls over the image, real renderer),
// « Ajouter à cette table » → maps/fromLibrary. Also the dialog of a library-linked table map: diff with the library,
// « Mettre à jour depuis la bibliothèque », « Publier mes corrections dans la bibliothèque », « Détacher ».
import { useEffect, useMemo, useState } from 'react';
import { Button, Badge, Empty, Modal, Field, Select, SearchBox, confirmAction } from '../../lib/ui.tsx';
import { send, api, type ServerError } from '../../lib/net.ts';
import { toast } from '../../lib/ui-store.ts';
import { t, tn, tk, getLang, fmtDate } from '../../lib/i18n.ts';
import { uid } from '/shared/util.ts';
import { libGeometry, instanceContent, libImageUrl } from '/shared/maplib.ts';
import { MapCanvas } from './MapCanvas.tsx';
import { themeOptions, themeLabel, lightingLabel, type MapScene } from './renderer.ts';
import { useLibKey, signedUrl, useLibrary, loadLibrary, libDescription, libMatches, libName } from './maplib-client.ts';
import type { GameMap, GameView } from '../../../shared/types.ts';
import type { LibDiff, LibEntry, LibFull, LibLinkInfo } from './types.ts';

const quiet = () => {};
const SOURCES: Record<string, string> = { fragmap: tk('Fragmaps (Patreon)'), 'fragmaps-free': tk('Fragmaps (free)') };
const QUALITY: Record<string, string> = { good: tk('Clean walls'), rough: tk('Rough walls') };
/** Table map (Map schema) built from a library map, for the preview only (nothing is sent). */
function previewMap(full: LibFull): GameMap {
  const g = libGeometry({ ...full, ...(full.geometry || {}) });
  const c = instanceContent(full, uid);
  // The preview map leaves out the fields the renderer does not need (regions/doors/fog flags…): cast.
  return {
    id: `preview_${full.slug}_${full.version}`, name: libName(full), width: g.width, height: g.height, metersPerCell: full.metersPerCell,
    tiles: Array.from({ length: g.height }, () => '.'.repeat(g.width)), doors: [], notes: [], tokens: [], explored: {}, fog: false,
    lighting: 'bright', theme: full.theme, walls: c.walls, lights: c.lights, regions: c.regions,
    background: { url: libImageUrl(full.slug), opacity: 1, mode: 'image', x: g.bgX, y: g.bgY, w: g.bgW, h: g.bgH },
  } as unknown as GameMap;
}

interface AddFormProps {
  entry: LibEntry;
  game: GameView;
  onAdded?: (id: string) => void;
}

function AddForm({ entry, game, onAdded }: AddFormProps) {
  const folders = [...new Set(Object.values(game.maps || {}).map((m) => m.folder).filter(Boolean) as string[])].sort();
  const [name, setName] = useState(libName(entry));
  const [folder, setFolder] = useState(t('Library'));
  const [busy, setBusy] = useState(false);
  const add = async () => {
    setBusy(true);
    try {
      const id = await send<string>('maps/fromLibrary', { slug: entry.slug, name: name.trim(), folder: folder.trim() });
      toast(t('Map added to the table: {name}', { name: name.trim() || libName(entry) }), 'success');
      onAdded?.(id);
    } catch {
      setBusy(false);
    }
  };
  return (
    <div className="col gap-s">
      <Field label={t('Name in this table')}>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label={t('Folder')}>
        <input className="input" list="maplib-folders" value={folder} onChange={(e) => setFolder(e.target.value)} />
        <datalist id="maplib-folders">
          {folders.map((f) => (
            <option key={f} value={f} />
          ))}
        </datalist>
      </Field>
      <Button variant="primary" disabled={busy} onClick={add}>
        {t('Add to this table')}
      </Button>
      <span className="small muted">{t('The table gets its own copy: tokens, fog, doors and edits stay in this table.')}</span>
    </div>
  );
}

interface PreviewModalProps {
  entry: LibEntry;
  game: GameView;
  onClose: () => void;
  onAdded?: (id: string) => void;
}

function PreviewModal({ entry, game, onClose, onAdded }: PreviewModalProps) {
  const [full, setFull] = useState<LibFull | null>(null);
  const [err, setErr] = useState<Error | null>(null);
  const [showWalls, setShowWalls] = useState(true);
  useEffect(() => {
    api<LibFull>(`/api/maplib/${encodeURIComponent(entry.slug)}`).then(setFull, setErr);
  }, [entry.slug]);
  const map = useMemo(() => (full ? previewMap(full) : null), [full]);
  const scene = useMemo<MapScene | null>(
    () =>
      map && {
        map, actors: {}, role: 'gm', me: game.me, selected: new Set(), turnTokenId: null, gmLayer: true, editor: false,
        fog: null, unseen: null, tokenMask: null, darkFactor: 0.55, showWalls, showGrid: true, barsFor: () => false,
      },
    [map, showWalls]
  );
  return (
    <Modal title={libName(entry)} width={1100} onClose={onClose}>
      <div className="maplib-preview">
        <div className="maplib-preview-canvas">
          {err ? <Empty>{err.message}</Empty> : scene ? <MapCanvas scene={scene} handlers={{}} /> : <Empty>{t('Loading…')}</Empty>}
        </div>
        <aside className="maplib-preview-side col gap-s">
          <div className="row wrap gap-s">
            <Badge color="cyan">{t(SOURCES[entry.source] || entry.source)}</Badge>
            <Badge color={entry.quality === 'good' ? 'green' : 'amber'}>{t(QUALITY[entry.quality] || QUALITY.rough)}</Badge>
            {!entry.hasImage && <Badge color="red">{t('Image missing on the server')}</Badge>}
          </div>
          {getLang() === 'en' ? null : <div className="small muted">{entry.name}</div>}
          <p className="small">{libDescription(entry) || t('No description.')}</p>
          <div className="small muted">
            {t('{w} × {h} cells · {m} m per cell', { w: entry.width, h: entry.height, m: entry.metersPerCell })}
            <br />
            {themeLabel(entry.theme)} · {lightingLabel(entry.lighting)}
            <br />
            {entry.counts ? t('{walls} walls, {doors} doors, {lights} lights, {regions} zones', entry.counts) : null}
            <br />
            {t('Version {v}', { v: entry.version })}
            {entry.updatedAt ? ` · ${fmtDate(entry.updatedAt)}` : ''}
          </div>
          {entry.tags?.length ? (
            <div className="row wrap gap-s">
              {entry.tags.slice(0, 16).map((x) => (
                <span key={x} className="maplib-tag">
                  {x}
                </span>
              ))}
            </div>
          ) : null}
          <label className="row gap-s small">
            <input type="checkbox" checked={showWalls} onChange={(e) => setShowWalls(e.target.checked)} /> {t('Show walls')}
          </label>
          <hr />
          <AddForm
            entry={entry}
            game={game}
            onAdded={(id) => {
              onClose();
              onAdded?.(id);
            }}
          />
        </aside>
      </div>
    </Modal>
  );
}

interface LibCardProps {
  entry: LibEntry;
  k: string | null;
  uses: number;
  onPreview: () => void;
  game: GameView;
  onAdded?: (id: string) => void;
}

function LibCard({ entry, k, uses, onPreview, onAdded }: LibCardProps) {
  const src = entry.hasThumb || !entry.hasImage ? signedUrl(entry.thumb, k) : null;
  const [adding, setAdding] = useState(false);
  return (
    <div className="maps-card maplib-card">
      <div className="maps-thumb" onClick={onPreview} title={t('Preview')}>
        {src ? <img src={src} alt="" loading="lazy" /> : <span className="muted small">{libName(entry)}</span>}
        {uses ? <Badge color="green">{tn(uses, '{n} copy in this table', '{n} copies in this table')}</Badge> : null}
      </div>
      <div className="maps-card-body">
        <h4>{libName(entry)}</h4>
        <div className="row wrap small muted">
          <span>
            {entry.width} × {entry.height}
          </span>
          ·<span>{themeLabel(entry.theme)}</span>·
          <span className={entry.quality === 'good' ? 'green' : 'amber'}>{t(QUALITY[entry.quality] || QUALITY.rough)}</span>
          {entry.source === 'fragmaps-free' ? (
            <>
              ·<span className="magenta">{t('free')}</span>
            </>
          ) : null}
        </div>
      </div>
      <div className="maps-card-actions">
        <Button
          small
          variant="primary"
          disabled={adding}
          onClick={async () => {
            setAdding(true);
            try {
              const id = await send<string>('maps/fromLibrary', { slug: entry.slug });
              toast(t('Map added to the table: {name}', { name: libName(entry) }), 'success');
              onAdded?.(id);
            } catch {}
            setAdding(false);
          }}
        >
          {t('Add to this table')}
        </Button>
        <Button small variant="ghost" onClick={onPreview}>
          {t('Preview')}
        </Button>
      </div>
    </div>
  );
}

interface LibraryBrowserProps {
  game: GameView;
  onAdded?: (id: string) => void;
}

/** Library browser (GM). onAdded(mapId) after « Ajouter à cette table ». */
export function LibraryBrowser({ game, onAdded }: LibraryBrowserProps) {
  const { data, error } = useLibrary();
  const k = useLibKey();
  const [q, setQ] = useState('');
  const [theme, setTheme] = useState('');
  const [source, setSource] = useState('');
  const [quality, setQuality] = useState('');
  const [preview, setPreview] = useState<LibEntry | null>(null);
  const uses = useMemo(() => {
    const out: Record<string, number> = {};
    for (const m of Object.values(game.maps || {})) if (m.library?.slug) out[m.library.slug] = (out[m.library.slug] || 0) + 1;
    return out;
  }, [game.maps]);
  const list = useMemo(
    () =>
      (data?.maps || [])
        .filter((e) => (!theme || e.theme === theme) && (!source || e.source === source) && (!quality || e.quality === quality) && libMatches(e, q))
        .sort((a, b) => libName(a).localeCompare(libName(b), getLang(), { numeric: true })),
    [data, q, theme, source, quality]
  );
  if (error) return <Empty>{error.message}</Empty>;
  if (!data) return <Empty>{t('Loading…')}</Empty>;
  return (
    <div className="col gap-s">
      <div className="row wrap gap-s maplib-filters">
        <SearchBox value={q} onChange={setQ} placeholder={t('Search: name, place, mood…')} />
        <Select value={theme} onChange={setTheme} options={[{ value: '', label: t('All moods') }, ...themeOptions()]} />
        <Select
          value={source}
          onChange={setSource}
          options={[{ value: '', label: t('All sources') }, ...Object.entries(SOURCES).map(([value, label]) => ({ value, label: t(label) }))]}
        />
        <Select
          value={quality}
          onChange={setQuality}
          options={[{ value: '', label: t('All tracings') }, ...Object.entries(QUALITY).map(([value, label]) => ({ value, label: t(label) }))]}
        />
        <span className="small muted">{tn(list.length, '{n} map', '{n} maps')}</span>
        <Button small variant="ghost" onClick={() => loadLibrary(true).catch(quiet)} title={t('Reload the library')}>
          ⟳
        </Button>
      </div>
      <div className="small muted">
        {t('Raw maps shared by every table on this server. Add a map to get an editable copy in this table.')}
      </div>
      {!list.length && <Empty>{data.maps.length ? t('No map matches these filters.') : t('The library is empty.')}</Empty>}
      <div className="maps-grid">
        {list.map((e) => (
          <LibCard key={e.slug} entry={e} k={k} uses={uses[e.slug] || 0} game={game} onAdded={onAdded} onPreview={() => setPreview(e)} />
        ))}
      </div>
      {preview && <PreviewModal entry={preview} game={game} onClose={() => setPreview(null)} onAdded={onAdded} />}
    </div>
  );
}

const STALE_KEY = 'The library changed since your last sync (v{lib}, your map: v{mine})'; // server error key

function diffLines(d: LibDiff): string[] {
  const line = (label: string, x: { add: number; remove: number }) =>
    x.add || x.remove ? t('{what}: +{add} / −{remove}', { what: label, add: x.add, remove: x.remove }) : null;
  return [line(t('Walls'), d.walls), line(t('Doors'), d.doors), line(t('Lights'), d.lights), line(t('Areas'), d.regions)].filter(Boolean) as string[];
}

interface LibraryLinkModalProps {
  map: GameMap;
  onClose: () => void;
  beforeAction?: () => Promise<unknown>;
}

/** Dialog of a library-linked table map. `beforeAction` (editor) flushes pending wall edits first. */
export function LibraryLinkModal({ map, onClose, beforeAction }: LibraryLinkModalProps) {
  const [info, setInfo] = useState<LibLinkInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = () => send<LibLinkInfo>('maps/libraryDiff', { mapId: map.id }).then(setInfo, () => onClose());
  useEffect(() => {
    (beforeAction ? beforeAction() : Promise.resolve()).then(refresh, refresh);
  }, [map.id]);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      if (beforeAction) await beforeAction();
      await fn();
      loadLibrary(true).catch(quiet);
      await refresh();
    } catch {}
    setBusy(false);
  };
  const update = () =>
    run(async () => {
      if (
        !(await confirmAction(
          t('Replace the walls, doors, lights and zones of “{name}” with the library’s? Tokens, notes, fog, GM zones and door states are kept.', {
            name: map.name,
          })
        ))
      )
        return;
      const r = await send<{ version: number }>('maps/libraryUpdate', { mapId: map.id });
      toast(t('Map updated (version {v})', { v: r.version }), 'success');
    });
  const publish = () =>
    run(async () => {
      if (
        !(await confirmAction(
          t(
            'Publish the walls, doors, lights and zones of “{name}” to the server library? Every table will benefit. Tokens, notes, fog and GM zones are never published; doors are reset to closed.',
            { name: map.name }
          )
        ))
      )
        return;
      let r: { version: number };
      try {
        r = await send<{ version: number }>('maps/publishToLibrary', { mapId: map.id }, { silent: true });
      } catch (e) {
        const err = e as ServerError;
        if (err.key !== STALE_KEY) {
          toast(err.message, 'error');
          throw err;
        }
        if (!(await confirmAction(t('Someone published a newer version. Publish anyway (the old one stays in the history)?')))) return;
        r = await send<{ version: number }>('maps/publishToLibrary', { mapId: map.id, force: true });
      }
      toast(t('Published to the library (version {v})', { v: r.version }), 'success');
    });
  const unlink = () =>
    run(async () => {
      if (
        !(await confirmAction(
          t('Detach “{name}” from the library? It becomes an ordinary table map (no more updates or publishing).', { name: map.name })
        ))
      )
        return;
      await send('maps/libraryUnlink', { mapId: map.id });
      toast(t('Map detached from the library'));
      onClose();
    });
  const d = info?.diff;
  const lines = d ? diffLines(d) : [];
  return (
    <Modal title={t('Library: {name}', { name: map.name })} width={560} onClose={onClose}>
      {!info || !d ? (
        <Empty>{t('Loading…')}</Empty>
      ) : (
        <div className="col gap-s">
          <div>{t('Copy of “{name}” (server library).', { name: libName(info) })}</div>
          <div className="small muted">{t('This map’s version: {mine} · library version: {lib}', { mine: info.current, lib: info.latest })}</div>
          {info.latest > info.current ? <Badge color="amber">{t('New version available')}</Badge> : null}
          <div className="section-title">{t('Differences with the library')}</div>
          {d.same ? (
            <div className="small green">{t('Same as the library.')}</div>
          ) : (
            <>
              <ul className="small">
                {lines.map((l) => (
                  <li key={l}>{l}</li>
                ))}
                {d.resized ? <li>{t('Size: {w} × {h} cells', { w: d.width, h: d.height })}</li> : null}
              </ul>
              <div className="small muted">{t('“+” = only in the library, “−” = only in your map.')}</div>
            </>
          )}
          {d.keptDoorStates ? (
            <div className="small muted">{tn(d.keptDoorStates, 'An update keeps the state of {n} door.', 'An update keeps the state of {n} doors.')}</div>
          ) : null}
          <div className="row wrap gap-s" style={{ marginTop: '8px' }}>
            <Button variant="primary" disabled={busy || (d.same && info.latest <= info.current)} onClick={update}>
              {t('Update from the library')}
            </Button>
            {info.publishAllowed ? (
              <Button variant="accent" disabled={busy || d.same} onClick={publish}>
                {t('Publish my fixes to the library')}
              </Button>
            ) : (
              <span className="small muted">{t('Publishing is reserved to the server admin.')}</span>
            )}
            <Button variant="ghost" disabled={busy} onClick={unlink}>
              {t('Detach')}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
