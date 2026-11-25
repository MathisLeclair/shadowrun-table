// Procedural ambiences. Each export: start(ctx, destination, opts?) -> { stop(fadeSeconds) }.
// Long-running parts live in a rig (see synth.js); random events are scheduled on the audio clock.
import {
  createRig, tone, noise, metal, fm, pad, kick, snare, hat, clap, oscNode, finish, gainNode, filterNode, panner,
  crushCurve, rand, randInt, chance, pick,
} from './synth.js';
import { mtof, chordNotes, chordRoot, arpNote, scaleNote, SCALES, fitRange } from './theory.js';

// ---------------------------------------------------------------------------
// Shared layers
// ---------------------------------------------------------------------------
/** Rain on asphalt: hiss + body + droplets + gutter drips + passing tyres. */
function rainLayer(rig, intensity = 1, dest = rig.out) {
  const { ctx } = rig;
  const hp = rig.filter('highpass', 450, 0.5, dest);
  const lp = rig.filter('lowpass', 6500, 0.5, hp);
  const hiss = rig.loopNoise('pink', lp, { gain: 0.55 * intensity });
  rig.lfo(hiss.gain, { rate: 0.045, depth: 0.12 * intensity });
  const body = rig.filter('lowpass', 750, 0.6, dest);
  rig.loopNoise('brown', body, { gain: 0.22 * intensity });
  // Pre-panned buses: droplets are many, so they don't each get their own panner.
  const spots = [-0.9, -0.5, -0.15, 0.2, 0.55, 0.9].map((p) => rig.pan(p, dest));
  rig.every(0.03 / intensity, 0.1 / intensity, (t) => {
    const f = rand(2400, 6000);
    tone(ctx, pick(spots), t, { freq: f, freqEnd: f * 0.6, glide: 0.015, env: 'perc', a: 0.001, dur: rand(0.008, 0.03), gain: rand(0.008, 0.035) });
  });
  rig.every(0.05, 0.15, (t) => noise(ctx, pick(spots), t, { freq: rand(1500, 4500), q: 2, dur: 0.018, gain: rand(0.01, 0.04) }));
  const verb = rig.reverb({ seconds: 1.6, decay: 3, wet: 0.5, dest });
  rig.every(0.35, 1.3, (t) => {
    const f = rand(650, 1300);
    tone(ctx, verb, t, { freq: f, freqEnd: f * 1.6, glide: 0.03, env: 'perc', a: 0.002, dur: 0.06, gain: rand(0.02, 0.05), pan: rand(-0.6, 0.6) });
  });
  rig.every(9, 22, (t) => {
    const dir = chance(0.5) ? 1 : -1;
    noise(ctx, dest, t, { color: 'pink', freq: 900, freqEnd: 600, q: 0.6, env: 'swell', a: rand(1.4, 2.4), hold: 0.3, r: 2.2, gain: 0.16 * intensity, pan: -0.85 * dir, panEnd: 0.85 * dir });
  }, rand(4, 9));
}

/** Murmuring crowd: n "talkers" (voiced saw + breath noise through moving vowel formants). */
const VOWELS = [[800, 1200], [500, 1850], [320, 2250], [520, 900], [360, 800], [420, 2000], [650, 1450]];
function crowdLayer(rig, n, level, dest) {
  const { ctx } = rig;
  for (let i = 0; i < n; i++) {
    const male = chance(0.55);
    const base = male ? rand(95, 140) : rand(170, 240);
    const out = rig.gain(0, rig.pan(rand(-0.85, 0.85), dest));
    const f1 = rig.filter('bandpass', 600, 5, out);
    const f2 = rig.filter('bandpass', 1500, 6, out);
    const f2g = rig.gain(0.5, f2);
    const src = rig.gain(1, f1);
    src.connect(f2g);
    const voiced = rig.osc('sawtooth', base, src, { gain: 0.9 });
    rig.loopNoise('pink', src, { gain: 0.5 });
    let talking = chance(0.6);
    rig.every(0.1, 0.28, (t) => {
      if (chance(talking ? 0.04 : 0.12)) talking = !talking;
      const [a, b] = pick(VOWELS);
      f1.frequency.setTargetAtTime(a * rand(0.9, 1.1), t, 0.03);
      f2.frequency.setTargetAtTime(b * rand(0.9, 1.1), t, 0.03);
      voiced.osc.frequency.setTargetAtTime(base * rand(0.85, 1.25), t, 0.06);
      out.gain.setTargetAtTime(talking ? level * rand(0.25, 1) : 0, t, talking ? 0.025 : 0.08);
    }, rand(0, 0.3));
  }
}

/** Two-tone wailing siren far away (moves across the stereo field). */
function siren(rig, dest, t, { dur = rand(6, 10), gain = 0.045 } = {}) {
  const { ctx } = rig;
  const o = oscNode(ctx, 'triangle', 700);
  const f = filterNode(ctx, 'lowpass', 1600, 0.7);
  const g = gainNode(ctx, 0);
  const p = panner(ctx, rand(-0.8, 0.8));
  o.connect(f);
  f.connect(g);
  g.connect(p);
  p.connect(dest);
  const lo = rand(600, 720);
  const hi = lo * rand(1.7, 1.95);
  const period = rand(1.3, 1.9);
  o.frequency.setValueAtTime(lo, t);
  for (let k = 0, tt = t; tt < t + dur; k++, tt += period / 2) o.frequency.linearRampToValueAtTime(k % 2 ? lo : hi, tt + period / 2);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(gain, t + dur * 0.35);
  g.gain.linearRampToValueAtTime(gain * 0.8, t + dur * 0.6);
  g.gain.linearRampToValueAtTime(0, t + dur);
  o.start(t);
  finish([o], [o, f, g, p], t + dur + 0.05);
}

/** A car passing by (tyre hiss + engine) with stereo motion. */
function carPass(rig, dest, t, gain = 0.16) {
  const { ctx } = rig;
  const dir = chance(0.5) ? 1 : -1;
  const a = rand(1.8, 3);
  noise(ctx, dest, t, { color: 'pink', freq: rand(700, 1000), freqEnd: rand(350, 500), q: 0.5, env: 'swell', a, hold: 0.2, r: a, gain, pan: -0.9 * dir, panEnd: 0.9 * dir });
  const e = rand(60, 90);
  tone(ctx, dest, t, { type: 'sawtooth', freq: e * 1.08, freqEnd: e * 0.9, glide: a * 2, cutoff: 260, a, d: 0.1, s: 1, dur: a, r: a, gain: gain * 0.25, pan: 0 });
}

/** Single water drop with room echo. */
function drop(rig, dest, t, gain = 0.05) {
  const f = rand(850, 1700);
  tone(rig.ctx, dest, t, { freq: f, freqEnd: f * rand(1.4, 1.8), glide: 0.02, env: 'perc', a: 0.001, dur: rand(0.04, 0.07), gain, pan: rand(-0.7, 0.7) });
}

/** Distant dog barking 2-4 times. */
function dogs(rig, dest, t) {
  const n = randInt(2, 4);
  const base = rand(380, 540);
  const p = rand(-0.8, 0.8);
  let tt = t;
  for (let i = 0; i < n; i++) {
    tone(rig.ctx, dest, tt, { type: 'sawtooth', freq: base * rand(0.95, 1.1), freqEnd: base * 0.65, glide: 0.13, env: 'perc', a: 0.012, dur: 0.13, gain: 0.05, filterType: 'bandpass', cutoff: 1000, q: 1.6, pan: p });
    noise(rig.ctx, dest, tt, { freq: 1300, q: 1, dur: 0.07, gain: 0.012, pan: p });
    tt += rand(0.3, 0.6);
  }
}

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------
export function rain(ctx, dest, opts) {
  const rig = createRig(ctx, dest, opts);
  rainLayer(rig, 1);
  // distant city under the rain
  rig.loopNoise('brown', rig.filter('lowpass', 160), { gain: 0.25 });
  return { stop: rig.stop };
}

export function cityNight(ctx, dest, opts) {
  const rig = createRig(ctx, dest, opts);
  const hum = rig.loopNoise('brown', rig.filter('lowpass', 180), { gain: 0.45 });
  rig.lfo(hum.gain, { rate: 0.03, depth: 0.1 });
  const traffic = rig.loopNoise('pink', rig.filter('bandpass', 600, 0.4), { gain: 0.1 });
  rig.lfo(traffic.gain, { rate: 0.07, depth: 0.05 });
  const windF = rig.filter('bandpass', 520, 1.4);
  const wind = rig.loopNoise('pink', windF, { gain: 0.09 });
  rig.lfo(windF.frequency, { rate: 0.08, depth: 260 });
  rig.lfo(wind.gain, { rate: 0.05, depth: 0.05 });
  const verb = rig.reverb({ seconds: 3.5, decay: 2.5, wet: 0.6 });
  rig.every(5, 14, (t) => carPass(rig, rig.out, t, rand(0.08, 0.18)), rand(1, 4));
  rig.every(25, 60, (t) => siren(rig, verb, t), rand(8, 18));
  rig.every(18, 45, (t) => {
    const n = chance(0.4) ? 2 : 1;
    for (let i = 0; i < n; i++) {
      for (const f of [330, 415]) tone(ctx, verb, t + i * 0.45, { type: 'square', freq: f * rand(0.97, 1.03), dur: 0.32, cutoff: 900, a: 0.01, r: 0.08, gain: 0.018, pan: rand(-0.8, 0.8) });
    }
  });
  rig.every(30, 70, (t) => dogs(rig, rig.filter('lowpass', 1200, 0.7, verb), t), rand(15, 30));
  return { stop: rig.stop };
}

export function bar(ctx, dest, opts) {
  const rig = createRig(ctx, dest, opts);
  const verb = rig.reverb({ seconds: 1.4, decay: 2.5, wet: 0.35 });
  rig.loopNoise('pink', rig.filter('lowpass', 1100), { gain: 0.07 });
  const crowd = rig.gain(1, rig.filter('lowpass', 2400, 0.6));
  crowd.connect(verb);
  crowdLayer(rig, 9, 0.05, crowd);
  // Jukebox in the corner: muffled groove.
  const juke = rig.gain(0.55, rig.pan(0.45, rig.filter('lowpass', 650, 0.8)));
  const chords = ['Am', 'F', 'C', 'G'];
  rig.seq({
    bpm: 98,
    onStep(step, t, sd) {
      const bar = Math.floor(step / 16);
      const s = step % 16;
      const chord = chords[bar % chords.length];
      if (s % 8 === 0) kick(ctx, juke, t, { gain: 0.55, f0: 120, f1: 45, click: 0 });
      if (s === 4 || s === 12) snare(ctx, juke, t, { gain: 0.25 });
      if (s % 2 === 0) {
        const root = chordRoot(chord, 2) + (s % 4 === 2 ? 12 : 0);
        tone(ctx, juke, t, { type: 'sawtooth', freq: mtof(root), env: 'perc', dur: sd * 1.8, a: 0.004, cutoff: 380, gain: 0.16 });
      }
      if (s === 0) pad(ctx, juke, t, { freqs: chordNotes(chord, 4).map(mtof), dur: sd * 15, a: 0.05, r: 0.2, cutoff: 1400, gain: 0.06, type: 'square' });
    },
  });
  rig.every(1.5, 5, (t) => {
    const n = chance(0.35) ? 2 : 1;
    for (let i = 0; i < n; i++) metal(ctx, verb, t + i * rand(0.08, 0.15), { freq: rand(1900, 3300), ratios: [1, 2.32, 3.71], decay: rand(0.15, 0.3), gain: 0.035, pan: rand(-0.9, 0.9) });
  });
  rig.every(9, 24, (t) => {
    const n = randInt(4, 7);
    const f0 = rand(200, 300);
    const p = rand(-0.8, 0.8);
    for (let i = 0; i < n; i++) {
      const tt = t + i * rand(0.11, 0.15);
      tone(ctx, crowd, tt, { type: 'sawtooth', freq: f0 * (1 - i * 0.03), env: 'perc', a: 0.01, dur: 0.09, filterType: 'bandpass', cutoff: rand(700, 1000), q: 3, gain: 0.09, pan: p });
    }
  }, rand(4, 10));
  rig.every(14, 30, (t) => noise(ctx, verb, t, { color: 'brown', type: 'bandpass', freq: 500, freqEnd: 300, q: 2, env: 'swell', a: 0.05, hold: 0.25, r: 0.1, gain: 0.25, pan: rand(-0.8, 0.8) }));
  return { stop: rig.stop };
}

export function club(ctx, dest, opts) {
  const rig = createRig(ctx, dest, opts);
  rig.loopNoise('brown', rig.filter('lowpass', 140), { gain: 0.18 });
  // The "wall": everything goes through this low-pass, which opens when someone opens the door.
  const wallF = rig.filter('lowpass', 240, 0.9);
  const wall = rig.gain(0.9, wallF);
  const chords = ['Am', 'F', 'C', 'G'];
  rig.seq({
    bpm: 120,
    onStep(step, t, sd) {
      const bar = Math.floor(step / 16);
      const s = step % 16;
      const chord = chords[Math.floor(bar / 2) % chords.length];
      if (s % 4 === 0) kick(ctx, wall, t, { gain: 1, f0: 130, f1: 44, decay: 0.32, click: 0.1 });
      if (s === 4 || s === 12) clap(ctx, wall, t, { gain: 0.3 });
      if (s % 4 === 2) hat(ctx, wall, t, { gain: 0.12, open: true });
      if (s % 2 === 1 || s % 4 === 2) {
        const root = chordRoot(chord, 1) + (s % 4 === 2 ? 12 : 0);
        tone(ctx, wall, t, { type: 'sawtooth', freq: mtof(root), env: 'perc', dur: sd * 0.9, filterEnv: { from: 900, to: 150, time: sd }, gain: 0.3 });
      }
      tone(ctx, wall, t, { type: 'square', freq: mtof(arpNote(chordNotes(chord, 4), step, 'updown', 2)), env: 'perc', dur: sd * 0.8, cutoff: 2200, gain: 0.04 });
      if (s === 0 && bar % 2 === 0) pad(ctx, wall, t, { freqs: chordNotes(chord, 3).map(mtof), dur: sd * 30, a: 0.4, r: 0.8, cutoff: 1800, gain: 0.08 });
    },
  });
  // Door opens: the muffled music suddenly gets bright, then closes again.
  rig.every(25, 60, (t) => {
    const open = rand(2.5, 6);
    wallF.frequency.setTargetAtTime(4500, t, 0.08);
    wallF.frequency.setTargetAtTime(240, t + open, 0.15);
    wall.gain.setTargetAtTime(0.45, t, 0.08);
    wall.gain.setTargetAtTime(0.9, t + open, 0.15);
    noise(ctx, rig.out, t, { color: 'pink', freq: 1500, q: 0.5, env: 'swell', a: 0.15, hold: open - 0.3, r: 0.3, gain: 0.05 });
  }, rand(12, 25));
  return { stop: rig.stop };
}

export function corpLobby(ctx, dest, opts) {
  const rig = createRig(ctx, dest, opts);
  const verb = rig.reverb({ seconds: 4, decay: 2.2, wet: 0.55 });
  const echo = rig.delay({ time: 0.48, feedback: 0.45, tone: 3000, wet: 0.3 });
  rig.loopNoise('pink', rig.filter('lowpass', 900), { gain: 0.07 });
  const chords = ['Dmaj9', 'Bm9', 'Gmaj9', 'Aadd9'];
  let ci = 0;
  rig.schedule(0.2, (t) => {
    const chord = chords[ci++ % chords.length];
    pad(ctx, verb, t, { freqs: fitRange(chordNotes(chord, 3), 52, 76).map(mtof), dur: 7, a: 3, r: 4, type: 'triangle', cutoff: 1500, gain: 0.09 });
    pad(ctx, rig.out, t, { freqs: [mtof(chordRoot(chord, 2))], dur: 7, a: 3, r: 4, type: 'sine', cutoff: 600, gain: 0.07 });
    return 8;
  });
  rig.every(3, 9, (t) => {
    const n = scaleNote(74, SCALES.pentaMajor, randInt(0, 7));
    const p = rand(-0.7, 0.7);
    fm(ctx, verb, t, { freq: mtof(n), ratio: 3.5, index: 1.5, indexDecay: 0.6, dur: 3, gain: 0.035, pan: p });
    fm(ctx, echo, t, { freq: mtof(n), ratio: 3.5, index: 1.5, indexDecay: 0.6, dur: 2, gain: 0.012, pan: -p });
  });
  rig.every(40, 90, (t) => {
    fm(ctx, verb, t, { freq: mtof(88), ratio: 2, index: 1, dur: 1.6, gain: 0.05 });
    fm(ctx, verb, t + 0.38, { freq: mtof(84), ratio: 2, index: 1, dur: 2, gain: 0.05 });
  }, rand(15, 35));
  rig.every(15, 35, (t) => {
    const n = randInt(4, 9);
    const dir = chance(0.5) ? 1 : -1;
    for (let i = 0; i < n; i++) {
      noise(ctx, verb, t + i * rand(0.46, 0.54), { type: 'bandpass', freq: rand(2200, 2800), q: 1.5, dur: 0.03, gain: 0.07, pan: dir * (-0.7 + (1.4 * i) / n) });
    }
  });
  const murmur = rig.gain(1, rig.filter('lowpass', 1500, 0.6, verb));
  crowdLayer(rig, 3, 0.02, murmur);
  return { stop: rig.stop };
}

export function lab(ctx, dest, opts) {
  const rig = createRig(ctx, dest, opts);
  const verb = rig.reverb({ seconds: 1.2, decay: 3, wet: 0.3 });
  rig.osc('sawtooth', 60, rig.filter('lowpass', 480, 0.8), { gain: 0.03 });
  rig.osc('sine', 120, rig.out, { gain: 0.02 });
  const buzzF = rig.filter('bandpass', 3000, 6);
  const buzz = rig.osc('sawtooth', 120, buzzF, { gain: 0.05 });
  rig.loopNoise('pink', rig.filter('lowpass', 800), { gain: 0.07 });
  // Neon flicker: the buzz stutters for a moment.
  rig.every(15, 40, (t) => {
    const n = randInt(4, 10);
    let tt = t;
    for (let i = 0; i < n; i++) {
      buzz.gain.gain.setValueAtTime(i % 2 ? 0.05 : rand(0, 0.15), tt);
      if (i % 2 === 0) noise(ctx, rig.out, tt, { type: 'highpass', freq: 3000, dur: 0.015, gain: 0.04 });
      tt += rand(0.03, 0.12);
    }
    buzz.gain.gain.setValueAtTime(0.05, tt);
  });
  rig.every(2, 7, (t) => {
    const f = pick([880, 1046.5, 1318.5, 1760, 2093]);
    const n = randInt(1, 3);
    for (let i = 0; i < n; i++) tone(ctx, verb, t + i * 0.13, { type: 'square', freq: f, dur: 0.06, a: 0.002, r: 0.01, s: 1, cutoff: 3000, gain: 0.018, pan: rand(-0.6, 0.6) });
  });
  rig.every(6, 14, (t) => {
    const n = randInt(5, 14);
    for (let i = 0; i < n; i++) {
      const f = rand(300, 800);
      tone(ctx, verb, t + rand(0, 1.4), { freq: f, freqEnd: f * 2.3, glide: 0.04, env: 'perc', dur: 0.05, a: 0.003, gain: 0.025, pan: 0.5 });
    }
  });
  rig.every(40, 80, (t) => tone(ctx, rig.out, t, { freq: 180, freqEnd: 1150, glide: 4, a: 3, d: 0.1, s: 1, dur: 8, r: 3, gain: 0.013, pan: -0.4, vibrato: { rate: 9, depth: 6 } }), rand(10, 30));
  return { stop: rig.stop };
}

export function hospital(ctx, dest, opts) {
  const rig = createRig(ctx, dest, opts);
  const verb = rig.reverb({ seconds: 1.8, decay: 3, wet: 0.35 });
  rig.loopNoise('pink', rig.filter('lowpass', 700), { gain: 0.08 });
  let bpm = rand(68, 78);
  rig.schedule(0.3, (t) => {
    tone(ctx, verb, t, { freq: 960, dur: 0.09, a: 0.003, d: 0.01, s: 1, r: 0.03, gain: 0.05, pan: 0.3 });
    if (chance(0.03)) bpm = Math.min(95, Math.max(58, bpm + rand(-6, 6)));
    return 60 / bpm + rand(-0.015, 0.015);
  });
  rig.schedule(0.8, (t) => {
    noise(ctx, rig.out, t, { type: 'highpass', freq: 2500, dur: 0.012, gain: 0.03, pan: -0.3 });
    noise(ctx, rig.out, t, { color: 'pink', freq: 600, freqEnd: 1100, q: 1, env: 'swell', a: 1.4, hold: 0.2, r: 0.6, gain: 0.06, pan: -0.3 });
    noise(ctx, rig.out, t + 2.4, { color: 'pink', freq: 900, freqEnd: 480, q: 1, env: 'swell', a: 0.3, hold: 0.2, r: 1.3, gain: 0.04, pan: -0.3 });
    return 4.6;
  });
  rig.every(60, 140, (t) => {
    [79, 76, 72].forEach((m, i) => fm(ctx, verb, t + i * 0.5, { freq: mtof(m), ratio: 2, index: 0.8, dur: 1.4, gain: 0.03 }));
  }, rand(20, 50));
  rig.every(20, 45, (t) => {
    const dir = chance(0.5) ? 1 : -1;
    noise(ctx, verb, t, { color: 'brown', type: 'lowpass', freq: 350, q: 0.7, env: 'swell', a: 1, hold: 2, r: 1, gain: 0.25, pan: -0.8 * dir, panEnd: 0.8 * dir });
    for (let i = 0; i < 3; i++) if (chance(0.6)) tone(ctx, verb, t + rand(0.5, 3), { freq: rand(2200, 2800), dur: rand(0.08, 0.2), a: 0.02, r: 0.05, gain: 0.006, vibrato: { rate: 14, depth: 40, delay: 0.01 } });
  }, rand(5, 15));
  return { stop: rig.stop };
}

export function serverRoom(ctx, dest, opts) {
  const rig = createRig(ctx, dest, opts);
  const fanF = rig.filter('highpass', 120, 0.5, rig.filter('lowpass', 2800, 0.5));
  const fans = rig.loopNoise('pink', fanF, { gain: 0.32 });
  rig.lfo(fans.gain, { rate: 0.13, depth: 0.02 });
  rig.osc('sine', 2400, rig.out, { gain: 0.004 });
  rig.osc('sine', 2404, rig.out, { gain: 0.004 });
  rig.osc('sine', 4810, rig.out, { gain: 0.0015 });
  rig.osc('sine', 100, rig.out, { gain: 0.03 });
  rig.osc('sawtooth', 50, rig.filter('lowpass', 200), { gain: 0.03 });
  rig.every(0.4, 2.5, (t) => {
    const n = randInt(2, 8);
    const p = rand(-0.8, 0.8);
    let tt = t;
    for (let i = 0; i < n; i++) {
      noise(ctx, rig.out, tt, { freq: rand(2500, 5000), q: 3, dur: 0.004, a: 0.0005, gain: rand(0.03, 0.07), pan: p });
      tt += rand(0.02, 0.09);
    }
  });
  rig.every(4, 12, (t) => tone(ctx, rig.out, t, { freq: rand(3000, 5000), env: 'perc', dur: 0.04, gain: 0.005, pan: rand(-1, 1) }));
  rig.every(30, 70, (t) => {
    noise(ctx, rig.out, t, { type: 'lowpass', freq: 400, dur: 0.06, gain: 0.12 });
    metal(ctx, rig.out, t, { freq: 180, decay: 0.15, gain: 0.03 });
  }, rand(8, 20));
  return { stop: rig.stop };
}

export function matrix(ctx, dest, opts) {
  const rig = createRig(ctx, dest, opts);
  const verb = rig.reverb({ seconds: 3, decay: 2, wet: 0.45 });
  const echo = rig.delay({ time: 0.375, feedback: 0.55, tone: 4000, wet: 0.4 });
  const droneF = rig.filter('lowpass', 420, 5);
  rig.lfo(droneF.frequency, { rate: 0.045, depth: 260 });
  rig.osc('sawtooth', 55, droneF, { gain: 0.06 });
  rig.osc('sawtooth', 55.35, droneF, { gain: 0.06 });
  rig.osc('sine', 27.5, rig.out, { gain: 0.09 });
  const shimmer = rig.gain(0.012, verb);
  rig.lfo(shimmer.gain, { rate: 0.11, depth: 0.01 });
  rig.osc('sine', 880, shimmer);
  rig.osc('sine', 1318.5, shimmer, { gain: 0.7 });
  // Glitch arpeggios through a staircase "bit-crusher".
  const crusher = rig.keep(ctx.createWaveShaper());
  crusher.curve = crushCurve(ctx, 5);
  // Signals go in hot (the staircase would round quiet signals to silence) and are attenuated after.
  const crushIn = rig.gain(1, crusher);
  const crushOut = rig.gain(0.07);
  crushOut.connect(echo);
  crusher.connect(crushOut);
  rig.every(3, 8, (t) => {
    const n = randInt(8, 24);
    const sd = pick([0.055, 0.07, 0.09]);
    const notes = [45, 46, 48, 50, 52, 53, 55].map((m) => m + 24);
    const pattern = pick(['up', 'down', 'updown']);
    const off = randInt(0, 6);
    for (let i = 0; i < n; i++) {
      if (chance(0.12)) continue;
      tone(ctx, crushIn, t + i * sd, { type: 'square', freq: mtof(arpNote(notes, i + off, pattern, 2)), env: 'perc', dur: sd * 0.8, a: 0.001, gain: 0.6, pan: rand(-0.5, 0.5) });
    }
  });
  rig.every(5, 12, (t) => {
    const n = randInt(6, 20);
    const p = rand(-0.9, 0.9);
    for (let i = 0; i < n; i++) noise(ctx, rig.out, t + i * rand(0.02, 0.05), { type: 'highpass', freq: 4000, dur: rand(0.008, 0.025), gain: 0.035, pan: p });
  });
  rig.every(6, 15, (t) => tone(ctx, echo, t, { freq: pick([1760, 2637, 2093]), env: 'perc', dur: 0.15, gain: 0.03, pan: rand(-0.6, 0.6) }));
  rig.every(8, 16, (t) => kick(ctx, verb, t, { gain: 0.2, f0: 80, f1: 40, decay: 0.8, click: 0 }));
  return { stop: rig.stop };
}

export function industrial(ctx, dest, opts) {
  const rig = createRig(ctx, dest, opts);
  const verb = rig.reverb({ seconds: 3.5, decay: 2, wet: 0.5 });
  rig.loopNoise('brown', rig.filter('lowpass', 120), { gain: 0.5 });
  const whirr = rig.osc('sawtooth', 80, rig.filter('lowpass', 300), { gain: 0.04 });
  rig.lfo(whirr.gain.gain, { rate: 3.2, depth: 0.02 });
  let beat = 0;
  rig.schedule(0.5, (t) => {
    kick(ctx, verb, t, { gain: 0.35, f0: 90, f1: 38, decay: 0.5, click: 0.1 });
    noise(ctx, rig.out, t + 0.12, { type: 'highpass', freq: 3000, env: 'swell', a: 0.05, hold: 0.1, r: 0.4, gain: 0.035, pan: -0.3 });
    if (beat++ % 2) metal(ctx, verb, t + 0.9, { freq: rand(150, 250), ratios: [1, 2.6, 4.3, 6.8], decay: 0.4, gain: 0.05, pan: -0.3 });
    return 1.8;
  });
  rig.every(6, 15, (t) => noise(ctx, rig.out, t, { type: 'bandpass', freq: 5000, q: 0.5, env: 'swell', a: 0.15, hold: rand(0.5, 2), r: 1, gain: 0.1, pan: rand(-0.9, 0.9) }));
  rig.every(3, 9, (t) => metal(ctx, verb, t, { freq: rand(90, 400), ratios: [1, 2.6, 4.3, 6.8, 9.1], decay: rand(0.6, 1.6), gain: 0.07, pan: rand(-0.9, 0.9) }));
  rig.every(20, 40, (t) => noise(ctx, verb, t, { freq: 700, freqEnd: 1600, q: 8, env: 'swell', a: 0.5, hold: 1, r: 1, gain: 0.06, pan: rand(-0.9, 0.9) }), rand(5, 15));
  return { stop: rig.stop };
}

export function underground(ctx, dest, opts) {
  const rig = createRig(ctx, dest, opts);
  const verb = rig.reverb({ seconds: 4, decay: 2, wet: 0.65 });
  const echo = rig.delay({ time: 0.28, feedback: 0.45, tone: 1800, wet: 0.35 });
  const rumble = rig.loopNoise('brown', rig.filter('lowpass', 90), { gain: 0.55 });
  rig.lfo(rumble.gain, { rate: 0.04, depth: 0.15 });
  const trickle = rig.loopNoise('white', rig.filter('bandpass', 1800, 1.5), { gain: 0.016 });
  rig.lfo(trickle.gain, { rate: 6.3, depth: 0.007 });
  rig.lfo(trickle.gain, { rate: 9.7, depth: 0.005 });
  rig.every(0.8, 3.5, (t) => {
    const g = rand(0.03, 0.07);
    drop(rig, verb, t, g);
    drop(rig, echo, t, g * 0.4);
  });
  rig.every(40, 90, (t) => {
    noise(ctx, rig.out, t, { color: 'brown', type: 'lowpass', freq: 200, q: 0.7, env: 'swell', a: 4, hold: 2, r: 5, gain: 0.5 });
    metal(ctx, verb, t + 3, { freq: 1900, ratios: [1, 1.5], decay: 2, gain: 0.006 });
  }, rand(15, 40));
  rig.every(25, 60, (t) => tone(ctx, verb, t, { type: 'sawtooth', freq: rand(65, 75), freqEnd: rand(85, 100), glide: 3, a: 1, d: 0.1, s: 1, dur: 2.5, r: 1.5, cutoff: 250, gain: 0.035, vibrato: { rate: 4, depth: 20 } }));
  return { stop: rig.stop };
}

export function storm(ctx, dest, opts) {
  const rig = createRig(ctx, dest, opts);
  rainLayer(rig, 1.35);
  const verb = rig.reverb({ seconds: 4, decay: 1.8, wet: 0.7 });
  const windF = rig.filter('bandpass', 400, 0.8);
  const wind = rig.loopNoise('pink', windF, { gain: 0.12 });
  rig.lfo(windF.frequency, { rate: 0.1, depth: 200 });
  rig.lfo(wind.gain, { rate: 0.06, depth: 0.06 });
  rig.every(6, 14, (t) => noise(ctx, rig.out, t, { color: 'pink', freq: 300, freqEnd: 900, q: 0.9, env: 'swell', a: 2, hold: 1, r: 3, gain: 0.16, pan: rand(-0.9, 0.9) }));
  rig.every(10, 30, (t) => {
    const close = chance(0.35);
    const delay = close ? 0 : rand(0.3, 1.2);
    if (close) {
      noise(ctx, rig.out, t, { type: 'highpass', freq: 1200, dur: 0.25, a: 0.002, gain: 0.45 });
      noise(ctx, verb, t, { type: 'lowpass', freq: 3000, freqEnd: 200, dur: 0.6, gain: 0.5 });
    }
    const n = randInt(3, 7);
    let tt = t + delay;
    for (let i = 0; i < n; i++) {
      const g = rand(0.35, 0.9) * (close ? 1 : 0.55);
      noise(ctx, i % 2 ? verb : rig.out, tt, { color: 'brown', type: 'lowpass', freq: close ? rand(200, 320) : rand(110, 180), q: 0.7, env: 'swell', a: rand(0.08, 0.5), hold: rand(0.2, 0.9), r: rand(1, 3), gain: g });
      tt += rand(0.3, 1);
    }
  }, rand(4, 8));
  return { stop: rig.stop };
}

export function alley(ctx, dest, opts) {
  const rig = createRig(ctx, dest, opts);
  const verb = rig.reverb({ seconds: 1.8, decay: 2.5, wet: 0.5 });
  const far = rig.filter('lowpass', 1500, 0.7, rig.reverb({ seconds: 3, decay: 2, wet: 0.7 }));
  rig.loopNoise('brown', rig.filter('lowpass', 250), { gain: 0.3 });
  rig.loopNoise('pink', rig.filter('bandpass', 350, 0.8), { gain: 0.05 });
  const neon = rig.gain(1, rig.pan(0.35));
  const buzz = rig.osc('sawtooth', 120, rig.filter('bandpass', 2500, 2, neon), { gain: 0.03 });
  rig.osc('sine', 120, neon, { gain: 0.012 });
  rig.every(8, 20, (t) => {
    let tt = t;
    const n = randInt(3, 9);
    for (let i = 0; i < n; i++) {
      neon.gain.setValueAtTime(i % 2 ? 1 : rand(0, 0.3), tt);
      if (i % 2 === 0) noise(ctx, neon, tt, { type: 'highpass', freq: 2500, dur: 0.012, gain: 0.05 });
      tt += rand(0.03, 0.15);
    }
    neon.gain.setValueAtTime(1, tt);
  });
  void buzz;
  rig.every(0.5, 3, (t) => drop(rig, verb, t, rand(0.02, 0.05)));
  rig.every(9, 22, (t) => carPass(rig, far, t, 0.12), rand(3, 9));
  rig.every(15, 40, (t) => dogs(rig, far, t), rand(5, 15));
  rig.every(60, 120, (t) => siren(rig, far, t, { gain: 0.04 }), rand(30, 60));
  rig.every(20, 50, (t) => {
    const n = randInt(3, 8);
    const p = rand(-0.9, 0.9);
    for (let i = 0; i < n; i++) noise(ctx, verb, t + rand(0, 0.8), { freq: rand(2000, 4000), q: 1.5, dur: rand(0.02, 0.06), gain: 0.03, pan: p });
  });
  return { stop: rig.stop };
}

/** preset id -> start function */
export const AMBIENCES = {
  rain,
  'city-night': cityNight,
  bar,
  club,
  'corp-lobby': corpLobby,
  lab,
  hospital,
  'server-room': serverRoom,
  matrix,
  industrial,
  underground,
  storm,
  alley,
};
