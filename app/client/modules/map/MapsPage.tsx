// GM maps page: list grouped by folder (previews, active badge, create / import / export / duplicate / delete)
// and the full editor (editor.tsx) for the selected map.
import { useEffect, useMemo, useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import { Button, Badge, Empty, Modal, Field, Select, SearchBox, NumberInput, Tabs, confirmAction } from '../../lib/ui.tsx';
import { send, type GameProps } from '../../lib/net.ts';
import { useUI, setUI, getUI, toast } from '../../lib/ui-store.ts';
import { themeOptions, lightingOptions, themeLabel, lightingLabel, renderThumbnail, isImageMap, wallsKey } from './renderer.ts';
import { t, compare, getLang } from '../../lib/i18n.ts';
import type { GameMap, GameView } from '../../../shared/types.ts';

const byName = (a: unknown, b: unknown) => String(a).localeCompare(String(b), getLang(), { numeric: true });
import { MapEditor } from './editor.tsx';
import { LibraryBrowser, LibraryLinkModal } from './LibraryBrowser.tsx';
import { useLibrary } from './maplib-client.ts';
import './map.css';

const quiet = () => {};
/** Like Field but a <div>: a <label> would forward clicks on its text to the stepper buttons. */
const NumField = ({ label, children }: { label: ReactNode; children?: ReactNode }) => (
  <div className="field">
    <span className="field-label">{label}</span>
    {children}
  </div>
);

function download(name: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
function exportMap(map: GameMap) {
  const { explored, ...rest } = map;
  const clean = { ...rest, tokens: (rest.tokens || []).map(({ lastMove, ...t }) => t) };
  const file = (map.name || t('map')).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w-]+/g, '-').toLowerCase();
  download(`${file || t('map')}.json`, clean);
}

type MapsTab = 'table' | 'library';

export default function MapsPage({ game }: GameProps) {
  const ui = useUI();
  const maps = game.maps || {};
  const editing = ui.mapsEditId && maps[ui.mapsEditId] ? maps[ui.mapsEditId] : null;
  const [tab, setTab] = useState<MapsTab>(lastTab);
  const pick = (v: MapsTab) => setTab((lastTab = v));
  if (editing) return <MapEditor key={editing.id} game={game} map={editing} onBack={() => setUI({ mapsEditId: null })} />;
  const tabs = (
    <Tabs<MapsTab>
      value={tab}
      onChange={pick}
      tabs={[
        { id: 'table', label: t('Table maps') },
        { id: 'library', label: t('Library') },
      ]}
    />
  );
  if (tab === 'library') {
    return (
      <div className="page">
        <div className="page-title">
          <h2>{t('Maps')}</h2>
        </div>
        {tabs}
        <LibraryBrowser game={game} onAdded={() => pick('table')} />
      </div>
    );
  }
  return <MapsList game={game} tabs={tabs} />;
}
let lastTab: MapsTab = 'table'; // tab kept while the editor is open

function MapsList({ game, tabs }: { game: GameView; tabs: ReactNode }) {
  const maps = game.maps || {};
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const activeId = game.scene?.activeMapId;
  const [linkMap, setLinkMap] = useState<string | null>(null);
  const hasLinked = Object.values(maps).some((m) => m.library);
  const lib = useLibrary(hasLinked).data;
  const latest = useMemo<Record<string, number>>(() => Object.fromEntries((lib?.maps || []).map((e) => [e.slug, e.version])), [lib]);

  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = Object.values(maps)
      .filter((m) => !needle || `${m.name} ${m.folder || ''}`.toLowerCase().includes(needle))
      .sort((a, b) => byName(a.name, b.name));
    const by = new Map<string, GameMap[]>();
    // '' = maps without a folder (listed last, shown as « Sans dossier »).
    for (const m of list) {
      const f = m.folder || '';
      if (!by.has(f)) by.set(f, []);
      by.get(f)!.push(m);
    }
    return [...by.entries()].sort((a, b) => Number(a[0] === '') - Number(b[0] === '') || byName(a[0], b[0]));
  }, [maps, q]);

  const onImport = async (e: ChangeEvent<HTMLInputElement>) => {
    const files = [...(e.target.files || [])];
    e.target.value = '';
    for (const f of files) {
      try {
        const data = JSON.parse(await f.text());
        const list = Array.isArray(data) ? data : [data];
        for (const m of list) {
          const id = await send<string>('maps/import', { map: m });
          toast(t('Map imported: {name}', { name: maps[id]?.name || m.name || f.name }), 'success');
        }
      } catch (err) {
        toast(t('Import failed ({file}): {error}', { file: f.name, error: (err as Error).message }), 'error');
      }
    }
  };

  return (
    <div className="page">
      <div className="page-title">
        <h2>{t('Maps')}</h2>
        <div className="row wrap">
          <SearchBox value={q} onChange={setQ} placeholder={t('Search for a map…')} />
          <Button onClick={() => fileRef.current?.click()}>{t('Importing…')}</Button>
          <input type="file" accept=".json,application/json" multiple hidden ref={fileRef} onChange={onImport} />
          <Button variant="primary" onClick={() => setCreating(true)}>
            {t('+ New map')}
          </Button>
        </div>
      </div>
      {tabs}
      <div className="row wrap small muted" style={{ marginBottom: '4px' }}>
        {t('Map shown to players:')} <strong className="green">{(activeId && maps[activeId]?.name) || t('none')}</strong>
        {activeId && (
          <Button small variant="ghost" onClick={() => send('maps/setActive', { mapId: null }).catch(quiet)}>
            {t('Hide the map')}
          </Button>
        )}
      </div>
      {!Object.keys(maps).length && <Empty>{t("No maps yet. Create one or import a JSON file.")}</Empty>}
      {groups.map(([folder, list]) => (
        <div key={folder} className="maps-folder">
          <div className="section-title">
            {folder || t('No folder')} <span className="muted">({list.length})</span>
          </div>
          <div className="maps-grid">
            {list.map((m) => (
              <MapCard key={m.id} map={m} active={m.id === activeId} latest={m.library ? latest[m.library.slug] : null} onLibrary={() => setLinkMap(m.id)} />
            ))}
          </div>
        </div>
      ))}
      {creating && <CreateMapModal game={game} onClose={() => setCreating(false)} />}
      {linkMap && maps[linkMap] && <LibraryLinkModal map={maps[linkMap]} onClose={() => setLinkMap(null)} />}
    </div>
  );
}

interface MapCardProps {
  map: GameMap;
  active: boolean;
  latest: number | null | undefined;
  onLibrary: () => void;
}

function MapCard({ map, active, latest, onLibrary }: MapCardProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  const bg = map.background;
  const sig = `${map.width}x${map.height}|${map.theme}|${map.tiles.join('')}|${(map.doors || []).map((d) => d.state + d.kind).join()}|${(map.tokens || []).map((t) => t.x + ',' + t.y + t.disposition).join()}|${bg ? `${bg.url}${bg.mode}${bg.x},${bg.y},${bg.w},${bg.h},${bg.opacity}` : ''}|${wallsKey(map)}`;
  const walls = map.walls || [];
  const wallDoors = walls.filter((w) => w.door).length;
  useEffect(() => {
    if (ref.current) renderThumbnail(ref.current, map, 240);
  }, [sig]);
  const edit = () => setUI({ mapsEditId: map.id });
  const del = async () => {
    if (!(await confirmAction(t('Permanently delete the map “{name}”?', { name: map.name }) + (active ? '\n' + t('It is currently shown to players.') : '')))) return;
    send('maps/delete', { mapId: map.id }).then(() => {
      toast(t('Map deleted'));
      const u = getUI();
      if (u.viewMapId === map.id) setUI({ viewMapId: null });
      if (u.mapsEditId === map.id) setUI({ mapsEditId: null });
    }, quiet);
  };
  const dup = () => send('maps/duplicate', { mapId: map.id }).then(() => toast(t('Map duplicated'), 'success'), quiet);
  const newer = (latest ?? 0) > (map.library?.version || 0);
  return (
    <div className={'maps-card' + (active ? ' active' : '')}>
      <div className="maps-thumb" onClick={edit} title={t('Edit')}>
        <canvas ref={ref}></canvas>
        {active && <Badge color="green">● {t('Shown')}</Badge>}
        {map.library && (
          <span className="maps-lib-badge">
            <Badge color={newer ? 'amber' : 'cyan'} title={newer ? t('New version available in the library') : t('Copy of a library map')}>
              {t('Library')}
              {newer ? ' ↑' : ''}
            </Badge>
          </span>
        )}
      </div>
      <div className="maps-card-body">
        <h4>{map.name}</h4>
        <div className="row wrap small muted">
          <span>
            {map.width} × {map.height}
          </span>
          ·<span>{themeLabel(map.theme)}</span>·<span>{lightingLabel(map.lighting)}</span>
          {(map.tokens || []).length ? (
            <>
              ·<span>{t('{n} token(s)', { n: map.tokens.length })}</span>
            </>
          ) : null}
          {map.fog === false ? (
            <>
              ·<span className="amber">{t('no fog')}</span>
            </>
          ) : null}
          {isImageMap(map) ? (
            <>
              ·
              <span className="cyan" title={t("Illustrated map: the image is the floor")}>
                {t('illustrated')}
              </span>
            </>
          ) : null}
          {walls.length ? (
            <>
              ·
              <span title={t('Segment walls')}>
                {wallDoors ? t('{walls} wall(s), {doors} door(s)', { walls: walls.length, doors: wallDoors }) : t('{n} wall(s)', { n: walls.length })}
              </span>
            </>
          ) : null}
          {map.foundry ? (
            <>
              ·
              <span className="magenta" title={t('Imported from Foundry VTT')}>
                Foundry
              </span>
            </>
          ) : null}
        </div>
      </div>
      <div className="maps-card-actions">
        <Button small variant="primary" onClick={edit}>
          {t('Edit')}
        </Button>
        {active ? (
          <Button small onClick={() => setUI({ viewMapId: map.id, mainTab: 'map' })}>
            {t('View in play')}
          </Button>
        ) : (
          <Button
            small
            variant="accent"
            onClick={() => send('maps/setActive', { mapId: map.id }).then(() => toast(t('Map shown to players'), 'success'), quiet)}
          >
            {t('Show')}
          </Button>
        )}
        {map.library && (
          <Button small variant="ghost" onClick={onLibrary} title={t('Update from the library or publish your fixes to it')}>
            {t('Library…')}
          </Button>
        )}
        <Button small variant="ghost" onClick={dup}>
          {t('Duplicate')}
        </Button>
        <Button small variant="ghost" onClick={() => exportMap(map)}>
          {t('Export')}
        </Button>
        <Button small variant="ghost" onClick={del} title={t('Delete')}>
          ✕
        </Button>
      </div>
    </div>
  );
}

interface CreateForm {
  name: string;
  folder: string;
  width: number;
  height: number;
  theme: string;
  lighting: string;
  fill: string;
}

function CreateMapModal({ game, onClose }: { game: GameView; onClose: () => void }) {
  const folders = [...new Set(Object.values(game.maps || {}).map((m) => m.folder).filter(Boolean) as string[])].sort(compare);
  const [f, setF] = useState<CreateForm>({ name: '', folder: folders[0] || '', width: 30, height: 20, theme: 'street', lighting: 'bright', fill: '.' });
  const [busy, setBusy] = useState(false);
  const set =
    <K extends keyof CreateForm>(k: K) =>
    (v: CreateForm[K]) =>
      setF((o) => ({ ...o, [k]: v }));
  const submit = async (e?: { preventDefault?: () => void }) => {
    e?.preventDefault?.();
    if (busy) return;
    setBusy(true);
    try {
      const id = await send<string>('maps/create', { ...f, name: f.name.trim() || t('New map') });
      onClose();
      setUI({ mapsEditId: id });
    } catch {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={t('New map')}
      width={520}
      onClose={onClose}
      actions={
        <Button variant="primary" disabled={busy} onClick={submit}>
          {t('Create and edit')}
        </Button>
      }
    >
      <form className="col" onSubmit={submit}>
        <Field label={t('Name')}>
          <input className="input" value={f.name} placeholder={t('e.g. Tacoma warehouse')} autoFocus onChange={(e) => set('name')(e.target.value)} />
        </Field>
        <Field label={t('Folder')} hint={t('Groups maps together (e.g. Act 1, Recurring places)')}>
          <input className="input" list="maps-folders" value={f.folder} onChange={(e) => set('folder')(e.target.value)} />
          <datalist id="maps-folders">
            {folders.map((x) => (
              <option key={x} value={x} />
            ))}
          </datalist>
        </Field>
        <div className="grid-2">
          <NumField label={t('Width (cells)')}>
            <NumberInput value={f.width} min={4} max={160} onChange={set('width')} />
          </NumField>
          <NumField label={t('Height (cells)')}>
            <NumberInput value={f.height} min={4} max={160} onChange={set('height')} />
          </NumField>
          <Field label={t('map::Theme')}>
            <Select value={f.theme} options={themeOptions()} onChange={set('theme')} />
          </Field>
          <Field label={t('Lighting')}>
            <Select value={f.lighting} options={lightingOptions()} onChange={set('lighting')} />
          </Field>
        </div>
        <Field label={t('Start with')}>
          <Select
            value={f.fill}
            onChange={set('fill')}
            options={[
              { value: '.', label: t('Interior: floor surrounded by walls') },
              { value: ',', label: t('Exterior: street / ground surrounded by walls') },
              { value: ' ', label: t('Empty (draw everything)') },
              { value: 'image', label: t('Illustrated map: floor everywhere, image + segment walls') },
            ]}
          />
        </Field>
        <span className="small muted">{t("1 cell = 1 meter by default (can be changed in the editor).")}</span>
        <button type="submit" hidden></button>
      </form>
    </Modal>
  );
}
