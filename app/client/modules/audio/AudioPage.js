// GM ambience / music manager: now playing, scenes, libraries (built-in + uploads), effects, uploads.
import { useEffect, useRef, useState } from 'preact/hooks';
import { html, Button, IconButton, Modal, Tabs, Field, Select, Toggle, Badge, Empty, SearchBox, loadCss, confirmAction } from '../../lib/ui.js';
import { send, upload } from '../../lib/net.js';
import { toast } from '../../lib/ui-store.js';
import { t, tk, compare } from '../../lib/i18n.js';
import { presetMeta, trackIcon, KIND_LABELS } from './catalog.js';
import { togglePreview, stopPreview, useAudioState } from './audio-core.js';
import {
  ChannelControl, UnlockNotice, LocalVolume, VolumeSlider, tracksOf, findTrack, sceneIsActive, sceneValueLabel,
  setChannelTrack, broadcastSfx, useSfxVolume, sendVolume, lsGet, lsSet, trackName, presetDesc, tagLabel,
} from './widgets.js';
import { SfxButton } from './SoundDock.js';

loadCss('/modules/audio/audio.css');

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
const kindOptions = () => Object.entries(KIND_LABELS).map(([value, label]) => ({ value, label: t(label) }));

const channelOf = (track) => (track.kind === 'music' ? 'music' : 'ambient');

function matches(track, q) {
  if (!q) return true;
  const tags = track.tags || [];
  const hay = [track.name, trackName(track), presetMeta(track)?.desc, presetDesc(track), ...tags, ...tags.map(tagLabel)].join(' ').toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => hay.includes(w));
}

function mapOptions(game, current) {
  const maps = Object.values(game.maps || {}).sort((a, b) => compare(`${a.folder || ''} ${a.name}`, `${b.folder || ''} ${b.name}`));
  const opts = [{ value: '', label: t('— Aucune —') }, ...maps.map((m) => ({ value: m.id, label: (m.folder ? m.folder + ' · ' : '') + (m.name || m.id) }))];
  if (current && !maps.some((m) => m.id === current)) opts.push({ value: current, label: t('(carte introuvable)') });
  return opts;
}

// ---------------------------------------------------------------------------
// Scenes
// ---------------------------------------------------------------------------
function sceneChannelOptions(game, kind, current) {
  const list = tracksOf(game, kind);
  const cur = findTrack(game, current);
  if (cur && !list.includes(cur)) list.unshift(cur);
  const opts = [{ value: 'keep', label: t('(ne pas changer)') }, { value: '', label: t('— Silence —') }, ...list.map((tr) => ({ value: tr.id, label: `${trackIcon(tr)} ${trackName(tr)}` }))];
  if (current && current !== 'keep' && !cur) opts.push({ value: current, label: t('(piste supprimée)') });
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

  return html`<${Modal} title=${isNew ? t('Nouvelle scène sonore') : t('Modifier la scène')} width=${560} onClose=${onClose}>
    <form class="col gap-l" onSubmit=${save}>
      <${Field} label=${t('Nom')}>
        <input class="input" value=${name} maxlength="80" placeholder=${t('ex. Bar de Porfla')} autofocus onInput=${(e) => setName(e.currentTarget.value)} />
      </${Field}>
      <div class="grid-2">
        <${Field} label=${t('Ambiance')}>
          <${Select} value=${ambient} options=${sceneChannelOptions(game, 'ambient', scene.ambient)} onChange=${setAmbient} />
        </${Field}>
        <${Field} label=${t('Musique')}>
          <${Select} value=${music} options=${sceneChannelOptions(game, 'music', scene.music)} onChange=${setMusic} />
        </${Field}>
      </div>
      <${Field} label=${t('Carte liée')} hint=${linked ? t('Déjà liée à « {name} » : c’est la première trouvée qui sera lancée.', { name: linked.name }) : t('Quand cette carte devient la carte active, la scène se lance (si l’option « scène auto » est activée).')}>
        <${Select} value=${mapId} options=${mapOptions(game, scene.mapId)} onChange=${setMapId} />
      </${Field}>
      <div class="col">
        <${Toggle} value=${withVol} onChange=${setWithVol} label=${t('Imposer aussi les volumes')} />
        ${withVol &&
        html`<div class="grid-2">
          <${VolumeSlider} value=${av} onChange=${setAv} label=${t('Ambiance')} />
          <${VolumeSlider} value=${mv} onChange=${setMv} label=${t('Musique')} />
        </div>`}
      </div>
      <div class="row spread">
        <span class="muted small">${t('« Ne pas changer » laisse la piste en cours (ex. scène « Combat ! »).')}</span>
        <div class="row">
          <${Button} type="button" variant="ghost" onClick=${onClose}>${t('Annuler')}</${Button}>
          <${Button} type="submit" variant="primary" disabled=${busy}>${t('Enregistrer')}</${Button}>
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
      () => toast(t('Scène « {name} »', { name: scene.name }), 'success', 2000),
      () => {}
    );
  const remove = async (e) => {
    e.stopPropagation();
    if (await confirmAction(t('Supprimer la scène « {name} » ?', { name: scene.name }))) send('audio/deleteScene', { sceneId: scene.id }).catch(() => {});
  };
  return html`<div class=${'audio-scene' + (active ? ' active' : '')} role="button" tabindex="0" title=${t('Appliquer cette scène pour tout le monde')}
    onClick=${apply} onKeyDown=${(e) => e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), apply())}>
    <div class="audio-scene-name" title=${scene.name}>${scene.name}</div>
    <div class="audio-scene-line">${t('Ambiance : {value}', { value: sceneValueLabel(game, scene.ambient) })}</div>
    <div class="audio-scene-line">${t('Musique : {value}', { value: sceneValueLabel(game, scene.music) })}</div>
    ${scene.mapId && html`<div class="audio-scene-line" title=${t('Carte liée')}>⌖ ${map?.name || t('carte introuvable')}</div>`}
    <div class="audio-scene-tools">
      <${IconButton} icon="✎" title=${t('Modifier')} onClick=${(e) => {
        e.stopPropagation();
        onEdit(scene);
      }} />
      <${IconButton} icon="🗑" title=${t('Supprimer')} onClick=${remove} />
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
        tags: tags.split(',').map((x) => x.trim()).filter(Boolean),
        volume: Number(level),
      });
      onClose();
    } catch {}
  };
  const known = LEVELS.map((l) => ({ ...l, label: t(l.label) }));
  const levels = LEVELS.some((l) => l.value === level) ? known : [...known, { value: level, label: `${Math.round(Number(level) * 100)} %` }];
  return html`<${Modal} title=${t('Modifier la piste')} width=${480} onClose=${onClose}>
    <form class="col gap-l" onSubmit=${save}>
      <${Field} label=${t('Nom')}><input class="input" value=${name} maxlength="80" autofocus onInput=${(e) => setName(e.currentTarget.value)} /></${Field}>
      <div class="grid-2">
        <${Field} label=${t('Type')}>
          <${Select} value=${kind} disabled=${track.source !== 'url'} options=${kindOptions()} onChange=${setKind} />
        </${Field}>
        <${Field} label=${t('Niveau')} hint=${t('Corrige un fichier trop fort ou trop faible.')}>
          <${Select} value=${level} options=${levels} onChange=${setLevel} />
        </${Field}>
      </div>
      <${Field} label=${t('Étiquettes')} hint=${t('Séparées par des virgules.')}>
        <input class="input" value=${tags} onInput=${(e) => setTags(e.currentTarget.value)} placeholder=${t('ex. combat, acte 2')} />
      </${Field}>
      <div class="row" style="justify-content:flex-end">
        <${Button} type="button" variant="ghost" onClick=${onClose}>${t('Annuler')}</${Button}>
        <${Button} type="submit" variant="primary">${t('Enregistrer')}</${Button}>
      </div>
    </form>
  </${Modal}>`;
}

function TrackCard({ game, track, previewKey, onEdit }) {
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
  return html`<div class=${'audio-track' + (playing ? ' playing' : '') + (previewing ? ' previewing' : '')}>
    <div class="audio-track-icon">${trackIcon(track)}</div>
    <div class="audio-track-body">
      <div class="audio-track-name" title=${name}>${name}</div>
      ${(desc || track.source === 'url') && html`<div class="audio-track-desc">${desc || t('Fichier importé')}</div>`}
      ${(track.source === 'url' || track.tags?.length > 0) &&
      html`<div class="row wrap gap-s">
        ${track.source === 'url' && html`<${Badge} color="amber">${KIND_LABELS[track.kind] ? t(KIND_LABELS[track.kind]) : track.kind}</${Badge}>`}
        ${(track.tags || []).map((tag) => html`<${Badge}>${tagLabel(tag)}</${Badge}>`)}
      </div>`}
      <div class="audio-track-actions">
        <${Button} small variant=${playing ? 'accent' : 'primary'} onClick=${play} title=${isSfx ? t('Jouer pour tout le monde') : playing ? t('Arrêter pour tout le monde') : t('Diffuser à toute la table')}>
          ${isSfx ? '▶ ' + t('Jouer') : playing ? '■ ' + t('Arrêter') : '▶ ' + t('Diffuser')}
        </${Button}>
        <${Button} small variant=${previewing ? 'default' : 'ghost'} onClick=${() => togglePreview(track)} title=${t('Écouter en privé : seulement sur ce poste, les joueurs n’entendent rien')}>
          ${previewing ? '■ ' + t('Fin de l’écoute') : '🎧 ' + t('Écouter en privé')}
        </${Button}>
        ${track.source === 'url' &&
        html`<${IconButton} icon="✎" title=${t('Modifier')} onClick=${() => onEdit(track)} />
          <${IconButton} icon="🗑" title=${t('Retirer de la bibliothèque')} onClick=${remove} />`}
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
          toast(t('Échec de l’envoi de « {name} » : {error}', { name: f.name, error: err.message }), 'error');
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
    <${Field} label=${t('Importer comme')}>
      <${Select} value=${kind} options=${kindOptions()} onChange=${setKind} />
    </${Field}>
    <input ref=${input} class="audio-file" type="file" accept="audio/*,.mp3,.ogg,.wav,.m4a,.webm" multiple onChange=${(e) => onFiles(e.currentTarget.files)} />
    <${Button} variant="primary" disabled=${busy > 0} onClick=${() => input.current?.click()}>${busy > 0 ? t('Envoi… ({n})', { n: busy }) : '⇪ ' + t('Choisir des fichiers')}</${Button}>
    <span class="muted small grow">${t('…ou glisser-déposer ici. mp3 / ogg / wav / m4a / webm, 80 Mo max. Les ambiances et musiques tournent en boucle.')}</span>
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

  if (!audio) return html`<div class="page"><${Empty}>${t('Module audio indisponible (serveur).')}</${Empty}></div>`;

  const setTab = (id) => {
    setTabState(id);
    lsSet('sr.audio.tab', id);
  };
  const scenes = audio.scenes || [];
  const uploads = (audio.tracks || []).filter((tr) => tr.source === 'url');
  const lists = {
    ambient: tracksOf(game, 'ambient'),
    music: tracksOf(game, 'music'),
    sfx: tracksOf(game, 'sfx'),
    files: uploads.sort((a, b) => a.kind.localeCompare(b.kind) || compare(a.name, b.name)),
  };
  const current = lists[tab] ? tab : 'ambient';
  const shown = lists[current].filter((tr) => matches(tr, q));
  const fromCurrent = () =>
    setSceneEdit({
      name: '',
      ambient: audio.ambient?.trackId || null,
      music: audio.music?.trackId || null,
      mapId: game.scene?.activeMapId || undefined,
    });

  return html`<div class="page audio-page">
    <div class="page-title">
      <h2>${t('Ambiance & musique')}</h2>
      <div class="row wrap">
        <${Toggle} value=${!!audio.autoScenes} onChange=${(v) => send('audio/setOptions', { autoScenes: v }).catch(() => {})}
          label=${t('Scène auto au changement de carte')} title=${t('Quand la carte active change, lancer la scène sonore liée à cette carte')} />
        <${Button} variant="danger" title=${t('Coupe ambiance, musique et bruitages en cours, chez tout le monde')} onClick=${() => send('audio/stopAll').catch(() => {})}>⏹ ${t('Tout couper')}</${Button}>
      </div>
    </div>

    <${UnlockNotice} />

    <div class="audio-now">
      <${ChannelControl} game=${game} channel="ambient" label=${t('Ambiance')} />
      <${ChannelControl} game=${game} channel="music" label=${t('Musique')} />
      <div class="audio-now-side">
        <${VolumeSlider} value=${audio.master ?? 0.8} onChange=${(v) => sendVolume('master', v)} label=${t('volume::Général')} title=${t('Volume général, pour toute la table')} />
        <${LocalVolume} label=${t('Ce poste')} />
      </div>
    </div>

    <div class="section-title">${t('Scènes')}</div>
    <div class="audio-toolbar">
      <${Button} small variant="primary" onClick=${fromCurrent} title=${t('Crée une scène avec l’ambiance et la musique en cours')}>+ ${t('Scène depuis l’ambiance actuelle')}</${Button}>
      <${Button} small onClick=${() => setSceneEdit({ name: '', ambient: 'keep', music: 'keep' })}>+ ${t('Scène vide')}</${Button}>
      <span class="muted small">${t('Un clic sur une scène la lance pour tout le monde.')}</span>
    </div>
    ${scenes.length
      ? html`<div class="audio-scenes">${scenes.map((s) => html`<${SceneCard} key=${s.id} game=${game} scene=${s} onEdit=${setSceneEdit} />`)}</div>`
      : html`<${Empty}>${t('Aucune scène. Lance une ambiance et une musique, puis « Scène depuis l’ambiance actuelle ».')}</${Empty}>`}

    <div class="section-title">${t('Bibliothèque')}</div>
    <div class="audio-toolbar">
      <${Tabs}
        tabs=${[
          { id: 'ambient', label: t('Ambiances') },
          { id: 'music', label: t('Musiques') },
          { id: 'sfx', label: t('Bruitages') },
          { id: 'files', label: t('Mes fichiers'), badge: uploads.length || null },
        ]}
        value=${current}
        onChange=${setTab}
      />
      <div class="grow"></div>
      <${SearchBox} value=${q} onChange=${setQ} placeholder=${t('Filtrer…')} />
    </div>

    ${current === 'sfx'
      ? html`<div class="col">
          <div class="row wrap" style="max-width: 460px">
            <${VolumeSlider} value=${sfxVol} onChange=${setSfxVol} label=${t('Volume des bruitages')} title=${t('Volume auquel vos bruitages sont joués chez tout le monde')} />
          </div>
          ${shown.length
            ? html`<div class="audio-sfx-grid">
                ${shown.map((tr) => html`<${SfxButton} key=${tr.id} track=${tr} onFire=${(x) => broadcastSfx(x.id, sfxVol)} onPreview=${togglePreview} />`)}
              </div>`
            : html`<${Empty}>${t('Aucun bruitage ne correspond.')}</${Empty}>`}
          <span class="muted small">${t('Clic = joué chez tout le monde · 🎧 = écoute privée sur ce poste. Les autres modules (dés, portes, achats…) déclenchent aussi ces sons automatiquement.')}</span>
        </div>`
      : current === 'files'
      ? html`<div class="col gap-l">
          <${UploadPanel} />
          ${shown.length
            ? html`<div class="audio-lib">${shown.map((tr) => html`<${TrackCard} key=${tr.id} game=${game} track=${tr} previewKey=${st.previewKey} onEdit=${setTrackEdit} />`)}</div>`
            : html`<${Empty}>${uploads.length ? t('Aucun fichier ne correspond.') : t('Aucun fichier importé. Toutes les ambiances, musiques et bruitages intégrés sont synthétisés en direct.')}</${Empty}>`}
        </div>`
      : shown.length
      ? html`<div class="audio-lib">${shown.map((tr) => html`<${TrackCard} key=${tr.id} game=${game} track=${tr} previewKey=${st.previewKey} onEdit=${setTrackEdit} />`)}</div>`
      : html`<${Empty}>${t('Aucune piste ne correspond.')}</${Empty}>`}

    ${sceneEdit && html`<${SceneModal} game=${game} scene=${sceneEdit} onClose=${() => setSceneEdit(null)} />`}
    ${trackEdit && html`<${TrackModal} track=${trackEdit} onClose=${() => setTrackEdit(null)} />`}
  </div>`;
}
