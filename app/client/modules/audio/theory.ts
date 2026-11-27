// Pure helpers for the audio module: music theory, randomness, volume curves, lookahead scheduling.
// No DOM / Web Audio here, so it can be unit-tested in Node (tools/test-audio.js).

export const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

// ---------------------------------------------------------------------------
// Randomness
// ---------------------------------------------------------------------------
export const rand = (min: number, max: number): number => min + Math.random() * (max - min);
export const randInt = (min: number, max: number): number => Math.floor(rand(min, max + 1));
export const chance = (p: number): boolean => Math.random() < p;
export const pick = <T>(arr: readonly T[]): T => arr[Math.floor(Math.random() * arr.length)];

// ---------------------------------------------------------------------------
// Pitch
// ---------------------------------------------------------------------------
const PC: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** 'A4' -> 69, 'C#3' -> 49, 'Eb2' -> 39. Returns NaN on bad input. */
export function noteToMidi(name: unknown): number {
  const m = /^([A-Ga-g])([#b]?)(-?\d)$/.exec(String(name || '').trim());
  if (!m) return NaN;
  const pc = PC[m[1].toUpperCase()] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
  return 12 * (Number(m[3]) + 1) + pc;
}

/** MIDI note number -> frequency in Hz (A4 = 440). */
export function mtof(m: number): number {
  return 440 * Math.pow(2, (m - 69) / 12);
}

export const SCALES: Record<'major' | 'minor' | 'dorian' | 'phrygian' | 'harmonicMinor' | 'pentaMinor' | 'pentaMajor' | 'blues', number[]> = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  harmonicMinor: [0, 2, 3, 5, 7, 8, 11],
  pentaMinor: [0, 3, 5, 7, 10],
  pentaMajor: [0, 2, 4, 7, 9],
  blues: [0, 3, 5, 6, 7, 10],
};

/** Note of a scale by degree (degree may be negative or exceed the scale length: octaves wrap). */
export function scaleNote(tonicMidi: number, scale: readonly number[], degree: number): number {
  const n = scale.length;
  const oct = Math.floor(degree / n);
  const i = ((degree % n) + n) % n;
  return tonicMidi + 12 * oct + scale[i];
}

const QUALITIES: Record<string, number[]> = {
  '': [0, 4, 7],
  m: [0, 3, 7],
  '5': [0, 7, 12],
  dim: [0, 3, 6],
  aug: [0, 4, 8],
  sus2: [0, 2, 7],
  sus4: [0, 5, 7],
  '6': [0, 4, 7, 9],
  m6: [0, 3, 7, 9],
  '7': [0, 4, 7, 10],
  maj7: [0, 4, 7, 11],
  m7: [0, 3, 7, 10],
  m7b5: [0, 3, 6, 10],
  dim7: [0, 3, 6, 9],
  '9': [0, 4, 7, 10, 14],
  maj9: [0, 4, 7, 11, 14],
  m9: [0, 3, 7, 10, 14],
  add9: [0, 4, 7, 14],
  madd9: [0, 3, 7, 14],
  '7b9': [0, 4, 7, 10, 13],
  m11: [0, 3, 7, 10, 14, 17],
};

/** 'F#m7' -> { root: 6 (pitch class), intervals: [0,3,7,10] }, or null if unknown. */
export function parseChord(sym: unknown): { root: number; intervals: number[] } | null {
  const m = /^([A-G])([#b]?)(.*)$/.exec(String(sym || ''));
  if (!m || !(m[3] in QUALITIES)) return null;
  const root = (PC[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0) + 12) % 12;
  return { root, intervals: QUALITIES[m[3]] };
}

/** MIDI notes of a chord in root position: chordNotes('Am', 3) -> [57, 60, 64]. */
export function chordNotes(sym: string, octave = 3): number[] {
  const c = parseChord(sym);
  if (!c) return [];
  const base = 12 * (octave + 1) + c.root;
  return c.intervals.map((i) => base + i);
}

/** MIDI root of a chord at an octave: chordRoot('Am', 2) -> 45. */
export function chordRoot(sym: string, octave = 2): number {
  const c = parseChord(sym);
  return c ? 12 * (octave + 1) + c.root : NaN;
}

/** Arpeggio index into chord tones. pattern: 'up' | 'down' | 'updown'. Extends over octaves. */
export function arpNote(notes: readonly number[], i: number, pattern: 'up' | 'down' | 'updown' = 'up', octaves = 1): number {
  if (!notes.length) return NaN;
  const span = notes.length * octaves;
  const seq: number[] = [];
  for (let k = 0; k < span; k++) seq.push(notes[k % notes.length] + 12 * Math.floor(k / notes.length));
  let order = seq;
  if (pattern === 'down') order = [...seq].reverse();
  else if (pattern === 'updown') order = seq.length > 1 ? [...seq, ...seq.slice(1, -1).reverse()] : seq;
  return order[((i % order.length) + order.length) % order.length];
}

// ---------------------------------------------------------------------------
// Volume
// ---------------------------------------------------------------------------
/** Slider value (0..1) -> linear gain, with a perceptual (squared) curve. Bad input -> 0. */
export function toGain(v: unknown): number {
  const n = clamp(Number(v), 0, 1);
  return Number.isFinite(n) ? n * n : 0;
}

/** Gain of the local output stage (per-device volume + mute). */
export function localGain(volume: unknown, muted: boolean): number {
  return muted ? 0 : toGain(volume);
}

/** Validate a volume coming from anywhere. Returns a number in [0,1] or `fallback`. */
export function cleanVolume(v: unknown, fallback = 1): number {
  const n = Number(v);
  return Number.isFinite(n) ? clamp(n, 0, 1) : fallback;
}

/**
 * Where a looping file should be when a client joins late: seconds into the file.
 * startedAt = epoch ms when the server started the track.
 */
export function syncOffset(startedAt: number, nowMs: number, duration: number): number {
  if (!(duration > 0) || !Number.isFinite(duration) || !(startedAt > 0)) return 0;
  const elapsed = (nowMs - startedAt) / 1000;
  if (!(elapsed > 0)) return 0;
  return elapsed % duration;
}

// ---------------------------------------------------------------------------
// Lookahead scheduler (audio-clock based)
// ---------------------------------------------------------------------------
/**
 * Run scheduled callbacks whose time falls before now + lookahead.
 * items: [{ next: seconds (audio clock), fn(t) -> delay until next call (seconds) | null to stop }]
 * If an item lags behind by more than maxLag (tab throttled, context suspended), it is resynced to "now"
 * instead of firing a burst of overdue events. Returns the still-active items.
 */
/** A scheduled callback: `fn(t)` returns the delay (s) until its next call, or null / false to stop. */
export interface ScheduleItem {
  next: number;
  fn: (t: number) => number | null | undefined | false | void;
  done?: boolean;
}

export function runSchedule<S extends ScheduleItem>(items: S[], now: number, lookahead = 0.4, maxLag = 0.6, onError?: (err: unknown) => void): S[] {
  const keep: S[] = [];
  for (const s of items) {
    if (s.done) continue;
    if (s.next < now - maxLag) s.next = now + 0.02;
    let guard = 0;
    while (!s.done && s.next < now + lookahead) {
      if (++guard > 512) break; // never spin forever
      let d;
      try {
        d = s.fn(s.next);
      } catch (err) {
        s.done = true;
        onError?.(err);
        break;
      }
      if (d == null || d === false || !Number.isFinite(Number(d))) s.done = true;
      else s.next += Math.max(0.005, Number(d));
    }
    if (!s.done) keep.push(s);
  }
  return keep;
}

/** Duration of one sequencer step in seconds (stepsPerBeat = 4 -> sixteenth notes). */
export function stepDuration(bpm: unknown, stepsPerBeat = 4): number {
  return 60 / clamp(Number(bpm) || 120, 20, 300) / stepsPerBeat;
}

/** Simple throttle with trailing call and flush(). Pure JS (timers only). */
export interface Throttled<A extends unknown[]> {
  (...args: A): void;
  /** Run now with these args (or the pending ones). */
  flush(...args: A | []): void;
  cancel(): void;
}

export function throttle<A extends unknown[]>(fn: (...args: A) => void, ms: number): Throttled<A> {
  let last = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: A | null = null;
  const run = () => {
    timer = null;
    last = Date.now();
    const args = pending;
    pending = null;
    if (args) fn(...args);
  };
  const t = ((...args: A) => {
    pending = args;
    const wait = ms - (Date.now() - last);
    if (wait <= 0) {
      clearTimeout(timer ?? undefined);
      run();
    } else if (!timer) timer = setTimeout(run, wait);
  }) as Throttled<A>;
  t.flush = (...args: A | []) => {
    clearTimeout(timer ?? undefined);
    timer = null;
    pending = args.length ? (args as A) : pending;
    if (pending) run();
  };
  t.cancel = () => {
    clearTimeout(timer ?? undefined);
    timer = null;
    pending = null;
  };
  return t;
}

/** Move every note by octaves into [lo, hi] (close voicing), sorted ascending, duplicates removed. */
export function fitRange(notes: Iterable<number>, lo = 55, hi = 74): number[] {
  const out = new Set<number>();
  for (let n of notes) {
    if (!Number.isFinite(n)) continue;
    while (n < lo) n += 12;
    while (n > hi && n - 12 >= lo) n -= 12;
    out.add(n);
  }
  return [...out].sort((a, b) => a - b);
}
