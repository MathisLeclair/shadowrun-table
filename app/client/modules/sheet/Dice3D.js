// 3D dice overlay (global, every user): new roll entries of the log are thrown as CSS 3D cubes that tumble onto the
// server's results (the server rolls, the animation only shows what it rolled). Each user picks, in this browser,
// whether they see none, their own rolls or every roll they can see (`Dice3dPicker`, Journal & dés bar).
import { useEffect, useRef, useState } from 'preact/hooks';
import { html, loadCss } from '../../lib/ui.js';
import { t, tn, tk, logText } from '../../lib/i18n.js';
import { RollBadges, rollLabel } from './common.js';

loadCss('/modules/sheet/dice3d.css');

// ---------------------------------------------------------------------------
// Preference: 'off' | 'mine' | 'all', per browser
// ---------------------------------------------------------------------------
const LS_KEY = 'sr.dice3d';
const MODES = ['off', 'mine', 'all'];
const MODE_LABEL = { off: tk('Dés 3D : non'), mine: tk('Dés 3D : mes jets'), all: tk('Dés 3D : tous les jets') };
const readMode = () => {
  try {
    const v = localStorage.getItem(LS_KEY);
    return MODES.includes(v) ? v : 'off';
  } catch {
    return 'off';
  }
};
let mode = readMode();
const listeners = new Set();
export function setDice3dMode(m) {
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
    return () => listeners.delete(setM);
  }, []);
  return m;
}

/** Small cycling button: off → my rolls → all rolls. */
export function Dice3dPicker() {
  const m = useDice3dMode();
  const next = MODES[(MODES.indexOf(m) + 1) % MODES.length];
  return html`<button type="button" class=${'ld-filter d3-pick' + (m !== 'off' ? ' on' : '')} title=${t(MODE_LABEL[m]) + ' — ' + t('cliquer pour changer')}
    aria-label=${t(MODE_LABEL[m])} onClick=${() => setDice3dMode(next)}>🎲 ${m === 'off' ? t('3D') : m === 'mine' ? t('3D : moi') : t('3D : tous')}</button>`;
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------
// Faces are placed with these rotations (opposite faces sum to 7); [rx, ry] brings face N to the viewer.
const FACE_ROT = { 1: '', 2: 'rotateX(90deg)', 3: 'rotateY(90deg)', 4: 'rotateY(-90deg)', 5: 'rotateX(-90deg)', 6: 'rotateY(180deg)' };
const SHOW = { 1: [0, 0], 2: [-90, 0], 3: [0, -90], 4: [0, 90], 5: [90, 0], 6: [0, 180] };
const PIPS = { 1: [5], 2: [3, 7], 3: [3, 5, 7], 4: [1, 3, 7, 9], 5: [1, 3, 5, 7, 9], 6: [1, 3, 4, 6, 7, 9] };
const MAX_DICE = 40;
const rand = (a, b) => a + Math.random() * (b - a);

/** The area the dice land in: the main page (left of the dock), else the window. */
function stageBox() {
  const r = document.querySelector('.shell > .main')?.getBoundingClientRect();
  if (r && r.width > 200 && r.height > 200) return { x: r.left + r.width / 2, y: r.top + r.height * 0.48, w: r.width, h: r.height };
  return { x: window.innerWidth / 2, y: window.innerHeight * 0.48, w: window.innerWidth, h: window.innerHeight };
}

/** Final positions (centre-relative px) of n dice in a loose grid, plus a throw origin per die. */
function layout(n, size, fromLeft, offset = 0) {
  const { w: vw, h: vh } = stageBox();
  const cell = size * 1.55;
  const cols = Math.max(1, Math.min(Math.ceil(Math.sqrt(n * 1.8)), Math.floor((vw * 0.8) / cell)));
  const rows = Math.ceil(n / cols);
  const out = [];
  for (let i = 0; i < n; i++) {
    const r = Math.floor(i / cols);
    const inRow = r === rows - 1 ? n - r * cols : cols;
    const c = i % cols;
    const x = (c - (inRow - 1) / 2) * cell + rand(-0.18, 0.18) * size;
    const y = (r - (rows - 1) / 2) * cell + offset + rand(-0.18, 0.18) * size;
    const dir = fromLeft ? -1 : 1;
    out.push({ x, y, sx: dir * (vw * 0.55 + rand(0, 160)) - x * 0.3, sy: vh * 0.45 + rand(-80, 160) });
  }
  return { out, height: rows * cell };
}

function makeDice(values, size, fromLeft, delay, offset, kind) {
  const { out, height } = layout(values.length, size, fromLeft, offset);
  return {
    height,
    dice: values.map((v, i) => {
      const [rx, ry] = SHOW[v] || SHOW[1];
      const rz = rand(-25, 25);
      const p = out[i];
      const dur = Math.round(rand(950, 1300));
      return {
        key: `${kind}${i}`,
        v,
        kind,
        dur: dur + delay,
        style: {
          '--x': `${p.x}px`, '--y': `${p.y}px`, '--sx': `${p.sx}px`, '--sy': `${p.sy}px`, '--s': `${size}px`,
          '--rx': `${rx}deg`, '--ry': `${ry}deg`, '--rz': `${rz}deg`,
          '--rx0': `${rx + (Math.random() < 0.5 ? -1 : 1) * rand(540, 1080)}deg`,
          '--ry0': `${ry + (Math.random() < 0.5 ? -1 : 1) * rand(540, 1080)}deg`,
          '--rz0': `${rz + rand(-180, 180)}deg`,
          '--dur': `${dur}ms`, '--delay': `${delay}ms`,
        },
      };
    }),
  };
}

/** Everything one throw needs, computed once when it starts. */
function buildThrow(entry, color) {
  const r = entry.roll;
  const main = r.dice.slice(0, MAX_DICE);
  const extra = (r.extra || []).slice(0, Math.max(0, MAX_DICE - main.length));
  const total = main.length + extra.length;
  const size = total <= 8 ? 64 : total <= 16 ? 54 : total <= 26 ? 44 : 36;
  const fromLeft = Math.random() < 0.35;
  const a = makeDice(main, size, fromLeft, 0, 0, 'm');
  const b = extra.length ? makeDice(extra, size, !fromLeft, 1150, a.height / 2 + size * 0.9, 'x') : { dice: [], height: 0 };
  const dice = a.dice.concat(b.dice);
  const landAt = Math.max(...dice.map((d) => d.dur), 0) + 80;
  const box = stageBox();
  return { id: entry.id, entry, color, dice, landAt, center: { left: `${box.x}px`, top: `${box.y - (b.height ? b.height / 2 : 0)}px` }, hidden: Math.max(0, r.dice.length + (r.extra || []).length - total) };
}

function Pips({ v }) {
  return html`${PIPS[v].map((i) => html`<span class="d3-pip" style=${{ gridArea: `${Math.floor((i - 1) / 3) + 1} / ${((i - 1) % 3) + 1}` }}></span>`)}`;
}

const DieCube = ({ d, landed }) => html`<div class=${'d3-die' + (landed ? (d.v >= 5 ? ' hit' : d.v === 1 ? ' one' : ' miss') : '') + (d.kind === 'x' ? ' extra' : '')} style=${d.style}>
  <div class="d3-shadow"></div>
  <div class="d3-throw"><div class="d3-tilt"><div class="d3-cube">
    ${[1, 2, 3, 4, 5, 6].map((f) => html`<div class=${'d3-face' + (f === d.v ? ' top' : '')} style=${{ transform: `${FACE_ROT[f]} translateZ(calc(var(--s) / 2))` }}><${Pips} v=${f} /></div>`)}
  </div></div></div>
</div>`;

// ---------------------------------------------------------------------------
// Overlay
// ---------------------------------------------------------------------------
function rollColor(game, e) {
  if (e.roll?.actorId && game.actors?.[e.roll.actorId]?.color) return game.actors[e.roll.actorId].color;
  if (e.userId === 'gm') return '#e0468f';
  const u = game.users?.[e.userId];
  const a = u && game.actors?.[(u.characterIds || [])[0]];
  return a?.color || '#3fd6d0';
}

function wanted(game, e, m) {
  if (!e?.roll || !Array.isArray(e.roll.dice) || !e.roll.dice.length) return false;
  if (m === 'all') return true;
  if (e.userId === game.me.id) return true;
  return game.me.role !== 'gm' && !!e.roll.actorId && (game.me.characterIds || []).includes(e.roll.actorId);
}

export default function Dice3D({ game }) {
  const m = useDice3dMode();
  const seen = useRef(null);
  const queue = useRef([]);
  const [cur, setCur] = useState(null);
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
    const fresh = entries.filter((e) => !seen.current.has(e.id));
    fresh.forEach((e) => seen.current.add(e.id));
    if (seen.current.size > 2000) seen.current = new Set(entries.map((e) => e.id));
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
  const r = live.roll || cur.entry.roll;
  const author = live.authorI18n?.key ? t(live.authorI18n.key, live.authorI18n.params) : live.author === 'MJ' ? t('MJ') : live.author || '';
  const landed = phase !== 'roll';
  return html`<div class=${'d3-layer' + (phase === 'out' ? ' out' : '')} style=${{ '--die': cur.color }} aria-hidden="true">
    <div class="d3-stage" style=${cur.center}>${cur.dice.map((d) => html`<${DieCube} key=${d.key} d=${d} landed=${landed} />`)}</div>
    ${landed &&
    html`<button type="button" class="d3-banner" onClick=${next} title=${t('Fermer')}>
      <span class="d3-who" style=${{ color: cur.color }}>${author}</span>
      <span class="d3-label">${rollLabel(r) || logText(live)}</span>
      <span class=${'d3-hits' + (r.critGlitch ? ' crit' : r.glitch ? ' glitch' : r.hits === 0 ? ' zero' : '')}>${r.hits}<small> ${t('succès')}</small></span>
      ${cur.hidden > 0 && html`<span class="muted small">${tn(cur.hidden, '+{n} dé non affiché', '+{n} dés non affichés')}</span>`}
      <${RollBadges} roll=${r} />
    </button>`}
  </div>`;
}
