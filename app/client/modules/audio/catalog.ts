// Built-in sound catalog (procedurally synthesized). Pure data — imported by the browser AND by
// server/modules/60-audio.js, so it must not import anything.
import type { TrackKind } from '../../../shared/types.ts';

// Names, descriptions and tags are French source strings (stored as-is in state.audio.tracks); the client shows
// them translated (widgets.js trackName/presetDesc/tagLabel). tk() only marks them for tools/i18n-check.ts.
const tk = (s: string): string => s;

/** A built-in preset (ambient / music: desc + tags; sfx: `label` = display key when the name is ambiguous). */
export interface AudioPreset {
  id: string;
  name: string;
  icon: string;
  desc?: string;
  tags?: string[];
  label?: string;
}
interface LoopPreset extends AudioPreset {
  desc: string;
  tags: string[];
}
/** Default built-in track (subset of AudioTrack). */
export interface BuiltinTrack {
  id: string;
  name: string;
  kind: TrackKind;
  source: 'synth';
  preset: string;
  tags: string[];
}
/** What presetMeta / trackIcon read of a track. */
export interface TrackLike {
  kind?: TrackKind | string;
  source?: string;
  preset?: string | null;
}

/** Looping atmospheres. Track id = 'amb-' + id. */
export const AMBIENT_PRESETS: LoopPreset[] = [
  { id: 'rain', name: tk('Pluie urbaine'), icon: '🌧️', desc: tk('Averse sur le bitume, gouttières, chuintement de pneus.'), tags: [tk('extérieur'), tk('nuit')] },
  { id: 'city-night', name: tk('Ville la nuit'), icon: '🌃', desc: tk('Rumeur du trafic, vent, sirènes au loin.'), tags: [tk('extérieur'), tk('nuit')] },
  { id: 'bar', name: tk('Bar bondé'), icon: '🍺', desc: tk('Brouhaha de la foule, verres, juke-box étouffé.'), tags: [tk('intérieur'), tk('social')] },
  { id: 'club', name: tk('Boîte de nuit'), icon: '🎛️', desc: tk('Synthwave 120 bpm à travers les murs, la porte s’ouvre parfois.'), tags: [tk('intérieur'), tk('social')] },
  { id: 'corp-lobby', name: tk('Hall corpo'), icon: '🏢', desc: tk('Nappe feutrée, carillons discrets, ascenseurs.'), tags: [tk('intérieur'), tk('corpo')] },
  { id: 'lab', name: tk('Laboratoire'), icon: '🧪', desc: tk('Néons 60 Hz, bips d’appareils, centrifugeuse.'), tags: [tk('intérieur'), tk('corpo')] },
  { id: 'hospital', name: tk('Hôpital'), icon: '🏥', desc: tk('Moniteur cardiaque, respirateur, ventilation.'), tags: [tk('intérieur')] },
  { id: 'server-room', name: tk('Salle serveurs'), icon: '🖥️', desc: tk('Ventilateurs, disques qui grattent, voyants.'), tags: [tk('intérieur'), tk('matrice')] },
  { id: 'matrix', name: tk('Matrice'), icon: '🌐', desc: tk('Drone numérique, arpèges glitchés, flux de données.'), tags: [tk('matrice')] },
  { id: 'industrial', name: tk('Zone industrielle'), icon: '🏭', desc: tk('Machines, chocs métalliques, jets de vapeur.'), tags: [tk('extérieur'), tk('industriel')] },
  { id: 'underground', name: tk('Égouts / souterrain'), icon: '🕳️', desc: tk('Gouttes qui résonnent, grondement sourd, canalisations.'), tags: [tk('souterrain')] },
  { id: 'storm', name: tk('Orage'), icon: '⛈️', desc: tk('Pluie battante, rafales et roulements de tonnerre.'), tags: [tk('extérieur'), tk('nuit')] },
  { id: 'alley', name: tk('Ruelle'), icon: '🌫️', desc: tk('Gouttes, néon qui grésille, chiens et trafic au loin.'), tags: [tk('extérieur'), tk('nuit')] },
];

/** Looping music. Track id = 'mus-' + id. */
export const MUSIC_PRESETS: LoopPreset[] = [
  { id: 'tension', name: tk('Tension'), icon: '⚠️', desc: tk('Drone menaçant, pulsations graves.'), tags: [tk('infiltration')] },
  { id: 'combat', name: tk('Combat'), icon: '⚔️', desc: tk('Percussions synthétiques 140 bpm, basse obstinée.'), tags: [tk('action')] },
  { id: 'chase', name: tk('Course-poursuite'), icon: '🏍️', desc: tk('Arpèges rapides, rythmique pressante.'), tags: [tk('action')] },
  { id: 'investigation', name: tk('Enquête (noir)'), icon: '🕵️', desc: tk('Accords mineurs de piano électrique, batterie aux balais.'), tags: [tk('calme')] },
  { id: 'sad', name: tk('Mélancolie'), icon: '🥀', desc: tk('Nappes lentes et piano clairsemé.'), tags: [tk('calme'), tk('émotion')] },
  { id: 'corp-gala', name: tk('Gala corpo'), icon: '🥂', desc: tk('Jazz feutré et élégant.'), tags: [tk('social'), tk('corpo')] },
  { id: 'victory', name: tk('Victoire'), icon: '🏆', desc: tk('Boucle triomphante.'), tags: [tk('émotion')] },
  { id: 'menu', name: tk('Synthwave calme'), icon: '🌆', desc: tk('Synthwave posée, pour l’accueil ou les temps morts.'), tags: [tk('calme')] },
];

/** One-shot effects. Track id = sfx id (standard ids, see ARCHITECTURE.md). */
export const SFX_PRESETS: AudioPreset[] = [
  { id: 'dice', name: tk('Dés'), icon: '🎲' },
  { id: 'door-open', name: tk('Porte s’ouvre'), icon: '🚪' },
  { id: 'door-close', name: tk('Porte se ferme'), icon: '🚪' },
  { id: 'door-locked', name: tk('Verrouillée'), icon: '🔒' },
  { id: 'gunshot-pistol', name: tk('Pistolet'), icon: '🔫' },
  { id: 'gunshot-rifle', name: tk('Fusil'), icon: '🎯' },
  { id: 'gunshot-auto', name: tk('Rafale'), icon: '💥' },
  { id: 'explosion', name: tk('Explosion'), icon: '💣' },
  { id: 'hit-melee', name: tk('Coup'), icon: '👊' },
  { id: 'glass-break', name: tk('Verre brisé'), icon: '🥃' },
  { id: 'alarm', name: tk('Alarme'), icon: '🚨' },
  { id: 'footsteps', name: tk('Bruits de pas'), icon: '👣' },
  { id: 'notify', name: tk('Notification'), icon: '🔔' },
  { id: 'matrix-glitch', name: tk('Glitch Matrice'), icon: '👾' },
  { id: 'spell-cast', name: tk('Sort'), icon: '✨' },
  { id: 'heal', name: tk('Soin'), icon: '💚' },
  { id: 'death', name: tk('Mort'), label: tk('bruitage::Mort'), icon: '💀' },
  { id: 'cash', name: tk('Nuyens'), icon: '💴' },
  { id: 'level-up', name: tk('Progression'), icon: '⭐' },
  { id: 'ping', name: tk('Ping'), icon: '📍' },
];

export const SFX_IDS = SFX_PRESETS.map((s) => s.id);
export const TRACK_KINDS: TrackKind[] = ['ambient', 'music', 'sfx'];
export const KIND_LABELS: Record<TrackKind, string> = { ambient: tk('Ambiance'), music: tk('Musique'), sfx: tk('Bruitage') }; // render with t()

/** Default state.audio tracks for every built-in preset (source 'synth'). */
export function builtinTracks(): BuiltinTrack[] {
  return [
    ...AMBIENT_PRESETS.map((p): BuiltinTrack => ({ id: 'amb-' + p.id, name: p.name, kind: 'ambient', source: 'synth', preset: p.id, tags: [...p.tags] })),
    ...MUSIC_PRESETS.map((p): BuiltinTrack => ({ id: 'mus-' + p.id, name: p.name, kind: 'music', source: 'synth', preset: p.id, tags: [...p.tags] })),
    ...SFX_PRESETS.map((p): BuiltinTrack => ({ id: p.id, name: p.name, kind: 'sfx', source: 'synth', preset: p.id, tags: [] })),
  ];
}

const META: Record<string, AudioPreset> = {};
for (const p of AMBIENT_PRESETS) META['ambient:' + p.id] = p;
for (const p of MUSIC_PRESETS) META['music:' + p.id] = p;
for (const p of SFX_PRESETS) META['sfx:' + p.id] = p;

/** Catalog entry (icon, name, desc, label?) for a track, or null for uploaded files. */
export function presetMeta(track: TrackLike | null | undefined): AudioPreset | null {
  if (!track || track.source !== 'synth') return null;
  return META[track.kind + ':' + track.preset] || null;
}

/** Icon to display for any track. */
export function trackIcon(track: TrackLike | null | undefined): string {
  const m = presetMeta(track);
  if (m) return m.icon;
  return track?.kind === 'music' ? '🎵' : track?.kind === 'sfx' ? '🔊' : '🎧';
}
