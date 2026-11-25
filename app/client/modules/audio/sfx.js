// Procedural one-shot sound effects (standard sfx ids, see ARCHITECTURE.md).
// Each function: (ctx, { out, verb }, t) -> end time (seconds, audio clock).
//   out  = dry destination, verb = reverb send (both already scaled by the requested volume).
import { tone, noise, metal, fm, pad, kick, oscNode, gainNode, filterNode, finish, crushCurve, driveCurve, rand, randInt, chance } from './synth.js';
import { mtof } from './theory.js';

function gunshot(ctx, { out, verb }, t, { power = 1, tail = 0.4, crackFreq = 1000 } = {}) {
  noise(ctx, out, t, { type: 'highpass', freq: crackFreq, dur: 0.05, a: 0.0005, gain: 0.9 * power });
  noise(ctx, out, t, { type: 'lowpass', freq: 2600 + 900 * power, freqEnd: 350, q: 0.7, dur: 0.16 + 0.12 * power, a: 0.001, gain: 0.7 * power });
  tone(ctx, out, t, { freq: 160, freqEnd: 42, glide: 0.08, env: 'perc', a: 0.001, dur: 0.1 + 0.08 * power, gain: 0.8 * power });
  return noise(ctx, verb, t, { type: 'lowpass', freq: 1600, dur: tail, a: 0.002, gain: 0.45 * power });
}

export const SFX = {
  dice(ctx, { out }, t) {
    const n = randInt(8, 14);
    let tt = t;
    for (let i = 0; i < n; i++) {
      const fade = 1 - (i / n) * 0.6;
      noise(ctx, out, tt, { freq: rand(2500, 5200), q: 2.5, dur: rand(0.008, 0.02), a: 0.0005, gain: rand(0.15, 0.35) * fade, pan: rand(-0.4, 0.4) });
      tone(ctx, out, tt, { freq: rand(1800, 3200), env: 'perc', dur: 0.015, a: 0.0005, gain: 0.05 * fade });
      tt += i < 4 ? rand(0.03, 0.06) : rand(0.04, 0.11) * (1 + (i - 4) * 0.12);
    }
    return noise(ctx, out, tt, { type: 'lowpass', freq: 600, dur: 0.05, gain: 0.12 });
  },

  'door-open'(ctx, { out, verb }, t) {
    noise(ctx, out, t, { freq: 3000, q: 2, dur: 0.015, gain: 0.3 });
    metal(ctx, out, t, { freq: 900, ratios: [1, 2.4], decay: 0.08, gain: 0.07 });
    noise(ctx, out, t + 0.08, { freq: 1200, freqEnd: 3500, q: 0.8, env: 'swell', a: 0.1, hold: 0.25, r: 0.35, gain: 0.18 });
    tone(ctx, out, t + 0.08, { type: 'sawtooth', freq: 110, freqEnd: 160, glide: 0.5, cutoff: 600, a: 0.05, d: 0.1, s: 1, dur: 0.5, r: 0.2, gain: 0.05 });
    return noise(ctx, verb, t + 0.75, { type: 'lowpass', freq: 300, dur: 0.08, gain: 0.25 });
  },

  'door-close'(ctx, { out, verb }, t) {
    noise(ctx, out, t, { freq: 3500, freqEnd: 1000, q: 0.8, env: 'swell', a: 0.1, hold: 0.2, r: 0.3, gain: 0.16 });
    tone(ctx, out, t, { type: 'sawtooth', freq: 160, freqEnd: 110, glide: 0.5, cutoff: 600, a: 0.05, d: 0.1, s: 1, dur: 0.45, r: 0.15, gain: 0.05 });
    kick(ctx, out, t + 0.6, { gain: 0.5, f0: 120, f1: 50, decay: 0.25, click: 0 });
    noise(ctx, verb, t + 0.6, { type: 'lowpass', freq: 800, dur: 0.12, gain: 0.35 });
    return noise(ctx, out, t + 0.68, { freq: 3200, q: 2, dur: 0.015, gain: 0.25 });
  },

  'door-locked'(ctx, { out, verb }, t) {
    for (let i = 0; i < 4; i++) {
      const tt = t + i * rand(0.08, 0.11);
      metal(ctx, out, tt, { freq: rand(600, 900), ratios: [1, 2.4, 3.9], decay: 0.08, gain: 0.08 });
      noise(ctx, out, tt, { freq: 2000, q: 1.5, dur: 0.03, gain: 0.15 });
    }
    noise(ctx, verb, t + 0.45, { type: 'lowpass', freq: 400, dur: 0.07, gain: 0.3 });
    tone(ctx, out, t + 0.45, { freq: 90, freqEnd: 60, glide: 0.1, env: 'perc', dur: 0.12, gain: 0.25 });
    tone(ctx, out, t + 0.65, { type: 'square', freq: 520, dur: 0.12, a: 0.003, d: 0.01, s: 1, r: 0.02, cutoff: 2000, gain: 0.05 });
    return tone(ctx, out, t + 0.82, { type: 'square', freq: 390, dur: 0.2, a: 0.003, d: 0.01, s: 1, r: 0.03, cutoff: 2000, gain: 0.05 });
  },

  'gunshot-pistol'(ctx, o, t) {
    noise(ctx, o.out, t + 0.09, { freq: 4000, q: 2, dur: 0.01, gain: 0.08 });
    return gunshot(ctx, o, t, { power: 0.8, tail: 0.4 });
  },

  'gunshot-rifle'(ctx, o, t) {
    noise(ctx, o.verb, t + 0.18, { type: 'lowpass', freq: 800, dur: 0.25, gain: 0.15 });
    return gunshot(ctx, o, t, { power: 1.2, tail: 0.8, crackFreq: 1500 });
  },

  'gunshot-auto'(ctx, o, t) {
    const n = randInt(6, 9);
    let tt = t;
    for (let i = 0; i < n; i++) {
      gunshot(ctx, o, tt, { power: rand(0.75, 0.95), tail: 0.15, crackFreq: rand(1100, 1500) });
      tt += rand(0.068, 0.083);
    }
    noise(ctx, o.verb, tt, { type: 'lowpass', freq: 1200, dur: 0.9, gain: 0.35 });
    let end = tt + 0.9;
    for (let i = 0; i < randInt(3, 6); i++) {
      end = Math.max(end, metal(ctx, o.out, t + 0.3 + rand(0, 1.2), { freq: rand(3500, 5500), ratios: [1, 2.7], decay: 0.15, gain: 0.025, pan: rand(-0.6, 0.6) }));
    }
    return end;
  },

  explosion(ctx, { out, verb }, t) {
    const shaper = ctx.createWaveShaper();
    shaper.curve = driveCurve(ctx, 3);
    const pre = gainNode(ctx, 1);
    pre.connect(shaper);
    shaper.connect(out);
    tone(ctx, pre, t, { freq: 70, freqEnd: 24, glide: 1.2, env: 'perc', a: 0.005, dur: 1.8, gain: 0.9 });
    noise(ctx, pre, t, { type: 'lowpass', freq: 4000, freqEnd: 150, q: 0.7, dur: 2.2, a: 0.004, gain: 0.9 });
    noise(ctx, verb, t, { type: 'lowpass', freq: 2500, freqEnd: 200, q: 0.7, dur: 1.5, a: 0.004, gain: 0.6 });
    noise(ctx, out, t + 0.05, { color: 'brown', type: 'lowpass', freq: 220, q: 0.7, env: 'swell', a: 0.05, hold: 0.5, r: 2.5, gain: 0.9 });
    for (let i = 0; i < randInt(10, 22); i++) noise(ctx, verb, t + rand(0.2, 2.2), { freq: rand(1500, 5000), q: 1.5, dur: 0.02, gain: rand(0.05, 0.2), pan: rand(-0.9, 0.9) });
    const end = t + 3.2;
    setTimeout(() => {
      try {
        pre.disconnect();
        shaper.disconnect();
      } catch {}
    }, (end - ctx.currentTime) * 1000 + 300);
    return end;
  },

  'hit-melee'(ctx, { out }, t) {
    noise(ctx, out, t, { freq: 600, freqEnd: 1800, q: 1.5, env: 'swell', a: 0.1, hold: 0, r: 0.06, gain: 0.15 });
    tone(ctx, out, t + 0.13, { freq: 160, freqEnd: 55, glide: 0.1, env: 'perc', dur: 0.15, gain: 0.8 });
    noise(ctx, out, t + 0.13, { type: 'lowpass', freq: 1800, dur: 0.07, gain: 0.5 });
    return noise(ctx, out, t + 0.13, { freq: 1000, q: 1, dur: 0.04, gain: 0.3 });
  },

  'glass-break'(ctx, { out, verb }, t) {
    noise(ctx, out, t, { type: 'highpass', freq: 2500, dur: 0.08, gain: 0.5 });
    metal(ctx, out, t, { freq: 1800, ratios: [1, 2.3, 3.6, 5.1], decay: 0.3, gain: 0.12 });
    let end = t + 0.4;
    for (let i = 0; i < randInt(14, 24); i++) {
      const tt = t + 0.02 + Math.pow(Math.random(), 1.5) * 0.9;
      end = Math.max(end, metal(ctx, chance(0.4) ? verb : out, tt, { freq: rand(2500, 7000), ratios: [1, 2.2, 3.9], decay: rand(0.1, 0.4), gain: rand(0.02, 0.08), pan: rand(-0.8, 0.8) }));
      noise(ctx, out, tt, { type: 'highpass', freq: 6000, dur: 0.03, gain: 0.04 });
    }
    return end;
  },

  alarm(ctx, { out }, t) {
    const dur = 3;
    const o1 = oscNode(ctx, 'square', 960);
    const o2 = oscNode(ctx, 'sawtooth', 960, 7);
    const f = filterNode(ctx, 'lowpass', 3000, 0.7);
    const g = gainNode(ctx, 0);
    o1.connect(f);
    o2.connect(f);
    f.connect(g);
    g.connect(out);
    for (let k = 0; k * 0.3 < dur; k++) {
      const fr = k % 2 ? 770 : 960;
      o1.frequency.setValueAtTime(fr, t + k * 0.3);
      o2.frequency.setValueAtTime(fr, t + k * 0.3);
    }
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.09, t + 0.04);
    g.gain.setValueAtTime(0.09, t + dur - 0.15);
    g.gain.linearRampToValueAtTime(0, t + dur);
    o1.start(t);
    o2.start(t);
    finish([o1, o2], [o1, o2, f, g], t + dur + 0.02);
    return t + dur;
  },

  footsteps(ctx, { out }, t) {
    const n = randInt(4, 6);
    let tt = t;
    for (let i = 0; i < n; i++) {
      const pan = i % 2 ? 0.15 : -0.15;
      const g = 0.6 + (i / n) * 0.4;
      noise(ctx, out, tt, { type: 'lowpass', freq: 400, dur: 0.06, gain: 0.35 * g * rand(0.85, 1.1), pan });
      noise(ctx, out, tt + 0.03, { freq: 1800, q: 1, dur: 0.05, gain: 0.08 * g, pan });
      tt += rand(0.46, 0.56);
    }
    return tt;
  },

  notify(ctx, { out, verb }, t) {
    fm(ctx, out, t, { freq: mtof(88), ratio: 2, index: 1, dur: 0.8, gain: 0.12, a: 0.004 });
    fm(ctx, verb, t, { freq: mtof(88), ratio: 2, index: 1, dur: 0.8, gain: 0.05, a: 0.004 });
    return fm(ctx, out, t + 0.12, { freq: mtof(95), ratio: 2, index: 1, dur: 1, gain: 0.1, a: 0.004 });
  },

  'matrix-glitch'(ctx, { out }, t) {
    const crusher = ctx.createWaveShaper();
    crusher.curve = crushCurve(ctx, 4);
    const post = gainNode(ctx, 0.12);
    crusher.connect(post);
    post.connect(out);
    let tt = t;
    for (let i = 0; i < randInt(10, 18); i++) {
      tone(ctx, crusher, tt, { type: 'square', freq: rand(200, 3000), env: 'perc', dur: 0.025, a: 0.001, gain: 0.7, pan: rand(-0.7, 0.7) });
      if (chance(0.3)) noise(ctx, crusher, tt, { type: 'highpass', freq: 3000, dur: 0.02, gain: 0.6 });
      tt += rand(0.02, 0.04);
    }
    tone(ctx, out, t, { type: 'sawtooth', freq: 2000, freqEnd: 80, glide: 0.3, env: 'perc', dur: 0.3, cutoff: 3000, gain: 0.05 });
    const end = Math.max(tt, t + 0.35);
    setTimeout(() => {
      try {
        crusher.disconnect();
        post.disconnect();
      } catch {}
    }, (end - ctx.currentTime) * 1000 + 300);
    return end;
  },

  'spell-cast'(ctx, { out, verb }, t) {
    [72, 76, 79, 83, 86, 90].forEach((m, i) => {
      tone(ctx, verb, t + i * 0.07, { freq: mtof(m), a: 0.3, d: 0.1, s: 1, dur: 0.8, r: 0.6, gain: 0.035, vibrato: { rate: 6, depth: 20, delay: 0.1 } });
    });
    noise(ctx, out, t, { freq: 400, freqEnd: 4000, q: 2, env: 'swell', a: 0.6, hold: 0.1, r: 0.6, gain: 0.12 });
    return tone(ctx, verb, t, { type: 'triangle', freq: mtof(48), a: 0.4, d: 0.1, s: 1, dur: 0.6, r: 0.6, gain: 0.09 });
  },

  heal(ctx, { out, verb }, t) {
    [72, 76, 79, 84].forEach((m, i) => tone(ctx, out, t + i * 0.09, { type: 'triangle', freq: mtof(m), a: 0.02, d: 0.1, s: 0.7, dur: 0.4, r: 0.5, gain: 0.07 }));
    for (let i = 0; i < 6; i++) fm(ctx, verb, t + 0.2 + rand(0, 0.7), { freq: mtof(88 + [0, 4, 7, 12][randInt(0, 3)]), ratio: 3.5, index: 1, dur: 0.6, gain: 0.02, pan: rand(-0.6, 0.6) });
    return pad(ctx, verb, t, { freqs: [60, 64, 67].map(mtof), type: 'triangle', a: 0.2, dur: 0.6, r: 0.8, cutoff: 2500, gain: 0.1 });
  },

  death(ctx, { out, verb }, t) {
    tone(ctx, out, t, { freq: 65, freqEnd: 28, glide: 2, env: 'perc', a: 0.01, dur: 2.4, gain: 0.8 });
    noise(ctx, out, t, { color: 'brown', type: 'lowpass', freq: 180, q: 0.7, env: 'swell', a: 0.02, hold: 0.3, r: 2, gain: 0.6 });
    pad(ctx, verb, t, { freqs: [45, 46, 52].map(mtof), a: 0.3, dur: 1.5, r: 2, cutoff: 500, gain: 0.12 });
    return fm(ctx, verb, t + 0.1, { freq: 110, ratio: 1.4, index: 3, indexDecay: 1.5, dur: 4, gain: 0.12 });
  },

  cash(ctx, { out, verb }, t) {
    noise(ctx, out, t, { type: 'lowpass', freq: 1000, env: 'swell', a: 0.02, hold: 0.1, r: 0.15, gain: 0.12 });
    fm(ctx, out, t + 0.12, { freq: mtof(96), ratio: 2.01, index: 1.2, dur: 1, gain: 0.1 });
    fm(ctx, verb, t + 0.18, { freq: mtof(100), ratio: 2.01, index: 1.2, dur: 1.1, gain: 0.08 });
    let end = t + 1.3;
    for (let i = 0; i < randInt(6, 10); i++) {
      end = Math.max(end, metal(ctx, out, t + 0.15 + rand(0, 0.5), { freq: rand(2800, 4800), ratios: [1, 2.3, 3.4, 4.9], decay: rand(0.15, 0.35), gain: rand(0.03, 0.07), pan: rand(-0.5, 0.5) }));
    }
    return end;
  },

  'level-up'(ctx, { out, verb }, t) {
    [72, 76, 79, 84, 88, 91].forEach((m, i) => tone(ctx, out, t + i * 0.065, { type: 'square', freq: mtof(m), env: 'perc', dur: 0.15, cutoff: 4000, gain: 0.07 }));
    [84, 88, 91, 96].forEach((m) => tone(ctx, verb, t + 0.42, { type: 'triangle', freq: mtof(m), a: 0.01, d: 0.1, s: 0.8, dur: 0.5, r: 0.6, gain: 0.05 }));
    for (let i = 0; i < 4; i++) fm(ctx, verb, t + 0.45 + i * 0.08, { freq: mtof(96 + i * 2), ratio: 3.5, index: 1, dur: 0.5, gain: 0.015 });
    return t + 1.6;
  },

  ping(ctx, { out, verb }, t) {
    tone(ctx, out, t, { freq: 1200, freqEnd: 1800, glide: 0.04, env: 'perc', dur: 0.18, gain: 0.16 });
    tone(ctx, verb, t, { freq: 1200, freqEnd: 1800, glide: 0.04, env: 'perc', dur: 0.18, gain: 0.06 });
    return tone(ctx, out, t + 0.18, { freq: 1800, env: 'perc', dur: 0.15, gain: 0.05 });
  },
};
