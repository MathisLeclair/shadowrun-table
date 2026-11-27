# Audio (ambience, music, sound effects)

| | |
|---|---|
| server | `server/modules/60-audio.ts` (owner of `state.audio`) |
| client | `client/modules/audio/` (AudioPage, SoundDock, AudioEngine (global), `catalog.ts`, `sfx.ts` procedural effects) |
| tests | `node tools/test-audio.ts` (port 3912) |

## State

Types `AudioState`, `AudioTrack`, `AudioChannel`, `AudioScene`.
```js
audio: {
  master: 0.8,
  ambient: { trackId: string|null, volume: 0.5 },   // looping atmosphere, synced to everyone
  music: { trackId: string|null, volume: 0.4 },
  tracks: [{ id, name, kind: 'ambient'|'music'|'sfx', source: 'synth'|'url', preset?: 'rain'|..., url?, tags?, credit? }],
  scenes?: [{ id, name, ambient, music, mapId? }],   // one-click presets
}
```
Music library: `data/assets/music/` (not in git, served at `/assets/music/`, credits in its `CREDITS.md`) = seed tracks
`trk_lib_*` (tags: mood + artist), also shipped in the `vierge` pack. A seed scene may carry `replaces: { music:
oldValue }`: on an existing table the channel is upgraded only if it still holds `oldValue` (the GM never changed it).

## Sound effects

Transient event `'sfx'` `{ id, volume? }` → every client plays it. **Standard sfx ids** (any module may emit them, type
`SfxId`): `dice`, `door-open`, `door-close`, `door-locked`, `gunshot-pistol`, `gunshot-rifle`, `gunshot-auto`,
`explosion`, `hit-melee`, `glass-break`, `alarm`, `footsteps`, `notify`, `matrix-glitch`, `spell-cast`, `heal`,
`death`, `cash`, `level-up`, `ping`.

## Actions

`audio/setAmbient|setMusic|setVolume|sfx|addTrack|updateTrack|removeTrack|saveScene|applyScene|deleteScene|stopAll|
setOptions`.
