// Web Audio building blocks for the procedural ambiences, music and sound effects.
// Conventions:
//  - "voices" (tone, noise, kick…) are one-shot: they schedule their own start/stop at time `t`
//    and disconnect every node they created once their sources have ended. They return their end time.
//  - a "rig" groups the long-running parts of a generator (looping noise, drones, LFOs, schedulers)
//    behind one output gain and stops/cleans everything with rig.stop(fadeSeconds).
import { clamp, rand, runSchedule } from './theory.js';

export { rand, chance, pick, randInt } from './theory.js';

const SILENT = 0.0001;
const LOOKAHEAD = 0.45; // seconds scheduled in advance
const TICK_MS = 90;

// ---------------------------------------------------------------------------
// Per-context caches (noise buffers, impulse responses, shaper curves)
// ---------------------------------------------------------------------------
const caches = new WeakMap();
function cacheOf(ctx) {
  let c = caches.get(ctx);
  if (!c) {
    c = { noise: {}, impulse: {}, curve: {} };
    caches.set(ctx, c);
  }
  return c;
}

/** Stereo noise buffer ('white' | 'pink' | 'brown'), seamlessly loopable. */
export function noiseBuffer(ctx, color = 'white', seconds = 6) {
  const c = cacheOf(ctx);
  const key = color + ':' + seconds;
  if (c.noise[key]) return c.noise[key];
  const len = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    if (color === 'pink') {
      let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
      for (let i = 0; i < len; i++) {
        const w = Math.random() * 2 - 1;
        b0 = 0.99886 * b0 + w * 0.0555179;
        b1 = 0.99332 * b1 + w * 0.0750759;
        b2 = 0.969 * b2 + w * 0.153852;
        b3 = 0.8665 * b3 + w * 0.3104856;
        b4 = 0.55 * b4 + w * 0.5329522;
        b5 = -0.7616 * b5 - w * 0.016898;
        d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
        b6 = w * 0.115926;
      }
    } else if (color === 'brown') {
      let last = 0;
      for (let i = 0; i < len; i++) {
        const w = Math.random() * 2 - 1;
        last = (last + 0.02 * w) / 1.02;
        d[i] = last * 3.5;
      }
    } else {
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    }
    // Blend the tail into the head so the loop point doesn't click.
    const n = Math.min(Math.floor(ctx.sampleRate * 0.05), Math.floor(len / 4));
    for (let i = 0; i < n; i++) {
      const w = i / n;
      d[len - n + i] = d[len - n + i] * (1 - w) + d[i] * w;
    }
  }
  c.noise[key] = buf;
  return buf;
}

/** Synthetic reverb impulse response (decaying stereo noise). */
export function impulse(ctx, seconds = 2.5, decay = 3) {
  const c = cacheOf(ctx);
  const key = seconds + ':' + decay;
  if (c.impulse[key]) return c.impulse[key];
  const len = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
  }
  c.impulse[key] = buf;
  return buf;
}

/** Soft-clipping curve for WaveShaperNode. */
export function driveCurve(ctx, amount = 2) {
  const c = cacheOf(ctx);
  if (c.curve[amount]) return c.curve[amount];
  const n = 1024;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * amount) / Math.tanh(amount);
  }
  c.curve[amount] = curve;
  return curve;
}

/** Staircase curve (bit-crush look-alike) for WaveShaperNode. */
export function crushCurve(ctx, steps = 6) {
  const c = cacheOf(ctx);
  const key = 'crush' + steps;
  if (c.curve[key]) return c.curve[key];
  const n = 1024;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.round(x * steps) / steps;
  }
  c.curve[key] = curve;
  return curve;
}

// ---------------------------------------------------------------------------
// Node helpers
// ---------------------------------------------------------------------------
export function gainNode(ctx, v = 1) {
  const g = ctx.createGain();
  g.gain.value = v;
  return g;
}

export function filterNode(ctx, type = 'lowpass', freq = 1000, q = 0.7) {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = clamp(freq, 10, ctx.sampleRate / 2 - 100);
  f.Q.value = q;
  return f;
}

/** Stereo panner, or a plain gain on browsers without StereoPannerNode. */
export function panner(ctx, pan = 0) {
  if (typeof ctx.createStereoPanner === 'function') {
    const p = ctx.createStereoPanner();
    p.pan.value = clamp(pan, -1, 1);
    return p;
  }
  return ctx.createGain();
}

export function oscNode(ctx, type, freq, detune = 0) {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.value = clamp(freq, 1, ctx.sampleRate / 2 - 100);
  o.detune.value = detune;
  return o;
}

function noiseSrc(ctx, color, dur) {
  const s = ctx.createBufferSource();
  s.buffer = noiseBuffer(ctx, color);
  const maxOffset = Math.max(0, s.buffer.duration - dur - 0.05);
  s._offset = Math.random() * maxOffset;
  return s;
}

/** Stop every source at stopAt and disconnect all nodes once they have all ended. */
export function finish(sources, nodes, stopAt) {
  let remaining = sources.length;
  const cleanup = () => {
    for (const n of nodes) {
      try {
        n.disconnect();
      } catch {}
    }
  };
  for (const s of sources) {
    s.onended = () => {
      if (--remaining <= 0) cleanup();
    };
    try {
      s.stop(stopAt);
    } catch {
      if (--remaining <= 0) cleanup();
    }
  }
}

/** Chain nodes a -> b -> c…; returns the first. */
function chain(...nodes) {
  for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]);
  return nodes[0];
}

// ---------------------------------------------------------------------------
// Envelopes
// ---------------------------------------------------------------------------
/** Percussive: silence -> peak in `a`, exponential decay to silence over `d`. Returns end time. */
export function perc(param, t, peak, a = 0.003, d = 0.2) {
  const p = Math.max(SILENT * 2, peak);
  param.setValueAtTime(0, t);
  param.linearRampToValueAtTime(p, t + a);
  param.exponentialRampToValueAtTime(SILENT, t + a + d);
  param.setValueAtTime(0, t + a + d + 0.001);
  return t + a + d;
}

/** ADSR: attack a, decay d to s×peak, hold until t+dur, release r. Returns end time. */
export function adsr(param, t, dur, { peak = 1, a = 0.01, d = 0.1, s = 0.7, r = 0.2 } = {}) {
  const sus = Math.max(SILENT, peak * s);
  param.setValueAtTime(0, t);
  param.linearRampToValueAtTime(peak, t + a);
  param.setTargetAtTime(sus, t + a, Math.max(0.001, d / 3));
  const rel = t + Math.max(dur, a + 0.001);
  param.setTargetAtTime(0, rel, Math.max(0.001, r / 5));
  return rel + r * 1.1;
}

/** Linear swell in and out (for whooshes, sirens, wind gusts). Returns end time. */
export function swell(param, t, peak, a, hold, r) {
  param.setValueAtTime(0, t);
  param.linearRampToValueAtTime(peak, t + a);
  param.setValueAtTime(peak, t + a + hold);
  param.linearRampToValueAtTime(0, t + a + hold + r);
  return t + a + hold + r;
}

// ---------------------------------------------------------------------------
// One-shot voices
// ---------------------------------------------------------------------------
/**
 * Oscillator voice.
 * opts: freq, freqEnd (glide over `glide` s), type, dur, gain, env ('adsr'|'perc'), a, d, s, r,
 *       cutoff/q (lowpass) with filterEnv { from, to, time }, pan, voices (unison), spread (cents),
 *       vibrato { rate, depth (cents), delay }
 */
export function tone(ctx, dest, t, o = {}) {
  const {
    freq = 440, freqEnd, glide, type = 'sine', dur = 0.3, gain = 0.2, env = 'adsr',
    a = 0.005, d = 0.1, s = 0.7, r = 0.15, cutoff, q = 0.7, filterEnv, filterType = 'lowpass',
    pan, voices = 1, spread = 10, vibrato, detune = 0,
  } = o;
  const nodes = [];
  const sources = [];
  const g = gainNode(ctx, 0);
  nodes.push(g);
  let last = g;
  if (cutoff || filterEnv) {
    const f = filterNode(ctx, filterType, cutoff || filterEnv.from, q);
    if (filterEnv) {
      f.frequency.setValueAtTime(clamp(filterEnv.from, 20, 20000), t);
      f.frequency.exponentialRampToValueAtTime(clamp(filterEnv.to, 20, 20000), t + Math.max(0.01, filterEnv.time || dur));
    }
    g.connect(f);
    nodes.push(f);
    last = f;
  }
  if (pan) {
    const p = panner(ctx, pan);
    last.connect(p);
    nodes.push(p);
    last = p;
  }
  last.connect(dest);
  let vib = null;
  if (vibrato) {
    const lfo = oscNode(ctx, 'sine', vibrato.rate || 5);
    const lg = gainNode(ctx, 0);
    lfo.connect(lg);
    lg.gain.setValueAtTime(0, t);
    lg.gain.linearRampToValueAtTime(vibrato.depth || 15, t + (vibrato.delay || 0.2));
    lfo.start(t);
    sources.push(lfo);
    nodes.push(lfo, lg);
    vib = lg;
  }
  const n = Math.max(1, voices | 0);
  for (let i = 0; i < n; i++) {
    const det = detune + (n > 1 ? (i / (n - 1) - 0.5) * 2 * spread : 0);
    const osc = oscNode(ctx, type, freq, det);
    if (freqEnd) {
      osc.frequency.setValueAtTime(freq, t);
      osc.frequency.exponentialRampToValueAtTime(Math.max(1, freqEnd), t + Math.max(0.005, glide || dur));
    }
    if (vib) vib.connect(osc.detune);
    osc.connect(g);
    osc.start(t);
    sources.push(osc);
    nodes.push(osc);
  }
  const peak = gain / Math.sqrt(n);
  const end = env === 'perc' ? perc(g.gain, t, peak, a, dur) : adsr(g.gain, t, dur, { peak, a, d, s, r });
  finish(sources, nodes, end + 0.03);
  return end;
}

/**
 * Filtered noise voice.
 * opts: color, dur, gain, env ('perc'|'adsr'|'swell'), a, r, hold, type (filter), freq, freqEnd, q,
 *       highpass (extra HPF freq), pan, panEnd, rate (playbackRate)
 */
export function noise(ctx, dest, t, o = {}) {
  const {
    color = 'white', dur = 0.2, gain = 0.3, env = 'perc', a = 0.002, r = 0.1, hold = 0,
    type = 'bandpass', freq = 1000, freqEnd, q = 1, highpass, pan, panEnd, rate = 1,
  } = o;
  const nodes = [];
  const total = env === 'swell' ? a + hold + r : env === 'adsr' ? dur + r : a + dur;
  const src = noiseSrc(ctx, color, total + 0.1);
  src.playbackRate.value = rate;
  const f = filterNode(ctx, type, freq, q);
  if (freqEnd) {
    f.frequency.setValueAtTime(clamp(freq, 20, 20000), t);
    f.frequency.exponentialRampToValueAtTime(clamp(freqEnd, 20, 20000), t + Math.max(0.01, total));
  }
  const g = gainNode(ctx, 0);
  nodes.push(src, f, g);
  let last = g;
  src.connect(f);
  if (highpass) {
    const hp = filterNode(ctx, 'highpass', highpass, 0.7);
    f.connect(hp);
    hp.connect(g);
    nodes.push(hp);
  } else f.connect(g);
  if (pan != null) {
    const p = panner(ctx, pan);
    if (panEnd != null && p.pan) {
      p.pan.setValueAtTime(clamp(pan, -1, 1), t);
      p.pan.linearRampToValueAtTime(clamp(panEnd, -1, 1), t + total);
    }
    g.connect(p);
    nodes.push(p);
    last = p;
  }
  last.connect(dest);
  let end;
  if (env === 'swell') end = swell(g.gain, t, gain, a, hold, r);
  else if (env === 'adsr') end = adsr(g.gain, t, dur, { peak: gain, a, d: 0.05, s: 1, r });
  else end = perc(g.gain, t, gain, a, dur);
  src.start(t, src._offset);
  finish([src], nodes, end + 0.03);
  return end;
}

/** Inharmonic metallic partials (clanks, coins, glass, bells without FM). */
export function metal(ctx, dest, t, { freq = 400, ratios = [1, 2.76, 5.4, 8.93], decay = 0.6, gain = 0.2, pan, a = 0.001, type = 'sine' } = {}) {
  const nodes = [];
  const sources = [];
  const out = gainNode(ctx, 1);
  nodes.push(out);
  if (pan != null) {
    const p = panner(ctx, pan);
    out.connect(p);
    p.connect(dest);
    nodes.push(p);
  } else out.connect(dest);
  let end = t;
  ratios.forEach((ratio, i) => {
    const f = freq * ratio;
    if (f > ctx.sampleRate / 2 - 200) return;
    const o = oscNode(ctx, type, f);
    const g = gainNode(ctx, 0);
    o.connect(g);
    g.connect(out);
    const e = perc(g.gain, t, gain / (1 + i * 0.6), a, decay / (1 + i * 0.35));
    end = Math.max(end, e);
    o.start(t);
    sources.push(o);
    nodes.push(o, g);
  });
  if (!sources.length) return t;
  finish(sources, nodes, end + 0.03);
  return end;
}

/**
 * Two-operator FM voice (electric piano, bells, vibraphone).
 * ratio: modulator/carrier, index: modulation depth (× freq), indexDecay: how fast the brightness fades.
 */
export function fm(ctx, dest, t, o = {}) {
  const { freq = 440, ratio = 1, index = 1.5, indexDecay = 0.4, dur = 1, gain = 0.2, a = 0.005, env = 'perc', s = 0.4, r = 0.4, pan, tremolo, detune = 0 } = o;
  const nodes = [];
  const sources = [];
  const car = oscNode(ctx, 'sine', freq, detune);
  const mod = oscNode(ctx, 'sine', freq * ratio);
  const mg = gainNode(ctx, 0);
  mod.connect(mg);
  mg.connect(car.frequency);
  mg.gain.setValueAtTime(index * freq, t);
  mg.gain.setTargetAtTime(index * freq * 0.08, t + 0.005, Math.max(0.01, indexDecay / 3));
  const g = gainNode(ctx, 0);
  car.connect(g);
  nodes.push(car, mod, mg, g);
  let last = g;
  if (tremolo) {
    const tg = gainNode(ctx, 1 - (tremolo.depth || 0.3) / 2);
    const lfo = oscNode(ctx, 'sine', tremolo.rate || 5);
    const lg = gainNode(ctx, (tremolo.depth || 0.3) / 2);
    lfo.connect(lg);
    lg.connect(tg.gain);
    g.connect(tg);
    lfo.start(t);
    sources.push(lfo);
    nodes.push(tg, lfo, lg);
    last = tg;
  }
  if (pan != null) {
    const p = panner(ctx, pan);
    last.connect(p);
    nodes.push(p);
    last = p;
  }
  last.connect(dest);
  const end = env === 'adsr' ? adsr(g.gain, t, dur, { peak: gain, a, d: dur * 0.5, s, r }) : perc(g.gain, t, gain, a, dur);
  car.start(t);
  mod.start(t);
  sources.push(car, mod);
  finish(sources, nodes, end + 0.03);
  return end;
}

/** Chord pad: detuned oscillators per note through a shared lowpass with a slow filter opening. */
export function pad(ctx, dest, t, { freqs = [220], dur = 4, gain = 0.1, a = 1.2, r = 1.5, type = 'sawtooth', cutoff = 1200, q = 0.8, detune = 8, pan } = {}) {
  const nodes = [];
  const sources = [];
  const f = filterNode(ctx, 'lowpass', cutoff * 0.5, q);
  f.frequency.setValueAtTime(cutoff * 0.5, t);
  f.frequency.linearRampToValueAtTime(cutoff, t + a + dur * 0.3);
  f.frequency.linearRampToValueAtTime(cutoff * 0.7, t + dur + r);
  const g = gainNode(ctx, 0);
  f.connect(g);
  nodes.push(f, g);
  let last = g;
  if (pan != null) {
    const p = panner(ctx, pan);
    g.connect(p);
    nodes.push(p);
    last = p;
  }
  last.connect(dest);
  const per = gain / Math.sqrt(freqs.length * 2);
  for (const fr of freqs) {
    for (const det of [-detune, detune]) {
      const o = oscNode(ctx, type, fr, det + rand(-2, 2));
      const og = gainNode(ctx, per);
      o.connect(og);
      og.connect(f);
      o.start(t);
      sources.push(o);
      nodes.push(o, og);
    }
  }
  const end = adsr(g.gain, t, dur, { peak: 1, a, d: 0.01, s: 1, r });
  finish(sources, nodes, end + 0.03);
  return end;
}

// ---------------------------------------------------------------------------
// Drums
// ---------------------------------------------------------------------------
export function kick(ctx, dest, t, { gain = 0.8, f0 = 150, f1 = 46, decay = 0.38, click = 0.25 } = {}) {
  const o = oscNode(ctx, 'sine', f0);
  const g = gainNode(ctx, 0);
  o.frequency.setValueAtTime(f0, t);
  o.frequency.exponentialRampToValueAtTime(f1, t + 0.09);
  o.connect(g);
  g.connect(dest);
  const end = perc(g.gain, t, gain, 0.002, decay);
  o.start(t);
  finish([o], [o, g], end + 0.02);
  if (click > 0) noise(ctx, dest, t, { type: 'highpass', freq: 1800, dur: 0.012, gain: gain * click, a: 0.0005 });
  return end;
}

export function snare(ctx, dest, t, { gain = 0.5, tone: body = 185, decay = 0.18, brush = false } = {}) {
  if (brush) return noise(ctx, dest, t, { type: 'bandpass', freq: 3500, q: 0.6, dur: decay * 1.4, a: 0.012, gain: gain * 0.6, color: 'white' });
  noise(ctx, dest, t, { type: 'highpass', freq: 1200, q: 0.5, dur: decay, gain: gain * 0.8 });
  return tone(ctx, dest, t, { type: 'triangle', freq: body, freqEnd: body * 0.75, glide: 0.08, env: 'perc', dur: 0.09, a: 0.001, gain: gain * 0.7 });
}

export function hat(ctx, dest, t, { gain = 0.15, open = false, pan } = {}) {
  return noise(ctx, dest, t, { type: 'highpass', freq: 7500, q: 0.8, dur: open ? 0.28 : 0.045, gain, a: 0.001, pan });
}

export function clap(ctx, dest, t, { gain = 0.4 } = {}) {
  for (let i = 0; i < 3; i++) noise(ctx, dest, t + i * 0.011, { type: 'bandpass', freq: 1300, q: 1.2, dur: 0.02, gain: gain * 0.7 });
  return noise(ctx, dest, t + 0.033, { type: 'bandpass', freq: 1200, q: 1, dur: 0.16, gain });
}

export function tom(ctx, dest, t, { gain = 0.5, freq = 140, pan } = {}) {
  return tone(ctx, dest, t, { type: 'sine', freq, freqEnd: freq * 0.6, glide: 0.2, env: 'perc', dur: 0.3, a: 0.002, gain, pan });
}

// ---------------------------------------------------------------------------
// Rig: lifetime manager for long-running generators
// ---------------------------------------------------------------------------
/**
 * Create a rig whose output fades in over `fadeIn` seconds into `destination`.
 * Everything long-running (loops, oscillators, LFOs, schedulers) must go through the rig so that
 * rig.stop(fade) can fade out, stop and disconnect it all.
 */
export function createRig(ctx, destination, { fadeIn = 1.5, level = 1 } = {}) {
  const t0 = ctx.currentTime;
  const out = ctx.createGain();
  out.gain.setValueAtTime(0, t0);
  out.gain.linearRampToValueAtTime(level, t0 + Math.max(0.02, fadeIn));
  out.connect(destination);
  const sources = new Set();
  const nodes = new Set([out]);
  let scheds = [];
  let timer = null;
  let alive = true;
  let errorLogged = false;

  const tick = () => {
    if (!alive || ctx.state !== 'running') return;
    scheds = runSchedule(scheds, ctx.currentTime, LOOKAHEAD, 0.8, (err) => {
      if (!errorLogged) console.warn('[audio] generator error', err);
      errorLogged = true;
    });
  };

  const rig = {
    ctx,
    out,
    get alive() {
      return alive;
    },
    /** Register a node so that it is disconnected on stop. */
    keep(node) {
      nodes.add(node);
      return node;
    },
    gain(v = 1, dest = out) {
      const g = gainNode(ctx, v);
      g.connect(dest);
      nodes.add(g);
      return g;
    },
    filter(type, freq, q = 0.7, dest = out) {
      const f = filterNode(ctx, type, freq, q);
      f.connect(dest);
      nodes.add(f);
      return f;
    },
    pan(p, dest = out) {
      const n = panner(ctx, p);
      n.connect(dest);
      nodes.add(n);
      return n;
    },
    /** Reverb send: returns the input node. */
    reverb({ seconds = 2.5, decay = 3, wet = 0.35, dest = out } = {}) {
      const conv = ctx.createConvolver();
      conv.buffer = impulse(ctx, seconds, decay);
      const send = gainNode(ctx, 1);
      const wetG = gainNode(ctx, wet);
      chain(send, conv, wetG, dest);
      nodes.add(send).add(conv).add(wetG);
      return send;
    },
    /** Feedback delay (echo) send: returns the input node. */
    delay({ time = 0.33, feedback = 0.4, tone: lp = 2600, wet = 0.35, dest = out } = {}) {
      const input = gainNode(ctx, 1);
      const dl = ctx.createDelay(4);
      dl.delayTime.value = clamp(time, 0.01, 3.9);
      const f = filterNode(ctx, 'lowpass', lp, 0.5);
      const fb = gainNode(ctx, clamp(feedback, 0, 0.9));
      const wetG = gainNode(ctx, wet);
      input.connect(dl);
      dl.connect(f);
      f.connect(fb);
      fb.connect(dl);
      f.connect(wetG);
      wetG.connect(dest);
      for (const n of [input, dl, f, fb, wetG]) nodes.add(n);
      return input;
    },
    /** Looping noise into `dest`; returns its gain node (automate .gain). */
    loopNoise(color, dest = out, { gain = 1, rate = 1 } = {}) {
      const src = ctx.createBufferSource();
      src.buffer = noiseBuffer(ctx, color);
      src.loop = true;
      src.playbackRate.value = rate;
      const g = gainNode(ctx, gain);
      src.connect(g);
      g.connect(dest);
      src.start(ctx.currentTime, Math.random() * src.buffer.duration * 0.9);
      sources.add(src);
      nodes.add(src).add(g);
      return g;
    },
    /** Continuous oscillator into `dest`; returns { osc, gain }. */
    osc(type, freq, dest = out, { gain = 1, detune = 0 } = {}) {
      const o = oscNode(ctx, type, freq, detune);
      const g = gainNode(ctx, gain);
      o.connect(g);
      g.connect(dest);
      o.start();
      sources.add(o);
      nodes.add(o).add(g);
      return { osc: o, gain: g };
    },
    /** LFO added to an AudioParam (param value + depth × wave). */
    lfo(param, { rate = 0.1, depth = 1, type = 'sine' } = {}) {
      const o = oscNode(ctx, type, rate);
      const g = gainNode(ctx, depth);
      o.connect(g);
      g.connect(param);
      o.start();
      sources.add(o);
      nodes.add(o).add(g);
      return o;
    },
    /** Schedule fn(t) on the audio clock; fn returns the delay (s) until its next call, or null to stop. */
    schedule(firstDelay, fn) {
      if (!alive) return;
      scheds.push({ next: ctx.currentTime + Math.max(0, firstDelay), fn });
      if (!timer) timer = setInterval(tick, TICK_MS);
      tick();
    },
    /** Random recurring event every [min, max] seconds. */
    every(min, max, fn, firstDelay) {
      rig.schedule(firstDelay ?? rand(min, max), (t) => {
        fn(t);
        return rand(min, max);
      });
    },
    /** Step sequencer: onStep(step, t, stepDur). swing (0..0.5) delays odd steps. */
    seq({ bpm = 120, stepsPerBeat = 4, swing = 0, startDelay = 0.15, onStep }) {
      const sd = 60 / bpm / stepsPerBeat;
      let step = 0;
      rig.schedule(startDelay, (t) => {
        const s = step++;
        onStep(s, t + (s % 2 ? swing * sd : 0), sd);
        return sd;
      });
    },
    /** Smoothly move an AudioParam to a value. */
    ramp(param, value, seconds = 0.5) {
      const now = ctx.currentTime;
      try {
        param.cancelScheduledValues(now);
        param.setValueAtTime(param.value, now);
        param.linearRampToValueAtTime(value, now + Math.max(0.01, seconds));
      } catch {}
    },
    stop(fade = 1.5) {
      if (!alive) return;
      alive = false;
      clearInterval(timer);
      timer = null;
      scheds = [];
      const now = ctx.currentTime;
      const f = Math.max(0.03, Number(fade) || 0);
      try {
        out.gain.cancelScheduledValues(now);
        out.gain.setValueAtTime(out.gain.value, now);
        out.gain.linearRampToValueAtTime(0, now + f);
      } catch {}
      setTimeout(() => {
        for (const s of sources) {
          try {
            s.stop();
          } catch {}
        }
        for (const n of nodes) {
          try {
            n.disconnect();
          } catch {}
        }
        sources.clear();
        nodes.clear();
      }, f * 1000 + 250);
    },
  };
  return rig;
}
