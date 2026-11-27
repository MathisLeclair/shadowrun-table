// 3D dice overlay (global, every user): new roll entries of the log are thrown as CSS 3D cubes that roll onto the
// server's results (the server rolls, the animation only shows what it rolled). Each user picks, in this browser,
// whether they see none, their own rolls or every roll they can see (`Dice3dPicker`, Journal & dés bar).
import { useEffect, useRef, useState, type CSSProperties } from 'react';

import { t, tn, tk, logText } from '../../lib/i18n.ts';
import { RollBadges, rollLabel, cssVars } from './common.tsx';

import type { GameProps } from '../../lib/net.ts';
import type { GameView, LogEntry } from '../../../shared/types.ts';
import type { ShownRoll } from './types.ts';
import './dice3d.css';

type Mode = 'off' | 'mine' | 'all';
/** 3-vector [x, y, z]. */
type Vec3 = number[];
/** Quaternion [w, x, y, z]. */
type Quat = number[];
/** 3×3 rotation matrix (rows). */
type Mat3 = number[][];
interface Frame {
  x: number;
  y: number;
  z: number;
  q: Quat;
}
interface Die {
  key: string;
  v: number;
  kind: string;
  start: number;
  end: number;
  frames: Frame[];
}
interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
/** Everything one throw needs (buildThrow). */
interface ThrowData {
  id: string;
  entry: LogEntry;
  color: string;
  dice: Die[];
  size: number;
  landAt: number;
  center: { x: number; y: number };
  hidden: number;
}

// ---------------------------------------------------------------------------
// Preference: 'off' | 'mine' | 'all' (default), per browser
// ---------------------------------------------------------------------------
const LS_KEY = 'sr.dice3d';
const MODES: Mode[] = ['off', 'mine', 'all'];
const MODE_LABEL: Record<Mode, string> = { off: tk('Dés 3D : non'), mine: tk('Dés 3D : mes jets'), all: tk('Dés 3D : tous les jets') };
const readMode = (): Mode => {
  try {
    const v = localStorage.getItem(LS_KEY) as Mode | null;
    return v && MODES.includes(v) ? v : 'all';
  } catch {
    return 'all';
  }
};
let mode = readMode();
const listeners = new Set<(m: Mode) => void>();
export function setDice3dMode(m: Mode) {
  if (!MODES.includes(m)) return;
  mode = m;
  try {
    localStorage.setItem(LS_KEY, m);
  } catch {}
  listeners.forEach((fn) => fn(m));
}
function useDice3dMode() {
  const [m, setM] = useState(mode);
  useEffect(() => {
    listeners.add(setM);
    return () => {
      listeners.delete(setM);
    };
  }, []);
  return m;
}

/** Small cycling button: off → my rolls → all rolls. */
export function Dice3dPicker() {
  const m = useDice3dMode();
  const next = MODES[(MODES.indexOf(m) + 1) % MODES.length];
  return <button type="button" className={'ld-filter d3-pick' + (m !== 'off' ? ' on' : '')} title={t(MODE_LABEL[m]) + ' — ' + t('cliquer pour changer')} aria-label={t(MODE_LABEL[m])} onClick={() => setDice3dMode(next)}>
    🎲 {m === 'off' ? t('3D') : m === 'mine' ? t('3D : moi') : t('3D : tous')}
  </button>;
}

// ---------------------------------------------------------------------------
// Simulation (pure): each die is thrown from the stage edge, falls, bounces and rolls with its motion (no slipping)
// until it stops. The spin is computed forward, then the orientation backward from the resting pose (the server's
// value facing up), so it lands on that face. Coordinates: CSS px, x right, y down, z toward the viewer.
// ---------------------------------------------------------------------------
const MAX_DICE = 40;
const DT = 1 / 60;
const GRAVITY = 2800;
const BOUNCE = 0.42;
const rand = (a: number, b: number): number => a + Math.random() * (b - a);

function norm3(v: Vec3): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}
const LIGHT = norm3([-0.35, -0.55, 0.76]);
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: number[], b: number[]): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
// Quaternions [w, x, y, z].
const qmul = (a: Quat, b: Quat): Quat => [
  a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
  a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
  a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
  a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
];
function qnorm(q: Quat): Quat {
  const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}
function qaxis(axis: Vec3, ang: number): Quat {
  const s = Math.sin(ang / 2);
  return [Math.cos(ang / 2), axis[0] * s, axis[1] * s, axis[2] * s];
}
/** Shortest rotation taking unit vector a onto unit vector b. */
function qbetween(a: Vec3, b: Vec3): Quat {
  const d = dot(a, b);
  if (d > 0.99999) return [1, 0, 0, 0];
  if (d < -0.99999) return qaxis(Math.abs(a[0]) < 0.9 ? norm3(cross(a, [1, 0, 0])) : norm3(cross(a, [0, 1, 0])), Math.PI);
  return qaxis(norm3(cross(a, b)), Math.acos(d));
}
function qslerp(a: Quat, b: Quat, t: number): Quat {
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  if (d < 0) {
    b = b.map((x) => -x);
    d = -d;
  }
  if (d > 0.9995) return qnorm(a.map((x, i) => x + (b[i] - x) * t));
  const th = Math.acos(d);
  const s = Math.sin(th);
  const wa = Math.sin((1 - t) * th) / s;
  const wb = Math.sin(t * th) / s;
  return a.map((x, i) => x * wa + b[i] * wb);
}
/** Rotation matrix (rows) of q. */
function qmat(q: Quat): Mat3 {
  const [w, x, y, z] = q;
  return [
    [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
    [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
    [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)],
  ];
}
const mulv = (m: Mat3, v: Vec3): Vec3 => [dot(m[0], v), dot(m[1], v), dot(m[2], v)];
// CSS matrix3d takes columns.
const cssMatrix = (m: Mat3): string => `matrix3d(${m[0][0]},${m[1][0]},${m[2][0]},0,${m[0][1]},${m[1][1]},${m[2][1]},0,${m[0][2]},${m[1][2]},${m[2][2]},0,0,0,0,1)`;

// Model faces: value → outward normal n and in-plane axes u, w (u × w = n, so backface culling works). Opposites sum to 7.
const FACES: Record<number, { n: Vec3; u: Vec3; w: Vec3 }> = {
  1: { n: [0, 0, 1], u: [1, 0, 0], w: [0, 1, 0] },
  6: { n: [0, 0, -1], u: [-1, 0, 0], w: [0, 1, 0] },
  3: { n: [1, 0, 0], u: [0, 0, -1], w: [0, 1, 0] },
  4: { n: [-1, 0, 0], u: [0, 0, 1], w: [0, 1, 0] },
  5: { n: [0, 1, 0], u: [1, 0, 0], w: [0, 0, -1] },
  2: { n: [0, -1, 0], u: [1, 0, 0], w: [0, 0, 1] },
};
const faceTransform = (f: { n: Vec3; u: Vec3; w: Vec3 }, half: number): string => `matrix3d(${f.u.join(',')},0,${f.w.join(',')},0,${f.n.join(',')},0,${f.n[0] * half},${f.n[1] * half},${f.n[2] * half},1)`;
const PIPS: Record<number, number[]> = { 1: [5], 2: [3, 7], 3: [3, 5, 7], 4: [1, 3, 7, 9], 5: [1, 3, 5, 7, 9], 6: [1, 3, 4, 6, 7, 9] };

/** Precomputed frames { x, y, z, q } of one die (exported for checks). */
interface Step {
  x: number;
  y: number;
  z: number;
  axis: Vec3 | null;
  ang: number;
  q?: Quat;
}
export function simulateDie({ from, to, value, size }: { from: number[]; to: number[]; value: number; size: number }): { frames: Frame[]; duration: number } {
  const r = size / 2;
  const T = rand(1.3, 1.65); // time until it comes to rest
  const steps: Step[] = [];
  let w = norm3([rand(-1, 1), rand(-1, 1), rand(-1, 1)]).map((c) => c * rand(12, 20)); // tumble while airborne (rad/s)
  let z = rand(170, 260);
  let vz = rand(-120, 60);
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  // Forward pass: position, height and spin.
  for (let t = 0; t <= T + 1e-6; t += DT) {
    const u = Math.min(1, t / T);
    const e = 1 - Math.pow(1 - u, 3);
    const k = (3 * Math.pow(1 - u, 2)) / T; // d(e)/dt
    const vx = dx * k;
    const vy = dy * k;
    // Height: ballistic fall and decaying bounces.
    vz -= GRAVITY * DT;
    z += vz * DT;
    let touching = false;
    if (z <= 0) {
      z = 0;
      vz = vz < -140 ? -vz * BOUNCE : 0;
      touching = true;
    }
    // On the table, friction pulls the spin toward rolling without slipping: ω = (n × v) / r with n = +z.
    // The speed eases to 0, so the spin does too: the die rolls to a stop.
    if (touching) {
      const roll = [-vy / r, vx / r, 0];
      w = w.map((c, i) => c + (roll[i] - c) * 0.35);
    }
    const mag = Math.min(Math.hypot(w[0], w[1], w[2]), 24);
    steps.push({ x: from[0] + dx * e, y: from[1] + dy * e, z, axis: mag > 1e-4 ? norm3(w) : null, ang: mag * DT });
  }
  // Backward pass: start from the resting pose (the value's face up, random yaw) and undo each step's rotation,
  // so the die rolls forward straight into that pose — no snapping or tipping back at the end.
  let q = qnorm(qmul(qaxis([0, 0, 1], rand(0, Math.PI * 2)), qbetween(FACES[value].n, [0, 0, 1])));
  for (let i = steps.length - 1; i >= 0; i--) {
    steps[i].q = q;
    const axis = steps[i].axis;
    if (axis) q = qnorm(qmul(qaxis(axis, -steps[i].ang), q));
  }
  // A cube is not a ball: lift it so its lowest corner touches the table (it rocks over its edges while rolling).
  const frames: Frame[] = steps.map((st) => {
    const q = st.q as Quat; // set by the backward pass
    const m = qmat(q);
    const lift = r * (Math.abs(m[2][0]) + Math.abs(m[2][1]) + Math.abs(m[2][2]) - 1);
    return { x: st.x, y: st.y, z: st.z + lift, q };
  });
  for (let i = 0; i < 6; i++) frames.push(frames[frames.length - 1]); // brief rest before the result shows
  return { frames, duration: frames.length * DT };
}

/** The area the dice land in: the main page (left of the dock), else the window. */
function stageBox(): Box {
  const r = document.querySelector('.shell > .main')?.getBoundingClientRect();
  if (r && r.width > 200 && r.height > 200) return { x: r.left + r.width / 2, y: r.top + r.height * 0.5, w: r.width, h: r.height };
  return { x: window.innerWidth / 2, y: window.innerHeight * 0.5, w: window.innerWidth, h: window.innerHeight };
}

/** Final positions (centre-relative px) of n dice in a loose grid, centred, or starting at y = `top` when given. */
function layout(n: number, size: number, box: Box, top: number | null = null): { out: number[][]; height: number } {
  const cell = size * 1.6;
  const cols = Math.max(1, Math.min(Math.ceil(Math.sqrt(n * 1.8)), Math.floor((box.w * 0.8) / cell)));
  const rows = Math.ceil(n / cols);
  const y0 = top === null ? (-(rows - 1) / 2) * cell : top + cell / 2;
  const out: number[][] = [];
  for (let i = 0; i < n; i++) {
    const row = Math.floor(i / cols);
    const inRow = row === rows - 1 ? n - row * cols : cols;
    const c = i % cols;
    out.push([(c - (inRow - 1) / 2) * cell + rand(-0.2, 0.2) * size, y0 + row * cell + rand(-0.2, 0.2) * size]);
  }
  return { out, height: rows * cell };
}

function makeDice(values: number[], size: number, box: Box, side: string, delay: number, top: number | null, kind: string): { height: number; dice: Die[] } {
  const { out, height } = layout(values.length, size, box, top);
  return {
    height,
    dice: values.map((v, i) => {
      const to = out[i];
      const from =
        side === 'left'
          ? [-box.w / 2 - rand(60, 160), to[1] * 0.4 + rand(-box.h * 0.2, box.h * 0.2)]
          : side === 'right'
            ? [box.w / 2 + rand(60, 160), to[1] * 0.4 + rand(-box.h * 0.2, box.h * 0.2)]
            : [to[0] * 0.4 + rand(-box.w * 0.15, box.w * 0.15), box.h / 2 + rand(60, 160)];
      const sim = simulateDie({ from, to, value: v, size });
      const start = delay + rand(0, 0.15);
      return { key: `${kind}${i}`, v, kind, start, end: start + sim.duration, frames: sim.frames };
    }),
  };
}

/** Everything one throw needs, computed once when it starts. */
function buildThrow(entry: LogEntry, color: string): ThrowData {
  const r = entry.roll as NonNullable<LogEntry['roll']>; // only entries with dice are thrown
  const main = r.dice.slice(0, MAX_DICE);
  const extra = (r.extra || []).slice(0, Math.max(0, MAX_DICE - main.length));
  const total = main.length + extra.length;
  const size = total <= 8 ? 60 : total <= 16 ? 50 : total <= 26 ? 42 : 34;
  const box = stageBox();
  const sides = ['left', 'right', 'bottom'];
  const side = sides[Math.floor(Math.random() * 3)];
  const a = makeDice(main, size, box, side, 0, null, 'm');
  const b: { dice: Die[]; height: number } = extra.length ? makeDice(extra, size, box, sides[(sides.indexOf(side) + 1) % 3], 1.2, a.height / 2 + size * 0.3, 'x') : { dice: [], height: 0 };
  const dice = a.dice.concat(b.dice);
  const landAt = Math.round(Math.max(...dice.map((d) => d.end), 0) * 1000) + 60;
  const cy = box.y - (b.height ? (b.height + size * 0.3) / 2 : 0);
  return { id: entry.id, entry, color, dice, size, landAt, center: { x: box.x, y: cy }, hidden: Math.max(0, r.dice.length + (r.extra || []).length - total) };
}

/** Frame of a die at time t (s): blend of the two nearest simulation steps. */
function frameAt(d: Die, t: number): Frame {
  const f = d.frames;
  const pos = Math.max(0, (t - d.start) / DT);
  const i = Math.min(f.length - 1, Math.floor(pos));
  const j = Math.min(f.length - 1, i + 1);
  const k = pos - i;
  if (i === j || k <= 0) return f[i];
  const a = f[i];
  const b = f[j];
  return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, z: a.z + (b.z - a.z) * k, q: qslerp(a.q, b.q, k) };
}

function Pips({ v }: { v: number }) {
  return <>{PIPS[v].map((i) => <span key={i} className="d3-pip" style={{ gridArea: `${Math.floor((i - 1) / 3) + 1} / ${((i - 1) % 3) + 1}` }} />)}</>;
}

/** The dice of one throw, driven by requestAnimationFrame (no re-render per frame). */
function Throw({ cur, landed }: { cur: ThrowData; landed: boolean }) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const parts = [...el.querySelectorAll<HTMLElement>('.d3-die')].map((de) => ({
      die: de,
      cube: de.querySelector('.d3-cube') as HTMLElement,
      shadow: el.querySelector(`.d3-shadow[data-k="${de.dataset.k}"]`) as HTMLElement,
      shades: [...de.querySelectorAll<HTMLElement>('.d3-face')].map((fe) => ({ n: FACES[Number(fe.dataset.v)].n, el: fe.querySelector('.d3-shade') as HTMLElement })),
    }));
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const t0 = performance.now();
    const half = cur.size / 2;
    let raf = 0;
    const draw = () => {
      const t = reduce ? 1e9 : (performance.now() - t0) / 1000;
      cur.dice.forEach((d, i) => {
        const p = parts[i];
        const visible = t >= d.start;
        p.die.style.visibility = p.shadow.style.visibility = visible ? 'visible' : 'hidden';
        if (!visible) return;
        const fr = frameAt(d, t);
        const m = qmat(fr.q);
        p.die.style.transform = `translate3d(${fr.x}px, ${fr.y}px, ${fr.z}px)`;
        p.cube.style.transform = cssMatrix(m);
        const lift = fr.z / 300;
        p.shadow.style.transform = `translate3d(${fr.x + fr.z * 0.25}px, ${fr.y + half * 0.3 + fr.z * 0.4}px, 0) scale(${1 + lift * 0.6})`;
        p.shadow.style.opacity = String(Math.max(0.15, 0.75 - lift * 0.5));
        for (const s of p.shades) s.el.style.opacity = String((1 - Math.max(0, dot(mulv(m, s.n), LIGHT))) * 0.75);
      });
      if (t * 1000 < cur.landAt + 100) raf = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, [cur]);
  const half = cur.size / 2;
  const box: CSSProperties = { width: `${cur.size}px`, height: `${cur.size}px`, marginLeft: `${-half}px`, marginTop: `${-half}px`, visibility: 'hidden' };
  return <div className="d3-stage" ref={root} style={cssVars({ left: `${cur.center.x}px`, top: `${cur.center.y}px`, '--s': `${cur.size}px` })}>
    {cur.dice.map((d) => <div key={'s' + d.key} className="d3-shadow" data-k={d.key} style={box} />)}
    {cur.dice.map(
      (d) => <div key={d.key} data-k={d.key} className={'d3-die' + (landed ? (d.v >= 5 ? ' hit' : d.v === 1 ? ' one' : ' miss') : '')} style={box}>
        <div className="d3-cube">
          {[1, 2, 3, 4, 5, 6].map(
            (f) => <div key={f} className={'d3-face' + (f === d.v ? ' top' : '')} data-v={f} style={{ transform: faceTransform(FACES[f], half) }}>
              <Pips v={f} />
              <span className="d3-shade" />
            </div>
          )}
        </div>
      </div>
    )}
  </div>;
}

// ---------------------------------------------------------------------------
// Overlay
// ---------------------------------------------------------------------------
function rollColor(game: GameView, e: LogEntry): string {
  const actorColor = e.roll?.actorId ? game.actors?.[e.roll.actorId]?.color : undefined;
  if (actorColor) return actorColor;
  if (e.userId === 'gm') return '#e0468f';
  const u = e.userId ? game.users?.[e.userId] : undefined;
  const a = u && game.actors?.[(u.characterIds || [])[0]];
  return a?.color || '#3fd6d0';
}

function wanted(game: GameView, e: LogEntry, m: Mode): boolean {
  if (!e?.roll || !Array.isArray(e.roll.dice) || !e.roll.dice.length) return false;
  if (m === 'all') return true;
  if (e.userId === game.me.id) return true;
  return game.me.role !== 'gm' && !!e.roll.actorId && (game.me.characterIds || []).includes(e.roll.actorId);
}

export default function Dice3D({ game }: GameProps) {
  const m = useDice3dMode();
  const seen = useRef<Set<string> | null>(null);
  const queue = useRef<string[]>([]);
  const [cur, setCur] = useState<ThrowData | null>(null);
  const [phase, setPhase] = useState('roll'); // roll → landed → out
  const gameRef = useRef(game);
  gameRef.current = game;

  const log = game.log;
  useEffect(() => {
    const entries = log || [];
    if (!seen.current) {
      // First state (page load / login): nothing is replayed.
      seen.current = new Set(entries.map((e) => e.id));
      return;
    }
    const seenIds = seen.current;
    const fresh = entries.filter((e) => !seenIds.has(e.id));
    fresh.forEach((e) => seenIds.add(e.id));
    if (seenIds.size > 2000) seen.current = new Set(entries.map((e) => e.id));
    if (m === 'off') return;
    // A reconnection can deliver many entries at once: only the last few are thrown.
    const rolls = fresh.filter((e) => wanted(game, e, m)).slice(-3);
    if (!rolls.length) return;
    queue.current.push(...rolls.map((e) => e.id));
    if (queue.current.length > 4) queue.current = queue.current.slice(-4);
    if (!cur) next();
  }, [log]);

  useEffect(() => {
    if (m === 'off') {
      queue.current = [];
      setCur(null);
    }
  }, [m]);

  function next() {
    const g = gameRef.current;
    while (queue.current.length) {
      const id = queue.current.shift();
      const e = (g.log || []).find((x) => x.id === id);
      if (e?.roll?.dice) {
        setPhase('roll');
        setCur(buildThrow(e, rollColor(g, e)));
        return;
      }
    }
    setCur(null);
  }

  useEffect(() => {
    if (!cur) return;
    const hold = queue.current.length ? 1300 : 2600;
    const t1 = setTimeout(() => setPhase('landed'), cur.landAt);
    const t2 = setTimeout(() => setPhase('out'), cur.landAt + hold);
    const t3 = setTimeout(next, cur.landAt + hold + 380);
    return () => [t1, t2, t3].forEach(clearTimeout);
  }, [cur]);

  if (!cur || m === 'off') return null;
  // The entry may have changed since (second chance, deleted): show its live values in the banner.
  const live = (game.log || []).find((x) => x.id === cur.id) || cur.entry;
  const r = (live.roll || cur.entry.roll) as ShownRoll;
  const author = live.authorI18n?.key ? t(live.authorI18n.key, live.authorI18n.params) : live.author === 'MJ' ? t('MJ') : live.author || '';
  const landed = phase !== 'roll';
  return <div className={'d3-layer' + (phase === 'out' ? ' out' : '')} style={cssVars({ '--die': cur.color, perspectiveOrigin: `${cur.center.x}px ${cur.center.y}px` })} aria-hidden="true">
    <Throw key={cur.id} cur={cur} landed={landed} />
    {landed &&
    <button type="button" className="d3-banner" onClick={next} title={t('Fermer')}>
      <span className="d3-who" style={{ color: cur.color }}>{author}</span>
      <span className="d3-label">{rollLabel(r) || logText(live)}</span>
      {typeof r.hits === 'number' ? <span className={'d3-hits' + (r.critGlitch ? ' crit' : r.glitch ? ' glitch' : r.hits === 0 ? ' zero' : '')}>
        {r.hits}
        <small>{' '}{t('succès')}</small>
      </span> : r.total !== undefined ? <span className="d3-hits">{r.total}</span> : null}
      {cur.hidden > 0 && <span className="muted small">{tn(cur.hidden, '+{n} dé non affiché', '+{n} dés non affichés')}</span>}
      <RollBadges roll={r} />
    </button>}
  </div>;
}
