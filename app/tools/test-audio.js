// Audio module tests: pure helpers, every synth generator against a strict Web Audio mock (fake clock),
// the client engine core, then server actions / permissions / filters over a real isolated server.
//   node tools/test-audio.js            (exit code 1 on failure)
import assert from 'node:assert/strict';

let failures = 0;
let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  ✓', name);
  } catch (err) {
    failures++;
    console.log('  ✗', name);
    console.log('    ', err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n     ') : err);
  }
}

// ===========================================================================
// 1. Pure helpers
// ===========================================================================
const T = await import('../client/modules/audio/theory.js');
const catalog = await import('../client/modules/audio/catalog.js');
console.log('\n[theory / catalog]');

await test('noteToMidi / mtof', () => {
  assert.equal(T.noteToMidi('A4'), 69);
  assert.equal(T.noteToMidi('C4'), 60);
  assert.equal(T.noteToMidi('C#3'), 49);
  assert.equal(T.noteToMidi('Eb2'), 39);
  assert.ok(Number.isNaN(T.noteToMidi('H2')));
  assert.equal(T.mtof(69), 440);
  assert.ok(Math.abs(T.mtof(60) - 261.6256) < 0.001);
});

await test('chords, scales, arpeggios, voicing', () => {
  assert.deepEqual(T.chordNotes('Am', 3), [57, 60, 64]);
  assert.deepEqual(T.chordNotes('F#m7', 3), [54, 57, 61, 64]);
  assert.deepEqual(T.chordNotes('Abmaj7', 3), [56, 60, 63, 67]);
  assert.deepEqual(T.chordNotes('Dm7b5', 3), [50, 53, 56, 60]);
  assert.deepEqual(T.chordNotes('Zz', 3), []);
  assert.equal(T.parseChord('Cfoo'), null);
  assert.equal(T.chordRoot('E', 2), 40);
  assert.equal(T.scaleNote(60, T.SCALES.major, 7), 72);
  assert.equal(T.scaleNote(60, T.SCALES.major, -1), 59);
  assert.equal(T.scaleNote(57, T.SCALES.pentaMinor, 5), 69);
  assert.equal(T.arpNote([60, 64, 67], 3, 'up'), 60);
  assert.equal(T.arpNote([60, 64, 67], 3, 'up', 2), 72);
  assert.equal(T.arpNote([60, 64, 67], 0, 'down'), 67);
  assert.deepEqual([0, 1, 2, 3, 4].map((i) => T.arpNote([60, 64, 67], i, 'updown')), [60, 64, 67, 64, 60]);
  assert.ok(Number.isNaN(T.arpNote([], 0)));
  assert.deepEqual(T.fitRange([40, 43, 47, 50], 55, 74), [55, 59, 62, 64]);
  // Every progression symbol used by the music generators must parse.
  for (const sym of ['Em', 'C', 'Am', 'B', 'F', 'G', 'Cm9', 'Abmaj7', 'Fm9', 'Dm7b5', 'G7b9', 'Fmaj7', 'Dm7', 'Gm7', 'C9', 'Am7', 'D7b9', 'Em7', 'Dmaj9', 'Bm9', 'Gmaj9', 'Aadd9', 'E', 'Dm'])
    assert.ok(T.parseChord(sym), sym);
});

await test('volume helpers', () => {
  assert.equal(T.toGain(1), 1);
  assert.equal(T.toGain(0.5), 0.25);
  assert.equal(T.toGain(-3), 0);
  assert.equal(T.toGain(7), 1);
  assert.equal(T.toGain('abc'), 0);
  assert.equal(T.toGain(undefined), 0);
  assert.equal(T.localGain(1, true), 0);
  assert.equal(T.cleanVolume('0.3'), 0.3);
  assert.equal(T.cleanVolume('x', 0.7), 0.7);
  assert.equal(T.cleanVolume(4), 1);
});

await test('syncOffset (late joiners on uploaded loops)', () => {
  assert.equal(T.syncOffset(0, 10_000, 60), 0);
  assert.equal(T.syncOffset(1000, 11_000, 60), 10);
  assert.equal(T.syncOffset(1000, 71_000, 60), 10);
  assert.equal(T.syncOffset(5000, 1000, 60), 0); // clock skew: start in the future
  assert.equal(T.syncOffset(1000, 5000, NaN), 0);
  assert.equal(T.syncOffset(1000, 5000, Infinity), 0);
});

await test('runSchedule: lookahead, stop, lag resync, error isolation', () => {
  const hits = [];
  let items = [{ next: 0, fn: (t) => (hits.push(t), 0.1) }];
  items = T.runSchedule(items, 0, 0.35);
  assert.deepEqual(hits.map((x) => +x.toFixed(2)), [0, 0.1, 0.2, 0.3]);
  // fell 10 s behind -> resync instead of firing ~100 overdue events
  hits.length = 0;
  items = T.runSchedule(items, 10, 0.35);
  assert.ok(hits.length <= 5, 'burst after lag: ' + hits.length);
  assert.ok(hits[0] >= 10);
  // null stops
  let n = 0;
  items = T.runSchedule([{ next: 0, fn: () => (n++ < 2 ? 0.05 : null) }], 0, 1);
  assert.equal(items.length, 0);
  assert.equal(n, 3);
  // a throwing callback is dropped, others continue
  const errs = [];
  let ok = 0;
  items = T.runSchedule([{ next: 0, fn: () => { throw new Error('boom'); } }, { next: 0, fn: () => (ok++, 1) }], 0, 0.5, 0.6, (e) => errs.push(e));
  assert.equal(errs.length, 1);
  assert.equal(items.length, 1);
  assert.equal(ok, 1);
  // zero / negative delays can't spin forever
  let spins = 0;
  T.runSchedule([{ next: 0, fn: () => (spins++, 0) }], 0, 0.4);
  assert.ok(spins <= 512 && spins > 1);
  assert.equal(T.stepDuration(120, 4), 0.125);
});

await test('throttle: leading call, trailing call, flush', async () => {
  const calls = [];
  const th = T.throttle((v) => calls.push(v), 40);
  th(1);
  th(2);
  th(3);
  assert.deepEqual(calls, [1]);
  await new Promise((r) => setTimeout(r, 70));
  assert.deepEqual(calls, [1, 3]);
  th(4); // within 40 ms of the trailing call: deferred
  th(5);
  th.flush(6);
  assert.deepEqual(calls, [1, 3, 6]);
  await new Promise((r) => setTimeout(r, 60));
  th(7); // long after: immediate
  assert.deepEqual(calls, [1, 3, 6, 7]);
  th.cancel();
});

await test('catalog: ids, unique track ids, metadata', () => {
  const tracks = catalog.builtinTracks();
  assert.equal(new Set(tracks.map((t) => t.id)).size, tracks.length);
  assert.equal(catalog.AMBIENT_PRESETS.length, 13);
  assert.equal(catalog.MUSIC_PRESETS.length, 8);
  assert.deepEqual(catalog.SFX_IDS, ['dice', 'door-open', 'door-close', 'door-locked', 'gunshot-pistol', 'gunshot-rifle', 'gunshot-auto', 'explosion', 'hit-melee', 'glass-break', 'alarm', 'footsteps', 'notify', 'matrix-glitch', 'spell-cast', 'heal', 'death', 'cash', 'level-up', 'ping']);
  assert.ok(tracks.every((t) => t.source === 'synth' && t.name && catalog.presetMeta(t)));
  assert.equal(catalog.trackIcon({ kind: 'music', source: 'url' }), '🎵');
});

// ===========================================================================
// 2. Strict Web Audio mock + fake timers
// ===========================================================================
const fin = (v, what) => {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new TypeError(`${what}: non-finite value ${v}`);
};
let mockCtxCount = 0;

class MockParam {
  constructor(ctx, value, name) {
    this.ctx = ctx;
    this._v = value;
    this._last = value;
    this.name = name;
  }
  get value() {
    return this._v;
  }
  set value(v) {
    fin(v, this.name + '.value');
    this._v = v;
    this._last = v;
  }
  _time(t, op) {
    fin(t, `${this.name}.${op} time`);
    if (t < 0) throw new RangeError(`${this.name}.${op}: negative time`);
  }
  setValueAtTime(v, t) {
    fin(v, this.name + '.setValueAtTime');
    this._time(t, 'setValueAtTime');
    this._last = v;
    return this;
  }
  linearRampToValueAtTime(v, t) {
    fin(v, this.name + '.linearRamp');
    this._time(t, 'linearRamp');
    this._last = v;
    return this;
  }
  exponentialRampToValueAtTime(v, t) {
    fin(v, this.name + '.expRamp');
    this._time(t, 'expRamp');
    if (v === 0) throw new RangeError(`${this.name}: exponentialRamp to 0`);
    if (this._last !== null && (this._last === 0 || Math.sign(this._last) !== Math.sign(v)))
      throw new Error(`${this.name}: exponentialRamp from ${this._last} (stays silent/flat — anchor a non-zero value first)`);
    this._last = v;
    return this;
  }
  setTargetAtTime(v, t, tc) {
    fin(v, this.name + '.setTarget');
    this._time(t, 'setTarget');
    fin(tc, this.name + '.timeConstant');
    if (tc < 0) throw new RangeError('negative timeConstant');
    this._last = null; // unknown
    return this;
  }
  cancelScheduledValues(t) {
    this._time(t, 'cancel');
    return this;
  }
}

class MockNode {
  constructor(ctx) {
    this.context = ctx;
    this._outs = new Set();
    ctx._nodeCount++;
  }
  connect(dest) {
    if (!(dest instanceof MockNode) && !(dest instanceof MockParam)) throw new TypeError('connect(): invalid destination ' + dest);
    const dctx = dest instanceof MockNode ? dest.context : dest.ctx;
    if (dctx !== this.context) throw new Error('connect(): node from another context');
    this._outs.add(dest);
    return dest;
  }
  disconnect() {
    this._outs.clear();
  }
  _param(value, name) {
    return new MockParam(this.context, value, this.constructor.name + '.' + name);
  }
}

class MockSource extends MockNode {
  constructor(ctx) {
    super(ctx);
    this.onended = null;
  }
  start(when = 0, offset) {
    if (this._started) throw new Error('InvalidStateError: start() called twice');
    fin(when, 'start(when)');
    if (when < 0) throw new RangeError('start(): negative when');
    if (offset !== undefined) {
      fin(offset, 'start(offset)');
      if (offset < 0) throw new RangeError('start(): negative offset');
    }
    this._started = true;
    this._startAt = Math.max(when, this.context.currentTime);
    this._offset = offset || 0;
    this.context._live.add(this);
    this.context._maxLive = Math.max(this.context._maxLive, this.context._live.size);
  }
  stop(when = 0) {
    if (!this._started) throw new Error('InvalidStateError: stop() before start()');
    fin(when, 'stop(when)');
    if (when < 0) throw new RangeError('stop(): negative when');
    this._stopAt = Math.max(when, this.context.currentTime);
  }
  _naturalEnd() {
    return null;
  }
}

class MockOsc extends MockSource {
  constructor(ctx) {
    super(ctx);
    this._type = 'sine';
    this.frequency = this._param(440, 'frequency');
    this.detune = this._param(0, 'detune');
  }
  get type() {
    return this._type;
  }
  set type(v) {
    if (!['sine', 'square', 'sawtooth', 'triangle'].includes(v)) throw new TypeError('bad oscillator type ' + v);
    this._type = v;
  }
}

class MockBufferSource extends MockSource {
  constructor(ctx) {
    super(ctx);
    this.buffer = null;
    this.loop = false;
    this.playbackRate = this._param(1, 'playbackRate');
    this.detune = this._param(0, 'detune');
  }
  start(when, offset) {
    if (!this.buffer) throw new Error('AudioBufferSourceNode started without buffer');
    if (offset !== undefined && offset > this.buffer.duration) throw new RangeError('offset beyond buffer');
    super.start(when, offset);
  }
  _naturalEnd() {
    if (this.loop || !this.buffer) return null;
    return this._startAt + (this.buffer.duration - this._offset) / Math.max(0.01, this.playbackRate.value);
  }
}

class MockFilter extends MockNode {
  constructor(ctx) {
    super(ctx);
    this._type = 'lowpass';
    this.frequency = this._param(350, 'frequency');
    this.Q = this._param(1, 'Q');
    this.gain = this._param(0, 'gain');
    this.detune = this._param(0, 'detune');
  }
  get type() {
    return this._type;
  }
  set type(v) {
    if (!['lowpass', 'highpass', 'bandpass', 'lowshelf', 'highshelf', 'peaking', 'notch', 'allpass'].includes(v)) throw new TypeError('bad filter type ' + v);
    this._type = v;
  }
}

class MockCtx {
  constructor() {
    mockCtxCount++;
    MockCtx.last = this;
    this.sampleRate = 48000;
    this.currentTime = 0;
    this.state = 'suspended';
    this._live = new Set();
    this._maxLive = 0;
    this._nodeCount = 0;
    this.destination = new MockNode(this);
    this.onstatechange = null;
  }
  _setTime(t) {
    this.currentTime = t;
    for (const s of [...this._live]) {
      const end = s._stopAt ?? s._naturalEnd();
      if (end != null && end <= t) {
        this._live.delete(s);
        s.onended?.({ target: s });
      }
    }
  }
  resume() {
    this.state = 'running';
    this.onstatechange?.();
    return Promise.resolve();
  }
  createGain() {
    const n = new MockNode(this);
    n.gain = n._param(1, 'gain');
    return n;
  }
  createOscillator() {
    return new MockOsc(this);
  }
  createBufferSource() {
    return new MockBufferSource(this);
  }
  createBiquadFilter() {
    return new MockFilter(this);
  }
  createDelay(max = 1) {
    const n = new MockNode(this);
    n.delayTime = n._param(0, 'delayTime');
    const p = n.delayTime;
    Object.defineProperty(p, 'value', {
      get: () => p._v,
      set: (v) => {
        fin(v, 'delayTime');
        if (v > max) throw new RangeError('delayTime > maxDelayTime');
        p._v = v;
      },
    });
    return n;
  }
  createConvolver() {
    const n = new MockNode(this);
    n.buffer = null;
    return n;
  }
  createWaveShaper() {
    const n = new MockNode(this);
    let curve = null;
    Object.defineProperty(n, 'curve', {
      get: () => curve,
      set: (c) => {
        if (!(c instanceof Float32Array)) throw new TypeError('curve must be a Float32Array');
        curve = c;
      },
    });
    return n;
  }
  createStereoPanner() {
    const n = new MockNode(this);
    n.pan = n._param(0, 'pan');
    const p = n.pan;
    Object.defineProperty(p, 'value', {
      get: () => p._v,
      set: (v) => {
        fin(v, 'pan');
        if (v < -1 || v > 1) throw new RangeError('pan out of range');
        p._v = v;
      },
    });
    return n;
  }
  createDynamicsCompressor() {
    const n = new MockNode(this);
    for (const k of ['threshold', 'knee', 'ratio', 'attack', 'release']) n[k] = n._param(0, k);
    return n;
  }
  createMediaElementSource(el) {
    if (!el) throw new TypeError('no element');
    return new MockNode(this);
  }
  createBuffer(channels, length, sampleRate) {
    if (!(length > 0) || !(channels > 0)) throw new RangeError('createBuffer: bad size');
    const data = Array.from({ length: channels }, () => new Float32Array(length));
    return { numberOfChannels: channels, length, sampleRate, duration: length / sampleRate, getChannelData: (i) => data[i] };
  }
  decodeAudioData() {
    return Promise.resolve(this.createBuffer(2, 48000, 48000));
  }
}

// Fake timers so minutes of audio run in milliseconds.
const realTimers = { setTimeout, clearTimeout, setInterval, clearInterval };
let fakeNow = 0;
let timerSeq = 0;
let timers = [];
let activeCtx = null;
function useFakeTimers() {
  fakeNow = 0;
  timers = [];
  globalThis.setTimeout = (fn, ms = 0, ...args) => {
    const id = ++timerSeq;
    timers.push({ id, at: fakeNow + Math.max(0, Number(ms) || 0), fn, args });
    return id;
  };
  globalThis.setInterval = (fn, ms = 0) => {
    const id = ++timerSeq;
    const every = Math.max(1, Number(ms) || 0);
    timers.push({ id, at: fakeNow + every, fn, args: [], every });
    return id;
  };
  globalThis.clearTimeout = globalThis.clearInterval = (id) => {
    timers = timers.filter((t) => t.id !== id);
  };
}
function useRealTimers() {
  Object.assign(globalThis, realTimers);
}
function advance(ms) {
  const end = fakeNow + ms;
  for (;;) {
    timers.sort((a, b) => a.at - b.at || a.id - b.id);
    const t = timers[0];
    if (!t || t.at > end) break;
    fakeNow = t.at;
    activeCtx?._setTime(fakeNow / 1000);
    if (t.every) t.at += t.every;
    else timers.shift();
    t.fn(...t.args);
  }
  fakeNow = end;
  activeCtx?._setTime(fakeNow / 1000);
}

const warnings = [];
const realWarn = console.warn;
console.warn = (...a) => {
  warnings.push(a.map(String).join(' '));
};

// ===========================================================================
// 3. Generators
// ===========================================================================
const { AMBIENCES } = await import('../client/modules/audio/ambiences.js');
const { MUSIC } = await import('../client/modules/audio/music.js');
const { SFX } = await import('../client/modules/audio/sfx.js');

console.log('\n[generators on the Web Audio mock]');
await test('every catalog preset has a generator', () => {
  for (const p of catalog.AMBIENT_PRESETS) assert.equal(typeof AMBIENCES[p.id], 'function', 'ambient ' + p.id);
  for (const p of catalog.MUSIC_PRESETS) assert.equal(typeof MUSIC[p.id], 'function', 'music ' + p.id);
  for (const p of catalog.SFX_PRESETS) assert.equal(typeof SFX[p.id], 'function', 'sfx ' + p.id);
});

const stats = [];
async function runLoop(kind, id, start) {
  await test(`${kind} « ${id} »: 4 min without error, clean stop`, () => {
    useFakeTimers();
    const ctx = new MockCtx();
    ctx.state = 'running';
    activeCtx = ctx;
    warnings.length = 0;
    const out = ctx.createGain();
    out.connect(ctx.destination);
    const h = start(ctx, out, { fadeIn: 1 });
    assert.equal(typeof h?.stop, 'function');
    advance(240_000);
    assert.deepEqual(warnings, [], 'warnings during playback');
    const live = ctx._live.size;
    const peak = ctx._maxLive;
    const perMin = Math.round(ctx._nodeCount / 4);
    h.stop(2);
    h.stop(2); // idempotent
    advance(15_000); // longest scheduled voices (pads) ring ~9 s
    assert.equal(ctx._live.size, 0, `sources still running after stop: ${ctx._live.size}`);
    assert.equal(timers.length, 0, `timers left after stop: ${timers.length}`);
    stats.push(`${kind}:${id} live≈${live} peak=${peak} nodes/min≈${perMin}`);
    assert.ok(peak < 400, 'too many simultaneous sources: ' + peak);
    activeCtx = null;
    useRealTimers();
  });
}
for (const [id, fn] of Object.entries(AMBIENCES)) await runLoop('ambient', id, fn);
for (const [id, fn] of Object.entries(MUSIC)) await runLoop('music', id, fn);

await test('generator started on a suspended context does not pile up events', () => {
  useFakeTimers();
  const ctx = new MockCtx(); // suspended: currentTime frozen at 0
  activeCtx = null;
  const h = AMBIENCES.rain(ctx, ctx.destination);
  advance(60_000);
  const before = ctx._nodeCount;
  advance(60_000);
  assert.equal(ctx._nodeCount, before, 'nodes created while suspended');
  h.stop(0.5);
  advance(2000);
  useRealTimers();
});

await test('every sfx plays and ends cleanly', () => {
  useFakeTimers();
  const ctx = new MockCtx();
  ctx.state = 'running';
  activeCtx = ctx;
  warnings.length = 0;
  for (const [id, fn] of Object.entries(SFX)) {
    const out = ctx.createGain();
    const verb = ctx.createGain();
    out.connect(ctx.destination);
    verb.connect(ctx.destination);
    const t = ctx.currentTime + 0.02;
    const end = fn(ctx, { out, verb }, t);
    assert.ok(Number.isFinite(end) && end > t && end < t + 8, `${id}: bad end time ${end}`);
    advance((end - ctx.currentTime) * 1000 + 3500);
    assert.equal(ctx._live.size, 0, `${id}: sources still alive`);
  }
  assert.equal(timers.length, 0, 'timers left');
  assert.deepEqual(warnings, []);
  activeCtx = null;
  useRealTimers();
});

// ===========================================================================
// 4. Engine core (audio-core.js) with mocked browser globals
// ===========================================================================
console.log('\n[engine core]');
const store = {};
globalThis.window = { AudioContext: MockCtx };
globalThis.localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => (store[k] = String(v)),
  removeItem: (k) => delete store[k],
};
let audioEls = 0;
globalThis.Audio = class {
  constructor() {
    audioEls++;
    this.listeners = {};
  }
  addEventListener(ev, fn) {
    this.listeners[ev] = fn;
  }
  play() {
    return Promise.resolve();
  }
  pause() {}
  removeAttribute() {}
  load() {}
};
const realFetch = globalThis.fetch;
globalThis.fetch = async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) });

useFakeTimers();
const core = await import('../client/modules/audio/audio-core.js');
const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};
const tracks = catalog.builtinTracks().concat([
  { id: 'trk_file', name: 'Fichier', kind: 'ambient', source: 'url', url: '/uploads/a.mp3' },
  { id: 'trk_sfx', name: 'Bip', kind: 'sfx', source: 'url', url: '/uploads/b.ogg', volume: 1.5 },
]);
const audioState = (amb, mus, extra = {}) => ({ master: 0.8, ambient: { trackId: amb, volume: 0.5, startedAt: Date.now() - 5000 }, music: { trackId: mus, volume: 0.4 }, tracks, ...extra });

await test('nothing plays before a user gesture, then the scene starts', async () => {
  warnings.length = 0;
  const ctxBefore = mockCtxCount;
  assert.equal(core.getAudioState().unlocked, false);
  core.syncAudio(audioState('amb-rain', null));
  assert.equal(mockCtxCount, ctxBefore, 'context created before a gesture');
  assert.equal(core.playSfx('dice'), false);
  core.unlock();
  await flush();
  activeCtx = MockCtx.last;
  assert.equal(core.getAudioState().unlocked, true);
  advance(3000);
  assert.ok(activeCtx._live.size > 0, 'ambient not started');
});

await test('crossfade, volume changes, stop: no leaks', async () => {
  const ctx = activeCtx;
  core.syncAudio(audioState('amb-storm', 'mus-combat'));
  advance(10_000);
  core.syncAudio(audioState('amb-storm', 'mus-combat', { master: 0.3 })); // same tracks: no restart
  const n = ctx._nodeCount;
  core.syncAudio(audioState('amb-storm', 'mus-combat', { master: 0.3 }));
  assert.ok(ctx._nodeCount - n < 5, 'resync restarted tracks');
  core.syncAudio(audioState(null, null));
  advance(8000);
  assert.equal(ctx._live.size, 0, 'sources left after stopping both channels');
});

await test('uploaded loop uses a media element; unknown ids are ignored', async () => {
  const before = audioEls;
  core.syncAudio(audioState('trk_file', 'does-not-exist'));
  advance(500);
  assert.equal(audioEls, before + 1);
  core.syncAudio(audioState('trk_file', null)); // same: no new element
  assert.equal(audioEls, before + 1);
  core.syncAudio(audioState(null, null));
  advance(4000);
  core.syncAudio(null); // tolerated
  core.syncAudio({ ambient: 'garbage', tracks: 'nope' });
});

await test('sfx: built-in, uploaded, dedupe, unknown, stopAll', async () => {
  const ctx = activeCtx;
  assert.equal(core.playSfx('dice', 1), true);
  assert.equal(core.playSfx('dice', 1), false, 'duplicate within 60 ms should be ignored');
  assert.equal(core.playSfx('explosion', 0.5), true);
  assert.equal(core.playSfx('alarm', 'loud'), true);
  assert.equal(core.playSfx('nope'), false);
  assert.equal(core.playSfx(42), false);
  core.syncAudio(audioState(null, null));
  assert.equal(core.playSfx('trk_sfx', 1), true);
  await flush();
  core.stopAllSfx();
  advance(9000);
  assert.equal(ctx._live.size, 0);
});

await test('private preview toggles and stops', async () => {
  const ctx = activeCtx;
  const rain = tracks.find((t) => t.id === 'amb-matrix');
  core.togglePreview(rain);
  await flush();
  assert.equal(core.getAudioState().previewKey, 'p:amb-matrix');
  advance(2000);
  core.togglePreview(rain);
  assert.equal(core.getAudioState().previewKey, null);
  core.togglePreview(tracks.find((t) => t.id === 'ping'));
  advance(6000);
  assert.equal(ctx._live.size, 0);
});

await test('local volume & mute persist per device', () => {
  core.setLocalVolume(0.3);
  assert.equal(store['sr.audio.volume'], '0.3');
  core.setMuted(true);
  assert.equal(store['sr.audio.muted'], '1');
  assert.equal(core.getAudioState().muted, true);
  core.setLocalVolume(0.6); // moving the slider unmutes
  assert.equal(core.getAudioState().muted, false);
  core.setLocalVolume('garbage');
  assert.equal(core.getAudioState().local, 0.6);
  assert.deepEqual(warnings.filter((w) => !w.includes('inconnu')), []);
});
activeCtx = null;
useRealTimers();
console.warn = realWarn;
globalThis.fetch = realFetch;
for (const s of stats) console.log('     ', s);

// ===========================================================================
// 5. Server module: init merge (direct) + actions over a real isolated server
// ===========================================================================
console.log('\n[server]');
const audioMod = (await import('../server/modules/60-audio.js')).default;

await test('init: defaults, built-ins merged by id, seeds, stale references cleared', () => {
  const state = { audio: { master: 'x', ambient: { trackId: 'trk_gone', volume: 9 }, tracks: [{ id: 'amb-rain', name: 'Ma pluie', kind: 'music', source: 'synth', preset: 'zzz' }, { id: 'amb-old', kind: 'ambient', source: 'synth', preset: 'old' }], scenes: [{ id: 'scn-bar-porfla', name: 'Perso' }] } };
  const seed = { tracks: [{ id: 'seed_t', name: 'S', kind: 'music', source: 'url', url: '/uploads/s.mp3' }, { id: 'bad', kind: 'x', source: 'url', url: '/u' }], scenes: [{ id: 'scn-bar-porfla', name: 'Seed' }, { id: 'scn-new', name: 'Nouvelle', ambient: 'amb-bar', music: null }] };
  audioMod.init(state, { readSeed: () => seed });
  const a = state.audio;
  assert.equal(a.master, 0.8);
  assert.equal(a.ambient.volume, 1);
  assert.equal(a.ambient.trackId, null);
  assert.equal(a.music.volume, 0.4);
  assert.equal(a.autoScenes, true);
  const rain = a.tracks.find((t) => t.id === 'amb-rain');
  assert.equal(rain.name, 'Ma pluie', 'GM rename kept');
  assert.equal(rain.kind, 'ambient');
  assert.equal(rain.preset, 'rain');
  assert.ok(!a.tracks.some((t) => t.id === 'amb-old'), 'stale synth track kept');
  assert.ok(a.tracks.some((t) => t.id === 'seed_t'));
  assert.ok(!a.tracks.some((t) => t.id === 'bad'));
  assert.equal(a.scenes.find((s) => s.id === 'scn-bar-porfla').name, 'Perso', 'seed overwrote GM scene');
  assert.ok(a.scenes.some((s) => s.id === 'scn-new'));
  audioMod.init(state, { readSeed: () => seed }); // idempotent
  assert.equal(a.tracks.length, new Set(a.tracks.map((t) => t.id)).size);
  audioMod.init({}, { readSeed: () => null }); // empty state + missing seed file
});

await test('seed file: scenes reference existing tracks and known maps', async () => {
  const fs = await import('node:fs');
  const seed = JSON.parse(fs.readFileSync(new URL('../data/seed/audio.json', import.meta.url), 'utf8'));
  const ids = new Set(catalog.builtinTracks().map((t) => t.id));
  for (const s of seed.scenes) {
    for (const ch of ['ambient', 'music']) if (s[ch] && s[ch] !== 'keep') assert.ok(ids.has(s[ch]), `${s.id}.${ch} = ${s[ch]}`);
  }
  assert.equal(new Set(seed.scenes.map((s) => s.id)).size, seed.scenes.length);
});

const { startServer, login, client, settle } = await import('./test-client.js');
const srv = await startServer({ port: 3106 });
let gm, p1;
try {
  gm = await client(srv.url, await login(srv.url, { role: 'gm', password: 'lazarus' }));
  p1 = await client(srv.url, await login(srv.url, { role: 'player', name: 'Testeur audio' }));
  const fails = async (p, re) => {
    try {
      await p;
    } catch (err) {
      if (re) assert.match(err.message, re);
      return;
    }
    assert.fail('expected a failure');
  };
  const sync = async () => {
    await settle(150);
  };

  await test('initial state: GM full slice, player filtered', async () => {
    const a = gm.state.audio;
    assert.ok(a, 'no audio slice');
    assert.equal(a.master, 0.8);
    assert.deepEqual(a.ambient, { trackId: null, volume: 0.5, startedAt: 0 });
    assert.equal(a.music.volume, 0.4);
    assert.ok(a.tracks.some((t) => t.id === 'amb-rain') && a.tracks.some((t) => t.id === 'mus-combat') && a.tracks.some((t) => t.id === 'dice'));
    const porfla = a.scenes.find((s) => s.id === 'scn-bar-porfla');
    assert.equal(porfla.ambient, 'amb-bar');
    assert.equal(porfla.mapId, 'map_bar_porfla');
    const pa = p1.state.audio;
    assert.equal(pa.scenes, undefined);
    assert.equal(pa.autoScenes, undefined);
    assert.deepEqual(pa.tracks, []);
  });

  await test('players cannot change audio', async () => {
    for (const [type, payload] of [
      ['audio/setAmbient', { trackId: 'amb-rain' }],
      ['audio/setMusic', { trackId: 'mus-combat' }],
      ['audio/setVolume', { channel: 'master', volume: 0 }],
      ['audio/sfx', { id: 'explosion' }],
      ['audio/stopAll', {}],
      ['audio/addTrack', { name: 'x', kind: 'sfx', url: '/uploads/x.mp3' }],
      ['audio/saveScene', { name: 'x' }],
      ['audio/applyScene', { sceneId: 'scn-combat' }],
      ['audio/deleteScene', { sceneId: 'scn-combat' }],
      ['audio/setOptions', { autoScenes: false }],
    ])
      await fails(p1.send(type, payload), /MJ/);
  });

  await test('setAmbient / setMusic (ids, preset ids, errors)', async () => {
    assert.equal(await gm.send('audio/setAmbient', { trackId: 'amb-rain' }), 'amb-rain');
    await sync();
    const started = gm.state.audio.ambient.startedAt;
    assert.ok(started > 0);
    assert.equal(p1.state.audio.ambient.trackId, 'amb-rain');
    assert.deepEqual(p1.state.audio.tracks.map((t) => t.id), ['amb-rain'], 'player gets the playing track');
    assert.equal(await gm.send('audio/setAmbient', { trackId: 'rain' }), 'amb-rain', 'preset id alias');
    await sync();
    assert.equal(gm.state.audio.ambient.startedAt, started, 're-selecting the same track must not restart it');
    await fails(gm.send('audio/setAmbient', { trackId: 'dice' }), /boucle/);
    await fails(gm.send('audio/setAmbient', { trackId: 'nope' }), /introuvable/);
    assert.equal(await gm.send('audio/setMusic', { trackId: 'combat' }), 'mus-combat');
    await gm.send('audio/setMusic', { trackId: null });
    await gm.send('audio/setMusic', {});
    await sync();
    assert.equal(gm.state.audio.music.trackId, null);
  });

  await test('setVolume validation & clamping', async () => {
    await gm.send('audio/setVolume', { channel: 'master', volume: 0.5 });
    await gm.send('audio/setVolume', { channel: 'music', volume: 5 });
    await gm.send('audio/setVolume', { channel: 'ambient', volume: -1 });
    await fails(gm.send('audio/setVolume', { channel: 'bass', volume: 0.5 }), /Canal/);
    await fails(gm.send('audio/setVolume', { channel: 'master', volume: 'fort' }), /invalide/);
    await sync();
    assert.equal(gm.state.audio.master, 0.5);
    assert.equal(gm.state.audio.music.volume, 1);
    assert.equal(gm.state.audio.ambient.volume, 0);
    assert.equal(p1.state.audio.master, 0.5);
  });

  await test('sfx broadcast reaches players (built-in + uploaded)', async () => {
    p1.events.length = 0;
    gm.events.length = 0;
    await gm.send('audio/sfx', { id: 'dice' });
    await gm.send('audio/sfx', { id: 'explosion', volume: 0.4 });
    await fails(gm.send('audio/sfx', { id: 'pouet' }), /inconnu/);
    await fails(gm.send('audio/sfx', { id: 'amb-rain' }), /inconnu/);
    await sync();
    const got = p1.events.filter((e) => e.ev === 'sfx').map((e) => e.data);
    assert.deepEqual(got, [{ id: 'dice', volume: 1 }, { id: 'explosion', volume: 0.4 }]);
    assert.ok(gm.events.some((e) => e.ev === 'sfx'), 'GM hears it too');
  });

  let upId;
  await test('uploaded tracks: add, play as sfx, update, remove', async () => {
    await fails(gm.send('audio/addTrack', { name: 'x', kind: 'sfx', url: 'javascript:alert(1)' }), /invalide/);
    await fails(gm.send('audio/addTrack', { name: 'x', kind: 'boom', url: '/uploads/x.mp3' }), /invalide/);
    upId = await gm.send('audio/addTrack', { name: '  Cri du Wendigo  ', kind: 'sfx', url: '/uploads/abc-cri.mp3', tags: ['monstre', 'monstre', ''] });
    await sync();
    const t = gm.state.audio.tracks.find((x) => x.id === upId);
    assert.deepEqual({ name: t.name, kind: t.kind, source: t.source, tags: t.tags }, { name: 'Cri du Wendigo', kind: 'sfx', source: 'url', tags: ['monstre'] });
    assert.ok(p1.state.audio.tracks.some((x) => x.id === upId && x.url === '/uploads/abc-cri.mp3'), 'player needs uploaded sfx urls');
    p1.events.length = 0;
    await gm.send('audio/sfx', { id: upId });
    await sync();
    assert.deepEqual(p1.events.find((e) => e.ev === 'sfx')?.data, { id: upId, volume: 1, url: '/uploads/abc-cri.mp3' });
    await gm.send('audio/updateTrack', { id: upId, name: 'Hurlement', kind: 'ambient', volume: 3 });
    await gm.send('audio/setAmbient', { trackId: upId });
    await sync();
    const t2 = gm.state.audio.tracks.find((x) => x.id === upId);
    assert.equal(t2.name, 'Hurlement');
    assert.equal(t2.kind, 'ambient');
    assert.equal(t2.volume, 2);
    assert.equal(gm.state.audio.ambient.trackId, upId);
    await fails(gm.send('audio/updateTrack', { id: 'amb-rain', kind: 'music' }), /intégrée/);
    await gm.send('audio/updateTrack', { id: 'amb-rain', name: 'Crachin' });
    await fails(gm.send('audio/updateTrack', { id: 'nope', name: 'x' }), /introuvable/);
    await fails(gm.send('audio/removeTrack', { id: 'amb-rain' }), /intégrées/);
    await gm.send('audio/removeTrack', { id: upId });
    await sync();
    assert.ok(!gm.state.audio.tracks.some((x) => x.id === upId));
    assert.equal(gm.state.audio.ambient.trackId, null, 'removing the playing track silences the channel');
    assert.equal(gm.state.audio.tracks.find((x) => x.id === 'amb-rain').name, 'Crachin');
  });

  await test('scenes: create from current, keep, apply, update, delete', async () => {
    await gm.send('audio/setAmbient', { trackId: 'amb-lab' });
    await gm.send('audio/setMusic', { trackId: 'mus-tension' });
    const id = await gm.send('audio/saveScene', { name: 'Labo test', mapId: 'map_x', ambientVolume: 0.7 });
    await sync();
    let s = gm.state.audio.scenes.find((x) => x.id === id);
    assert.deepEqual({ name: s.name, ambient: s.ambient, music: s.music, mapId: s.mapId, av: s.ambientVolume }, { name: 'Labo test', ambient: 'amb-lab', music: 'mus-tension', mapId: 'map_x', av: 0.7 });
    await fails(gm.send('audio/saveScene', { name: 'x', ambient: 'dice' }), /boucle/);
    await fails(gm.send('audio/saveScene', { id: 'nope', name: 'x' }), /introuvable/);
    await gm.send('audio/saveScene', { id, name: 'Labo Lazarus bis', music: 'keep', mapId: null, ambientVolume: null });
    await sync();
    s = gm.state.audio.scenes.find((x) => x.id === id);
    assert.equal(s.name, 'Labo Lazarus bis');
    assert.equal(s.music, 'keep');
    assert.equal(s.mapId, undefined);
    assert.equal(s.ambientVolume, undefined);

    // Combat ! keeps the ambience and only changes the music.
    await gm.send('audio/applyScene', { sceneId: 'scn-combat' });
    await sync();
    assert.equal(gm.state.audio.ambient.trackId, 'amb-lab');
    assert.equal(gm.state.audio.music.trackId, 'mus-combat');
    assert.equal(p1.state.audio.music.trackId, 'mus-combat');
    await gm.send('audio/applyScene', { sceneId: 'scn-bar-porfla' });
    await sync();
    assert.equal(gm.state.audio.ambient.trackId, 'amb-bar');
    assert.equal(gm.state.audio.music.trackId, null);
    await gm.send('audio/saveScene', { id, ambientVolume: 0.25 });
    await gm.send('audio/applyScene', { sceneId: id });
    await sync();
    assert.equal(gm.state.audio.ambient.trackId, 'amb-lab');
    assert.equal(gm.state.audio.ambient.volume, 0.25);
    assert.equal(gm.state.audio.music.trackId, null, "music 'keep' left silence untouched");
    await gm.send('audio/deleteScene', { sceneId: id });
    await fails(gm.send('audio/applyScene', { sceneId: id }), /introuvable/);
    await fails(gm.send('audio/deleteScene', { sceneId: id }), /introuvable/);
    await sync();
    assert.ok(!gm.state.audio.scenes.some((x) => x.id === id));
    assert.equal(p1.state.audio.scenes, undefined);
  });

  await test('stopAll silences everyone and emits audio-stop; options', async () => {
    p1.events.length = 0;
    await gm.send('audio/stopAll');
    await gm.send('audio/setOptions', { autoScenes: false });
    await sync();
    assert.equal(gm.state.audio.ambient.trackId, null);
    assert.equal(gm.state.audio.music.trackId, null);
    assert.equal(gm.state.audio.autoScenes, false);
    assert.ok(p1.events.some((e) => e.ev === 'audio-stop'));
    assert.deepEqual(p1.state.audio.tracks, []);
  });

  await test('bad payloads never crash the server', async () => {
    for (const [type, payload] of [
      ['audio/setAmbient', { trackId: { evil: 1 } }],
      ['audio/setVolume', null],
      ['audio/sfx', { id: null }],
      ['audio/addTrack', { name: 'x'.repeat(5000), kind: 'music', url: '/uploads/' + 'a'.repeat(1000) }],
      ['audio/saveScene', { name: '', ambient: 12 }],
      ['audio/applyScene', {}],
      ['audio/updateTrack', { id: 'dice', volume: 'x' }],
    ]) {
      try {
        await gm.send(type, payload);
      } catch {}
    }
    await sync();
    assert.ok(gm.state.audio.tracks.every((t) => t.name.length <= 80));
    assert.ok(!/TypeError|ReferenceError/.test(srv.output()), 'server logged a crash:\n' + srv.output());
  });
} finally {
  gm?.close();
  p1?.close();
  srv.stop();
}

console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
