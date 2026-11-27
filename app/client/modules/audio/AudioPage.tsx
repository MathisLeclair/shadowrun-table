// GM ambience / music manager: now playing, scenes, libraries (built-in + uploads), effects, uploads.
import { useEffect, useRef, useState, type FormEvent, type MouseEvent } from 'react';
import { Button, IconButton, Modal, Tabs, Field, Select, Toggle, Badge, Empty, SearchBox, confirmAction } from '../../lib/ui.tsx';
import { send, upload, type GameProps } from '../../lib/net.ts';
import { toast } from '../../lib/ui-store.ts';
import { t, tk, compare } from '../../lib/i18n.ts';
import { presetMeta, trackIcon, KIND_LABELS } from './catalog.ts';
import { togglePreview, stopPreview, useAudioState } from './audio-core.ts';
import {
  ChannelControl, UnlockNotice, LocalVolume, VolumeSlider, tracksOf, findTrack, sceneIsActive, sceneValueLabel,
  setChannelTrack, broadcastSfx, useSfxVolume, sendVolume, lsGet, lsSet, trackName, presetDesc, tagLabel, type Channel,
} from './widgets.tsx';
import { SfxButton } from './SoundDock.tsx';
import type { AudioScene, AudioTrack, GameView, TrackKind } from '../../../shared/types.ts';
import './audio.css';

const AUDIO_EXT = /\.(mp3|ogg|wav|m4a|webm)$/i;
const MAX_UPLOAD = 80 * 1024 * 1024;
const LEVELS = [
  { value: '0.5', label: tk('50% (softer)') },
  { value: '0.75', label: '75 %' },
  { value: '1', label: tk('100% (normal)') },
  { value: '1.25', label: '125 %' },
  { value: '1.5', label: '150 %' },
  { value: '2', label: tk('200% (louder)') },
]; // labels rendered with t()
const kindOptions = () => Object.entries(KIND_LABELS as Record<TrackKind, string>).map(([value, label]) => ({ value: value as TrackKind, label: t(label) }));

const channelOf = (track: AudioTrack): Channel => (track.kind === 'music' ? 'music' : 'ambient');

/** A scene being created or edited in SceneModal (no id = new). */
type SceneDraft = Partial<AudioScene> & { name: string };

type LibTab = 'ambient' | 'music' | 'sfx' | 'files';

function matches(track: AudioTrack, q: string) {
  if (!q) return true;
  const tags = track.tags || [];
  const hay = [track.name, trackName(track), presetMeta(track)?.desc, presetDesc(track), ...tags, ...tags.map(tagLabel)].join(' ').toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => hay.includes(w));
}

function mapOptions(game: GameView, current: string | undefined) {
  const maps = Object.values(game.maps || {}).sort((a, b) => compare(`${a.folder || ''} ${a.name}`, `${b.folder || ''} ${b.name}`));
  const opts = [{ value: '', label: t('— None —') }, ...maps.map((m) => ({ value: m.id, label: (m.folder ? m.folder + ' · ' : '') + (m.name || m.id) }))];
  if (current && !maps.some((m) => m.id === current)) opts.push({ value: current, label: t('(map not found)') });
  return opts;
}

// ---------------------------------------------------------------------------
// Scenes
// ---------------------------------------------------------------------------
function sceneChannelOptions(game: GameView, kind: Channel, current: string | null | undefined) {
  const list = tracksOf(game, kind);
  const cur = findTrack(game, current);
  if (cur && !list.includes(cur)) list.unshift(cur);
  const opts = [{ value: 'keep', label: t('(don’t change)') }, { value: '', label: t('— Silence —') }, ...list.map((tr) => ({ value: tr.id, label: `${trackIcon(tr)} ${trackName(tr)}` }))];
  if (current && current !== 'keep' && !cur) opts.push({ value: current, label: t('(track deleted)') });
  return opts;
}

function SceneModal({ game, scene, onClose }: { game: GameView; scene: SceneDraft; onClose: () => void }) {
  const audio = game.audio;
  const isNew = !scene.id;
  const toUi = (v: string | null | undefined) => (v === undefined || v === 'keep' ? 'keep' : v || '');
  const [name, setName] = useState(scene.name || '');
  const [ambient, setAmbient] = useState(toUi(scene.ambient));
  const [music, setMusic] = useState(toUi(scene.music));
  const [mapId, setMapId] = useState(scene.mapId || '');
  const [withVol, setWithVol] = useState(Number.isFinite(scene.ambientVolume) || Number.isFinite(scene.musicVolume));
  const [av, setAv] = useState(Number.isFinite(scene.ambientVolume) ? (scene.ambientVolume as number) : audio.ambient?.volume ?? 0.5);
  const [mv, setMv] = useState(Number.isFinite(scene.musicVolume) ? (scene.musicVolume as number) : audio.music?.volume ?? 0.4);
  const [busy, setBusy] = useState(false);
  const linked = mapId ? (audio.scenes || []).find((s) => s.mapId === mapId && s.id !== scene.id) : null;

  const save = async (e?: FormEvent) => {
    e?.preventDefault();
    const clean = name.trim();
    if (!clean) return toast(t('Give the scene a name'), 'warn');
    setBusy(true);
    try {
      await send('audio/saveScene', {
        id: scene.id,
        name: clean,
        ambient: ambient === '' ? null : ambient,
        music: music === '' ? null : music,
        mapId: mapId || null,
        ambientVolume: withVol ? av : null,
        musicVolume: withVol ? mv : null,
      });
      toast(isNew ? t('Scene “{name}” created', { name: clean }) : t('Scene saved'), 'success');
      onClose();
    } catch {
      setBusy(false);
    }
  };

  return (
    <Modal title={isNew ? t('New sound scene') : t('Edit scene')} width={560} onClose={onClose}>
      <form className="col gap-l" onSubmit={save}>
        <Field label={t('Name')}>
          <input className="input" value={name} maxLength={80} placeholder={t('e.g. Porfla’s bar')} autoFocus onChange={(e) => setName(e.currentTarget.value)} />
        </Field>
        <div className="grid-2">
          <Field label={t('Ambience')}>
            <Select value={ambient} options={sceneChannelOptions(game, 'ambient', scene.ambient)} onChange={setAmbient} />
          </Field>
          <Field label={t('Music')}>
            <Select value={music} options={sceneChannelOptions(game, 'music', scene.music)} onChange={setMusic} />
          </Field>
        </div>
        <Field
          label={t('Linked map')}
          hint={linked ? t('Already linked to “{name}”: the first one found will be played.', { name: linked.name }) : t('When this map becomes the active map, the scene starts (if the “auto scene” option is on).')}
        >
          <Select value={mapId} options={mapOptions(game, scene.mapId)} onChange={setMapId} />
        </Field>
        <div className="col">
          <Toggle value={withVol} onChange={setWithVol} label={t('Also apply the volumes')} />
          {withVol && (
            <div className="grid-2">
              <VolumeSlider value={av} onChange={setAv} label={t('Ambience')} />
              <VolumeSlider value={mv} onChange={setMv} label={t('Music')} />
            </div>
          )}
        </div>
        <div className="row spread">
          <span className="muted small">{t('“Don’t change” keeps the current track playing (e.g. a “Combat!” scene).')}</span>
          <div className="row">
            <Button type="button" variant="ghost" onClick={onClose}>
              {t('Cancel')}
            </Button>
            <Button type="submit" variant="primary" disabled={busy}>
              {t('Save')}
            </Button>
          </div>
        </div>
      </form>
    </Modal>
  );
}

function SceneCard({ game, scene, onEdit }: { game: GameView; scene: AudioScene; onEdit: (scene: SceneDraft) => void }) {
  const audio = game.audio;
  const active = sceneIsActive(scene, audio);
  const map = scene.mapId ? game.maps?.[scene.mapId] : null;
  const apply = () =>
    send('audio/applyScene', { sceneId: scene.id }).then(
      () => toast(t('Scene “{name}”', { name: scene.name }), 'success', 2000),
      () => {}
    );
  const remove = async (e: MouseEvent) => {
    e.stopPropagation();
    if (await confirmAction(t('Delete the scene “{name}”?', { name: scene.name }))) send('audio/deleteScene', { sceneId: scene.id }).catch(() => {});
  };
  return (
    <div
      className={'audio-scene' + (active ? ' active' : '')}
      role="button"
      tabIndex={0}
      title={t('Apply this scene for everyone')}
      onClick={apply}
      onKeyDown={(e) => {
        if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          apply();
        }
      }}
    >
      <div className="audio-scene-name" title={scene.name}>
        {scene.name}
      </div>
      <div className="audio-scene-line">{t('Ambience: {value}', { value: sceneValueLabel(game, scene.ambient) })}</div>
      <div className="audio-scene-line">{t('Music: {value}', { value: sceneValueLabel(game, scene.music) })}</div>
      {scene.mapId && (
        <div className="audio-scene-line" title={t('Linked map')}>
          ⌖ {map?.name || t('map not found')}
        </div>
      )}
      <div className="audio-scene-tools">
        <IconButton
          icon="✎"
          title={t('Edit')}
          onClick={(e) => {
            e.stopPropagation();
            onEdit(scene);
          }}
        />
        <IconButton icon="🗑" title={t('Delete')} onClick={remove} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Library
// ---------------------------------------------------------------------------
function TrackModal({ track, onClose }: { track: AudioTrack; onClose: () => void }) {
  const [name, setName] = useState(track.name || '');
  const [kind, setKind] = useState<TrackKind>(track.kind);
  const [tags, setTags] = useState((track.tags || []).join(', '));
  const [level, setLevel] = useState(String(track.volume ?? 1));
  const save = async (e?: FormEvent) => {
    e?.preventDefault();
    try {
      await send('audio/updateTrack', {
        id: track.id,
        name: name.trim() || track.name,
        kind: track.source === 'url' ? kind : undefined,
        tags: tags
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean),
        volume: Number(level),
      });
      onClose();
    } catch {}
  };
  const known = LEVELS.map((l) => ({ ...l, label: t(l.label) }));
  const levels = LEVELS.some((l) => l.value === level) ? known : [...known, { value: level, label: `${Math.round(Number(level) * 100)} %` }];
  return (
    <Modal title={t('Edit track')} width={480} onClose={onClose}>
      <form className="col gap-l" onSubmit={save}>
        <Field label={t('Name')}>
          <input className="input" value={name} maxLength={80} autoFocus onChange={(e) => setName(e.currentTarget.value)} />
        </Field>
        <div className="grid-2">
          <Field label={t('Type')}>
            <Select value={kind} disabled={track.source !== 'url'} options={kindOptions()} onChange={setKind} />
          </Field>
          <Field label={t('Level')} hint={t('Corrects a file that is too loud or too quiet.')}>
            <Select value={level} options={levels} onChange={setLevel} />
          </Field>
        </div>
        <Field label={t('Tags')} hint={t('Comma-separated.')}>
          <input className="input" value={tags} onChange={(e) => setTags(e.currentTarget.value)} placeholder={t('e.g. combat, act 2')} />
        </Field>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <Button type="button" variant="ghost" onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button type="submit" variant="primary">
            {t('Save')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

interface TrackCardProps {
  game: GameView;
  track: AudioTrack;
  previewKey: string | null;
  onEdit: (track: AudioTrack) => void;
}
function TrackCard({ game, track, previewKey, onEdit }: TrackCardProps) {
  const desc = presetDesc(track);
  const name = trackName(track);
  const isSfx = track.kind === 'sfx';
  const channel = channelOf(track);
  const playing = !isSfx && game.audio?.[channel]?.trackId === track.id;
  const previewing = previewKey === 'p:' + track.id;
  const remove = async () => {
    if (await confirmAction(t('Remove “{name}” from the library?\n(The file stays on the server.)', { name }))) send('audio/removeTrack', { id: track.id }).catch(() => {});
  };
  const play = () => (isSfx ? broadcastSfx(track.id) : setChannelTrack(channel, playing ? null : track.id));
  const tags = track.tags || [];
  return (
    <div className={'audio-track' + (playing ? ' playing' : '') + (previewing ? ' previewing' : '')}>
      <div className="audio-track-icon">{trackIcon(track)}</div>
      <div className="audio-track-body">
        <div className="audio-track-name" title={name}>
          {name}
        </div>
        {(desc || track.source === 'url') && <div className="audio-track-desc">{desc || track.credit || t('Uploaded file')}</div>}
        {(track.source === 'url' || tags.length > 0) && (
          <div className="row wrap gap-s">
            {track.source === 'url' && <Badge color="amber">{KIND_LABELS[track.kind] ? t(KIND_LABELS[track.kind]) : track.kind}</Badge>}
            {tags.map((tag, i) => (
              <Badge key={`${i}:${tag}`}>{tagLabel(tag)}</Badge>
            ))}
          </div>
        )}
        <div className="audio-track-actions">
          <Button small variant={playing ? 'accent' : 'primary'} onClick={play} title={isSfx ? t('Play for everyone') : playing ? t('Stop for everyone') : t('Broadcast to the whole table')}>
            {isSfx ? '▶ ' + t('Play') : playing ? '■ ' + t('Stop') : '▶ ' + t('Broadcast')}
          </Button>
          <Button small variant={previewing ? 'default' : 'ghost'} onClick={() => togglePreview(track)} title={t('Preview privately: only on this device, players hear nothing')}>
            {previewing ? '■ ' + t('Stop preview') : '🎧 ' + t('Preview privately')}
          </Button>
          {track.source === 'url' && (
            <>
              <IconButton icon="✎" title={t('Edit')} onClick={() => onEdit(track)} />
              <IconButton icon="🗑" title={t('Remove from library')} onClick={remove} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function UploadPanel() {
  const [kind, setKind] = useState<TrackKind>('ambient');
  const [busy, setBusy] = useState(0);
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const onFiles = async (fileList: FileList | null | undefined) => {
    const files = [...(fileList || [])];
    const ok = files.filter((f) => AUDIO_EXT.test(f.name));
    if (files.length && !ok.length) return toast(t('Accepted formats: mp3, ogg, wav, m4a, webm'), 'warn');
    for (const f of ok) {
      if (f.size > MAX_UPLOAD) {
        toast(t('“{name}” is larger than 80 MB', { name: f.name }), 'error');
        continue;
      }
      const name = f.name.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').trim().slice(0, 80) || t('Untitled');
      setBusy((b) => b + 1);
      try {
        let res;
        try {
          res = await upload(f);
        } catch (err) {
          toast(t('Upload of “{name}” failed: {error}', { name: f.name, error: (err as Error).message }), 'error');
          continue;
        }
        await send('audio/addTrack', { name, kind, url: res.url }).then(
          () => toast(kind === 'music' ? t('“{name}” added (music)', { name }) : kind === 'sfx' ? t('“{name}” added (sound effect)', { name }) : t('“{name}” added (ambience)', { name }), 'success'),
          () => {}
        );
      } finally {
        setBusy((b) => b - 1);
      }
    }
    if (input.current) input.current.value = '';
  };

  return (
    <div
      className="card audio-upload"
      style={over ? { borderColor: 'var(--cyan)' } : undefined}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        onFiles(e.dataTransfer?.files);
      }}
    >
      <Field label={t('Import as')}>
        <Select value={kind} options={kindOptions()} onChange={setKind} />
      </Field>
      <input ref={input} className="audio-file" type="file" accept="audio/*,.mp3,.ogg,.wav,.m4a,.webm" multiple onChange={(e) => onFiles(e.currentTarget.files)} />
      <Button variant="primary" disabled={busy > 0} onClick={() => input.current?.click()}>
        {busy > 0 ? t('Uploading… ({n})', { n: busy }) : '⇪ ' + t('Choose files')}
      </Button>
      <span className="muted small grow">{t('…or drag and drop here. mp3 / ogg / wav / m4a / webm, 80 MB max. Ambiences and music loop.')}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------
export default function AudioPage({ game }: GameProps) {
  const audio = game.audio;
  const st = useAudioState();
  const [tab, setTabState] = useState(() => lsGet('sr.audio.tab', 'ambient'));
  const [q, setQ] = useState('');
  const [sceneEdit, setSceneEdit] = useState<SceneDraft | null>(null);
  const [trackEdit, setTrackEdit] = useState<AudioTrack | null>(null);
  const [sfxVol, setSfxVol] = useSfxVolume();
  useEffect(
    () => () => {
      stopPreview();
    },
    []
  );

  if (!audio)
    return (
      <div className="page">
        <Empty>{t('Audio module unavailable (server).')}</Empty>
      </div>
    );

  const setTab = (id: LibTab) => {
    setTabState(id);
    lsSet('sr.audio.tab', id);
  };
  const scenes = audio.scenes || [];
  const uploads = (audio.tracks || []).filter((tr) => tr.source === 'url');
  const lists: Record<LibTab, AudioTrack[]> = {
    ambient: tracksOf(game, 'ambient'),
    music: tracksOf(game, 'music'),
    sfx: tracksOf(game, 'sfx'),
    files: uploads.sort((a, b) => a.kind.localeCompare(b.kind) || compare(a.name, b.name)),
  };
  const current: LibTab = tab in lists ? (tab as LibTab) : 'ambient';
  const shown = lists[current].filter((tr) => matches(tr, q));
  const fromCurrent = () =>
    setSceneEdit({
      name: '',
      ambient: audio.ambient?.trackId || null,
      music: audio.music?.trackId || null,
      mapId: game.scene?.activeMapId || undefined,
    });

  return (
    <div className="page audio-page">
      <div className="page-title">
        <h2>{t('Ambience & music')}</h2>
        <div className="row wrap">
          <Toggle
            value={!!audio.autoScenes}
            onChange={(v) => send('audio/setOptions', { autoScenes: v }).catch(() => {})}
            label={t('Auto scene on map change')}
            title={t('When the active map changes, play the sound scene linked to that map')}
          />
          <Button variant="danger" title={t('Stops the ambience, music and sound effects playing, for everyone')} onClick={() => send('audio/stopAll').catch(() => {})}>
            ⏹ {t('Stop all')}
          </Button>
        </div>
      </div>

      <UnlockNotice />

      <div className="audio-now">
        <ChannelControl game={game} channel="ambient" label={t('Ambience')} />
        <ChannelControl game={game} channel="music" label={t('Music')} />
        <div className="audio-now-side">
          <VolumeSlider value={audio.master ?? 0.8} onChange={(v) => sendVolume('master', v)} label={t('volume::Master')} title={t('Master volume, for the whole table')} />
          <LocalVolume label={t('This device')} />
        </div>
      </div>

      <div className="section-title">{t('Scenes')}</div>
      <div className="audio-toolbar">
        <Button small variant="primary" onClick={fromCurrent} title={t('Creates a scene from the ambience and music currently playing')}>
          + {t('Scene from current ambience')}
        </Button>
        <Button small onClick={() => setSceneEdit({ name: '', ambient: 'keep', music: 'keep' })}>
          + {t('Empty scene')}
        </Button>
        <span className="muted small">{t('Click a scene to play it for everyone.')}</span>
      </div>
      {scenes.length ? (
        <div className="audio-scenes">
          {scenes.map((s) => (
            <SceneCard key={s.id} game={game} scene={s} onEdit={setSceneEdit} />
          ))}
        </div>
      ) : (
        <Empty>{t('No scenes. Start an ambience and some music, then “Scene from current ambience”.')}</Empty>
      )}

      <div className="section-title">{t('Library')}</div>
      <div className="audio-toolbar">
        <Tabs<LibTab>
          tabs={[
            { id: 'ambient', label: t('Ambiences') },
            { id: 'music', label: t('pl::Music') },
            { id: 'sfx', label: t('Sound effects') },
            { id: 'files', label: t('My files'), badge: uploads.length || null },
          ]}
          value={current}
          onChange={setTab}
        />
        <div className="grow"></div>
        <SearchBox value={q} onChange={setQ} placeholder={t('Filter…')} />
      </div>

      {current === 'sfx' ? (
        <div className="col">
          <div className="row wrap" style={{ maxWidth: 460 }}>
            <VolumeSlider value={sfxVol} onChange={setSfxVol} label={t('Sound effects volume')} title={t('Volume at which your sound effects play for everyone')} />
          </div>
          {shown.length ? (
            <div className="audio-sfx-grid">
              {shown.map((tr) => (
                <SfxButton key={tr.id} track={tr} onFire={(x) => broadcastSfx(x.id, sfxVol)} onPreview={togglePreview} />
              ))}
            </div>
          ) : (
            <Empty>{t('No matching sound effect.')}</Empty>
          )}
          <span className="muted small">{t('Click = plays for everyone · 🎧 = private preview on this device. Other modules (dice, doors, purchases…) also trigger these sounds automatically.')}</span>
        </div>
      ) : current === 'files' ? (
        <div className="col gap-l">
          <UploadPanel />
          {shown.length ? (
            <div className="audio-lib">
              {shown.map((tr) => (
                <TrackCard key={tr.id} game={game} track={tr} previewKey={st.previewKey} onEdit={setTrackEdit} />
              ))}
            </div>
          ) : (
            <Empty>{uploads.length ? t('No matching file.') : t('No uploaded files. All built-in ambiences, music and sound effects are synthesized live.')}</Empty>
          )}
        </div>
      ) : shown.length ? (
        <div className="audio-lib">
          {shown.map((tr) => (
            <TrackCard key={tr.id} game={game} track={tr} previewKey={st.previewKey} onEdit={setTrackEdit} />
          ))}
        </div>
      ) : (
        <Empty>{t('No matching track.')}</Empty>
      )}

      {sceneEdit && <SceneModal game={game} scene={sceneEdit} onClose={() => setSceneEdit(null)} />}
      {trackEdit && <TrackModal track={trackEdit} onClose={() => setTrackEdit(null)} />}
    </div>
  );
}
