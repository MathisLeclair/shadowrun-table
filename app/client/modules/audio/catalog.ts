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
  { id: 'rain', name: tk('City rain'), icon: '🌧️', desc: tk('Downpour on asphalt, gutters, hissing tires.'), tags: [tk('outdoors'), tk('night')] },
  { id: 'city-night', name: tk('City at night'), icon: '🌃', desc: tk('Traffic hum, wind, distant sirens.'), tags: [tk('outdoors'), tk('night')] },
  { id: 'bar', name: tk('Crowded bar'), icon: '🍺', desc: tk('Crowd chatter, glasses, muffled jukebox.'), tags: [tk('indoors'), tk('social')] },
  { id: 'club', name: tk('Nightclub'), icon: '🎛️', desc: tk('120 bpm synthwave through the walls, the door opens now and then.'), tags: [tk('indoors'), tk('social')] },
  { id: 'corp-lobby', name: tk('Corp lobby'), icon: '🏢', desc: tk('Hushed pad, discreet chimes, elevators.'), tags: [tk('indoors'), tk('corp')] },
  { id: 'lab', name: tk('Laboratory'), icon: '🧪', desc: tk('60 Hz neon hum, beeping equipment, centrifuge.'), tags: [tk('indoors'), tk('corp')] },
  { id: 'hospital', name: tk('Hospital'), icon: '🏥', desc: tk('Heart monitor, ventilator, air vents.'), tags: [tk('indoors')] },
  { id: 'server-room', name: tk('Server room'), icon: '🖥️', desc: tk('Fans, grinding drives, blinking lights.'), tags: [tk('indoors'), tk('matrix')] },
  { id: 'matrix', name: tk('Matrix'), icon: '🌐', desc: tk('Digital drone, glitchy arpeggios, data streams.'), tags: [tk('matrix')] },
  { id: 'industrial', name: tk('Industrial zone'), icon: '🏭', desc: tk('Machinery, metal clangs, steam jets.'), tags: [tk('outdoors'), tk('industrial')] },
  { id: 'underground', name: tk('Sewers / underground'), icon: '🕳️', desc: tk('Echoing drips, low rumble, pipes.'), tags: [tk('underground')] },
  { id: 'storm', name: tk('Thunderstorm'), icon: '⛈️', desc: tk('Pouring rain, gusts and rolling thunder.'), tags: [tk('outdoors'), tk('night')] },
  { id: 'alley', name: tk('Alley'), icon: '🌫️', desc: tk('Drips, buzzing neon, dogs and distant traffic.'), tags: [tk('outdoors'), tk('night')] },
];

/** Looping music. Track id = 'mus-' + id. */
export const MUSIC_PRESETS: LoopPreset[] = [
  { id: 'tension', name: tk('Tension'), icon: '⚠️', desc: tk('Menacing drone, deep pulses.'), tags: [tk('infiltration')] },
  { id: 'combat', name: tk('Combat'), icon: '⚔️', desc: tk('140 bpm synth percussion, relentless bass.'), tags: [tk('action')] },
  { id: 'chase', name: tk('Chase'), icon: '🏍️', desc: tk('Fast arpeggios, driving rhythm.'), tags: [tk('action')] },
  { id: 'investigation', name: tk('Investigation (noir)'), icon: '🕵️', desc: tk('Minor electric piano chords, brushed drums.'), tags: [tk('calm')] },
  { id: 'sad', name: tk('Melancholy'), icon: '🥀', desc: tk('Slow pads and sparse piano.'), tags: [tk('calm'), tk('emotion')] },
  { id: 'corp-gala', name: tk('Corp gala'), icon: '🥂', desc: tk('Smooth, elegant jazz.'), tags: [tk('social'), tk('corp')] },
  { id: 'victory', name: tk('Victory'), icon: '🏆', desc: tk('Triumphant loop.'), tags: [tk('emotion')] },
  { id: 'menu', name: tk('Chill synthwave'), icon: '🌆', desc: tk('Laid-back synthwave, for the lobby or downtime.'), tags: [tk('calm')] },
];

/** One-shot effects. Track id = sfx id (standard ids, see ARCHITECTURE.md). */
export const SFX_PRESETS: AudioPreset[] = [
  { id: 'dice', name: tk('Dice'), icon: '🎲' },
  { id: 'door-open', name: tk('Door opens'), icon: '🚪' },
  { id: 'door-close', name: tk('Door closes'), icon: '🚪' },
  { id: 'door-locked', name: tk('Locked'), icon: '🔒' },
  { id: 'gunshot-pistol', name: tk('Pistol'), icon: '🔫' },
  { id: 'gunshot-rifle', name: tk('Rifle'), icon: '🎯' },
  { id: 'gunshot-auto', name: tk('Burst'), icon: '💥' },
  { id: 'explosion', name: tk('Explosion'), icon: '💣' },
  { id: 'hit-melee', name: tk('Hit'), icon: '👊' },
  { id: 'glass-break', name: tk('Breaking glass'), icon: '🥃' },
  { id: 'alarm', name: tk('Alarm'), icon: '🚨' },
  { id: 'footsteps', name: tk('Footsteps'), icon: '👣' },
  { id: 'notify', name: tk('Notification'), icon: '🔔' },
  { id: 'matrix-glitch', name: tk('Matrix glitch'), icon: '👾' },
  { id: 'spell-cast', name: tk('Spell'), icon: '✨' },
  { id: 'heal', name: tk('Healing'), icon: '💚' },
  { id: 'death', name: tk('Dead'), label: tk('sfx::Death'), icon: '💀' },
  { id: 'cash', name: tk('Nuyen'), icon: '💴' },
  { id: 'level-up', name: tk('Advancement'), icon: '⭐' },
  { id: 'ping', name: tk('Ping'), icon: '📍' },
];

export const SFX_IDS = SFX_PRESETS.map((s) => s.id);
export const TRACK_KINDS: TrackKind[] = ['ambient', 'music', 'sfx'];
export const KIND_LABELS: Record<TrackKind, string> = { ambient: tk('Ambience'), music: tk('Music'), sfx: tk('Sound effect') }; // render with t()

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
