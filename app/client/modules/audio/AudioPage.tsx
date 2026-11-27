// GM ambience / music manager: now playing, scenes, libraries (built-in + uploads), effects, uploads.
import { useEffect, useRef, useState, type FormEvent, type MouseEvent } from 'react';
import { Button, IconButton, Modal, Tabs, Field, Select, Toggle, Badge, Empty, SearchBox, confirmAction } from '../../lib/ui.tsx';
import { send, upload, type GameProps } from '../../lib/net.ts';
import { toast } from '../../lib/ui-store.ts';
import { t, tk, compare } from '../../lib/i18n.js';
import { presetMeta, trackIcon, KIND_LABELS } from './catalog.js';
import { togglePreview, stopPreview, useAudioState } from './audio-core.js';
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
  { value: '0.5', label: tk('50 % (plus doux)') },
  { value: '0.75', label: '75 %' },
  { value: '1', label: tk('100 % (normal)') },
  { value: '1.25', label: '125 %' },
  { value: '1.5', label: '150 %' },
  { value: '2', label: tk('200 % (plus fort)') },
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
  const opts = [{ value: '', label: t('— Aucune —') }, ...maps.map((m) => ({ value: m.id, label: (m.folder ? m.folder + ' · ' : '') + (m.name || m.id) }))];
  if (current && !maps.some((m) => m.id === current)) opts.push({ value: current, label: t('(carte introuvable)') });
  return opts;
}

// ---------------------------------------------------------------------------
// Scenes
// ---------------------------------------------------------------------------
function sceneChannelOptions(game: GameView, kind: Channel, current: string | null | undefined) {
  const list = tracksOf(game, kind);
  const cur = findTrack(game, current);
  if (cur && !list.includes(cur)) list.unshift(cur);
  const opts = [{ value: 'keep', label: t('(ne pas changer)') }, { value: '', label: t('— Silence —') }, ...list.map((tr) => ({ value: tr.id, label: `${trackIcon(tr)} ${trackName(tr)}` }))];
  if (current && current !== 'keep' && !cur) opts.push({ value: current, label: t('(piste supprimée)') });
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
    if (!clean) return toast(t('Donne un nom à la scène'), 'warn');
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
      toast(isNew ? t('Scène « {name} » créée', { name: clean }) : t('Scène enregistrée'), 'success');
      onClose();
    } catch {
      setBusy(false);
    }
  };

  return (
    <Modal title={isNew ? t('Nouvelle scène sonore') : t('Modifier la scène')} width={560} onClose={onClose}>
      <form className="col gap-l" onSubmit={save}>
        <Field label={t('Nom')}>
          <input className="input" value={name} maxLength={80} placeholder={t('ex. Bar de Porfla')} autoFocus onChange={(e) => setName(e.currentTarget.value)} />
        </Field>
        <div className="grid-2">
          <Field label={t('Ambiance')}>
            <Select value={ambient} options={sceneChannelOptions(game, 'ambient', scene.ambient)} onChange={setAmbient} />
          </Field>
          <Field label={t('Musique')}>
            <Select value={music} options={sceneChannelOptions(game, 'music', scene.music)} onChange={setMusic} />
          </Field>
        </div>
        <Field
          label={t('Carte liée')}
          hint={linked ? t('Déjà liée à « {name} » : c’est la première trouvée qui sera lancée.', { name: linked.name }) : t('Quand cette carte devient la carte active, la scène se lance (si l’option « scène auto » est activée).')}
        >
          <Select value={mapId} options={mapOptions(game, scene.mapId)} onChange={setMapId} />
        </Field>
        <div className="col">
          <Toggle value={withVol} onChange={setWithVol} label={t('Imposer aussi les volumes')} />
          {withVol && (
            <div className="grid-2">
              <VolumeSlider value={av} onChange={setAv} label={t('Ambiance')} />
              <VolumeSlider value={mv} onChange={setMv} label={t('Musique')} />
            </div>
          )}
        </div>
        <div className="row spread">
          <span className="muted small">{t('« Ne pas changer » laisse la piste en cours (ex. scène « Combat ! »).')}</span>
          <div className="row">
            <Button type="button" variant="ghost" onClick={onClose}>
              {t('Annuler')}
            </Button>
            <Button type="submit" variant="primary" disabled={busy}>
              {t('Enregistrer')}
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
      () => toast(t('Scène « {name} »', { name: scene.name }), 'success', 2000),
      () => {}
    );
  const remove = async (e: MouseEvent) => {
    e.stopPropagation();
    if (await confirmAction(t('Supprimer la scène « {name} » ?', { name: scene.name }))) send('audio/deleteScene', { sceneId: scene.id }).catch(() => {});
  };
  return (
    <div
      className={'audio-scene' + (active ? ' active' : '')}
      role="button"
      tabIndex={0}
      title={t('Appliquer cette scène pour tout le monde')}
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
      <div className="audio-scene-line">{t('Ambiance : {value}', { value: sceneValueLabel(game, scene.ambient) })}</div>
      <div className="audio-scene-line">{t('Musique : {value}', { value: sceneValueLabel(game, scene.music) })}</div>
      {scene.mapId && (
        <div className="audio-scene-line" title={t('Carte liée')}>
          ⌖ {map?.name || t('carte introuvable')}
        </div>
      )}
      <div className="audio-scene-tools">
        <IconButton
          icon="✎"
          title={t('Modifier')}
          onClick={(e) => {
            e.stopPropagation();
            onEdit(scene);
          }}
        />
        <IconButton icon="🗑" title={t('Supprimer')} onClick={remove} />
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
    <Modal title={t('Modifier la piste')} width={480} onClose={onClose}>
      <form className="col gap-l" onSubmit={save}>
        <Field label={t('Nom')}>
          <input className="input" value={name} maxLength={80} autoFocus onChange={(e) => setName(e.currentTarget.value)} />
        </Field>
        <div className="grid-2">
          <Field label={t('Type')}>
            <Select value={kind} disabled={track.source !== 'url'} options={kindOptions()} onChange={setKind} />
          </Field>
          <Field label={t('Niveau')} hint={t('Corrige un fichier trop fort ou trop faible.')}>
            <Select value={level} options={levels} onChange={setLevel} />
          </Field>
        </div>
        <Field label={t('Étiquettes')} hint={t('Séparées par des virgules.')}>
          <input className="input" value={tags} onChange={(e) => setTags(e.currentTarget.value)} placeholder={t('ex. combat, acte 2')} />
        </Field>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <Button type="button" variant="ghost" onClick={onClose}>
            {t('Annuler')}
          </Button>
          <Button type="submit" variant="primary">
            {t('Enregistrer')}
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
    if (await confirmAction(t('Retirer « {name} » de la bibliothèque ?\n(Le fichier reste sur le serveur.)', { name }))) send('audio/removeTrack', { id: track.id }).catch(() => {});
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
        {(desc || track.source === 'url') && <div className="audio-track-desc">{desc || track.credit || t('Fichier importé')}</div>}
        {(track.source === 'url' || tags.length > 0) && (
          <div className="row wrap gap-s">
            {track.source === 'url' && <Badge color="amber">{KIND_LABELS[track.kind] ? t(KIND_LABELS[track.kind]) : track.kind}</Badge>}
            {tags.map((tag, i) => (
              <Badge key={`${i}:${tag}`}>{tagLabel(tag)}</Badge>
            ))}
          </div>
        )}
        <div className="audio-track-actions">
          <Button small variant={playing ? 'accent' : 'primary'} onClick={play} title={isSfx ? t('Jouer pour tout le monde') : playing ? t('Arrêter pour tout le monde') : t('Diffuser à toute la table')}>
            {isSfx ? '▶ ' + t('Jouer') : playing ? '■ ' + t('Arrêter') : '▶ ' + t('Diffuser')}
          </Button>
          <Button small variant={previewing ? 'default' : 'ghost'} onClick={() => togglePreview(track)} title={t('Écouter en privé : seulement sur ce poste, les joueurs n’entendent rien')}>
            {previewing ? '■ ' + t('Fin de l’écoute') : '🎧 ' + t('Écouter en privé')}
          </Button>
          {track.source === 'url' && (
            <>
              <IconButton icon="✎" title={t('Modifier')} onClick={() => onEdit(track)} />
              <IconButton icon="🗑" title={t('Retirer de la bibliothèque')} onClick={remove} />
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
    if (files.length && !ok.length) return toast(t('Formats acceptés : mp3, ogg, wav, m4a, webm'), 'warn');
    for (const f of ok) {
      if (f.size > MAX_UPLOAD) {
        toast(t('« {name} » dépasse 80 Mo', { name: f.name }), 'error');
        continue;
      }
      const name = f.name.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').trim().slice(0, 80) || t('Sans titre');
      setBusy((b) => b + 1);
      try {
        let res;
        try {
          res = await upload(f);
        } catch (err) {
          toast(t('Échec de l’envoi de « {name} » : {error}', { name: f.name, error: (err as Error).message }), 'error');
          continue;
        }
        await send('audio/addTrack', { name, kind, url: res.url }).then(
          () => toast(kind === 'music' ? t('« {name} » ajouté (musique)', { name }) : kind === 'sfx' ? t('« {name} » ajouté (bruitage)', { name }) : t('« {name} » ajouté (ambiance)', { name }), 'success'),
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
      <Field label={t('Importer comme')}>
        <Select value={kind} options={kindOptions()} onChange={setKind} />
      </Field>
      <input ref={input} className="audio-file" type="file" accept="audio/*,.mp3,.ogg,.wav,.m4a,.webm" multiple onChange={(e) => onFiles(e.currentTarget.files)} />
      <Button variant="primary" disabled={busy > 0} onClick={() => input.current?.click()}>
        {busy > 0 ? t('Envoi… ({n})', { n: busy }) : '⇪ ' + t('Choisir des fichiers')}
      </Button>
      <span className="muted small grow">{t('…ou glisser-déposer ici. mp3 / ogg / wav / m4a / webm, 80 Mo max. Les ambiances et musiques tournent en boucle.')}</span>
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
        <Empty>{t('Module audio indisponible (serveur).')}</Empty>
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
        <h2>{t('Ambiance & musique')}</h2>
        <div className="row wrap">
          <Toggle
            value={!!audio.autoScenes}
            onChange={(v) => send('audio/setOptions', { autoScenes: v }).catch(() => {})}
            label={t('Scène auto au changement de carte')}
            title={t('Quand la carte active change, lancer la scène sonore liée à cette carte')}
          />
          <Button variant="danger" title={t('Coupe ambiance, musique et bruitages en cours, chez tout le monde')} onClick={() => send('audio/stopAll').catch(() => {})}>
            ⏹ {t('Tout couper')}
          </Button>
        </div>
      </div>

      <UnlockNotice />

      <div className="audio-now">
        <ChannelControl game={game} channel="ambient" label={t('Ambiance')} />
        <ChannelControl game={game} channel="music" label={t('Musique')} />
        <div className="audio-now-side">
          <VolumeSlider value={audio.master ?? 0.8} onChange={(v) => sendVolume('master', v)} label={t('volume::Général')} title={t('Volume général, pour toute la table')} />
          <LocalVolume label={t('Ce poste')} />
        </div>
      </div>

      <div className="section-title">{t('Scènes')}</div>
      <div className="audio-toolbar">
        <Button small variant="primary" onClick={fromCurrent} title={t('Crée une scène avec l’ambiance et la musique en cours')}>
          + {t('Scène depuis l’ambiance actuelle')}
        </Button>
        <Button small onClick={() => setSceneEdit({ name: '', ambient: 'keep', music: 'keep' })}>
          + {t('Scène vide')}
        </Button>
        <span className="muted small">{t('Un clic sur une scène la lance pour tout le monde.')}</span>
      </div>
      {scenes.length ? (
        <div className="audio-scenes">
          {scenes.map((s) => (
            <SceneCard key={s.id} game={game} scene={s} onEdit={setSceneEdit} />
          ))}
        </div>
      ) : (
        <Empty>{t('Aucune scène. Lance une ambiance et une musique, puis « Scène depuis l’ambiance actuelle ».')}</Empty>
      )}

      <div className="section-title">{t('Bibliothèque')}</div>
      <div className="audio-toolbar">
        <Tabs<LibTab>
          tabs={[
            { id: 'ambient', label: t('Ambiances') },
            { id: 'music', label: t('Musiques') },
            { id: 'sfx', label: t('Bruitages') },
            { id: 'files', label: t('Mes fichiers'), badge: uploads.length || null },
          ]}
          value={current}
          onChange={setTab}
        />
        <div className="grow"></div>
        <SearchBox value={q} onChange={setQ} placeholder={t('Filtrer…')} />
      </div>

      {current === 'sfx' ? (
        <div className="col">
          <div className="row wrap" style={{ maxWidth: 460 }}>
            <VolumeSlider value={sfxVol} onChange={setSfxVol} label={t('Volume des bruitages')} title={t('Volume auquel vos bruitages sont joués chez tout le monde')} />
          </div>
          {shown.length ? (
            <div className="audio-sfx-grid">
              {shown.map((tr) => (
                <SfxButton key={tr.id} track={tr} onFire={(x) => broadcastSfx(x.id, sfxVol)} onPreview={togglePreview} />
              ))}
            </div>
          ) : (
            <Empty>{t('Aucun bruitage ne correspond.')}</Empty>
          )}
          <span className="muted small">{t('Clic = joué chez tout le monde · 🎧 = écoute privée sur ce poste. Les autres modules (dés, portes, achats…) déclenchent aussi ces sons automatiquement.')}</span>
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
            <Empty>{uploads.length ? t('Aucun fichier ne correspond.') : t('Aucun fichier importé. Toutes les ambiances, musiques et bruitages intégrés sont synthétisés en direct.')}</Empty>
          )}
        </div>
      ) : shown.length ? (
        <div className="audio-lib">
          {shown.map((tr) => (
            <TrackCard key={tr.id} game={game} track={tr} previewKey={st.previewKey} onEdit={setTrackEdit} />
          ))}
        </div>
      ) : (
        <Empty>{t('Aucune piste ne correspond.')}</Empty>
      )}

      {sceneEdit && <SceneModal game={game} scene={sceneEdit} onClose={() => setSceneEdit(null)} />}
      {trackEdit && <TrackModal track={trackEdit} onClose={() => setTrackEdit(null)} />}
    </div>
  );
}
