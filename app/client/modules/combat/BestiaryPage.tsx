// Bestiary (GM): NPC templates by folder, SR5 stat blocks, spawn onto maps, editor, import/export.
import { useState, useMemo, useRef, type ChangeEvent, type CSSProperties } from 'react';
import { Button, Badge, Empty, Panel, NumberInput, Toggle, SearchBox, confirmAction, promptText } from '../../lib/ui.tsx';
import { send, type GameProps } from '../../lib/net.ts';
import { useUI, openSheet, toast, goTab, type UIState } from '../../lib/ui-store.ts';
import { t, tn, tIfKnown, metatypeLabel, compare } from '../../lib/i18n.ts';
import { initials, avatarStyle, safeDerive, downloadJson, npcKindLabel } from './combat-common.tsx';
import StatBlock from './StatBlock.tsx';
import TemplateEditor from './TemplateEditor.tsx';
import EnemyGenerator from '../chargen/EnemyGenerator.tsx';
import type { Actor, GameMap, GameView, Template, Token } from '../../../shared/types.ts';
import './combat.css';

// Seed bestiary folders: stored names (French, kept for save compatibility), shown with folderLabel().
const FOLDER_ORDER = ['Project Lazarus', 'Gangs', 'Sécurité corpo', 'Spécialistes', 'Matrice', 'Créatures'];
const NO_MAP = '__none';
const DEFAULT_FOLDER = 'Divers'; // stored default folder name (server side), shown translated

const norm = (s: string | null | undefined) =>
  String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

/** Folder name to display (the default and seed folders are translated, GM folders are shown as typed). */
const folderLabel = (name: string) => (name === DEFAULT_FOLDER ? t('Miscellaneous') : tIfKnown(name));

function folderSort(a: string, b: string) {
  const ia = FOLDER_ORDER.indexOf(a);
  const ib = FOLDER_ORDER.indexOf(b);
  if (ia !== ib) return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  return a.localeCompare(b, 'fr');
}

interface TemplateCardProps {
  tpl: Template;
  active: boolean;
  spawned: number;
  onClick: () => void;
}
function TemplateCard({ tpl, active, spawned, onClick }: TemplateCardProps) {
  const d = safeDerive(tpl);
  const kind = tpl.npc?.kind || 'metahuman';
  const pr = tpl.npc?.professionalRating ?? 0;
  return (
    <div className={'bst-card' + (active ? ' active' : '')} style={{ '--tc': tpl.color || 'var(--magenta)' } as CSSProperties} onClick={onClick}>
      <div className="bst-card-top">
        <strong title={tpl.name}>{tpl.name}</strong>
        {spawned > 0 && (
          <Badge color="green" title={t('NPCs from this template currently in play')}>
            ×{spawned}
          </Badge>
        )}
      </div>
      <div className="sub">{[tpl.metatype && metatypeLabel(tpl.metatype), tpl.concept].filter(Boolean).join(' · ') || '—'}</div>
      <div className="meta">
        {pr > 0 && <Badge color="amber">{t('PR {n}', { n: pr })}</Badge>}
        {tpl.npc?.grunt && <Badge color="magenta">{t('Grunt')}</Badge>}
        {kind !== 'metahuman' && <Badge color="cyan">{npcKindLabel(kind)}</Badge>}
        {d && kind !== 'host' && <span className="mono small muted">{t('Init {text}', { text: d.initiative.text })}</span>}
      </div>
    </div>
  );
}

/** Toast text after a spawn (whole sentences, one per case). */
function spawnMessage(n: number, mapName: string, hidden: boolean): string {
  const p = { map: mapName };
  if (mapName && hidden) return tn(n, '{n} NPC created on « {map} » (hidden)', '{n} NPCs created on « {map} » (hidden)', p);
  if (mapName) return tn(n, '{n} NPC created on « {map} »', '{n} NPCs created on « {map} »', p);
  if (hidden) return tn(n, '{n} NPC created (hidden)', '{n} NPCs created (hidden)');
  return tn(n, '{n} NPC created', '{n} NPCs created');
}

/** Reply of bestiary/spawn and npcgen/create. */
interface SpawnReply {
  actorIds: string[];
  templateIds?: string[];
  unplaced?: number;
}

function SpawnBox({ game, tpl, ui }: { game: GameView; tpl: Template; ui: UIState }) {
  const maps = Object.values(game.maps || {}).sort((a, b) => compare(a.name, b.name));
  const defaultMap: string = (ui.viewMapId && game.maps?.[ui.viewMapId] && ui.viewMapId) || game.scene?.activeMapId || maps[0]?.id || NO_MAP;
  const [count, setCount] = useState(1);
  const [hidden, setHidden] = useState(false);
  const [mapChoice, setMapChoice] = useState<string | null>(null);
  const [addToCombat, setAddToCombat] = useState(true);
  const [busy, setBusy] = useState(false);
  const mapId = mapChoice && (mapChoice === NO_MAP || game.maps?.[mapChoice]) ? mapChoice : defaultMap;
  const map: GameMap | null | undefined = mapId !== NO_MAP ? game.maps?.[mapId] : null;
  // Spawn next to the selected token when it is on that map, otherwise in the middle of the map.
  const anchor: Token | undefined = map ? ((ui.selectedTokenIds || []) as string[]).map((id) => (map.tokens || []).find((tk) => tk.id === id)).find(Boolean) : undefined;
  const combatOn = !!game.combat?.active;
  const isHost = tpl.npc?.kind === 'host';

  const spawn = async () => {
    setBusy(true);
    try {
      const payload: Record<string, unknown> = { templateId: tpl.id, count, hidden, mapId: map ? map.id : null, addToCombat: combatOn && addToCombat };
      if (anchor) {
        payload.x = anchor.x;
        payload.y = anchor.y;
      }
      const res = await send<SpawnReply>('bestiary/spawn', payload);
      toast(spawnMessage(res.actorIds.length, map ? map.name : '', hidden), 'success');
      if (res.unplaced) toast(t('{n} NPC(s) with no free cell on the map (actors created without a token)', { n: res.unplaced }), 'warn');
    } catch {
      /* toasted */
    }
    setBusy(false);
  };

  if (isHost) {
    return (
      <Panel title={t('Spawn')}>
        <div className="bst-hint">{t('Reference sheet: spawn the IC and spiders from the Matrix folder instead.')}</div>
      </Panel>
    );
  }
  return (
    <Panel title={t('Spawn')}>
      <div className="bst-spawn">
        <div className="field">
          <span className="field-label">{t('Count')}</span>
          <NumberInput value={count} min={1} max={20} onChange={setCount} />
        </div>
        <div className="field grow">
          <span className="field-label">{t('Map')}</span>
          <select className="input" value={mapId} onChange={(e) => setMapChoice(e.target.value)}>
            {maps.map((m) => (
              <option key={m.id} value={m.id}>
                {m.id === game.scene?.activeMapId ? t('{name} (active)', { name: m.name }) : m.name}
              </option>
            ))}
            <option value={NO_MAP}>{t('— None (sheets only) —')}</option>
          </select>
        </div>
        <div className="field">
          <span className="field-label">{t('Visibility')}</span>
          <Toggle value={hidden} onChange={setHidden} label={hidden ? t('Hidden') : t('Visible')} />
        </div>
        {combatOn && (
          <div className="field">
            <span className="field-label">{t('Combat')}</span>
            <Toggle value={addToCombat} onChange={setAddToCombat} label={t('Add')} />
          </div>
        )}
        <Button variant="primary" disabled={busy} onClick={spawn}>
          ☠ {t('Spawn')}
        </Button>
      </div>
      <div className="bst-hint" style={{ marginTop: '6px' }}>
        {map
          ? anchor
            ? t('Next to the selected token ({name}).', { name: anchor.name })
            : t('In the middle of the map (select a token on the map to place them next to it).')
          : t('The NPCs will be created without a token.')}
      </div>
    </Panel>
  );
}

function SpawnedList({ game, tpl }: { game: GameView; tpl: Template }) {
  // GM view: every actor is a full sheet.
  const actors = Object.values(game.actors || {}).filter((a): a is Actor => a.templateId === tpl.id && 'attributes' in a);
  if (!actors.length) return null;
  const tokenOf = (actorId: string) => {
    for (const m of Object.values(game.maps || {})) {
      const tk = (m.tokens || []).find((x) => x.actorId === actorId);
      if (tk) return { map: m, token: tk };
    }
    return null;
  };
  const inCombat = (actorId: string) => (game.combat?.entries || []).some((e) => e.actorId === actorId);
  const addCombat = (a: Actor) => {
    const loc = tokenOf(a.id);
    send('combat/add', loc ? { tokenIds: [loc.token.id] } : { actorIds: [a.id] }).catch(() => null);
  };
  const saveAsTemplate = async (a: Actor) => {
    const name = await promptText(t('Name of the new template'), a.name.replace(/\s+\d+$/, ''));
    if (!name) return;
    send('bestiary/fromActor', { actorId: a.id, name, folder: tpl.folder })
      .then(() => toast(t('Template saved'), 'success'))
      .catch(() => null);
  };
  const remove = async (a: Actor) => {
    if (await confirmAction(t('Permanently delete {name} (sheet and token)?', { name: a.name }))) send('actor/delete', { actorId: a.id }).catch(() => null);
  };
  return (
    <Panel title={t('In play ({n})', { n: actors.length })}>
      <div className="bst-spawned">
        {actors.map((a) => {
          const d = safeDerive(a);
          const c: Partial<Actor['condition']> = a.condition || {};
          const loc = tokenOf(a.id);
          return (
            <div key={a.id} className="bst-spawned-row">
              <span className="grow">
                <strong>{a.name}</strong>
                {d && (
                  <>
                    {' '}
                    <span className="mono small muted">{t('P {p}/{pmax} · S {s}/{smax}', { p: c.physical || 0, pmax: d.physicalMonitor, s: c.stun || 0, smax: d.stunMonitor })}</span>
                  </>
                )}
                {loc && (
                  <>
                    {' '}
                    <span className="faint small">· {loc.map.name}</span>
                  </>
                )}
              </span>
              {a.hidden && <Badge>{t('Hidden')}</Badge>}
              {game.combat?.active && !inCombat(a.id) && (
                <Button small onClick={() => addCombat(a)}>
                  {t('+ Combat')}
                </Button>
              )}
              <Button small variant="ghost" onClick={() => openSheet(a.id)}>
                {t('Sheet')}
              </Button>
              <Button small variant="ghost" title={t('Save this version as a new template')} onClick={() => saveAsTemplate(a)}>
                {t('→ Template')}
              </Button>
              <Button small variant="danger" title={t('Delete')} onClick={() => remove(a)}>
                ✕
              </Button>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

export default function BestiaryPage({ game }: GameProps) {
  const ui = useUI();
  const [folder, setFolder] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [selId, setSelId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [genOpen, setGenOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const isGM = game.me.role === 'gm';
  const bestiary = game.bestiary || {};
  const templates = useMemo(() => Object.values(bestiary).sort((a, b) => String(a.name).localeCompare(String(b.name), 'fr')), [bestiary]);

  const folders = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const tpl of templates) counts[tpl.folder || DEFAULT_FOLDER] = (counts[tpl.folder || DEFAULT_FOLDER] || 0) + 1;
    return Object.keys(counts)
      .sort(folderSort)
      .map((name) => ({ name, count: counts[name] }));
  }, [templates]);

  const spawnedCount = useMemo(() => {
    const m: Record<string, number> = {};
    for (const a of Object.values(game.actors || {})) if (a.templateId) m[a.templateId] = (m[a.templateId] || 0) + 1;
    return m;
  }, [game.actors]);

  const filtered = useMemo(() => {
    const needle = norm(q.trim());
    return templates.filter((tpl) => {
      if (folder && (tpl.folder || DEFAULT_FOLDER) !== folder) return false;
      if (!needle) return true;
      const hay = norm([tpl.name, tpl.concept, tpl.metatype, tpl.folder, (tpl.skills || []).map((s) => s.name).join(' '), (tpl.weapons || []).map((w) => w.name).join(' ')].join(' '));
      return needle.split(/\s+/).every((w) => hay.includes(w));
    });
  }, [templates, folder, q]);

  if (!isGM)
    return (
      <div className="page">
        <Empty>{t('The bestiary is for the GM only.')}</Empty>
      </div>
    );

  const selected = selId && bestiary[selId] ? bestiary[selId] : null;
  const editing = editingId && bestiary[editingId] ? bestiary[editingId] : null;

  const create = async () => {
    try {
      const res = await send<{ templateId: string }>('bestiary/create', { folder: folder || DEFAULT_FOLDER });
      setSelId(res.templateId);
      setEditingId(res.templateId);
    } catch {
      /* toasted */
    }
  };
  const duplicate = async (tpl: Template) => {
    try {
      const res = await send<{ templateId: string }>('bestiary/duplicate', { templateId: tpl.id });
      setSelId(res.templateId);
      toast(t('Template duplicated'), 'success');
    } catch {
      /* toasted */
    }
  };
  const remove = async (tpl: Template) => {
    const n = spawnedCount[tpl.id] || 0;
    const ok = await confirmAction(
      n ? t('Delete the template « {name} »?\n({n} NPC(s) already in play stay on their maps.)', { name: tpl.name, n }) : t('Delete the template « {name} »?', { name: tpl.name })
    );
    if (!ok) return;
    send('bestiary/delete', { templateId: tpl.id })
      .then(() => setSelId(null))
      .catch(() => null);
  };
  const renameFolder = async (name: string) => {
    const to = await promptText(t('Rename the folder « {name} » to:', { name: folderLabel(name) }), name);
    if (!to || to === name) return;
    send('bestiary/renameFolder', { from: name, to })
      .then(() => {
        if (folder === name) setFolder(to);
      })
      .catch(() => null);
  };
  const exportList = () => {
    if (!filtered.length) return toast(t('Nothing to export'), 'warn');
    downloadJson(`bestiaire${folder ? '-' + norm(folder).replace(/[^a-z0-9]+/g, '-') : ''}.json`, filtered);
  };
  const importFile = async (ev: ChangeEvent<HTMLInputElement>) => {
    const file = ev.target.files?.[0];
    ev.target.value = '';
    if (!file) return;
    let data: unknown;
    try {
      data = JSON.parse(await file.text());
    } catch {
      return toast(t('Unreadable JSON file'), 'error');
    }
    const obj = data as { templates?: unknown } | null;
    const list = Array.isArray(data) ? data : Array.isArray(obj?.templates) ? obj.templates : [data];
    try {
      const res = await send<{ count: number; ids?: string[] }>('bestiary/import', { templates: list });
      toast(tn(res.count, '{n} template imported', '{n} templates imported'), 'success');
      if (res.ids?.[0]) setSelId(res.ids[0]);
    } catch {
      /* toasted */
    }
  };
  const saveEdit = async (draft: Template) => {
    if (!editing) return;
    await send('bestiary/update', { templateId: editing.id, patch: draft });
    toast(t('Template saved'), 'success');
    setEditingId(null);
  };

  return (
    <div className="page">
      <div className="page-title">
        <h2>{t('Bestiary')}</h2>
        <div className="row wrap">
          <SearchBox value={q} onChange={setQ} placeholder={t('Name, skill, weapon…')} />
          <Button variant="accent" onClick={() => setGenOpen(true)}>
            ☠ {t('Create an enemy')}
          </Button>
          <Button variant="primary" onClick={create}>
            {t('+ New template')}
          </Button>
          <Button variant="ghost" title={t('Import a JSON file of templates')} onClick={() => fileRef.current?.click()}>
            {t('Import')}
          </Button>
          <Button variant="ghost" title={t('Export the templates shown as JSON')} onClick={exportList}>
            {t('Export')}
          </Button>
          <input ref={fileRef} type="file" accept=".json,application/json" style={{ display: 'none' }} onChange={importFile} />
        </div>
      </div>

      <div className={'bst' + (selected ? ' has-sel' : '')}>
        <nav className="bst-side">
          <button className={'bst-folder' + (!folder ? ' active' : '')} onClick={() => setFolder(null)}>
            {t('All')}
            <span className="count">{templates.length}</span>
          </button>
          {folders.map((f) => (
            <button key={f.name} className={'bst-folder' + (folder === f.name ? ' active' : '')} onClick={() => setFolder(f.name)}>
              <span>{folderLabel(f.name)}</span>
              <span
                className="ren"
                title={t('Rename the folder')}
                onClick={(e) => {
                  e.stopPropagation();
                  renameFolder(f.name);
                }}
              >
                ✎
              </span>
              <span className="count">{f.count}</span>
            </button>
          ))}
        </nav>

        <div className="bst-list">
          {filtered.map((tpl) => (
            <TemplateCard key={tpl.id} tpl={tpl} active={selected?.id === tpl.id} spawned={spawnedCount[tpl.id] || 0} onClick={() => setSelId(tpl.id)} />
          ))}
          {!filtered.length && <Empty>{templates.length ? t('No template matches.') : t('Empty bestiary.')}</Empty>}
        </div>

        <div className="bst-detail">
          {selected ? (
            <>
              <div className="bst-actions">
                <Button small variant="ghost" className="bst-back" onClick={() => setSelId(null)}>
                  {t('← List')}
                </Button>
                <Button small variant="primary" onClick={() => setEditingId(selected.id)}>
                  {t('Edit')}
                </Button>
                <Button small onClick={() => duplicate(selected)}>
                  {t('Duplicate')}
                </Button>
                <Button small variant="ghost" onClick={() => downloadJson(`${norm(selected.name).replace(/[^a-z0-9]+/g, '-') || 'modele'}.json`, selected)}>
                  {t('Export')}
                </Button>
                <Button small variant="ghost" onClick={() => goTab('map')}>
                  {t('View the map')}
                </Button>
                <span className="grow"></span>
                <Button small variant="danger" onClick={() => remove(selected)}>
                  {t('Delete')}
                </Button>
              </div>
              <SpawnBox key={'spawn-' + selected.id} game={game} tpl={selected} ui={ui} />
              <SpawnedList game={game} tpl={selected} />
              <StatBlock t={selected} />
            </>
          ) : (
            <Panel title={t('Bestiary')}>
              <div className="col">
                <div className="muted">{t('Pick a template to see its stat block, spawn it on a map or edit it.')}</div>
                <div className="small faint">
                  {t('{templates} templates · {folders} folders · {npcs} NPCs in play', {
                    templates: templates.length,
                    folders: folders.length,
                    npcs: Object.values(spawnedCount).reduce((a, b) => a + b, 0),
                  })}
                </div>
              </div>
            </Panel>
          )}
        </div>
      </div>

      {genOpen && <EnemyGenerator game={game} onClose={() => setGenOpen(false)} onCreated={(res) => res.templateIds?.[0] && setSelId(res.templateIds[0])} />}
      {editing && <TemplateEditor key={editing.id} template={editing} folders={folders.map((f) => f.name)} onSave={saveEdit} onClose={() => setEditingId(null)} />}
    </div>
  );
}
