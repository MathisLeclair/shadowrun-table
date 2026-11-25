// Built-in sound catalog (procedurally synthesized). Pure data — imported by the browser AND by
// server/modules/60-audio.js, so it must not import anything.

/** Looping atmospheres. Track id = 'amb-' + id. */
export const AMBIENT_PRESETS = [
  { id: 'rain', name: 'Pluie urbaine', icon: '🌧️', desc: 'Averse sur le bitume, gouttières, chuintement de pneus.', tags: ['extérieur', 'nuit'] },
  { id: 'city-night', name: 'Ville la nuit', icon: '🌃', desc: 'Rumeur du trafic, vent, sirènes au loin.', tags: ['extérieur', 'nuit'] },
  { id: 'bar', name: 'Bar bondé', icon: '🍺', desc: 'Brouhaha de la foule, verres, juke-box étouffé.', tags: ['intérieur', 'social'] },
  { id: 'club', name: 'Boîte de nuit', icon: '🎛️', desc: 'Synthwave 120 bpm à travers les murs, la porte s’ouvre parfois.', tags: ['intérieur', 'social'] },
  { id: 'corp-lobby', name: 'Hall corpo', icon: '🏢', desc: 'Nappe feutrée, carillons discrets, ascenseurs.', tags: ['intérieur', 'corpo'] },
  { id: 'lab', name: 'Laboratoire', icon: '🧪', desc: 'Néons 60 Hz, bips d’appareils, centrifugeuse.', tags: ['intérieur', 'corpo'] },
  { id: 'hospital', name: 'Hôpital', icon: '🏥', desc: 'Moniteur cardiaque, respirateur, ventilation.', tags: ['intérieur'] },
  { id: 'server-room', name: 'Salle serveurs', icon: '🖥️', desc: 'Ventilateurs, disques qui grattent, voyants.', tags: ['intérieur', 'matrice'] },
  { id: 'matrix', name: 'Matrice', icon: '🌐', desc: 'Drone numérique, arpèges glitchés, flux de données.', tags: ['matrice'] },
  { id: 'industrial', name: 'Zone industrielle', icon: '🏭', desc: 'Machines, chocs métalliques, jets de vapeur.', tags: ['extérieur', 'industriel'] },
  { id: 'underground', name: 'Égouts / souterrain', icon: '🕳️', desc: 'Gouttes qui résonnent, grondement sourd, canalisations.', tags: ['souterrain'] },
  { id: 'storm', name: 'Orage', icon: '⛈️', desc: 'Pluie battante, rafales et roulements de tonnerre.', tags: ['extérieur', 'nuit'] },
  { id: 'alley', name: 'Ruelle', icon: '🌫️', desc: 'Gouttes, néon qui grésille, chiens et trafic au loin.', tags: ['extérieur', 'nuit'] },
];

/** Looping music. Track id = 'mus-' + id. */
export const MUSIC_PRESETS = [
  { id: 'tension', name: 'Tension', icon: '⚠️', desc: 'Drone menaçant, pulsations graves.', tags: ['infiltration'] },
  { id: 'combat', name: 'Combat', icon: '⚔️', desc: 'Percussions synthétiques 140 bpm, basse obstinée.', tags: ['action'] },
  { id: 'chase', name: 'Course-poursuite', icon: '🏍️', desc: 'Arpèges rapides, rythmique pressante.', tags: ['action'] },
  { id: 'investigation', name: 'Enquête (noir)', icon: '🕵️', desc: 'Accords mineurs de piano électrique, batterie aux balais.', tags: ['calme'] },
  { id: 'sad', name: 'Mélancolie', icon: '🥀', desc: 'Nappes lentes et piano clairsemé.', tags: ['calme', 'émotion'] },
  { id: 'corp-gala', name: 'Gala corpo', icon: '🥂', desc: 'Jazz feutré et élégant.', tags: ['social', 'corpo'] },
  { id: 'victory', name: 'Victoire', icon: '🏆', desc: 'Boucle triomphante.', tags: ['émotion'] },
  { id: 'menu', name: 'Synthwave calme', icon: '🌆', desc: 'Synthwave posée, pour l’accueil ou les temps morts.', tags: ['calme'] },
];

/** One-shot effects. Track id = sfx id (standard ids, see ARCHITECTURE.md). */
export const SFX_PRESETS = [
  { id: 'dice', name: 'Dés', icon: '🎲' },
  { id: 'door-open', name: 'Porte s’ouvre', icon: '🚪' },
  { id: 'door-close', name: 'Porte se ferme', icon: '🚪' },
  { id: 'door-locked', name: 'Verrouillée', icon: '🔒' },
  { id: 'gunshot-pistol', name: 'Pistolet', icon: '🔫' },
  { id: 'gunshot-rifle', name: 'Fusil', icon: '🎯' },
  { id: 'gunshot-auto', name: 'Rafale', icon: '💥' },
  { id: 'explosion', name: 'Explosion', icon: '💣' },
  { id: 'hit-melee', name: 'Coup', icon: '👊' },
  { id: 'glass-break', name: 'Verre brisé', icon: '🥃' },
  { id: 'alarm', name: 'Alarme', icon: '🚨' },
  { id: 'footsteps', name: 'Bruits de pas', icon: '👣' },
  { id: 'notify', name: 'Notification', icon: '🔔' },
  { id: 'matrix-glitch', name: 'Glitch Matrice', icon: '👾' },
  { id: 'spell-cast', name: 'Sort', icon: '✨' },
  { id: 'heal', name: 'Soin', icon: '💚' },
  { id: 'death', name: 'Mort', icon: '💀' },
  { id: 'cash', name: 'Nuyens', icon: '💴' },
  { id: 'level-up', name: 'Progression', icon: '⭐' },
  { id: 'ping', name: 'Ping', icon: '📍' },
];

export const SFX_IDS = SFX_PRESETS.map((s) => s.id);
export const TRACK_KINDS = ['ambient', 'music', 'sfx'];
export const KIND_LABELS = { ambient: 'Ambiance', music: 'Musique', sfx: 'Bruitage' };

/** Default state.audio tracks for every built-in preset (source 'synth'). */
export function builtinTracks() {
  return [
    ...AMBIENT_PRESETS.map((p) => ({ id: 'amb-' + p.id, name: p.name, kind: 'ambient', source: 'synth', preset: p.id, tags: [...p.tags] })),
    ...MUSIC_PRESETS.map((p) => ({ id: 'mus-' + p.id, name: p.name, kind: 'music', source: 'synth', preset: p.id, tags: [...p.tags] })),
    ...SFX_PRESETS.map((p) => ({ id: p.id, name: p.name, kind: 'sfx', source: 'synth', preset: p.id, tags: [] })),
  ];
}

const META = {};
for (const p of AMBIENT_PRESETS) META['ambient:' + p.id] = p;
for (const p of MUSIC_PRESETS) META['music:' + p.id] = p;
for (const p of SFX_PRESETS) META['sfx:' + p.id] = p;

/** Catalog entry (icon, desc) for a track, or null for uploaded files. */
export function presetMeta(track) {
  if (!track || track.source !== 'synth') return null;
  return META[track.kind + ':' + track.preset] || null;
}

/** Icon to display for any track. */
export function trackIcon(track) {
  const m = presetMeta(track);
  if (m) return m.icon;
  return track?.kind === 'music' ? '🎵' : track?.kind === 'sfx' ? '🔊' : '🎧';
}
