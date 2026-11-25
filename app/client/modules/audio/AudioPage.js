// GM ambience / music manager: now playing, scenes, libraries (built-in + uploads), effects, uploads.
import { useEffect, useRef, useState } from 'preact/hooks';
import { html, Button, IconButton, Modal, Tabs, Field, Select, Toggle, Badge, Empty, SearchBox, loadCss, confirmAction } from '../../lib/ui.js';
import { send, upload } from '../../lib/net.js';
import { toast } from '../../lib/ui-store.js';
import { presetMeta, trackIcon, KIND_LABELS } from './catalog.js';
import { togglePreview, stopPreview, useAudioState } from './audio-core.js';
import {
  ChannelControl, UnlockNotice, LocalVolume, VolumeSlider, tracksOf, findTrack, sceneIsActive, sceneValueLabel,
  setChannelTrack, broadcastSfx, useSfxVolume, sendVolume, lsGet, lsSet,
} from './widgets.js';
import { SfxButton } from './SoundDock.js';

loadCss('/modules/audio/audio.css');

const AUDIO_EXT = /\.(mp3|ogg|wav|m4a|webm)$/i;
const MAX_UPLOAD = 80 * 1024 * 1024;
const LEVELS = [
  { value: '0.5', label: '50 % (plus doux)' },
  { value: '0.75', label: '75 %' },
  { value: '1', label: '100 % (normal)' },
  { value: '1.25', label: '125 %' },
  { value: '1.5', label: '150 %' },
  { value: '2', label: '200 % (plus fort)' },
];

const channelOf = (track) => (track.kind === 'music' ? 'music' : 'ambient');

function matches(track, q) {
  if (!q) return true;
  const hay = [track.name, presetMeta(track)?.desc, ...(track.tags || [])].join(' ').toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => hay.includes(w));
}

function mapOptions(game, current) {
  const maps = Object.values(game.maps || {}).sort((a, b) => `${a.folder || ''} ${a.name}`.localeCompare(`${b.folder || ''} ${b.name}`, 'fr'));
  const opts = [{ value: '', label: '— Aucune —' }, ...maps.map((m) => ({ value: m.id, label: (m.folder ? m.folder + ' · ' : '') + (m.name || m.id) }))];
  if (current && !maps.some((m) => m.id === current)) opts.push({ value: current, label: '(carte introuvable)' });
  return opts;
}

// ---------------------------------------------------------------------------
// Scenes
// ---------------------------------------------------------------------------
function sceneChannelOptions(game, kind, current) {
  const list = tracksOf(game, kind);
  const cur = findTrack(game, current);
  if (cur && !list.includes(cur)) list.unshift(cur);
  const opts = [{ value: 'keep', label: '(ne pas changer)' }, { value: '', label: '— Silence —' }, ...list.map((t) => ({ value: t.id, label: `${trackIcon(t)} ${t.name}` }))];
  if (current && current !== 'keep' && !cur) opts.push({ value: current, label: '(piste supprimée)' });
  return opts;
}

function SceneModal({ game, scene, onClose }) {
  const audio = game.audio;
  const isNew = !scene.id;
  const toUi = (v) => (v === undefined || v === 'keep' ? 'keep' : v || '');
  const [name, setName] = useState(scene.name || '');
  const [ambient, setAmbient] = useState(toUi(scene.ambient));
  const [music, setMusic] = useState(toUi(scene.music));
  const [mapId, setMapId] = useState(scene.mapId || '');
  const [withVol, setWithVol] = useState(Number.isFinite(scene.ambientVolume) || Number.isFinite(scene.musicVolume));
  const [av, setAv] = useState(Number.isFinite(scene.ambientVolume) ? scene.ambientVolume : audio.ambient?.volume ?? 0.5);
  const [mv, setMv] = useState(Number.isFinite(scene.musicVolume) ? scene.musicVolume : audio.music?.volume ?? 0.4);
  const [busy, setBusy] = useState(false);
  const linked = mapId ? (audio.scenes || []).find((s) => s.mapId === mapId && s.id !== scene.id) : null;

  const save = async (e) => {
    e?.preventDefault();
    const clean = name.trim();
    if (!clean) return toast('Donne un nom à la scène', 'warn');
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
      toast(isNew ? `Scène « ${clean} » créée` : 'Scène enregistrée', 'success');
      onClose();
    } catch {
      setBusy(false);
    }
  };

  return html`<${Modal} title=${isNew ? 'Nouvelle scène sonore' : 'Modifier la scène'} width=${560} onClose=${onClose}>
    <form class="col gap-l" onSubmit=${save}>
      <${Field} label="Nom">
        <input class="input" value=${name} maxlength="80" placeholder="ex. Bar de Porfla" autofocus onInput=${(e) => setName(e.currentTarget.value)} />
      </${Field}>
      <div class="grid-2">
        <${Field} label="Ambiance">
          <${Select} value=${ambient} options=${sceneChannelOptions(game, 'ambient', scene.ambient)} onChange=${setAmbient} />
        </${Field}>
        <${Field} label="Musique">
          <${Select} value=${music} options=${sceneChannelOptions(game, 'music', scene.music)} onChange=${setMusic} />
        </${Field}>
      </div>
      <${Field} label="Carte liée" hint=${linked ? `Déjà liée à « ${linked.name} » : c’est la première trouvée qui sera lancée.` : 'Quand cette carte devient la carte active, la scène se lance (si l’option « scène auto » est activée).'}>
        <${Select} value=${mapId} options=${mapOptions(game, scene.mapId)} onChange=${setMapId} />
      </${Field}>
      <div class="col">
        <${Toggle} value=${withVol} onChange=${setWithVol} label="Imposer aussi les volumes" />
        ${withVol &&
        html`<div class="grid-2">
          <${VolumeSlider} value=${av} onChange=${setAv} label="Ambiance" />
          <${VolumeSlider} value=${mv} onChange=${setMv} label="Musique" />
        </div>`}
      </div>
      <div class="row spread">
        <span class="muted small">« Ne pas changer » laisse la piste en cours (ex. scène « Combat ! »).</span>
        <div class="row">
          <${Button} type="button" variant="ghost" onClick=${onClose}>Annuler</${Button}>
          <${Button} type="submit" variant="primary" disabled=${busy}>Enregistrer</${Button}>
        </div>
      </div>
    </form>
  </${Modal}>`;
}

function SceneCard({ game, scene, onEdit }) {
  const audio = game.audio;
  const active = sceneIsActive(scene, audio);
  const map = scene.mapId ? game.maps?.[scene.mapId] : null;
  const apply = () =>
    send('audio/applyScene', { sceneId: scene.id }).then(
      () => toast(`Scène « ${scene.name} »`, 'success', 2000),
      () => {}
    );
  const remove = async (e) => {
    e.stopPropagation();
    if (await confirmAction(`Supprimer la scène « ${scene.name} » ?`)) send('audio/deleteScene', { sceneId: scene.id }).catch(() => {});
  };
  return html`<div class=${'audio-scene' + (active ? ' active' : '')} role="button" tabindex="0" title="Appliquer cette scène pour tout le monde"
    onClick=${apply} onKeyDown=${(e) => e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), apply())}>
    <div class="audio-scene-name" title=${scene.name}>${scene.name}</div>
    <div class="audio-scene-line">Ambiance : ${sceneValueLabel(game, scene.ambient)}</div>
    <div class="audio-scene-line">Musique : ${sceneValueLabel(game, scene.music)}</div>
    ${scene.mapId && html`<div class="audio-scene-line" title="Carte liée">⌖ ${map?.name || 'carte introuvable'}</div>`}
    <div class="audio-scene-tools">
      <${IconButton} icon="✎" title="Modifier" onClick=${(e) => {
        e.stopPropagation();
        onEdit(scene);
      }} />
      <${IconButton} icon="🗑" title="Supprimer" onClick=${remove} />
    </div>
  </div>`;
}

// ---------------------------------------------------------------------------
// Library
// ---------------------------------------------------------------------------
function TrackModal({ track, onClose }) {
  const [name, setName] = useState(track.name || '');
  const [kind, setKind] = useState(track.kind);
  const [tags, setTags] = useState((track.tags || []).join(', '));
  const [level, setLevel] = useState(String(track.volume ?? 1));
  const save = async (e) => {
    e?.preventDefault();
    try {
      await send('audio/updateTrack', {
        id: track.id,
        name: name.trim() || track.name,
        kind: track.source === 'url' ? kind : undefined,
        tags: tags.split(',').map((t) => t.trim()).filter(Boolean),
        volume: Number(level),
      });
      onClose();
    } catch {}
  };
  const levels = LEVELS.some((l) => l.value === level) ? LEVELS : [...LEVELS, { value: level, label: `${Math.round(Number(level) * 100)} %` }];
  return html`<${Modal} title="Modifier la piste" width=${480} onClose=${onClose}>
    <form class="col gap-l" onSubmit=${save}>
      <${Field} label="Nom"><input class="input" value=${name} maxlength="80" autofocus onInput=${(e) => setName(e.currentTarget.value)} /></${Field}>
      <div class="grid-2">
        <${Field} label="Type">
          <${Select} value=${kind} disabled=${track.source !== 'url'} options=${Object.entries(KIND_LABELS).map(([value, label]) => ({ value, label }))} onChange=${setKind} />
        </${Field}>
        <${Field} label="Niveau" hint="Corrige un fichier trop fort ou trop faible.">
          <${Select} value=${level} options=${levels} onChange=${setLevel} />
        </${Field}>
      </div>
      <${Field} label="Étiquettes" hint="Séparées par des virgules.">
        <input class="input" value=${tags} onInput=${(e) => setTags(e.currentTarget.value)} placeholder="ex. combat, acte 2" />
      </${Field}>
      <div class="row" style="justify-content:flex-end">
        <${Button} type="button" variant="ghost" onClick=${onClose}>Annuler</${Button}>
        <${Button} type="submit" variant="primary">Enregistrer</${Button}>
      </div>
    </form>
  </${Modal}>`;
}

function TrackCard({ game, track, previewKey, onEdit }) {
  const meta = presetMeta(track);
  const isSfx = track.kind === 'sfx';
  const channel = channelOf(track);
  const playing = !isSfx && game.audio?.[channel]?.trackId === track.id;
  const previewing = previewKey === 'p:' + track.id;
  const remove = async () => {
    if (await confirmAction(`Retirer « ${track.name} » de la bibliothèque ?\n(Le fichier reste sur le serveur.)`)) send('audio/removeTrack', { id: track.id }).catch(() => {});
  };
  const play = () => (isSfx ? broadcastSfx(track.id) : setChannelTrack(channel, playing ? null : track.id));
  return html`<div class=${'audio-track' + (playing ? ' playing' : '') + (previewing ? ' previewing' : '')}>
    <div class="audio-track-icon">${trackIcon(track)}</div>
    <div class="audio-track-body">
      <div class="audio-track-name" title=${track.name}>${track.name}</div>
      ${(meta?.desc || track.source === 'url') && html`<div class="audio-track-desc">${meta?.desc || 'Fichier importé'}</div>`}
      ${(track.source === 'url' || track.tags?.length > 0) &&
      html`<div class="row wrap gap-s">
        ${track.source === 'url' && html`<${Badge} color="amber">${KIND_LABELS[track.kind] || track.kind}</${Badge}>`}
        ${(track.tags || []).map((t) => html`<${Badge}>${t}</${Badge}>`)}
      </div>`}
      <div class="audio-track-actions">
        <${Button} small variant=${playing ? 'accent' : 'primary'} onClick=${play} title=${isSfx ? 'Jouer pour tout le monde' : playing ? 'Arrêter pour tout le monde' : 'Diffuser à toute la table'}>
          ${isSfx ? '▶ Jouer' : playing ? '■ Arrêter' : '▶ Diffuser'}
        </${Button}>
        <${Button} small variant=${previewing ? 'default' : 'ghost'} onClick=${() => togglePreview(track)} title="Écouter en privé : seulement sur ce poste, les joueurs n’entendent rien">
          ${previewing ? '■ Fin de l’écoute' : '🎧 Écouter en privé'}
        </${Button}>
        ${track.source === 'url' &&
        html`<${IconButton} icon="✎" title="Modifier" onClick=${() => onEdit(track)} />
          <${IconButton} icon="🗑" title="Retirer de la bibliothèque" onClick=${remove} />`}
      </div>
    </div>
  </div>`;
}

function UploadPanel() {
  const [kind, setKind] = useState('ambient');
  const [busy, setBusy] = useState(0);
  const [over, setOver] = useState(false);
  const input = useRef(null);

  const onFiles = async (fileList) => {
    const files = [...(fileList || [])];
    const ok = files.filter((f) => AUDIO_EXT.test(f.name));
    if (files.length && !ok.length) return toast('Formats acceptés : mp3, ogg, wav, m4a, webm', 'warn');
    for (const f of ok) {
      if (f.size > MAX_UPLOAD) {
        toast(`« ${f.name} » dépasse 80 Mo`, 'error');
        continue;
      }
      const name = f.name.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').trim().slice(0, 80) || 'Sans titre';
      setBusy((b) => b + 1);
      try {
        let res;
        try {
          res = await upload(f);
        } catch (err) {
          toast(`Échec de l’envoi de « ${f.name} » : ${err.message}`, 'error');
          continue;
        }
        await send('audio/addTrack', { name, kind, url: res.url }).then(
          () => toast(`« ${name} » ajouté (${KIND_LABELS[kind].toLowerCase()})`, 'success'),
          () => {}
        );
      } finally {
        setBusy((b) => b - 1);
      }
    }
    if (input.current) input.current.value = '';
  };

  return html`<div class="card audio-upload" style=${over ? 'border-color: var(--cyan)' : ''}
    onDragOver=${(e) => {
      e.preventDefault();
      setOver(true);
    }}
    onDragLeave=${() => setOver(false)}
    onDrop=${(e) => {
      e.preventDefault();
      setOver(false);
      onFiles(e.dataTransfer?.files);
    }}>
    <${Field} label="Importer comme">
      <${Select} value=${kind} options=${Object.entries(KIND_LABELS).map(([value, label]) => ({ value, label }))} onChange=${setKind} />
    </${Field}>
    <input ref=${input} class="audio-file" type="file" accept="audio/*,.mp3,.ogg,.wav,.m4a,.webm" multiple onChange=${(e) => onFiles(e.currentTarget.files)} />
    <${Button} variant="primary" disabled=${busy > 0} onClick=${() => input.current?.click()}>${busy > 0 ? `Envoi… (${busy})` : '⇪ Choisir des fichiers'}</${Button}>
    <span class="muted small grow">…ou glisser-déposer ici. mp3 / ogg / wav / m4a / webm, 80 Mo max. Les ambiances et musiques tournent en boucle.</span>
  </div>`;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------
export default function AudioPage({ game }) {
  const audio = game.audio;
  const st = useAudioState();
  const [tab, setTabState] = useState(() => lsGet('sr.audio.tab', 'ambient'));
  const [q, setQ] = useState('');
  const [sceneEdit, setSceneEdit] = useState(null);
  const [trackEdit, setTrackEdit] = useState(null);
  const [sfxVol, setSfxVol] = useSfxVolume();
  useEffect(() => () => stopPreview(), []);

  if (!audio) return html`<div class="page"><${Empty}>Module audio indisponible (serveur).</${Empty}></div>`;

  const setTab = (id) => {
    setTabState(id);
    lsSet('sr.audio.tab', id);
  };
  const scenes = audio.scenes || [];
  const uploads = (audio.tracks || []).filter((t) => t.source === 'url');
  const lists = {
    ambient: tracksOf(game, 'ambient'),
    music: tracksOf(game, 'music'),
    sfx: tracksOf(game, 'sfx'),
    files: uploads.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name, 'fr')),
  };
  const current = lists[tab] ? tab : 'ambient';
  const shown = lists[current].filter((t) => matches(t, q));
  const fromCurrent = () =>
    setSceneEdit({
      name: '',
      ambient: audio.ambient?.trackId || null,
      music: audio.music?.trackId || null,
      mapId: game.scene?.activeMapId || undefined,
    });

  return html`<div class="page audio-page">
    <div class="page-title">
      <h2>Ambiance & musique</h2>
      <div class="row wrap">
        <${Toggle} value=${!!audio.autoScenes} onChange=${(v) => send('audio/setOptions', { autoScenes: v }).catch(() => {})}
          label="Scène auto au changement de carte" title="Quand la carte active change, lancer la scène sonore liée à cette carte" />
        <${Button} variant="danger" title="Coupe ambiance, musique et bruitages en cours, chez tout le monde" onClick=${() => send('audio/stopAll').catch(() => {})}>⏹ Tout couper</${Button}>
      </div>
    </div>

    <${UnlockNotice} />

    <div class="audio-now">
      <${ChannelControl} game=${game} channel="ambient" label="Ambiance" />
      <${ChannelControl} game=${game} channel="music" label="Musique" />
      <div class="audio-now-side">
        <${VolumeSlider} value=${audio.master ?? 0.8} onChange=${(v) => sendVolume('master', v)} label="Général" title="Volume général, pour toute la table" />
        <${LocalVolume} label="Ce poste" />
      </div>
    </div>

    <div class="section-title">Scènes</div>
    <div class="audio-toolbar">
      <${Button} small variant="primary" onClick=${fromCurrent} title="Crée une scène avec l’ambiance et la musique en cours">+ Scène depuis l’ambiance actuelle</${Button}>
      <${Button} small onClick=${() => setSceneEdit({ name: '', ambient: 'keep', music: 'keep' })}>+ Scène vide</${Button}>
      <span class="muted small">Un clic sur une scène la lance pour tout le monde.</span>
    </div>
    ${scenes.length
      ? html`<div class="audio-scenes">${scenes.map((s) => html`<${SceneCard} key=${s.id} game=${game} scene=${s} onEdit=${setSceneEdit} />`)}</div>`
      : html`<${Empty}>Aucune scène. Lance une ambiance et une musique, puis « Scène depuis l’ambiance actuelle ».</${Empty}>`}

    <div class="section-title">Bibliothèque</div>
    <div class="audio-toolbar">
      <${Tabs}
        tabs=${[
          { id: 'ambient', label: 'Ambiances' },
          { id: 'music', label: 'Musiques' },
          { id: 'sfx', label: 'Bruitages' },
          { id: 'files', label: 'Mes fichiers', badge: uploads.length || null },
        ]}
        value=${current}
        onChange=${setTab}
      />
      <div class="grow"></div>
      <${SearchBox} value=${q} onChange=${setQ} placeholder="Filtrer…" />
    </div>

    ${current === 'sfx'
      ? html`<div class="col">
          <div class="row wrap" style="max-width: 460px">
            <${VolumeSlider} value=${sfxVol} onChange=${setSfxVol} label="Volume des bruitages" title="Volume auquel vos bruitages sont joués chez tout le monde" />
          </div>
          ${shown.length
            ? html`<div class="audio-sfx-grid">
                ${shown.map((t) => html`<${SfxButton} key=${t.id} track=${t} onFire=${(tr) => broadcastSfx(tr.id, sfxVol)} onPreview=${togglePreview} />`)}
              </div>`
            : html`<${Empty}>Aucun bruitage ne correspond.</${Empty}>`}
          <span class="muted small">Clic = joué chez tout le monde · 🎧 = écoute privée sur ce poste. Les autres modules (dés, portes, achats…) déclenchent aussi ces sons automatiquement.</span>
        </div>`
      : current === 'files'
      ? html`<div class="col gap-l">
          <${UploadPanel} />
          ${shown.length
            ? html`<div class="audio-lib">${shown.map((t) => html`<${TrackCard} key=${t.id} game=${game} track=${t} previewKey=${st.previewKey} onEdit=${setTrackEdit} />`)}</div>`
            : html`<${Empty}>${uploads.length ? 'Aucun fichier ne correspond.' : 'Aucun fichier importé. Toutes les ambiances, musiques et bruitages intégrés sont synthétisés en direct.'}</${Empty}>`}
        </div>`
      : shown.length
      ? html`<div class="audio-lib">${shown.map((t) => html`<${TrackCard} key=${t.id} game=${game} track=${t} previewKey=${st.previewKey} onEdit=${setTrackEdit} />`)}</div>`
      : html`<${Empty}>Aucune piste ne correspond.</${Empty}>`}

    ${sceneEdit && html`<${SceneModal} game=${game} scene=${sceneEdit} onClose=${() => setSceneEdit(null)} />`}
    ${trackEdit && html`<${TrackModal} track=${trackEdit} onClose=${() => setTrackEdit(null)} />`}
  </div>`;
}
