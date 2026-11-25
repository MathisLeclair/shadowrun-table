// Procedural music loops: step sequencer + chord progressions + simple synth voices.
// Each export: start(ctx, destination, opts?) -> { stop(fadeSeconds) }.
import { createRig, tone, noise, metal, fm, pad, kick, snare, hat, clap, tom, rand, randInt, chance, pick } from './synth.js';
import { mtof, chordNotes, chordRoot, arpNote, scaleNote, SCALES, fitRange } from './theory.js';

/**
 * Bar-aware sequencer. onStep({ step, bar, s, t, sd, chord, next, section }) where s is the step in the bar.
 * chords: progression, one entry per `barsPerChord` bars. section = index of the 8-bar block (for arrangement).
 */
function song(rig, { bpm, stepsPerBeat = 4, beats = 4, swing = 0, chords = ['C'], barsPerChord = 1, onStep }) {
  const perBar = stepsPerBeat * beats;
  rig.seq({
    bpm,
    stepsPerBeat,
    swing,
    onStep(step, t, sd) {
      const bar = Math.floor(step / perBar);
      const s = step % perBar;
      const ci = Math.floor(bar / barsPerChord) % chords.length;
      const chord = chords[ci];
      const next = chords[(ci + 1) % chords.length];
      onStep({ step, bar, s, t, sd, chord, next, ci, section: Math.floor(bar / 8), lastBarOfChord: (bar + 1) % barsPerChord === 0 });
    },
  });
}

/** A melody line generated per section: random walk on a scale, regenerated every 8 bars. */
function melodyMaker(tonic, scale, { lo = -3, hi = 9, density = 0.45, length = 16 } = {}) {
  let cache = null;
  let section = -1;
  return (sec, i) => {
    if (sec !== section || !cache) {
      section = sec;
      cache = [];
      let deg = randInt(0, 4);
      for (let k = 0; k < length; k++) {
        if (!chance(density)) {
          cache.push(null);
          continue;
        }
        deg = Math.max(lo, Math.min(hi, deg + pick([-2, -1, -1, 1, 1, 2, 0, 3, -3])));
        cache.push(scaleNote(tonic, scale, deg));
      }
    }
    return cache[i % cache.length];
  };
}

/** Walking bass note for a beat (0..3) of a bar over `chord`, approaching `next`. */
function walkNote(chord, next, beat, octave = 2) {
  const notes = chordNotes(chord, octave);
  const root = notes[0];
  if (beat === 0) return root;
  if (beat === 3) {
    const nr = chordRoot(next, octave);
    return nr + (chance(0.5) ? -1 : 1);
  }
  return pick(notes.slice(1).concat([root + 12]));
}

// ---------------------------------------------------------------------------
export function tension(ctx, dest, opts) {
  const rig = createRig(ctx, dest, { fadeIn: 3, ...opts });
  const verb = rig.reverb({ seconds: 4, decay: 2, wet: 0.5 });
  const droneF = rig.filter('lowpass', 220, 6);
  rig.lfo(droneF.frequency, { rate: 0.03, depth: 120 });
  rig.osc('sawtooth', mtof(26), droneF, { gain: 0.1 });
  rig.osc('sawtooth', mtof(38) * 1.003, droneF, { gain: 0.07 });
  rig.osc('sine', mtof(26), rig.out, { gain: 0.14 });
  song(rig, {
    bpm: 64,
    onStep({ s, t, bar, section }) {
      if (s === 0 || s === 8) kick(ctx, rig.out, t, { gain: 0.45, f0: 70, f1: 38, decay: 0.5, click: 0 });
      if (s === 2 || s === 10) kick(ctx, rig.out, t, { gain: 0.25, f0: 60, f1: 36, decay: 0.4, click: 0 });
      if (section % 2 === 1 && s % 2 === 0) hat(ctx, rig.out, t, { gain: s % 4 === 0 ? 0.03 : 0.015, pan: s % 4 ? 0.4 : -0.4 });
      if (s === 0 && bar % 4 === 0 && chance(0.75)) {
        const cluster = pick([[62, 63], [57, 58, 64], [50, 56], [62, 68, 69]]);
        pad(ctx, verb, t, { freqs: cluster.map(mtof), dur: 5, a: 3, r: 3, type: 'triangle', cutoff: 900, gain: 0.06 });
      }
      if (s === 0 && bar % 8 === 4) {
        tone(ctx, verb, t, { type: 'sawtooth', freq: mtof(38), a: 0.8, d: 0.2, s: 1, dur: 2.5, r: 2, cutoff: 420, gain: 0.08, voices: 2, spread: 8 });
        tone(ctx, verb, t, { type: 'sawtooth', freq: mtof(44), a: 0.8, d: 0.2, s: 1, dur: 2.5, r: 2, cutoff: 420, gain: 0.06, voices: 2, spread: 8 });
      }
      if (s === 8 && chance(0.25)) noise(ctx, verb, t, { freq: rand(1800, 2400), freqEnd: rand(2600, 3400), q: 10, env: 'swell', a: 1, hold: 0.5, r: 1.5, gain: 0.04, pan: rand(-0.8, 0.8) });
    },
  });
  return { stop: rig.stop };
}

export function combat(ctx, dest, opts) {
  const rig = createRig(ctx, dest, { fadeIn: 0.8, ...opts });
  const verb = rig.reverb({ seconds: 1.5, decay: 3, wet: 0.25 });
  const bpm = 140;
  const echo = rig.delay({ time: (60 / bpm) * 0.75, feedback: 0.3, wet: 0.25 });
  const lead = melodyMaker(64, SCALES.pentaMinor, { lo: 0, hi: 8, density: 0.6, length: 16 });
  song(rig, {
    bpm,
    chords: ['Em', 'C', 'Am', 'B'],
    barsPerChord: 2,
    onStep({ s, t, sd, bar, chord, section }) {
      const fillBar = bar % 8 === 7;
      const breakdown = section % 4 === 3 && bar % 8 < 4;
      if (!breakdown && [0, 7, 8, 10].includes(s) && !(fillBar && s >= 12)) kick(ctx, rig.out, t, { gain: 0.8 });
      if (breakdown && s === 0) kick(ctx, rig.out, t, { gain: 0.8 });
      if ((s === 4 || s === 12) && !(fillBar && s === 12)) snare(ctx, verb, t, { gain: 0.45 });
      if (!breakdown) hat(ctx, rig.out, t, { gain: s % 4 === 2 ? 0.07 : 0.03, pan: 0.25 });
      if (fillBar && s >= 12) tom(ctx, verb, t, { gain: 0.5, freq: [190, 160, 130, 105][s - 12], pan: [-0.4, -0.1, 0.2, 0.4][s - 12] });
      if (bar % 8 === 0 && s === 0) noise(ctx, verb, t, { type: 'highpass', freq: 5000, dur: 1.2, gain: 0.09 });
      if (fillBar && s === 0) noise(ctx, rig.out, t, { type: 'highpass', freq: 800, freqEnd: 7000, env: 'swell', a: sd * 15, hold: 0, r: 0.05, gain: 0.05 });
      const root = chordRoot(chord, 2);
      const pat = [0, 0, 12, 0, 0, 0, 12, 0, 0, 0, 12, 0, 7, 0, 10, 0];
      tone(ctx, rig.out, t, { type: 'sawtooth', freq: mtof(root + pat[s]), env: 'perc', dur: sd * 1.1, filterEnv: { from: 1500, to: 220, time: sd }, gain: s % 4 === 0 ? 0.2 : 0.14 });
      if (s === 0 || s === 3 || s === 6) {
        const pw = [root + 12, root + 19];
        for (const n of pw) tone(ctx, rig.out, t, { type: 'sawtooth', freq: mtof(n), dur: sd * (s === 6 ? 6 : 2.5), a: 0.005, d: 0.1, s: 0.6, r: 0.08, cutoff: 1800, voices: 2, spread: 12, gain: 0.05 });
      }
      if (section % 2 === 1 && !breakdown && s % 2 === 0) {
        const n = lead(section, (bar % 2) * 8 + s / 2);
        if (n != null) {
          tone(ctx, rig.out, t, { type: 'square', freq: mtof(n), dur: sd * 1.6, a: 0.005, r: 0.05, cutoff: 2600, gain: 0.04 });
          tone(ctx, echo, t, { type: 'square', freq: mtof(n), dur: sd * 1.6, a: 0.005, r: 0.05, cutoff: 2600, gain: 0.02 });
        }
      }
    },
  });
  return { stop: rig.stop };
}

export function chase(ctx, dest, opts) {
  const rig = createRig(ctx, dest, { fadeIn: 0.8, ...opts });
  const bpm = 156;
  const sd16 = 60 / bpm / 4;
  const echo = rig.delay({ time: sd16 * 3, feedback: 0.35, tone: 3500, wet: 0.3 });
  const verb = rig.reverb({ seconds: 1.6, decay: 3, wet: 0.25 });
  song(rig, {
    bpm,
    chords: ['Am', 'F', 'G', 'Em'],
    barsPerChord: 2,
    onStep({ s, t, sd, bar, chord, section }) {
      const drop = bar % 16 >= 14;
      if (s % 4 === 0 && !(drop && s >= 8)) kick(ctx, rig.out, t, { gain: 0.75 });
      if (s === 4 || s === 12) clap(ctx, verb, t, { gain: 0.35 });
      hat(ctx, rig.out, t, { gain: s % 4 === 2 ? 0.08 : 0.025, open: s % 4 === 2 && chance(0.3), pan: -0.2 });
      if (s % 2 === 0) {
        const root = chordRoot(chord, 2) + (s % 4 === 2 ? 12 : 0);
        tone(ctx, rig.out, t, { type: 'sawtooth', freq: mtof(root), env: 'perc', dur: sd * 1.6, filterEnv: { from: 1300, to: 240, time: sd * 1.5 }, gain: 0.17 });
      }
      const pattern = section % 2 ? 'updown' : 'up';
      const n = arpNote(chordNotes(chord, 4), s + bar * 16, pattern, 2);
      tone(ctx, rig.out, t, { type: 'sawtooth', freq: mtof(n), env: 'perc', dur: sd * 1.3, filterEnv: { from: 3800, to: 700, time: sd * 1.2 }, gain: 0.05, pan: 0.15 });
      tone(ctx, echo, t, { type: 'square', freq: mtof(n), env: 'perc', dur: sd, cutoff: 2500, gain: 0.025 });
      if (s === 0 && bar % 2 === 0 && section % 2 === 1) {
        tone(ctx, verb, t, { type: 'sawtooth', freq: mtof(chordNotes(chord, 5)[randInt(0, 2)]), a: 0.05, d: 0.2, s: 0.8, dur: sd * 28, r: 0.4, cutoff: 3000, voices: 3, spread: 10, gain: 0.04, vibrato: { rate: 5.5, depth: 15, delay: 0.4 } });
      }
      if (drop && bar % 16 === 15 && s === 8) noise(ctx, verb, t, { type: 'highpass', freq: 600, freqEnd: 8000, env: 'swell', a: sd * 8, hold: 0, r: 0.05, gain: 0.07 });
    },
  });
  return { stop: rig.stop };
}

export function investigation(ctx, dest, opts) {
  const rig = createRig(ctx, dest, { fadeIn: 2, ...opts });
  const verb = rig.reverb({ seconds: 2.4, decay: 2.5, wet: 0.35 });
  const mel = melodyMaker(60, SCALES.blues, { lo: 2, hi: 11, density: 0.3, length: 16 });
  song(rig, {
    bpm: 72,
    stepsPerBeat: 2,
    swing: 0.32,
    chords: ['Cm9', 'Cm9', 'Abmaj7', 'Abmaj7', 'Fm9', 'Dm7b5', 'G7b9', 'G7b9'],
    onStep({ s, t, sd, bar, chord, next, section }) {
      // Rootless electric-piano voicing.
      if (s === 0 || (s === 3 && chance(0.35))) {
        const v = fitRange(chordNotes(chord, 3).slice(1), 55, 72);
        const len = s === 0 ? sd * 5 : sd * 2;
        v.forEach((n, i) => fm(ctx, verb, t + i * 0.012, { freq: mtof(n), ratio: 1, index: 1.1, indexDecay: 0.5, dur: len + 0.6, gain: s === 0 ? 0.05 : 0.035, tremolo: { rate: 4.5, depth: 0.25 }, pan: -0.25 + i * 0.15 }));
      }
      if (s % 2 === 0) {
        const n = walkNote(chord, next, s / 2, 2);
        tone(ctx, rig.out, t, { type: 'triangle', freq: mtof(n), env: 'perc', a: 0.006, dur: sd * 2.2, cutoff: 700, gain: 0.2 });
      }
      if (s === 0) kick(ctx, rig.out, t, { gain: 0.25, f0: 95, f1: 45, decay: 0.3, click: 0 });
      if (s === 2 || s === 6) snare(ctx, verb, t, { gain: 0.14, brush: true });
      if ([0, 2, 3, 4, 6, 7].includes(s)) metal(ctx, rig.out, t, { freq: 3100, ratios: [1, 1.48, 2.1], decay: s % 2 ? 0.2 : 0.4, gain: s % 2 ? 0.006 : 0.01, pan: 0.45 });
      if (section % 2 === 1 || bar % 4 >= 2) {
        const n = mel(section, (bar % 2) * 8 + s);
        if (n != null) tone(ctx, verb, t, { type: 'sawtooth', freq: mtof(n), a: 0.06, d: 0.2, s: 0.7, dur: sd * rand(1.2, 2.8), r: 0.25, cutoff: 1300, q: 2, gain: 0.04, vibrato: { rate: 5, depth: 12, delay: 0.25 }, pan: 0.2 });
      }
    },
  });
  return { stop: rig.stop };
}

export function sad(ctx, dest, opts) {
  const rig = createRig(ctx, dest, { fadeIn: 3, ...opts });
  const verb = rig.reverb({ seconds: 5, decay: 2, wet: 0.6 });
  const echo = rig.delay({ time: 0.77, feedback: 0.4, tone: 2200, wet: 0.25 });
  let last = 7;
  song(rig, {
    bpm: 58,
    stepsPerBeat: 2,
    chords: ['Am', 'F', 'C', 'G', 'Dm', 'Am', 'Fmaj7', 'E'],
    onStep({ s, t, sd, chord }) {
      const barDur = sd * 8;
      if (s === 0) {
        pad(ctx, verb, t, { freqs: fitRange(chordNotes(chord, 3), 52, 70).map(mtof), dur: barDur, a: 1.5, r: 2.5, cutoff: 900, gain: 0.07 });
        tone(ctx, rig.out, t, { freq: mtof(chordRoot(chord, 2)), a: 0.5, d: 0.3, s: 0.8, dur: barDur * 0.9, r: 1, gain: 0.12 });
        if (chance(0.3)) {
          const top = chordNotes(chord, 5)[randInt(0, 2)];
          tone(ctx, verb, t, { type: 'sawtooth', freq: mtof(top), a: 2, d: 0.2, s: 1, dur: barDur * 0.8, r: 2, cutoff: 2200, voices: 3, spread: 9, gain: 0.025, vibrato: { rate: 5, depth: 10, delay: 1 } });
        }
      }
      if (chance(s % 2 ? 0.22 : 0.4)) {
        last = Math.max(0, Math.min(10, last + pick([-2, -1, -1, 1, 1, 2])));
        const n = scaleNote(57, SCALES.pentaMinor, last);
        fm(ctx, verb, t, { freq: mtof(n), ratio: 1, index: 0.8, indexDecay: 0.3, dur: 2.5, gain: 0.06, pan: rand(-0.3, 0.3) });
        fm(ctx, echo, t, { freq: mtof(n + 12), ratio: 1, index: 0.3, dur: 1.2, gain: 0.015 });
      }
    },
  });
  return { stop: rig.stop };
}

export function corpGala(ctx, dest, opts) {
  const rig = createRig(ctx, dest, { fadeIn: 2, ...opts });
  const verb = rig.reverb({ seconds: 2.2, decay: 2.5, wet: 0.3 });
  const vib = melodyMaker(77, SCALES.pentaMajor, { lo: 0, hi: 8, density: 0.4, length: 16 });
  const comps = [[0, 3], [1, 4], [0, 5], [3, 6], [0, 4, 7]];
  let comp = comps[0];
  song(rig, {
    bpm: 104,
    stepsPerBeat: 2,
    swing: 0.3,
    chords: ['Fmaj7', 'Dm7', 'Gm7', 'C9', 'Am7', 'D7b9', 'Gm7', 'C9'],
    onStep({ s, t, sd, bar, chord, next, section }) {
      if (s === 0) comp = pick(comps);
      if (comp.includes(s)) {
        const v = fitRange(chordNotes(chord, 3).slice(1), 57, 74);
        v.forEach((n, i) => fm(ctx, verb, t + i * 0.01, { freq: mtof(n), ratio: 1, index: 0.9, indexDecay: 0.35, dur: sd * 2.5, gain: 0.035, pan: -0.3 + i * 0.12 }));
      }
      if (s % 2 === 0) tone(ctx, rig.out, t, { type: 'triangle', freq: mtof(walkNote(chord, next, s / 2, 2)), env: 'perc', a: 0.005, dur: sd * 2, cutoff: 900, gain: 0.18 });
      if ([0, 2, 3, 4, 6, 7].includes(s)) metal(ctx, rig.out, t, { freq: 3400, ratios: [1, 1.5, 2.2], decay: 0.3, gain: s % 2 ? 0.006 : 0.011, pan: 0.4 });
      if (s === 2 || s === 6) hat(ctx, rig.out, t, { gain: 0.035, pan: 0.3 });
      if ((s === 2 || s === 6) && chance(0.5)) snare(ctx, verb, t, { gain: 0.08, brush: true });
      if (section % 2 === 1 || bar % 8 >= 4) {
        const n = vib(section, (bar % 2) * 8 + s);
        if (n != null) fm(ctx, verb, t, { freq: mtof(n), ratio: 4, index: 0.6, indexDecay: 0.2, dur: 1.4, gain: 0.04, tremolo: { rate: 5.5, depth: 0.35 }, pan: 0.25 });
      }
    },
  });
  return { stop: rig.stop };
}

export function victory(ctx, dest, opts) {
  const rig = createRig(ctx, dest, { fadeIn: 0.5, ...opts });
  const verb = rig.reverb({ seconds: 2.5, decay: 2.5, wet: 0.35 });
  song(rig, {
    bpm: 118,
    chords: ['C', 'G', 'Am', 'F', 'C', 'F', 'G', 'C'],
    onStep({ s, t, sd, bar, chord }) {
      const b = bar % 8;
      const v = fitRange(chordNotes(chord, 4), 60, 76);
      const brass = (dur) => v.forEach((n) => tone(ctx, verb, t, { type: 'sawtooth', freq: mtof(n), a: 0.03, d: 0.15, s: 0.75, dur, r: 0.15, filterEnv: { from: 700, to: 2600, time: 0.12 }, voices: 2, spread: 7, gain: 0.055 }));
      if (s === 0) brass(sd * 6);
      if (s === 10 || s === 12) brass(sd * 1.5);
      if (s === 0) tom(ctx, verb, t, { gain: 0.45, freq: 90 });
      if (s === 0 || s === 8) kick(ctx, rig.out, t, { gain: 0.6 });
      if (s === 4 || s === 12) snare(ctx, verb, t, { gain: 0.35 });
      if (b === 7 && s >= 8) snare(ctx, verb, t, { gain: 0.12 + (s - 8) * 0.04 });
      if (s % 2 === 0) hat(ctx, rig.out, t, { gain: 0.035 });
      if (b === 0 && s === 0) noise(ctx, verb, t, { type: 'highpass', freq: 5000, dur: 1.5, gain: 0.08 });
      if (s % 2 === 0) tone(ctx, rig.out, t, { type: 'sawtooth', freq: mtof(chordRoot(chord, 2)), env: 'perc', dur: sd * 1.8, cutoff: 700, gain: 0.12 });
      const notes = chordNotes(chord, 5);
      if (b % 2 === 0 && s % 4 === 0) tone(ctx, verb, t, { type: 'square', freq: mtof(arpNote(notes, s / 4, 'up', 2)), dur: sd * 3.5, a: 0.01, r: 0.1, cutoff: 3000, gain: 0.04, vibrato: { rate: 6, depth: 10, delay: 0.15 } });
      if (b % 2 === 1 && s === 0) tone(ctx, verb, t, { type: 'square', freq: mtof(notes[1]), dur: sd * 14, a: 0.02, r: 0.3, cutoff: 3000, gain: 0.04, vibrato: { rate: 6, depth: 14, delay: 0.3 } });
      if (b % 2 === 1 && chance(0.5)) fm(ctx, verb, t, { freq: mtof(arpNote(chordNotes(chord, 6), s, 'updown')), ratio: 3.5, index: 1, dur: 0.6, gain: 0.015 });
    },
  });
  return { stop: rig.stop };
}

export function menu(ctx, dest, opts) {
  const rig = createRig(ctx, dest, { fadeIn: 2.5, ...opts });
  const verb = rig.reverb({ seconds: 3, decay: 2.2, wet: 0.4 });
  const bpm = 88;
  const echo = rig.delay({ time: (60 / bpm) * 0.75, feedback: 0.42, tone: 2800, wet: 0.35 });
  const lead = melodyMaker(69, SCALES.pentaMinor, { lo: 0, hi: 7, density: 0.35, length: 8 });
  song(rig, {
    bpm,
    chords: ['Fmaj7', 'G', 'Em7', 'Am'],
    barsPerChord: 2,
    onStep({ s, t, sd, bar, chord, section }) {
      if (s === 0 && bar % 2 === 0) pad(ctx, verb, t, { freqs: fitRange(chordNotes(chord, 3), 52, 72).map(mtof), dur: sd * 31, a: 1, r: 1.5, cutoff: 1100, detune: 10, gain: 0.07 });
      if (s % 2 === 0) {
        const root = chordRoot(chord, 2) + (s % 4 === 2 ? 12 : 0);
        tone(ctx, rig.out, t, { type: 'sawtooth', freq: mtof(root), env: 'perc', dur: sd * 2.4, filterEnv: { from: 900, to: 200, time: sd * 2 }, gain: 0.14 });
      }
      if (s === 0 || s === 8) kick(ctx, rig.out, t, { gain: 0.5, click: 0.1 });
      if (s === 4 || s === 12) snare(ctx, verb, t, { gain: 0.22 });
      if (s % 4 === 2) hat(ctx, rig.out, t, { gain: 0.03, pan: 0.3 });
      if (s % 2 === 0) {
        const n = arpNote(chordNotes(chord, 5), s / 2 + bar * 8, 'up');
        tone(ctx, echo, t, { type: 'triangle', freq: mtof(n), env: 'perc', dur: 0.25, gain: 0.035, pan: -0.2 });
      }
      if (section % 2 === 1 && s % 4 === 0) {
        const n = lead(section, (bar % 2) * 4 + s / 4);
        if (n != null) tone(ctx, verb, t, { type: 'triangle', freq: mtof(n), a: 0.08, d: 0.3, s: 0.7, dur: sd * 3.5, r: 0.6, gain: 0.05, vibrato: { rate: 5, depth: 12, delay: 0.3 } });
      }
    },
  });
  return { stop: rig.stop };
}

/** preset id -> start function */
export const MUSIC = {
  tension,
  combat,
  chase,
  investigation,
  sad,
  'corp-gala': corpGala,
  victory,
  menu,
};

